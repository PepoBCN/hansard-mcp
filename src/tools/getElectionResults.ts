import { z } from 'zod';
import { getElectionResults as fetchResults, getLatestElectionResult, type ElectionResult } from '../clients/members.js';
import { Citations } from '../domain/citations.js';
import { withSources, STATUS_NOTE } from './helpers.js';
import { READ_ONLY, type ToolDefinition } from './registry.js';

export const GetElectionResultsInput = z.object({
  constituency_id: z.coerce.number().int().min(1).describe('From parliament_find_constituency.'),
  // Left optional rather than defaulted so an explicit `latest_only: false` can
  // be told apart from an absent one, which is what makes the conflict below
  // detectable instead of guessed at.
  latest_only: z.coerce
    .boolean()
    .optional()
    .catch(undefined)
    .describe('true returns only the most recent contest. Defaults to false, every recorded contest.'),
  include_history: z.coerce
    .boolean()
    .optional()
    .catch(undefined)
    .describe('The inverse of `latest_only`: true returns every recorded contest, false returns only the most recent. Given both, this one wins.'),
});

/**
 * `include_history` and `latest_only` ask the same question from opposite ends,
 * so a caller can send a pair that contradicts itself. `include_history` wins,
 * because it is the more specific of the two and the one a legacy caller had to
 * type deliberately; the response says that happened rather than quietly
 * picking one.
 */
const SCOPE_CONFLICT_NOTE =
  '`include_history` and `latest_only` were both given and they disagree. `include_history` takes precedence; `scope` states which set was actually returned.';

const shape = (r: ElectionResult) => {
  const candidates = (r.candidates ?? [])
    .slice()
    .sort((a, b) => (a.rankOrder ?? 99) - (b.rankOrder ?? 99));
  const cast = candidates.reduce((n, c) => n + (c.votes ?? 0), 0);
  return {
    election: r.electionTitle ?? null,
    date: r.electionDate ?? null,
    result: r.result ?? null,
    majority: r.majority ?? null,
    electorate: r.electorate ?? null,
    votes_cast: cast || null,
    turnout_pct:
      r.turnout && r.electorate ? Math.round((r.turnout / r.electorate) * 1000) / 10 : null,
    candidates: candidates.map((c) => ({
      name: c.name ?? null,
      party: c.party?.name ?? null,
      votes: c.votes ?? null,
      vote_share_pct: cast > 0 && c.votes ? Math.round((c.votes / cast) * 1000) / 10 : null,
      change: c.resultChange ?? null,
    })),
  };
};

export async function getElectionResults(
  input: z.infer<typeof GetElectionResultsInput>,
  ctx: { requestId: string },
) {
  const latestOnly =
    input.include_history !== undefined ? !input.include_history : input.latest_only === true;
  const conflicting =
    input.include_history !== undefined &&
    input.latest_only !== undefined &&
    input.include_history === input.latest_only;

  return withSources(
    {
      tool: 'parliament_get_election_results',
      requestId: ctx.requestId,
      sources: latestOnly
        ? { members: (s) => getLatestElectionResult({ constituencyId: input.constituency_id, signal: s }) }
        : { members: (s) => fetchResults({ constituencyId: input.constituency_id, signal: s }) },
    },
    (get) => {
      const raw = get<ElectionResult[] | ElectionResult>('members');
      const list = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      return {
        data: {
          constituency_id: input.constituency_id,
          scope: latestOnly ? 'latest_only' : 'all_recorded',
          scope_from:
            input.include_history !== undefined
              ? 'include_history'
              : input.latest_only !== undefined
                ? 'latest_only'
                : 'default',
          // Each scope is a different endpoint, so nothing is trimmed here.
          scope_applied: 'upstream',
          ...(conflicting ? { scope_conflict_note: SCOPE_CONFLICT_NOTE } : {}),
          elections: list.map(shape),
        },
        citations: [
          {
            title: `Election results for constituency ${input.constituency_id}`,
            url: `https://members.parliament.uk/constituency/${input.constituency_id}/election-results`,
          },
        ],
      };
    },
  );
}

export const getElectionResultsTool: ToolDefinition<typeof GetElectionResultsInput> = {
  name: 'parliament_get_election_results',
  title: 'General election results for a constituency',
  description: [
    'Results for a constituency: every candidate, their votes and vote share, the majority, and turnout. Pass `latest_only` for just the most recent contest, or `include_history` for the same choice from the other end: true is every recorded contest, false is the latest only.',
    '',
    'The two are inverses, so a contradictory pair is possible: `include_history` wins, `scope` says which set came back, `scope_from` says which parameter decided it, and `scope_conflict_note` appears when they disagreed. Each scope is a separate endpoint, so `scope_applied` is always "upstream", nothing is filtered here.',
    '',
    'Vote shares are computed from votes actually cast, and turnout from the electorate, so they will not always match figures calculated on a different base.',
    '',
    STATUS_NOTE,
  ].join('\n'),
  inputSchema: GetElectionResultsInput,
  annotations: READ_ONLY,
  handler: getElectionResults,
};
