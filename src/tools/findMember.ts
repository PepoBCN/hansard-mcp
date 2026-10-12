import { z } from 'zod';
import { searchMembers, searchConstituencies, type MemberValue } from '../clients/members.js';
import { lookupPostcode, looksLikePostcode } from '../clients/postcodes.js';
import { fanOut, valueOf } from '../core/budget.js';
import { buildEnvelope } from '../envelope.js';
import { Citations, collectSources } from '../domain/citations.js';
import { callLogger } from '../core/logger.js';
import { EngineError } from '../core/errors.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const FindMemberInput = z.object({
  query: z
    .string()
    .min(2)
    .describe('An MP or Lord\'s name (e.g. "Diane Abbott"), or a UK postcode (e.g. "SW1A 0AA") to find the sitting MP.'),
  house: z
    .enum(['Commons', 'Lords', 'both'])
    .optional()
    .describe('Restrict to one chamber. Omitted, or "both", searches both.'),
  current_only: z.coerce
    .boolean()
    .default(true)
    .catch(true)
    .describe('true (the default) returns only sitting members. false widens the search to former members as well.'),
  limit: z.coerce.number().int().min(1).max(50).default(10).catch(10),
  offset: z.coerce.number().int().min(0).default(0).catch(0),
});

export type FindMemberInputType = z.infer<typeof FindMemberInput>;

/**
 * A postcode is answered through the constituency's current representation, so
 * the chamber and sitting-member questions are settled by the route itself
 * rather than by anything the caller asked for. Saying so beats returning an
 * empty list that looks like "no such member".
 */
const POSTCODE_HOUSE_NOTE =
  'A postcode resolves to a constituency and its sitting MP, so this route can only ever return a Commons member. The chamber filter was applied here, to that one member, not to a search.';

const POSTCODE_CURRENT_NOTE =
  '`current_only: false` cannot be honoured on a postcode: the constituency endpoint reports only current representation, so former MPs for the seat were never fetched. Search by name to include them.';

/**
 * Said when the upstream returned rows outside the chamber it was asked for.
 * It has not been seen to do this, but if it ever does, the caller has to be
 * told that the page was trimmed here and that `total` still counts what the
 * upstream claimed.
 */
const HOUSE_MISMATCH_NOTE =
  'The upstream returned members outside the requested chamber despite being asked to filter. Those rows were removed here, so this is a trimmed page: `total` is the upstream count and may overstate how many members match.';

const shape = (m: MemberValue) => ({
  member_id: m.id,
  name: m.nameDisplayAs,
  full_title: m.nameFullTitle ?? null,
  party: m.latestParty?.name ?? null,
  constituency: m.latestHouseMembership?.membershipFrom ?? null,
  house: m.latestHouseMembership?.house === 2 ? 'Lords' : 'Commons',
  is_active: m.latestHouseMembership?.membershipStatus?.statusIsActive ?? null,
});

