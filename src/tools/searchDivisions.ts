import { z } from 'zod';
import { searchCommonsDivisions, type DivisionSummary } from '../clients/commonsVotes.js';
import { Citations, collectSources } from '../domain/citations.js';
import { resolveWindow, splitTopicAndWindow, withinWindow, type ResolvedWindow } from '../domain/dates.js';
import { rank } from '../domain/relevance.js';
import { withSources, page, fromDateField, toDateField, SERVER_SIDE_DATE_NOTE, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const SearchDivisionsInput = z.object({
  query: z.string().min(2).describe('Words expected in the division title, e.g. "climate change".'),
  from_date: fromDateField,
  to_date: toDateField,
  lookback_days: z.coerce.number().int().min(1).max(3650).default(365).catch(365),
  limit: z.coerce.number().int().min(1).max(50).default(20).catch(20),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
});

export async function searchDivisions(
  input: z.infer<typeof SearchDivisionsInput>,
  ctx: { requestId: string },
) {
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
  // An absolute range is a request to restrict the results; a lookback is only
  // the default horizon, and trimming to it would silently hide older matches
  // the caller never excluded. So only the explicit range filters.
  const restrict = resolved.source === 'from_date/to_date';

  return withSources(
    {
      tool: 'parliament_search_divisions',
      requestId: ctx.requestId,
      sources: {
        commonsVotes: (s) =>
          searchCommonsDivisions({ searchTerm: query, skip: input.offset, take: input.limit, signal: s }),
      },
    },
    (get) => {
      const raw = get<DivisionSummary[]>('commonsVotes') ?? [];
      const ranked = rank(query, raw, (d) => ({ title: d.Title })).map((r) => r.item);
      const inWindow = ranked.filter((d) => withinWindow(d.Date, win));
      const shown = restrict ? inWindow : ranked;

      return {
        data: {
          query,
          // Upstream matches a literal title substring and is most-recent-first;
          // it does not accept a date window. An explicit range is therefore
          // honoured here, on the page it returned, and labelled as such. Saying
          // which of the two happened beats implying the search was filtered.
          date_filtered: restrict,
          date_filter_applied: restrict ? 'server_side' : 'none',
          ...(restrict ? { date_filter_note: SERVER_SIDE_DATE_NOTE } : {}),
          window_for_reference: win,
          window_source: resolved.source,
          in_window_count: inWindow.length,
          retrieval: {
            returned_by_upstream: raw.length,
            kept_after_relevance: ranked.length,
            ...(restrict ? { kept_after_date_filter: inWindow.length } : {}),
          },
          divisions: shown.map((d) => ({
            division_id: d.DivisionId,
            title: d.Title,
            date: d.Date,
            ayes: d.AyeCount,
            noes: d.NoCount,
            in_window: withinWindow(d.Date, win),
          })),
          ...page(input.offset, input.limit, ranked.length, raw.length),
        },
        citations: collectSources(shown, (d) => Citations.division('Commons', d.DivisionId, d.Title), 5),
      };
    },
  );
}

export const searchDivisionsTool: ToolDefinition<typeof SearchDivisionsInput> = {
  name: 'parliament_search_divisions',
  title: 'Search Commons divisions',
  description: [
    'Find Commons divisions whose title matches a query, most recent first, each with a division_id for chaining to parliament_get_division.',
    '',
    'The upstream is a title substring match and does not accept a date window. Without `from_date`/`to_date`, `date_filtered` is false and every division carries `in_window` against `window_for_reference`, so you can state which fall inside a period without implying the search was filtered.',
    '',
    'Giving `from_date` and/or `to_date` as YYYY-MM-DD does restrict the results, but server-side, on the page the upstream returned: `date_filtered` is then true, `date_filter_applied` is "server_side", and `date_filter_note` says what that does not cover. It is a filtered page, not an exhaustive search of the period.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: SearchDivisionsInput,
  annotations: READ_ONLY,
  handler: searchDivisions,
};
