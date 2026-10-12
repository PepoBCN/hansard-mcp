import { z } from 'zod';
import { getMemberVoting, type MemberVoteRecord } from '../clients/commonsVotes.js';
import { getLordsMemberVoting, type LordsMemberVote } from '../clients/lordsVotes.js';
import { Citations, collectSources } from '../domain/citations.js';
import { resolveWindow, withinWindow } from '../domain/dates.js';
import { withSources, page, fromDateField, toDateField, SERVER_SIDE_DATE_NOTE, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const MemberVotingHistoryInput = z.object({
  member_id: z.coerce.number().int().min(1),
  house: z.enum(['Commons', 'Lords']).default('Commons'),
  topic: z
    .string()
    .min(2)
    .optional()
    .describe('Keep only divisions whose title matches this topic, e.g. "climate". Matched by the votes API itself.'),
  from_date: fromDateField,
  to_date: toDateField,
  limit: z.coerce.number().int().min(1).max(50).default(25).catch(25),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
});

export async function memberVotingHistory(
  input: z.infer<typeof MemberVotingHistoryInput>,
  ctx: { requestId: string },
) {
  const isLords = input.house === 'Lords';
  // Neither votes API takes a date range on member voting, so the window is
  // resolved here and applied to what came back. Rejecting a reversed range
  // happens before the call, not after an empty answer.
  const resolved = resolveWindow({ fromDate: input.from_date, toDate: input.to_date });
  return withSources(
    {
      tool: 'parliament_member_voting_history',
      requestId: ctx.requestId,
      sources: isLords
        ? {
            lordsVotes: (s) =>
              getLordsMemberVoting({
                memberId: input.member_id,
                ...(input.topic !== undefined ? { searchTerm: input.topic } : {}),
                skip: input.offset,
                take: input.limit,
                signal: s,
              }),
          }
        : {
            commonsVotes: (s) =>
              getMemberVoting({
                memberId: input.member_id,
                ...(input.topic !== undefined ? { searchTerm: input.topic } : {}),
                skip: input.offset,
                take: input.limit,
                signal: s,
              }),
          },
    },
    (get) => {
      const commons = isLords ? [] : get<MemberVoteRecord[]>('commonsVotes') ?? [];
      const lords = isLords ? get<LordsMemberVote[]>('lordsVotes') ?? [] : [];

      const all = isLords
        ? lords.map((v) => ({
            division_id: v.divisionId,
            title: v.title,
            date: v.date,
            voted: v.memberVotedContent === undefined ? null : v.memberVotedContent ? 'Content' : 'Not content',
            was_teller: (v.memberWasTeller ?? null) as boolean | null,
          }))
        : commons.map((v) => ({
            division_id: v.PublishedDivision.DivisionId,
            title: v.PublishedDivision.Title,
            date: v.PublishedDivision.Date,
            voted: v.MemberVotedAye === undefined ? null : v.MemberVotedAye ? 'Aye' : 'No',
            was_teller: v.MemberWasTeller ?? null,
          }));

      // The votes API matches `topic` against the division title itself, so the
      // filter is genuinely upstream. It is re-checked here on the same
      // principle the written-questions relevance layer exists for: an upstream
      // parameter that quietly goes inert must not be able to present an
      // unfiltered record as a filtered one. A row whose title never arrived
      // cannot be checked either way, so it is kept and counted rather than
      // dropped as if it had failed the match.
      const term = input.topic?.trim().toLowerCase();
      const unverifiable = term ? all.filter((v) => !v.title).length : 0;
      const onTopic = term ? all.filter((v) => !v.title || v.title.toLowerCase().includes(term)) : all;
      const votes = resolved ? onTopic.filter((v) => withinWindow(v.date, resolved.window)) : onTopic;

      return {
        data: {
          member_id: input.member_id,
          house: input.house,
          topic: input.topic ?? null,
          topic_filtered: term !== undefined,
          topic_filter_applied: term ? 'upstream' : 'none',
          date_filtered: resolved !== null,
          date_filter_applied: resolved ? 'server_side' : 'none',
          window: resolved?.window ?? null,
          ...(resolved ? { date_filter_note: SERVER_SIDE_DATE_NOTE } : {}),
          ...(resolved || term
            ? {
                retrieval: {
                  returned_by_upstream: all.length,
                  ...(term ? { kept_after_topic_check: onTopic.length, titles_unverifiable: unverifiable } : {}),
                  ...(resolved ? { kept_after_date_filter: votes.length } : {}),
                },
              }
            : {}),
          votes,
          // Paging follows the upstream page, not the filtered list, so
          // `next_offset` still walks the record rather than stalling on a page
          // where nothing fell inside the window.
          ...page(input.offset, input.limit, all.length, input.offset + all.length + (all.length === input.limit ? 1 : 0)),
        },
        citations: collectSources(
          votes,
          (v) => Citations.division(input.house, v.division_id, v.title),
          5,
        ),
      };
    },
  );
}

export const memberVotingHistoryTool: ToolDefinition<typeof MemberVotingHistoryInput> = {
  name: 'parliament_member_voting_history',
  title: 'How a member voted',
  description: [
    'A member\'s division-by-division voting record, most recent first, with how they voted and a division_id for chaining to parliament_get_division.',
    '',
    'Upstream does not report a total, so `total` is an estimate that only tells you whether another page exists — use `has_more`, not the number.',
    '',
    '`topic` narrows the record to divisions whose title matches, in both Houses. The votes API does the match itself, so `topic_filter_applied` is "upstream" and the whole record is searched, not just one page; `retrieval.kept_after_topic_check` reports the re-check done here.',
    '',
    '`from_date` and `to_date` (YYYY-MM-DD) restrict the record to a period, but the votes API takes no date range, so the filter is applied here to the page it returned: `date_filter_applied` is "server_side" and `date_filter_note` says what that does not cover. `total`, `has_more` and `next_offset` still describe the unfiltered record, so paging works.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: MemberVotingHistoryInput,
  annotations: READ_ONLY,
  handler: memberVotingHistory,
};
