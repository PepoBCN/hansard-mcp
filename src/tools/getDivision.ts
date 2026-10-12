import { z } from 'zod';
import { getCommonsDivision, type DivisionDetail } from '../clients/commonsVotes.js';
import { getLordsDivision, type LordsDivision } from '../clients/lordsVotes.js';
import { Citations } from '../domain/citations.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetDivisionInput = z.object({
  division_id: z.coerce.number().int().min(1).describe('Numeric DivisionId.'),
  house: z.enum(['Commons', 'Lords']).default('Commons'),
  include_rebellions: z
    .boolean()
    .optional()
    .default(false)
    .describe('Also identify members who voted against the majority of their own party in this division.'),
});

/** Commons capitalises the field, Lords does not. */
type RawVoter = { MemberId?: number; Name?: string; Party?: string; memberId?: number; name?: string; party?: string };

const tally = (voters: ReadonlyArray<RawVoter> | undefined) => {
  const out: Record<string, number> = {};
  for (const v of voters ?? []) {
    const party = v.Party ?? v.party ?? 'Unknown';
    out[party] = (out[party] ?? 0) + 1;
  }
  return Object.entries(out)
    .sort(([, a], [, b]) => b - a)
    .map(([party, count]) => ({ party, count }));
};

interface Voter {
  member_id: number | null;
  name: string | null;
  party: string | null;
}

const normaliseVoters = (voters: ReadonlyArray<RawVoter> | undefined): Voter[] =>
  (voters ?? []).map((v) => ({
    member_id: v.MemberId ?? v.memberId ?? null,
    name: v.Name ?? v.name ?? null,
    party: v.Party ?? v.party ?? null,
  }));

/**
 * "Rebellion" here means voting against the majority of one's own party in this
 * division, derived from the per-member party the vote lists carry. That is not
 * the same thing as defying the whip: neither votes API publishes a whip
 * direction, so the response says which of the two it is measuring rather than
 * letting the stronger reading be assumed.
 *
 * Returns null when it cannot be worked out at all. An empty rebel list would
 * read as "nobody rebelled", which is exactly the false absence this engine
 * exists to stop.
 */
/**
 * Groupings that are not parties and therefore have no line to rebel against.
 *
 * Found on a real division: two Independents voted Aye while five other
 * Independents voted No, and both were reported as having rebelled against "the
 * Independent majority". There is no such thing. Independents are independent of
 * each other, so treating the group as a party manufactures a rebellion out of
 * two unconnected members voting differently, and names real people as rebels
 * for it. Counting them is a false claim, which is the thing this engine exists
 * not to make.
 *
 * They are still reported in `party_majority_direction` so the arithmetic stays
 * visible; they are only excluded from `rebels`.
 */
const NOT_A_PARTY_LINE = new Set(['independent', 'crossbench', 'non-affiliated', 'no affiliation', 'lord speaker', 'bishops']);

const hasPartyLine = (party: string | null | undefined): boolean =>
  Boolean(party) && !NOT_A_PARTY_LINE.has(party!.trim().toLowerCase());

function computeRebellions(ayes: Voter[], noes: Voter[], labels: { aye: string; no: string }) {
  const withParty = [...ayes, ...noes].filter((v) => v.party);
  if (withParty.length === 0) return null;

  const counts = new Map<string, { ayes: number; noes: number }>();
  const bump = (party: string, side: 'ayes' | 'noes') => {
    const row = counts.get(party) ?? { ayes: 0, noes: 0 };
    row[side] += 1;
    counts.set(party, row);
  };
  for (const v of ayes) if (v.party) bump(v.party, 'ayes');
  for (const v of noes) if (v.party) bump(v.party, 'noes');

  const direction = new Map<string, string | null>();
  for (const [party, row] of counts) {
    direction.set(party, row.ayes === row.noes ? null : row.ayes > row.noes ? labels.aye : labels.no);
  }

  const rebels = [
    ...ayes.map((v) => ({ voter: v, voted: labels.aye })),
    ...noes.map((v) => ({ voter: v, voted: labels.no })),
  ]
    .filter(({ voter, voted }) => {
      if (!hasPartyLine(voter.party)) return false;
      const majority = voter.party ? direction.get(voter.party) : undefined;
      return Boolean(majority) && majority !== voted;
    })
    .map(({ voter, voted }) => ({
      member_id: voter.member_id,
      name: voter.name,
      party: voter.party,
      voted,
      party_majority: voter.party ? direction.get(voter.party) ?? null : null,
    }));

  return {
    computed: true,
    basis:
      'Voted against the majority of their own party in this division, derived from the party recorded against each voter. Neither votes API publishes a whip direction, so this is not a count of defied whips. Members with no party line to cross (Independent, Crossbench, non-affiliated) are never counted as rebels, though their votes still appear in party_majority_direction.',
    groupings_excluded_from_rebellions: [...counts.keys()].filter((p) => !hasPartyLine(p)),
    rebel_count: rebels.length,
    rebels,
    party_majority_direction: [...counts.entries()]
      .sort(([, a], [, b]) => b.ayes + b.noes - (a.ayes + a.noes))
      // `ayes`/`noes` rather than the chamber's own words, matching the counts
      // the rest of this response already reports under those names.
      .map(([party, row]) => ({
        party,
        ayes: row.ayes,
        noes: row.noes,
        majority_direction: direction.get(party) ?? null,
      })),
    parties_with_no_majority: [...direction.entries()].filter(([, d]) => d === null).map(([party]) => party),
    voters_without_a_party: [...ayes, ...noes].filter((v) => !v.party).length,
  };
}

