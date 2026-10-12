import { z } from 'zod';
import {
  searchHansardDebates,
  searchHansardContributions,
  type ContributionResult,
  type DebateResult,
} from '../clients/hansard.js';
import { fanOut, valueOf } from '../core/budget.js';
import { buildEnvelope } from '../envelope.js';
import { Citations, collectSources } from '../domain/citations.js';
import { resolveWindow, splitTopicAndWindow, type ResolvedWindow } from '../domain/dates.js';
import { rank } from '../domain/relevance.js';
import { callLogger } from '../core/logger.js';
import { fromDateField, toDateField } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const SearchHansardInput = z.object({
  query: z.string().min(2).describe('What was said in the chamber, as a short phrase. A trailing date phrase is understood.'),
  house: z.enum(['Commons', 'Lords', 'both']).default('both'),
  member_id: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Restrict to contributions by this member. Searches the spoken-contribution index rather than debate titles.'),
  section: z
    .string()
    .min(2)
    .optional()
    .describe('Hansard section, e.g. "Commons Chamber", "Westminster Hall", "Grand Committee", "Written Statements". Matched here, not upstream.'),
  from_date: fromDateField,
  to_date: toDateField,
  lookback_days: z.coerce.number().int().min(1).max(3650).default(365).catch(365),
  limit: z.coerce.number().int().min(1).max(50).default(10).catch(10),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
});

export type SearchHansardInputType = z.infer<typeof SearchHansardInput>;

/**
 * Neither Hansard search endpoint accepts a section, so a requested one is
 * matched against the page that came back. Said in the response because "no
 * Westminster Hall debates" and "none on this page of results" are different
 * claims, and only one of them is true here.
 */
const SECTION_NOTE =
  'Hansard\'s search does not accept a section, so `section` was matched here, against the page the upstream returned. `sections_in_page` lists every section that page actually contained. Treat this as a filtered page, not an exhaustive search of that section, and page further with `next_offset` to widen it.';

/**
 * The member-restricted search reads a different index from the debate search,
 * and that index holds spoken contributions only. Saying so stops "this member
 * never mentioned it" being read off a search that could not have found a
 * written statement or a written answer in the first place.
 */
const MEMBER_NOTE =
  'Restricted upstream to this member, using Hansard\'s spoken-contribution index. The debate-title search ignores a member id (measured), so it cannot be used for this. Written contributions - written statements and written answers - are a separate index and are NOT covered by this search.';

interface Entry {
  title: string;
  house: string;
  date: string;
  debate_ext_id: string;
  section: string | null;
  member_id?: number | null;
  member_name?: string | null;
  contribution_ext_id?: string | null;
  contribution?: string | null;
}

const fromDebate = (d: DebateResult): Entry => ({
  title: d.Title,
  house: d.House,
  date: d.SittingDate,
  debate_ext_id: d.DebateSectionExtId,
  // In the debate index `DebateSection` carries the section, not the title.
  section: d.DebateSection ?? null,
});

const fromContribution = (c: ContributionResult): Entry => ({
  title: c.DebateSection ?? '',
  house: c.House ?? '',
  date: c.SittingDate ?? '',
  debate_ext_id: c.DebateSectionExtId ?? '',
  section: c.Section ?? null,
  member_id: c.MemberId ?? null,
  member_name: c.MemberName ?? null,
  contribution_ext_id: c.ContributionExtId ?? null,
  contribution: c.ContributionText ?? null,
});

const matchesSection = (entry: Entry, section: string): boolean =>
  (entry.section ?? '').toLowerCase().includes(section.trim().toLowerCase());

