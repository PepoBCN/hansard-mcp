import { z } from 'zod';
import { getMember, getSynopsis, getFocus, getContact, getContributionSummary, getBiography, type MemberDetail, type Biography, type Post } from '../clients/members.js';
import { getMemberVoting, type MemberVoteRecord } from '../clients/commonsVotes.js';
import { getLordsMemberVoting, type LordsMemberVote } from '../clients/lordsVotes.js';
import { Citations, collectSources } from '../domain/citations.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const MemberOverviewInput = z.object({
  member_id: z.coerce.number().int().min(1).describe('Member id from parliament_find_member.'),
  recent_votes_limit: z.coerce
    .number()
    .int()
    .min(0)
    .max(50)
    .default(0)
    .catch(0)
    .describe('How many of the member\'s most recent divisions to include. 0 (the default) fetches none, so the profile costs nothing extra.'),
});

export async function memberOverview(
  input: z.infer<typeof MemberOverviewInput>,
  ctx: { requestId: string },
) {
  const id = input.member_id;
  const wantVotes = input.recent_votes_limit > 0;
  return withSources(
    {
      tool: 'parliament_member_overview',
      requestId: ctx.requestId,
      sources: {
        // Each facet is a separate source so one slow endpoint degrades one
        // section of the profile rather than the whole card.
        member: (s) => getMember({ memberId: id, signal: s }),
        synopsis: (s) => getSynopsis({ memberId: id, signal: s }),
        focus: (s) => getFocus({ memberId: id, signal: s }),
        contact: (s) => getContact({ memberId: id, signal: s }),
        contributions: (s) => getContributionSummary({ memberId: id, signal: s }),
        // Government posts, opposition posts and committee memberships all come
        // from one biography call — there is no per-type endpoint.
        biography: (s) => getBiography({ memberId: id, signal: s }),
        // Which chamber the member sits in is only known once `member` returns,
        // and the fan-out is parallel, so both vote records are asked for and
        // the right one is chosen below. Only when votes were actually asked
        // for: an overview that did not request them costs no extra calls.
        ...(wantVotes
          ? {
              commonsVotes: (s) =>
                getMemberVoting({ memberId: id, take: input.recent_votes_limit, signal: s }),
              lordsVotes: (s) =>
                getLordsMemberVoting({ memberId: id, take: input.recent_votes_limit, signal: s }),
            }
          : {}),
      },
    },
    (get) => {
      const m = get<MemberDetail>('member');
      const contact = get<Array<{ type?: string; line1?: string; email?: string; phone?: string }>>('contact') ?? [];
      const bio = get<Biography>('biography');
      const posts = (rows: Post[] | undefined) =>
        (rows ?? []).map((p) => ({
          name: p.name ?? null,
          department: p.additionalInfo ?? null,
          start_date: p.startDate ?? null,
          end_date: p.endDate ?? null,
          is_current: !p.endDate,
        }));

      const isLords = m?.latestHouseMembership?.house === 2;
      const commonsVotes = (get<MemberVoteRecord[]>('commonsVotes') ?? []).map((v) => ({
        division_id: v.PublishedDivision.DivisionId,
        title: v.PublishedDivision.Title,
        date: v.PublishedDivision.Date,
        voted: v.MemberVotedAye === undefined ? null : v.MemberVotedAye ? 'Aye' : 'No',
      }));
      const lordsVotes = (get<LordsMemberVote[]>('lordsVotes') ?? []).map((v) => ({
        division_id: v.divisionId,
        title: v.title,
        date: v.date,
        voted: v.memberVotedContent === undefined ? null : v.memberVotedContent ? 'Content' : 'Not content',
      }));
      // Normally the member record settles which chamber to read. If that
      // lookup itself degraded, fall back to whichever record came back rather
      // than guessing Commons and reporting a peer as having never voted.
      const votesHouse = m ? (isLords ? 'Lords' : 'Commons') : lordsVotes.length > 0 && commonsVotes.length === 0 ? 'Lords' : 'Commons';
      const recentVotes = votesHouse === 'Lords' ? lordsVotes : commonsVotes;

      return {
        data: {
          member_id: id,
          found: m !== null,
          name: m?.nameDisplayAs ?? null,
          full_title: m?.nameFullTitle ?? null,
          party: m?.latestParty?.name ?? null,
          constituency: m?.latestHouseMembership?.membershipFrom ?? null,
          house: m?.latestHouseMembership?.house === 2 ? 'Lords' : 'Commons',
          is_active: m?.latestHouseMembership?.membershipStatus?.statusIsActive ?? null,
          member_since: m?.latestHouseMembership?.membershipStartDate ?? null,
          synopsis: (get<string>('synopsis') ?? '').replace(/<[^>]+>/g, '').trim() || null,
          policy_focus: (get<Array<{ category?: string; focus?: string[] }>>('focus') ?? []).map((f) => ({
            category: f.category ?? null,
            topics: f.focus ?? [],
          })),
          contact: contact.map((c) => ({
            type: c.type ?? null,
            address: c.line1 ?? null,
            email: c.email ?? null,
            phone: c.phone ?? null,
          })),
          recent_contributions: get<Array<{ house?: string; recentContributionCount?: number }>>('contributions') ?? [],
          recent_votes_limit: input.recent_votes_limit,
          recent_votes_included: wantVotes,
          // The votes APIs take `take`, so the limit is the size of the page
          // asked for rather than a trim of a bigger one.
          recent_votes_limit_applied: wantVotes ? 'upstream' : 'none',
          recent_votes_source: wantVotes ? (votesHouse === 'Lords' ? 'lordsVotes' : 'commonsVotes') : null,
          // Null, not an empty list: nobody asked for these, so "none returned"
          // would read as "voted in nothing".
          recent_votes: wantVotes ? recentVotes : null,
          government_posts: posts(bio?.governmentPosts),
          opposition_posts: posts(bio?.oppositionPosts),
          other_posts: posts(bio?.otherPosts),
          committees: posts(bio?.committeeMemberships).map((c) => ({
            name: c.name,
            start_date: c.start_date,
            end_date: c.end_date,
            is_current: c.is_current,
          })),
        },
        citations: [
          ...(m ? [Citations.member(id, m.nameDisplayAs)] : []),
          ...collectSources(recentVotes, (v) => Citations.division(votesHouse, v.division_id, v.title), 5),
        ],
      };
    },
  );
}

export const memberOverviewTool: ToolDefinition<typeof MemberOverviewInput> = {
  name: 'parliament_member_overview',
  title: 'One-page profile of a member',
  description: [
    'Everything on one MP or Lord in a single call: party, constituency, tenure, synopsis, policy focus, contact details, ministerial and opposition posts, and committee memberships.',
    '',
    'Each facet is fetched independently, so `meta.sources_status` reports them separately — a missing `committees` section with a non-ok status means the biography lookup failed, not that the member sits on no committees.',
    '',
    '`recent_votes_limit` adds that many of the member\'s most recent divisions. It is the page size asked of the votes API, so `recent_votes_limit_applied` reads "upstream". At the default of 0 no votes call is made and `recent_votes` is null rather than an empty list, which would read as "voted in nothing". `recent_votes_source` names the chamber record used, and its status is in `meta.sources_status` like any other.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: MemberOverviewInput,
  annotations: READ_ONLY,
  handler: memberOverview,
};