export async function getDivision(input: z.infer<typeof GetDivisionInput>, ctx: { requestId: string }) {
  const isLords = input.house === 'Lords';
  return withSources(
    {
      tool: 'parliament_get_division',
      requestId: ctx.requestId,
      sources: isLords
        ? { lordsVotes: (s) => getLordsDivision({ divisionId: input.division_id, signal: s }) }
        : { commonsVotes: (s) => getCommonsDivision({ divisionId: input.division_id, signal: s }) },
    },
    (get) => {
      const c = isLords ? null : get<DivisionDetail>('commonsVotes');
      const l = isLords ? get<LordsDivision>('lordsVotes') : null;
      const found = Boolean(c ?? l);

      const ayes = c?.AyeCount ?? l?.contentCount ?? null;
      const noes = c?.NoCount ?? l?.notContentCount ?? null;

      const ayeVoters = normaliseVoters(c?.Ayes ?? l?.contents);
      const noVoters = normaliseVoters(c?.Noes ?? l?.notContents);
      const labels = isLords ? { aye: 'Content', no: 'Not content' } : { aye: 'Aye', no: 'No' };
      const rebellions = input.include_rebellions ? computeRebellions(ayeVoters, noVoters, labels) : null;
      // Only two things can defeat the calculation, and each is said out loud
      // rather than being served as a rebel list of length zero.
      const rebellionsNote = !input.include_rebellions
        ? null
        : rebellions
          ? null
          : found
            ? 'include_rebellions was requested, but this division carries no per-member party against its vote lists, so rebellions could not be worked out. This is NOT evidence that nobody voted against their party.'
            : 'include_rebellions was requested, but the division itself was not returned, so there were no votes to work from. Check meta.sources_status before reporting anything about this division.';

      return {
        data: {
          division_id: input.division_id,
          house: input.house,
          found,
          title: c?.Title ?? l?.title ?? null,
          date: c?.Date ?? l?.date ?? null,
          ayes,
          noes,
          result: ayes !== null && noes !== null ? (ayes > noes ? 'Ayes have it' : 'Noes have it') : null,
          majority: ayes !== null && noes !== null ? Math.abs(ayes - noes) : null,
          aye_breakdown_by_party: tally(c?.Ayes ?? l?.contents),
          no_breakdown_by_party: tally(c?.Noes ?? l?.notContents),
          tellers: {
            ayes: (c?.AyeTellers ?? []).map((t) => t.Name),
            noes: (c?.NoTellers ?? []).map((t) => t.Name),
          },
          include_rebellions: input.include_rebellions,
          rebellions,
          ...(rebellionsNote ? { rebellions_note: rebellionsNote } : {}),
        },
        citations: found
          ? [Citations.division(input.house, input.division_id, c?.Title ?? l?.title ?? 'Division')]
          : [],
      };
    },
  );
}

export const getDivisionTool: ToolDefinition<typeof GetDivisionInput> = {
  name: 'parliament_get_division',
  title: 'Get a division with party breakdown',
  description: [
    'One division in full: motion title, date, result, majority, and how each party voted on both sides.',
    '',
    'Chain here from parliament_topic_tracker (`related_votes[].division_id`) or parliament_member_voting_history.',
    '',
    '`include_rebellions` adds `rebellions`: every member who voted against the majority of their own party here, with that party\'s direction. It is derived from the party recorded against each voter, so it measures voting against one\'s own party, NOT defying the whip — no votes API publishes a whip direction. If the party cannot be read off the vote lists, `rebellions` is null and `rebellions_note` says why; it never returns an empty rebel list to mean "could not tell".',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetDivisionInput,
  annotations: READ_ONLY,
  handler: getDivision,
};
