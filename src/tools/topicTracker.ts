import { z } from 'zod';
import { searchBills, type BillSummary } from '../clients/bills.js';
import { searchHansardDebates, type DebateResult } from '../clients/hansard.js';
import { searchCommonsDivisions, type DivisionSummary } from '../clients/commonsVotes.js';
import { searchWrittenQuestions, type WrittenQuestion } from '../clients/writtenQuestions.js';
import { searchPetitions, type Petition } from '../clients/petitions.js';
import { fanOut, valueOf } from '../core/budget.js';
import { buildEnvelope } from '../envelope.js';
import { Citations, collectSources } from '../domain/citations.js';
import { windowFor, splitTopicAndWindow, withinWindow } from '../domain/dates.js';
import { rank } from '../domain/relevance.js';
import { callLogger } from '../core/logger.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const TopicTrackerInput = z.object({
  topic: z
    .string()
    .min(2)
    .describe(
      'Policy topic as a short noun phrase, e.g. "climate change", "renters reform", "NHS waiting lists". ' +
        'A trailing date phrase is understood and stripped ("climate change last 90 days" works).',
    ),
  lookback_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(90)
    .catch(90)
    .describe('Days of history to search. Accepts a number or a numeric string. Out-of-range values are clamped.'),
  response_format: z.enum(['concise', 'detailed']).default('concise'),
});

export type TopicTrackerInputType = z.infer<typeof TopicTrackerInput>;

const truncate = (text: string | null | undefined, cap: number): string => {
  const t = (text ?? '').trim();
  if (!t) return '';
  return t.length <= cap ? t : `${t.slice(0, cap - 1).trimEnd()}…`;
};

