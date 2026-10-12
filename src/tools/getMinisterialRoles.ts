import { z } from 'zod';
import {
  getBiography,
  getMember,
  getPosts,
  type Post,
  type PostHolding,
  type Biography,
  type MemberDetail,
} from '../clients/members.js';
import { Citations } from '../domain/citations.js';
import { withSources, page, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetMinisterialRolesInput = z.object({
  member_id: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Member id from parliament_find_member. Omit to list the whole front bench instead.'),
  include_historical: z.coerce.boolean().default(true).catch(true),
  branch: z
    .enum(['government', 'opposition'])
    .default('government')
    .describe('Which front bench to list. Only used when `member_id` is omitted.'),
  filter: z
    .string()
    .min(2)
    .optional()
    .describe('Substring match on post, department or holder, e.g. "Treasury". Only used when `member_id` is omitted.'),
  limit: z.coerce.number().int().min(1).max(200).default(50).catch(50),
});

const shape = (posts: Post[] | undefined) =>
  (posts ?? []).map((p) => ({
    name: p.name ?? null,
    department: p.additionalInfo ?? null,
    start_date: p.startDate ?? null,
    end_date: p.endDate ?? null,
    is_current: !p.endDate,
  }));

/**
 * Listing mode: no member, so the question is "who is in the government",
 * which is what the legacy 0.2.0 tool did and the rebuild had dropped.
 */
async function listBranch(
  input: z.infer<typeof GetMinisterialRolesInput>,
  ctx: { requestId: string },
) {
  const branch = input.branch;
  return withSources(
    {
      tool: 'parliament_get_ministerial_roles',
      requestId: ctx.requestId,
      sources: { posts: (s) => getPosts({ branch, signal: s }) },
    },
    (get) => {
      const all = get<PostHolding[]>('posts') ?? [];
      const current = input.include_historical ? all : all.filter((p) => p.is_current);
      const needle = input.filter?.trim().toLowerCase();
      const matched = needle
        ? current.filter((p) =>
            [p.post, p.department, p.holder].some((f) => f?.toLowerCase().includes(needle)),
          )
        : current;

      return {
        data: {
          mode: 'branch_listing' as const,
          branch,
          filter: input.filter ?? null,
          retrieval: { returned_by_upstream: all.length, kept_after_filter: matched.length },
          roles: matched.slice(0, input.limit),
          ...page(0, Math.min(matched.length, input.limit), matched.length, matched.length),
        },
        citations: [
          {
            title: branch === 'opposition' ? 'Official Opposition' : "His Majesty's Government",
            url: 'https://members.parliament.uk/Government',
          },
        ],
      };
    },
  );
}

export async function getMinisterialRoles(
  input: z.infer<typeof GetMinisterialRolesInput>,
  ctx: { requestId: string },
) {
  if (input.member_id === undefined) return listBranch(input, ctx);
  const id = input.member_id;
  return withSources(
    {
      tool: 'parliament_get_ministerial_roles',
      requestId: ctx.requestId,
      sources: {
        member: (s) => getMember({ memberId: id, signal: s }),
        biography: (s) => getBiography({ memberId: id, signal: s }),
      },
    },
    (get) => {
      const m = get<MemberDetail>('member');
      const bio = get<Biography>('biography');
      const gov = shape(bio?.governmentPosts);
      const opp = shape(bio?.oppositionPosts);
      const keep = (rows: ReturnType<typeof shape>) =>
        input.include_historical ? rows : rows.filter((r) => r.is_current);

      return {
        data: {
          mode: 'member' as const,
          member_id: id,
          name: m?.nameDisplayAs ?? null,
          party: m?.latestParty?.name ?? null,
          currently_in_government: gov.some((r) => r.is_current),
          currently_in_opposition_frontbench: opp.some((r) => r.is_current),
          government_posts: keep(gov),
          opposition_posts: keep(opp),
        },
        citations: m ? [Citations.member(id, m.nameDisplayAs)] : [],
      };
    },
  );
}

export const getMinisterialRolesTool: ToolDefinition<typeof GetMinisterialRolesInput> = {
  name: 'parliament_get_ministerial_roles',
  title: 'Government and opposition posts, for one member or across a front bench',
  description: [
    'Two modes, selected by whether `member_id` is given.',
    '',
    'With `member_id`: ministerial and opposition frontbench posts for that one member, current and historical, with departments and dates. An empty `government_posts` with an ok status means the member has held no ministerial office — a backbencher, which is the common case.',
    '',
    'Without `member_id`: every post on a front bench and who holds it, which is how to answer "who is in the cabinet". Use `branch` for government or opposition, and `filter` to narrow by post, department or holder. A post with a null `holder` is a genuine vacancy, not missing data.',
    '',
    '`data.mode` says which mode ran.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetMinisterialRolesInput,
  annotations: READ_ONLY,
  handler: getMinisterialRoles,
};
