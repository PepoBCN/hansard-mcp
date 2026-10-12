import { z } from 'zod';
import { getInterestCategories, searchInterests, type RegisteredInterest } from '../clients/interests.js';
import { Citations } from '../domain/citations.js';
import { resolveWindow, withinWindow } from '../domain/dates.js';
import { withSources, page, fromDateField, toDateField, SERVER_SIDE_DATE_NOTE, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const MemberInterestsInput = z.object({
  member_id: z.coerce.number().int().min(1),
  category_number: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict to one register category by its published number, e.g. "2" for donations or "1.1". Not the category id.'),
  from_date: fromDateField,
  to_date: toDateField,
  limit: z.coerce.number().int().min(1).max(100).default(50).catch(50),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
});

export async function memberInterests(
  input: z.infer<typeof MemberInterestsInput>,
  ctx: { requestId: string },
) {
  // The Interests API takes no date range, so a requested window is applied to
  // what it returns and labelled as a local filter.
  const resolved = resolveWindow({ fromDate: input.from_date, toDate: input.to_date });
  const wanted = input.category_number?.trim();

  // Filled in by the source below. The category lookup has to happen before the
  // register call, so it is chained inside the same source rather than run
  // alongside it: that way a category index that times out degrades this source
  // and is reported as a status, instead of silently returning the whole
  // register dressed up as one category.
  let category:
    | { applied: true; id: number; name: string }
    | { applied: false; reason: string; available: string[] }
    | null = null;

  return withSources(
    {
      tool: 'parliament_member_interests',
      requestId: ctx.requestId,
      sources: {
        interests: async (s) => {
          let categoryId: number | undefined;
          if (wanted !== undefined) {
            const cats = await getInterestCategories({ signal: s });
            const match = cats.value.find((c) => (c.number ?? '').trim() === wanted);
            const available = cats.value.map((c) => c.number ?? '').filter(Boolean);
            if (match) {
              category = { applied: true, id: match.id, name: match.name };
              categoryId = match.id;
            } else {
              category = {
                applied: false,
                reason: `The register has no category numbered "${wanted}".`,
                available,
              };
              // Returning the unfiltered register here would present every
              // category as if it were the one asked for, so nothing is
              // returned and the response says why.
              return { value: { items: [], total: 0 }, cacheState: cats.cacheState, ageSeconds: cats.ageSeconds };
            }
          }
          return searchInterests({
            memberId: input.member_id,
            ...(categoryId !== undefined ? { categoryId } : {}),
            skip: input.offset,
            take: input.limit,
            signal: s,
          });
        },
      },
    },
    (get) => {
      const found = get<{ items: RegisteredInterest[]; total: number }>('interests');
      const all = found?.items ?? [];

      // The register is filtered by category upstream, and the page it returns
      // is checked again here, so an upstream parameter that goes inert cannot
      // pass the whole register off as one category.
      const onCategory = wanted === undefined ? all : all.filter((i) => (i.category?.number ?? '').trim() === wanted);

      // Entries are dated by registration, falling back to publication. An entry
      // carrying neither cannot be placed in or out of the window, so it is
      // dropped and counted rather than assumed to belong.
      const dateOf = (i: RegisteredInterest) => i.registrationDate ?? i.publishedDate ?? null;
      const undated = resolved ? onCategory.filter((i) => dateOf(i) === null).length : 0;
      const items = resolved
        ? onCategory.filter((i) => withinWindow(dateOf(i), resolved.window))
        : onCategory;

      const byCategory: Record<string, number> = {};
      for (const i of items) {
        const c = i.category?.name ?? 'Uncategorised';
        byCategory[c] = (byCategory[c] ?? 0) + 1;
      }

      return {
        data: {
          member_id: input.member_id,
          // From the unfiltered page: the member is still the same person when a
          // date window happens to exclude every entry.
          member_name: all[0]?.member?.nameDisplayAs ?? null,
          category_number: input.category_number ?? null,
          category_filter_applied: category?.applied ? 'upstream' : wanted === undefined ? 'none' : 'not_applied',
          category_name: category?.applied ? category.name : null,
          ...(category && !category.applied
            ? {
                category_filter_note: `${category.reason} Nothing is returned, because returning the unfiltered register would present every category as if it were the one requested. This is NOT evidence that the member has no interests in that category. Known category numbers: ${category.available.join(', ')}.`,
              }
            : {}),
          date_filtered: resolved !== null,
          date_filter_applied: resolved ? 'server_side' : 'none',
          window: resolved?.window ?? null,
          ...(resolved ? { date_filter_note: SERVER_SIDE_DATE_NOTE } : {}),
          ...(resolved || wanted !== undefined
            ? {
                retrieval: {
                  returned_by_upstream: all.length,
                  ...(wanted !== undefined ? { kept_after_category_check: onCategory.length } : {}),
                  ...(resolved ? { kept_after_date_filter: items.length, excluded_undated: undated } : {}),
                },
              }
            : {}),
          categories: Object.entries(byCategory)
            .sort(([, a], [, b]) => b - a)
            .map(([category, count]) => ({ category, count })),
          interests: items.map((i) => ({
            id: i.id,
            category: i.category?.name ?? null,
            category_number: i.category?.number ?? null,
            summary: i.summary ?? null,
            registered: i.registrationDate ?? null,
            published: i.publishedDate ?? null,
            fields: (i.fields ?? [])
              .filter((f) => (f.values?.length ?? 0) > 0)
              .map((f) => ({ name: f.name ?? null, values: f.values ?? [] })),
          })),
          // Paging follows the upstream page so `next_offset` keeps walking the
          // register even when this page has nothing inside the window.
          ...page(input.offset, input.limit, all.length, found?.total ?? all.length),
        },
        citations: all[0]?.member
          ? [Citations.member(input.member_id, all[0].member.nameDisplayAs ?? 'Member')]
          : [],
      };
    },
  );
}

export const memberInterestsTool: ToolDefinition<typeof MemberInterestsInput> = {
  name: 'parliament_member_interests',
  title: 'A member\'s registered financial interests',
  description: [
    'The Register of Members\' Financial Interests for one member: donations, employment, shareholdings, gifts and visits, grouped by category.',
    '',
    'This is a declaration register, not an allegation of anything. Report entries as declared.',
    '',
    '`category_number` restricts to one category by its published number ("2" for donations, "1.1" for ad hoc payments), which the register API filters on itself once the number is resolved to its category id: `category_filter_applied` is then "upstream" and `category_name` names the category. A number the register does not have returns nothing with `category_filter_applied` "not_applied" and a note listing the numbers that exist — that empty result is not evidence of an empty category.',
    '',
    '`from_date` and `to_date` (YYYY-MM-DD) narrow the entries to a period by registration date, falling back to publication date. The Interests API takes no date range, so this is applied here to the page it returned: `date_filter_applied` is "server_side", `retrieval.excluded_undated` counts entries with neither date, and `date_filter_note` says what the filter does not cover.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: MemberInterestsInput,
  annotations: READ_ONLY,
  handler: memberInterests,
};