export async function topicTracker(
  input: TopicTrackerInputType,
  ctx: { requestId: string },
) {
  const log = callLogger(ctx.requestId, 'parliament_topic_tracker');

  // A date phrase left inside the topic matches no titles and silently returns
  // an empty briefing, so it is split out and used as the window instead.
  const split = splitTopicAndWindow(input.topic);
  const topic = split.topic;
  const lookbackDays = split.lookbackDays ?? input.lookback_days;
  const win = windowFor(lookbackDays);
  const detailed = input.response_format === 'detailed';

  log.info({ topic, lookbackDays, inferred: Boolean(split.lookbackDays) }, 'topic_tracker start');

  const fan = await fanOut(
    [
      {
        key: 'bills',
        run: (signal) => searchBills({ searchTerm: topic, take: 20, signal }),
      },
      {
        key: 'debates',
        run: (signal) =>
          searchHansardDebates({
            searchTerm: topic,
            startDate: win.from,
            endDate: win.to,
            take: 20,
            signal,
          }),
      },
      {
        key: 'divisions',
        run: (signal) => searchCommonsDivisions({ searchTerm: topic, take: 20, signal }),
      },
      {
        key: 'written_questions',
        run: (signal) =>
          searchWrittenQuestions({
            searchTerm: topic,
            askedStartDate: win.from,
            askedEndDate: win.to,
            // This endpoint's searchTerm is effectively inert — it reported
            // 33,265 "matches" for "renters reform", returning Defence and NHS
            // dentistry questions. Since the ranking that makes the section
            // usable happens here, pull a wider set to rank over.
            take: 50,
            signal,
          }),
      },
      {
        key: 'petitions',
        run: (signal) => searchPetitions({ search: topic, state: 'open', signal }),
      },
    ],
    { log, tool: 'parliament_topic_tracker' },
  );

  const billsRaw = valueOf<{ items: BillSummary[] }>(fan.results.bills)?.items ?? [];
  const debatesRaw = valueOf<{ results: DebateResult[] }>(fan.results.debates)?.results ?? [];
  const divisionsRaw = valueOf<DivisionSummary[]>(fan.results.divisions) ?? [];
  const questionsRaw = valueOf<WrittenQuestion[]>(fan.results.written_questions) ?? [];
  const petitionsRaw = valueOf<Petition[]>(fan.results.petitions) ?? [];

  // Bills that already received Royal Assent are not "in progress".
  const bills = rank(topic, billsRaw.filter((b) => !b.isAct), (b) => ({ title: b.shortTitle }))
    .slice(0, 5)
    .map((s) => s.item);

  const debates = rank(topic, debatesRaw, (d) => ({ title: d.Title }))
    .slice(0, 5)
    .map((s) => s.item);

  // Upstream ignores the date window here, so results are labelled honestly
  // rather than presented as if they were filtered.
  const divisionsRanked = rank(topic, divisionsRaw, (d) => ({ title: d.Title })).map((s) => s.item);
  const divisionsInWindow = divisionsRanked.filter((d) => withinWindow(d.Date, win));

  const questions = rank(topic, questionsRaw, (q) => ({ title: q.questionText ?? '' }))
    .slice(0, 5)
    .map((s) => s.item);

  // The petitions API's own search is unreliable, so ranking happens here.
  // Requiring every significant term is what keeps "change" from matching
  // unrelated petitions when the topic is "climate change".
  const petitions = rank(
    topic,
    petitionsRaw,
    (p) => ({ title: p.attributes.action, body: p.attributes.background ?? '' }),
    // A petition's `action` is its actual subject. Long background text makes
    // term co-occurrence cheap, so the topic must appear in the action itself.
    { requireTitleHit: true },
  )
    .map((s) => s.item)
    .sort((a, b) => b.attributes.signature_count - a.attributes.signature_count)
    .slice(0, 5);

  /**
   * "Upstream returned nothing" and "upstream returned things, none of them
   * relevant" are different facts, and a bare empty list conflates them. The
   * counts make the distinction visible — Parliament's own search is weak enough
   * that the second case is common.
   */
  const retrieval = {
    bills: { returned_by_upstream: billsRaw.length, kept_after_relevance: bills.length },
    debates: { returned_by_upstream: debatesRaw.length, kept_after_relevance: debates.length },
    divisions: { returned_by_upstream: divisionsRaw.length, kept_after_relevance: divisionsRanked.length },
    written_questions: { returned_by_upstream: questionsRaw.length, kept_after_relevance: questions.length },
    petitions: { returned_by_upstream: petitionsRaw.length, kept_after_relevance: petitions.length },
  };

  const data = {
    topic,
    window: win,
    retrieval,
    ...(split.lookbackDays ? { window_inferred_from_topic: true } : {}),
    bills_in_progress: bills.map((b) => ({
      // Named to match what parliament_get_bill asks for. `id` is kept as well
      // because chaining the two tools is the common path and anything already
      // reading `id` should not break for a rename.
      bill_id: b.billId,
      id: b.billId,
      short_title: b.shortTitle,
      current_stage: b.currentStage?.description ?? null,
      ...(detailed ? { current_house: b.currentHouse, last_update: b.lastUpdate } : {}),
    })),
    recent_debates: debates.map((d) => ({
      title: d.Title,
      house: d.House,
      date: d.SittingDate,
      ...(detailed ? { debate_ext_id: d.DebateSectionExtId } : {}),
    })),
    related_votes: {
      // Named `related_votes`, not `recent_votes`: the upstream search is a
      // title substring match that is not date-windowed, and the previous engine
      // returned 2016 divisions inside a 90-day window without saying so.
      date_filtered: false,
      note: 'Division search is a title match, most-recent-first, and is not restricted to the window above.',
      in_window_count: divisionsInWindow.length,
      items: divisionsRanked.slice(0, 5).map((v) => ({
        division_id: v.DivisionId,
        title: v.Title,
        date: v.Date,
        ayes: v.AyeCount,
        noes: v.NoCount,
        in_window: withinWindow(v.Date, win),
        ...(detailed ? { number: v.Number } : {}),
      })),
    },
    recent_written_questions: questions.map((q) => ({
      house: q.house,
      date_tabled: q.dateTabled,
      question: truncate(q.questionText, detailed ? 400 : 200),
      answered: q.dateAnswered != null,
      ...(detailed ? { uin: q.uin, asking_member_id: q.askingMemberId } : {}),
    })),
    active_petitions: petitions.map((p) => ({
      id: p.id,
      action: p.attributes.action,
      signature_count: p.attributes.signature_count,
      ...(detailed ? { state: p.attributes.state, created_at: p.attributes.created_at } : {}),
    })),
  };

  const sources = [
    ...collectSources(bills, (b) => Citations.bill(b.billId, b.shortTitle), 2),
    ...collectSources(
      debates,
      (d) => Citations.hansardDebate(d.House, d.SittingDate, d.DebateSectionExtId, d.Title),
      2,
    ),
    ...collectSources(divisionsRanked, (v) => Citations.division('Commons', v.DivisionId, v.Title), 2),
    ...collectSources(questions, (q) => Citations.writtenQuestion(q.uin, q.house), 2),
    ...collectSources(petitions, (p) => Citations.petition(p.id, p.attributes.action), 2),
  ];

  return buildEnvelope(data, sources, {
    requestId: ctx.requestId,
    statuses: fan.statuses,
    partial: fan.partial,
    warnings: fan.warnings,
  });
}

export const topicTrackerTool: ToolDefinition<typeof TopicTrackerInput> = {
  name: 'parliament_topic_tracker',
  title: 'Track a policy topic across Parliament',
  description: [
    'A cross-Parliament round-up on one policy topic: bills in progress, recent Hansard debates, related Commons divisions, recent written questions, and active petitions.',
    '',
    'Good for: "what is Parliament doing about NHS waiting lists?", "track renters reform", "AI policy activity this year".',
    '',
    "Wrong for: one member's voting record (use parliament_member_voting_history); the text of a single debate (use parliament_get_debate).",
    '',
    'IMPORTANT — reading the result: every section has an entry in `meta.sources_status`. An empty section is evidence of absence ONLY when its status is "ok". For any other status (timeout, upstream_error, circuit_open, unavailable) the section is UNKNOWN — say it could not be retrieved, and never state that Parliament has done nothing on the topic.',
    '',
    '`retrieval` reports, per section, how many items the upstream returned and how many survived relevance filtering. Parliament\'s own search is weak, so `returned_by_upstream > 0` with `kept_after_relevance: 0` means results came back but none were about this topic — say that, rather than that Parliament has done nothing.',
    '',
    '`related_votes.date_filtered` is false: division search is a title match that upstream does not window by date. Each item carries `in_window` so you can say which fall inside the requested period.',
  ].join('\n'),
  inputSchema: TopicTrackerInput,
  annotations: READ_ONLY,
  handler: topicTracker,
};