export async function searchHansard(input: SearchHansardInputType, ctx: { requestId: string }) {
  const log = callLogger(ctx.requestId, 'parliament_search_hansard');
  const split = splitTopicAndWindow(input.query);
  const query = split.topic;
  // `lookback_days` is defaulted, so this always resolves to a window.
  const resolved = resolveWindow({
    fromDate: input.from_date,
    toDate: input.to_date,
    lookbackDays: input.lookback_days,
    ...(split.lookbackDays !== undefined ? { inferredLookbackDays: split.lookbackDays } : {}),
  }) as ResolvedWindow;
  const win = resolved.window;
  const memberId = input.member_id;
  const byMember = memberId !== undefined;

  const fan = await fanOut(
    [
      {
        key: 'debates',
        run: (signal) =>
          byMember
            ? searchHansardContributions({
                searchTerm: query,
                memberId,
                startDate: win.from,
                endDate: win.to,
                ...(input.house !== 'both' ? { house: input.house } : {}),
                skip: input.offset,
                take: input.limit,
                signal,
              })
            : searchHansardDebates({
                searchTerm: query,
                startDate: win.from,
                endDate: win.to,
                ...(input.house !== 'both' ? { house: input.house } : {}),
                skip: input.offset,
                take: input.limit,
                signal,
              }),
      },
    ],
    { log, tool: 'parliament_search_hansard' },
  );

  const found = valueOf<{ results: DebateResult[] | ContributionResult[]; total: number }>(fan.results.debates);
  const raw = found?.results ?? [];
  const total = found?.total ?? 0;

  let entries: Entry[] = byMember
    ? (raw as ContributionResult[]).map(fromContribution)
    : (raw as DebateResult[]).map(fromDebate);
  const returnedByUpstream = entries.length;

  // The upstream filter is trusted but re-checked, on the same principle that
  // keeps the written-questions relevance layer in place: a parameter that goes
  // inert must not be able to pass unrestricted rows off as restricted ones.
  if (byMember) entries = entries.filter((e) => e.member_id === null || e.member_id === memberId);
  const keptAfterMember = entries.length;

  const sectionsInPage = [...new Set(entries.map((e) => e.section).filter((s): s is string => Boolean(s)))];
  if (input.section) entries = entries.filter((e) => matchesSection(e, input.section!));
  const keptAfterSection = entries.length;

  // Upstream relevance is usually adequate, and ranking only reorders, so a
  // ranking that matches nothing falls back to the order as given. The member
  // index is already ranked against the search term, so it is left alone.
  const ranked = byMember ? entries : rank(query, entries, (e) => ({ title: e.title })).map((s) => s.item);
  const items = ranked.length > 0 ? ranked : entries;

  return buildEnvelope(
    {
      query,
      window: win,
      window_source: resolved.source,
      // Hansard's search endpoint takes startDate and endDate, so the window is
      // part of the query rather than something trimmed off the answer.
      date_filtered: true,
      date_filter_applied: 'upstream',
      ...(resolved.source === 'query_phrase' ? { window_inferred_from_query: true } : {}),
      house: input.house,
      member_id: memberId ?? null,
      member_filter_applied: byMember ? 'upstream' : 'none',
      ...(byMember ? { member_filter_note: MEMBER_NOTE, search_scope: 'member_spoken_contributions' } : { search_scope: 'debate_titles' }),
      section: input.section ?? null,
      section_filter_applied: input.section ? 'server_side' : 'none',
      ...(input.section ? { section_filter_note: SECTION_NOTE } : {}),
      sections_in_page: sectionsInPage,
      retrieval: {
        returned_by_upstream: returnedByUpstream,
        ...(byMember ? { kept_after_member_check: keptAfterMember } : {}),
        ...(input.section ? { kept_after_section_filter: keptAfterSection } : {}),
      },
      debates: items.map((e) => ({
        title: e.title,
        house: e.house,
        date: e.date,
        debate_ext_id: e.debate_ext_id,
        section: e.section,
        ...(byMember
          ? {
              member_id: e.member_id ?? null,
              member_name: e.member_name ?? null,
              contribution_ext_id: e.contribution_ext_id ?? null,
              contribution: e.contribution ?? null,
            }
          : {}),
      })),
      total,
      offset: input.offset,
      limit: input.limit,
      has_more: input.offset + items.length < total,
      next_offset: input.offset + items.length < total ? input.offset + items.length : null,
    },
    collectSources(items, (e) => Citations.hansardDebate(e.house, e.date, e.debate_ext_id, e.title), 5),
    { requestId: ctx.requestId, statuses: fan.statuses, partial: fan.partial, warnings: fan.warnings },
  );
}

export const searchHansardTool: ToolDefinition<typeof SearchHansardInput> = {
  name: 'parliament_search_hansard',
  title: 'Search Hansard debates',
  description: [
    'Search the official record of what was said in the Commons and Lords chambers, returning debate titles, dates and debate_ext_id for chaining.',
    '',
    'Wrong for: bills, votes or written questions — use parliament_topic_tracker for a cross-Parliament view.',
    '',
    'For a specific period give `from_date` and `to_date` as YYYY-MM-DD; they beat `lookback_days`, and either may be omitted to leave that end open. The upstream filters by date itself, so `date_filtered` is true and `window_source` says which input set the window.',
    '',
    '`member_id` restricts to one member. It switches the search to Hansard\'s spoken-contribution index, which honours a member id where the debate-title search does not, so each result also carries the contribution text. Written statements and written answers are a separate index and are not searched; `member_filter_note` says so in the response.',
    '',
    '`section` narrows to a Hansard section such as "Commons Chamber" or "Westminster Hall". Neither endpoint accepts a section, so it is matched here, on the page returned: `section_filter_applied` is "server_side", `sections_in_page` lists what that page held, and an empty result is a filtered page rather than proof the section held nothing.',
    '',
    'IMPORTANT: an empty `debates` list means "nothing was said" ONLY when `meta.sources_status.debates.status` is "ok". Any other status means the search could not be completed.',
  ].join('\n'),
  inputSchema: SearchHansardInput,
  annotations: READ_ONLY,
  handler: searchHansard,
};
