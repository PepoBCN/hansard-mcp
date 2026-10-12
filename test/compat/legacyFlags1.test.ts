/**
 * Three legacy parameters the 0.2.0 surface had and the rebuild dropped:
 * `find_member`'s chamber and `current_only`, `member_overview`'s
 * `recent_votes_limit`, and `get_election_results`' `include_history`.
 *
 * What these guard is not only that each one now does something, but that the
 * response says WHERE it was done. `find_member` filters at the search API and
 * says "upstream"; the same filter on a postcode can only be applied to the one
 * member the constituency route returns, and says "server_side"; `current_only`
 * cannot be applied at all on a postcode, and says so rather than returning a
 * shorter list. A parameter that quietly did nothing would be the same class of
 * bug as reporting a timeout as an absence, so every case ends by checking that
 * a degraded upstream still reads as unknown, never as an answer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { z } from 'zod';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { isReportableAbsence } from '../../src/envelope.js';
import { findMember, FindMemberInput } from '../../src/tools/findMember.js';
import { memberOverview, MemberOverviewInput } from '../../src/tools/memberOverview.js';
import { getElectionResults, GetElectionResultsInput } from '../../src/tools/getElectionResults.js';
import { tools } from '../../src/tools/index.js';

const ctx = { requestId: 'TEST' };

type Envelope<D> = { data: D; meta: { partial: boolean; sources_status: Record<string, { status: string }> } };

const call = async <D,>(
  handler: (input: never, c: typeof ctx) => Promise<unknown>,
  schema: { parse: (v: unknown) => unknown },
  args: Record<string, unknown>,
): Promise<Envelope<D>> => (await handler(schema.parse(args) as never, ctx)) as never as Envelope<D>;

const advertised = (name: string): string[] => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const shape = (tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape as unknown as Record<
    string,
    z.ZodTypeAny
  >;
  return Object.keys(shape);
};

const member = (id: number, name: string, house: 1 | 2) => ({
  value: {
    id,
    nameDisplayAs: name,
    nameFullTitle: name,
    latestParty: { name: 'Labour' },
    latestHouseMembership: {
      membershipFrom: house === 1 ? 'Somewhere North' : 'Life peer',
      house,
      membershipStatus: { statusIsActive: true },
    },
  },
});

/**
 * `member_overview` calls six different paths on the members API and each wants
 * a different body, so the shared MockUpstream (one body for every request)
 * cannot stand in for it. Same idea, keyed by path.
 */