export async function findMember(input: FindMemberInputType, ctx: { requestId: string }) {
  const log = callLogger(ctx.requestId, 'parliament_find_member');
  const isPostcode = looksLikePostcode(input.query);
  // "both" is the absence of a chamber filter, not a third chamber.
  const houseFilter = input.house === 'both' ? undefined : input.house;

  if (isPostcode) {
    // Neither filter can reach the upstream on this route, so both are reported
    // as what they actually are here: one applied locally to a single member,
    // one that could not be applied at all.
    const postcodeFilters = {
      house_filter: input.house ?? 'both',
      house_filter_applied: houseFilter ? 'server_side' : 'none',
      ...(houseFilter ? { house_filter_note: POSTCODE_HOUSE_NOTE } : {}),
      current_only: input.current_only,
      current_only_applied: input.current_only ? 'implied_by_route' : 'not_applicable',
      ...(input.current_only ? {} : { current_only_note: POSTCODE_CURRENT_NOTE }),
    };

    // Postcode → constituency → sitting member. The postcode hop must succeed;
    // without it there is nothing to look up, so it is reported as an error
    // rather than quietly returning zero members.
    const fan = await fanOut(
      [{ key: 'postcodes', run: (signal) => lookupPostcode({ postcode: input.query, signal }) }],
      { log, tool: 'parliament_find_member' },
    );
    const pc = valueOf<{ postcode: string; constituency: string | null }>(fan.results.postcodes);
    if (!pc) {
      throw new EngineError(
        'UPSTREAM_UNAVAILABLE',
        `Could not resolve postcode "${input.query}".`,
        'Retry, or search by member name instead.',
        { source: 'postcodes' },
      );
    }
    if (!pc.constituency) {
      return buildEnvelope(
        { query: input.query, resolved_from: 'postcode', constituency: null, members: [], total: 0, ...postcodeFilters },
        [],
        { requestId: ctx.requestId, statuses: fan.statuses, partial: fan.partial, warnings: fan.warnings },
      );
    }

    const inner = await fanOut(
      [
        {
          key: 'members',
          run: (signal) => searchConstituencies({ searchText: pc.constituency!, take: 1, signal }),
        },
      ],
      { log, tool: 'parliament_find_member' },
    );
    const consts = valueOf<Awaited<ReturnType<typeof searchConstituencies>>['value']>(inner.results.members) ?? [];
    const found = consts[0]?.currentRepresentation?.member?.value;
    const sitting = found && houseFilter && shape(found).house !== houseFilter ? undefined : found;
    const statuses = { ...fan.statuses, ...inner.statuses };

    return buildEnvelope(
      {
        query: input.query,
        resolved_from: 'postcode',
        constituency: pc.constituency,
        members: sitting ? [shape(sitting)] : [],
        total: sitting ? 1 : 0,
        ...postcodeFilters,
        ...(houseFilter
          ? { retrieval: { returned_by_upstream: found ? 1 : 0, kept_after_house_filter: sitting ? 1 : 0 } }
          : {}),
      },
      sitting ? [Citations.member(sitting.id, sitting.nameDisplayAs)] : [],
      {
        requestId: ctx.requestId,
        statuses,
        partial: fan.partial || inner.partial,
        warnings: [...fan.warnings, ...inner.warnings],
      },
    );
  }

  const fan = await fanOut(
    [
      {
        key: 'members',
        run: (signal) =>
          searchMembers({
            name: input.query,
            ...(houseFilter ? { house: houseFilter } : {}),
            currentOnly: input.current_only,
            skip: input.offset,
            take: input.limit,
            signal,
          }),
      },
    ],
    { log, tool: 'parliament_find_member' },
  );

  const found = valueOf<{ items: MemberValue[]; total: number }>(fan.results.members);
  const returned = found?.items ?? [];
  const total = found?.total ?? 0;
  // The upstream does the chamber filtering, so this only ever removes rows if
  // it stops doing so. Checking costs nothing and the alternative is trusting a
  // filter we cannot see, which is how a parameter comes to be silently ignored.
  const items = houseFilter ? returned.filter((m) => shape(m).house === houseFilter) : returned;
  const trimmed = returned.length - items.length;

  return buildEnvelope(
    {
      query: input.query,
      resolved_from: 'name',
      house_filter: input.house ?? 'both',
      house_filter_applied: houseFilter ? 'upstream' : 'none',
      ...(trimmed > 0 ? { house_filter_note: HOUSE_MISMATCH_NOTE } : {}),
      current_only: input.current_only,
      // The search flag is the only reliable answer here: former members come
      // back with an active-looking latest membership, so there is nothing to
      // re-check locally and no honest way to claim a local filter.
      current_only_applied: 'upstream',
      ...(houseFilter
        ? { retrieval: { returned_by_upstream: returned.length, kept_after_house_filter: items.length } }
        : {}),
      members: items.map(shape),
      total,
      offset: input.offset,
      limit: input.limit,
      has_more: input.offset + returned.length < total,
      next_offset: input.offset + returned.length < total ? input.offset + returned.length : null,
    },
    collectSources(items, (m) => Citations.member(m.id, m.nameDisplayAs), 5),
    { requestId: ctx.requestId, statuses: fan.statuses, partial: fan.partial, warnings: fan.warnings },
  );
}

export const findMemberTool: ToolDefinition<typeof FindMemberInput> = {
  name: 'parliament_find_member',
  title: 'Find an MP or Lord',
  description: [
    'Resolve a name or UK postcode to sitting members of the Commons or Lords, returning member_id for chaining to other tools.',
    '',
    'A postcode resolves to its constituency and that constituency\'s sitting MP. A name is matched against members.',
    '',
    '`house` ("Commons", "Lords" or "both") and `current_only` are both applied by the search upstream on a name query, so `total` and paging describe the filtered record: `house_filter_applied` and `current_only_applied` read "upstream". `current_only` defaults to true; set it to false to include former members.',
    '',
    'On a postcode neither reaches the upstream. The route resolves the constituency\'s current representation, so `house` is applied here to the one member found (`house_filter_applied` is "server_side") and `current_only: false` cannot be honoured at all: `current_only_applied` reads "not_applicable" and `current_only_note` says why. Search by name to include former members.',
    '',
    'IMPORTANT: an empty `members` list means "none found" ONLY when `meta.sources_status` reports "ok" for every source. Any other status means the lookup could not be completed — say so rather than reporting that no such member exists.',
  ].join('\n'),
  inputSchema: FindMemberInput,
  annotations: READ_ONLY,
  handler: findMember,
};