class RoutedMock {
  private server: http.Server;
  private routes: Array<[string, unknown]> = [];
  private open = new Set<Socket>();
  public requests: string[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const url = req.url ?? '';
      this.requests.push(url);
      const hit = this.routes.find(([match]) => url.includes(match));
      const body = hit ? hit[1] : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    this.server.on('connection', (s) => {
      this.open.add(s);
      s.on('close', () => this.open.delete(s));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  route(match: string, body: unknown): void {
    this.routes.push([match, body]);
  }

  reset(): void {
    this.requests = [];
    this.routes = [];
  }

  async stop(): Promise<void> {
    for (const s of this.open) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const commonsVote = (id: number, title: string, date: string) => ({
  PublishedDivision: { DivisionId: id, Title: title, Date: date, AyeCount: 300, NoCount: 200 },
  MemberVotedAye: true,
  MemberWasTeller: false,
});

describe('find_member: chamber and current_only', () => {
  let members: MockUpstream;
  let postcodes: MockUpstream;

  beforeAll(async () => {
    members = new MockUpstream();
    postcodes = new MockUpstream();
    setUpstream('members', { base: await members.start(), timeoutMs: 1_000, ttlMs: 60_000 });
    setUpstream('postcodes', { base: await postcodes.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });

  afterAll(async () => {
    await members.stop();
    await postcodes.stop();
    resetUpstreams();
  });

  beforeEach(() => {
    members.reset();
    postcodes.reset();
    cache.clear();
    __resetBreakers();
  });

  const MIXED = {
    items: [member(1, 'A Member', 1), member(2, 'Lord Somebody', 2)],
    totalResults: 2,
  };

  it('advertises the chamber and current_only', () => {
    const params = advertised('parliament_find_member');
    expect(params).toContain('house');
    expect(params).toContain('current_only');
  });

  it('asks the search API for the chamber, and for both when none is given', async () => {
    members.set({ kind: 'ok', body: MIXED });
    await call(findMember, FindMemberInput, { query: 'somebody', house: 'Lords' });
    expect(members.requests.join()).toContain('House=2');

    members.reset();
    cache.clear();
    members.set({ kind: 'ok', body: MIXED });
    await call(findMember, FindMemberInput, { query: 'somebody', house: 'both' });
    expect(members.requests.join()).not.toContain('House=');
  });

  /**
   * The upstream is asked to filter, but the page it returns is checked too. If
   * it ever stops filtering, the caller gets the right members and is told the
   * page was trimmed here, not a chamber filter that silently did nothing.
   */
  it('removes members outside the requested chamber and says the page was trimmed', async () => {
    members.set({ kind: 'ok', body: MIXED });
    const res = await call<{
      members: Array<{ name: string; house: string }>;
      house_filter: string;
      house_filter_applied: string;
      house_filter_note?: string;
      retrieval: { returned_by_upstream: number; kept_after_house_filter: number };
    }>(findMember, FindMemberInput, { query: 'somebody', house: 'Lords' });

    expect(res.data.house_filter).toBe('Lords');
    expect(res.data.house_filter_applied).toBe('upstream');
    expect(res.data.members.map((m) => m.name)).toEqual(['Lord Somebody']);
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 2, kept_after_house_filter: 1 });
    expect(res.data.house_filter_note).toContain('trimmed page');
  });

  it('leaves both chambers alone when none was asked for', async () => {
    members.set({ kind: 'ok', body: MIXED });
    const res = await call<{ members: unknown[]; house_filter: string; house_filter_applied: string }>(
      findMember,
      FindMemberInput,
      { query: 'somebody' },
    );
    expect(res.data.members).toHaveLength(2);
    expect(res.data.house_filter).toBe('both');
    expect(res.data.house_filter_applied).toBe('none');
  });

  /**
   * `IsCurrentMember=false` is the complement at this upstream, former members
   * only, so "current and former" is the parameter omitted. Sending false would
   * hide every sitting member, which is the opposite of widening the search.
   */
  it('restricts to sitting members by default and drops the flag to widen', async () => {
    members.set({ kind: 'ok', body: MIXED });
    const strict = await call<{ current_only: boolean; current_only_applied: string }>(
      findMember,
      FindMemberInput,
      { query: 'somebody' },
    );
    expect(strict.data.current_only).toBe(true);
    expect(strict.data.current_only_applied).toBe('upstream');
    expect(members.requests.join()).toContain('IsCurrentMember=true');

    members.reset();
    cache.clear();
    members.set({ kind: 'ok', body: MIXED });
    const wide = await call<{ current_only: boolean }>(findMember, FindMemberInput, {
      query: 'somebody',
      current_only: false,
    });
    expect(wide.data.current_only).toBe(false);
    expect(members.requests.join()).not.toContain('IsCurrentMember');
  });

  it('applies the chamber to the one member a postcode resolves to, and labels it local', async () => {
    postcodes.set({
      kind: 'ok',
      body: { status: 200, result: { postcode: 'SW1A 0AA', parliamentary_constituency_2024: 'Cities of London' } },
    });
    members.set({
      kind: 'ok',
      body: {
        items: [
          {
            value: {
              id: 9,
              name: 'Cities of London',
              currentRepresentation: { member: member(1, 'A Member', 1) },
            },
          },
        ],
      },
    });

    const res = await call<{
      members: unknown[];
      house_filter_applied: string;
      house_filter_note?: string;
      retrieval: { kept_after_house_filter: number };
    }>(findMember, FindMemberInput, { query: 'SW1A 0AA', house: 'Lords' });

    expect(res.data.house_filter_applied).toBe('server_side');
    expect(res.data.members).toHaveLength(0);
    expect(res.data.retrieval.kept_after_house_filter).toBe(0);
    expect(res.data.house_filter_note).toContain('only ever return a Commons member');
  });

  it('says current_only: false cannot be honoured on a postcode rather than pretending it was', async () => {
    postcodes.set({
      kind: 'ok',
      body: { status: 200, result: { postcode: 'SW1A 0AA', parliamentary_constituency_2024: 'Cities of London' } },
    });
    members.set({
      kind: 'ok',
      body: {
        items: [
          {
            value: {
              id: 9,
              name: 'Cities of London',
              currentRepresentation: { member: member(1, 'A Member', 1) },
            },
          },
        ],
      },
    });

    const res = await call<{ current_only_applied: string; current_only_note?: string; members: unknown[] }>(
      findMember,
      FindMemberInput,
      { query: 'SW1A 0AA', current_only: false },
    );
    expect(res.data.current_only_applied).toBe('not_applicable');
    expect(res.data.current_only_note).toContain('cannot be honoured');
    expect(res.data.members).toHaveLength(1);
  });

  it('a timed-out search still reports both filters, and is not an empty chamber', async () => {
    members.set({ kind: 'hang' });
    const res = await call<{
      members: unknown[];
      house_filter: string;
      house_filter_applied: string;
      current_only: boolean;
    }>(findMember, FindMemberInput, { query: 'somebody', house: 'Lords', current_only: false });

    expect(res.data.members).toHaveLength(0);
    expect(res.data.house_filter).toBe('Lords');
    expect(res.data.house_filter_applied).toBe('upstream');
    expect(res.data.current_only).toBe(false);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.members?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.members)).toBe(false);
  });
});

describe('member_overview: recent_votes_limit', () => {
  let members: RoutedMock;
  let commonsVotes: MockUpstream;
  let lordsVotes: MockUpstream;

  beforeAll(async () => {
    members = new RoutedMock();
    commonsVotes = new MockUpstream();
    lordsVotes = new MockUpstream();
    setUpstream('members', { base: await members.start(), timeoutMs: 1_000, ttlMs: 60_000 });
    setUpstream('commonsVotes', { base: await commonsVotes.start(), timeoutMs: 1_000, ttlMs: 60_000 });
    setUpstream('lordsVotes', { base: await lordsVotes.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });

  afterAll(async () => {
    await members.stop();
    await commonsVotes.stop();
    await lordsVotes.stop();
    resetUpstreams();
  });

  beforeEach(() => {
    members.reset();
    commonsVotes.reset();
    lordsVotes.reset();
    cache.clear();
    __resetBreakers();
  });

  /** The six facets the overview fans out to. Longest paths first: routes match
   * on a substring, so `/Members/1` would otherwise swallow `/Members/1/Focus`. */
  const profile = (id: number, name: string, house: 1 | 2) => {
    members.route(`/Members/${id}/Synopsis`, { value: 'A synopsis.' });
    members.route(`/Members/${id}/Focus`, { value: [] });
    members.route(`/Members/${id}/Contact`, { value: [] });
    members.route(`/Members/${id}/ContributionSummary`, { value: [] });
    members.route(`/Members/${id}/Biography`, { value: {} });
    members.route(`/Members/${id}`, member(id, name, house));
  };

  const COMMONS_VOTES = [
    commonsVote(101, 'Climate and Nature Bill', '2026-06-01T00:00:00'),
    commonsVote(102, 'Finance Bill', '2026-05-20T00:00:00'),
    commonsVote(103, 'Housing Bill', '2026-05-01T00:00:00'),
  ];

  it('advertises recent_votes_limit', () => {
    expect(advertised('parliament_member_overview')).toContain('recent_votes_limit');
  });

  it('fetches nothing at the default, and reports null rather than an empty record', async () => {
    profile(1, 'A Member', 1);
    commonsVotes.set({ kind: 'ok', body: COMMONS_VOTES });
    const res = await call<{
      recent_votes: unknown[] | null;
      recent_votes_included: boolean;
      recent_votes_limit_applied: string;
      recent_votes_source: string | null;
    }>(memberOverview, MemberOverviewInput, { member_id: 1 });

    expect(res.data.recent_votes).toBeNull();
    expect(res.data.recent_votes_included).toBe(false);
    expect(res.data.recent_votes_limit_applied).toBe('none');
    expect(res.data.recent_votes_source).toBeNull();
    expect(commonsVotes.requests).toHaveLength(0);
  });

  it('asks the votes API for exactly the limit given, and returns them', async () => {
    profile(1, 'A Member', 1);
    commonsVotes.set({ kind: 'ok', body: COMMONS_VOTES });
    lordsVotes.set({ kind: 'ok', body: [] });

    const res = await call<{
      recent_votes: Array<{ division_id: number; title: string; voted: string | null }>;
      recent_votes_limit: number;
      recent_votes_limit_applied: string;
      recent_votes_source: string;
    }>(memberOverview, MemberOverviewInput, { member_id: 1, recent_votes_limit: 3 });

    expect(res.data.recent_votes_limit).toBe(3);
    expect(res.data.recent_votes_limit_applied).toBe('upstream');
    expect(res.data.recent_votes_source).toBe('commonsVotes');
    expect(res.data.recent_votes.map((v) => v.division_id)).toEqual([101, 102, 103]);
    expect(commonsVotes.requests.join()).toContain('take=3');
  });

  it('reads the Lords record for a peer', async () => {
    profile(2, 'Lord Somebody', 2);
    commonsVotes.set({ kind: 'ok', body: [] });
    lordsVotes.set({
      kind: 'ok',
      body: [{ divisionId: 7, title: 'A Lords division', date: '2026-06-02T00:00:00', memberVotedContent: true }],
    });

    const res = await call<{
      recent_votes: Array<{ division_id: number; voted: string | null }>;
      recent_votes_source: string;
    }>(memberOverview, MemberOverviewInput, { member_id: 2, recent_votes_limit: 5 });

    expect(res.data.recent_votes_source).toBe('lordsVotes');
    expect(res.data.recent_votes[0]?.division_id).toBe(7);
    expect(res.data.recent_votes[0]?.voted).toBe('Content');
  });

  it('a timed-out votes API is a timeout, never a member who voted in nothing', async () => {
    profile(1, 'A Member', 1);
    commonsVotes.set({ kind: 'hang' });
    lordsVotes.set({ kind: 'ok', body: [] });

    const res = await call<{ recent_votes: unknown[]; recent_votes_included: boolean }>(
      memberOverview,
      MemberOverviewInput,
      { member_id: 1, recent_votes_limit: 5 },
    );

    expect(res.data.recent_votes_included).toBe(true);
    expect(res.data.recent_votes).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.commonsVotes?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.commonsVotes)).toBe(false);
  });
});

describe('get_election_results: include_history', () => {
  let members: MockUpstream;

  beforeAll(async () => {
    members = new MockUpstream();
    setUpstream('members', { base: await members.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });

  afterAll(async () => {
    await members.stop();
    resetUpstreams();
  });

  beforeEach(() => {
    members.reset();
    cache.clear();
    __resetBreakers();
  });

  const ALL = {
    value: [
      { electionTitle: '2024 General Election', electionDate: '2024-07-04', majority: 1000, candidates: [] },
      { electionTitle: '2019 General Election', electionDate: '2019-12-12', majority: 900, candidates: [] },
    ],
  };
  const LATEST = {
    value: { electionTitle: '2024 General Election', electionDate: '2024-07-04', majority: 1000, candidates: [] },
  };

  it('advertises include_history', () => {
    expect(advertised('parliament_get_election_results')).toContain('include_history');
  });

  it('true asks for every contest, false asks for the latest one', async () => {
    members.set({ kind: 'ok', body: ALL });
    const all = await call<{ elections: unknown[]; scope: string; scope_from: string; scope_applied: string }>(
      getElectionResults,
      GetElectionResultsInput,
      { constituency_id: 4000, include_history: true },
    );
    expect(all.data.scope).toBe('all_recorded');
    expect(all.data.scope_from).toBe('include_history');
    expect(all.data.scope_applied).toBe('upstream');
    expect(all.data.elections).toHaveLength(2);
    expect(members.requests.join()).toContain('/ElectionResults');

    members.reset();
    cache.clear();
    members.set({ kind: 'ok', body: LATEST });
    const latest = await call<{ elections: unknown[]; scope: string }>(
      getElectionResults,
      GetElectionResultsInput,
      { constituency_id: 4000, include_history: false },
    );
    expect(latest.data.scope).toBe('latest_only');
    expect(latest.data.elections).toHaveLength(1);
    expect(members.requests.join()).toContain('/ElectionResult/Latest');
  });

  it('still honours latest_only on its own, and says which parameter decided it', async () => {
    members.set({ kind: 'ok', body: LATEST });
    const res = await call<{ scope: string; scope_from: string; scope_conflict_note?: string }>(
      getElectionResults,
      GetElectionResultsInput,
      { constituency_id: 4000, latest_only: true },
    );
    expect(res.data.scope).toBe('latest_only');
    expect(res.data.scope_from).toBe('latest_only');
    expect(res.data.scope_conflict_note).toBeUndefined();
  });

  it('a contradictory pair goes to include_history, and the response says so', async () => {
    members.set({ kind: 'ok', body: ALL });
    const res = await call<{ scope: string; scope_from: string; scope_conflict_note?: string; elections: unknown[] }>(
      getElectionResults,
      GetElectionResultsInput,
      { constituency_id: 4000, include_history: true, latest_only: true },
    );
    expect(res.data.scope).toBe('all_recorded');
    expect(res.data.scope_from).toBe('include_history');
    expect(res.data.scope_conflict_note).toContain('takes precedence');
    expect(res.data.elections).toHaveLength(2);
  });

  it('a timed-out upstream still reports the scope, and is not a seat that never held an election', async () => {
    members.set({ kind: 'hang' });
    const res = await call<{ elections: unknown[]; scope: string }>(getElectionResults, GetElectionResultsInput, {
      constituency_id: 4000,
      include_history: true,
    });

    expect(res.data.scope).toBe('all_recorded');
    expect(res.data.elections).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.members?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.members)).toBe(false);
  });
});
