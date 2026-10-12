/**
 * Stage 3c: the 0.2.0 surface took `from_date` and `to_date` on four tools and the
 * rebuild replaced them with `lookback_days`, so "between March and May" could
 * not be asked at all.
 *
 * The thing these guard is not the filtering, it is the labelling. Hansard's
 * search accepts a date range, so the window is part of the query; the votes and
 * interests APIs do not, so the window is applied to the page they returned.
 * Both are legitimate, and the response has to say which one happened. A range
 * that was quietly dropped, or a local trim reported as a search of the whole
 * period, is the same class of bug as reporting a timeout as an absence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { EngineError } from '../../src/core/errors.js';
import { isReportableAbsence } from '../../src/envelope.js';
import { windowFromRange, resolveWindow, toIsoDate } from '../../src/domain/dates.js';
import { searchHansard, SearchHansardInput } from '../../src/tools/searchHansard.js';
import { searchDivisions, SearchDivisionsInput } from '../../src/tools/searchDivisions.js';
import { memberVotingHistory, MemberVotingHistoryInput } from '../../src/tools/memberVotingHistory.js';
import { memberInterests, MemberInterestsInput } from '../../src/tools/memberInterests.js';
import { tools } from '../../src/tools/index.js';
import { NOT_YET_SUPPORTED } from '../../src/compat.js';

const ctx = { requestId: 'TEST' };
const today = toIsoDate(new Date());

type Envelope<D> = { data: D; meta: { partial: boolean; sources_status: Record<string, { status: string }> } };

const call = async <D,>(
  handler: (input: never, c: typeof ctx) => Promise<unknown>,
  schema: { parse: (v: unknown) => unknown },
  args: Record<string, unknown>,
): Promise<Envelope<D>> => (await handler(schema.parse(args) as never, ctx)) as never as Envelope<D>;

describe('windowFromRange', () => {
  it('takes both ends as given', () => {
    expect(windowFromRange('2026-03-01', '2026-05-31')).toEqual({ from: '2026-03-01', to: '2026-05-31' });
  });

  it('runs a lone from_date up to today', () => {
    expect(windowFromRange('2026-03-01', undefined, new Date('2026-08-27T12:00:00Z'))).toEqual({
      from: '2026-03-01',
      to: '2026-08-27',
    });
  });

  it('leaves the start open for a lone to_date', () => {
    const w = windowFromRange(undefined, '2026-05-31');
    expect(w?.to).toBe('2026-05-31');
    // Earlier than Hansard itself, so it cannot exclude a real result.
    expect(w!.from < '1803-01-01').toBe(true);
  });

  it('is null when neither end is given, which is not the same as an empty range', () => {
    expect(windowFromRange(undefined, undefined)).toBeNull();
  });

  it('rejects a reversed range rather than returning nothing', () => {
    expect(() => windowFromRange('2026-05-31', '2026-03-01')).toThrow(EngineError);
    try {
      windowFromRange('2026-05-31', '2026-03-01');
    } catch (e) {
      expect((e as EngineError).code).toBe('BAD_INPUT');
      expect((e as EngineError).remedy.length).toBeGreaterThan(20);
    }
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => windowFromRange('1 March 2026')).toThrow(EngineError);
    expect(() => windowFromRange('2026-13-45')).toThrow(EngineError);
  });
});

describe('resolveWindow precedence', () => {
  it('prefers an absolute range over lookback_days', () => {
    const r = resolveWindow({ fromDate: '2026-03-01', toDate: '2026-05-31', lookbackDays: 7 });
    expect(r?.source).toBe('from_date/to_date');
    expect(r?.window).toEqual({ from: '2026-03-01', to: '2026-05-31' });
  });

  it('prefers an absolute range over a window inferred from the query', () => {
    const r = resolveWindow({ fromDate: '2026-03-01', lookbackDays: 365, inferredLookbackDays: 7 });
    expect(r?.source).toBe('from_date/to_date');
    expect(r?.window.from).toBe('2026-03-01');
  });

  it('falls back to the inferred window, then to lookback_days', () => {
    expect(resolveWindow({ lookbackDays: 365, inferredLookbackDays: 7 })?.source).toBe('query_phrase');
    expect(resolveWindow({ lookbackDays: 365 })?.source).toBe('lookback_days');
    expect(resolveWindow({})).toBeNull();
  });
});

describe('search_hansard filters upstream, because Hansard accepts a date range', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('hansard', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    mock.reset();
    await cache.clear();
    __resetBreakers();
  });

  const DEBATES = {
    Results: [
      { DebateSectionExtId: 'A', Title: 'Climate Change Targets', House: 'Commons', SittingDate: '2026-04-14T00:00:00' },
      { DebateSectionExtId: 'B', Title: 'Climate Change Adaptation', House: 'Commons', SittingDate: '2026-05-02T00:00:00' },
    ],
    TotalResultCount: 2,
  };

  it('sends both dates to the upstream and says the filter was applied there', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{
      window: { from: string; to: string };
      window_source: string;
      date_filtered: boolean;
      date_filter_applied: string;
      debates: unknown[];
    }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(mock.requests.join()).toContain('queryParameters.startDate=2026-03-01');
    expect(mock.requests.join()).toContain('queryParameters.endDate=2026-05-31');
    expect(res.data.window).toEqual({ from: '2026-03-01', to: '2026-05-31' });
    expect(res.data.window_source).toBe('from_date/to_date');
    expect(res.data.date_filtered).toBe(true);
    expect(res.data.date_filter_applied).toBe('upstream');
    expect(res.data.debates).toHaveLength(2);
  });

  it('runs a lone from_date to today', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{ window: { from: string; to: string } }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      from_date: '2026-03-01',
    });
    expect(res.data.window).toEqual({ from: '2026-03-01', to: today });
  });

  it('an absolute range beats lookback_days', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{ window: { from: string }; window_source: string }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
      lookback_days: 7,
    });
    expect(res.data.window_source).toBe('from_date/to_date');
    expect(res.data.window.from).toBe('2026-03-01');
    expect(mock.requests.join()).toContain('queryParameters.startDate=2026-03-01');
  });

  it('an absolute range also beats a date phrase in the query', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{ window: { from: string }; window_source: string }>(searchHansard, SearchHansardInput, {
      query: 'climate change last 7 days',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });
    expect(res.data.window_source).toBe('from_date/to_date');
    expect(res.data.window.from).toBe('2026-03-01');
  });

  it('still uses lookback_days when no range is given', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    const res = await call<{ window: { to: string }; window_source: string }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      lookback_days: 30,
    });
    expect(res.data.window_source).toBe('lookback_days');
    expect(res.data.window.to).toBe(today);
  });

  it('rejects a reversed range instead of searching a period that cannot exist', async () => {
    mock.set({ kind: 'ok', body: DEBATES });
    await expect(
      call(searchHansard, SearchHansardInput, {
        query: 'climate change',
        from_date: '2026-05-31',
        to_date: '2026-03-01',
      }),
    ).rejects.toBeInstanceOf(EngineError);
    expect(mock.requests).toHaveLength(0);
  });

  /** The point of the engine: a dated search that failed is not a quiet period. */
  it('a timed-out upstream still reports its status rather than an empty period', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{ debates: unknown[]; date_filtered: boolean }>(searchHansard, SearchHansardInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.debates).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.debates?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.debates)).toBe(false);
  });
});

describe('search_divisions filters locally, because the votes API takes no range', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('commonsVotes', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    mock.reset();
    await cache.clear();
    __resetBreakers();
  });

  const DIVISIONS = [
    { DivisionId: 1, Title: 'Climate Change Bill: Third Reading', Date: '2026-04-14T00:00:00', AyeCount: 300, NoCount: 200 },
    { DivisionId: 2, Title: 'Climate Change Levy', Date: '2026-07-02T00:00:00', AyeCount: 280, NoCount: 210 },
    { DivisionId: 3, Title: 'Climate Change Committee Report', Date: '2016-07-20T00:00:00', AyeCount: 250, NoCount: 240 },
  ];

  it('keeps only the divisions inside an explicit range, and says the filter was local', async () => {
    mock.set({ kind: 'ok', body: DIVISIONS });
    const res = await call<{
      date_filtered: boolean;
      date_filter_applied: string;
      date_filter_note: string;
      window_source: string;
      divisions: Array<{ division_id: number; in_window: boolean }>;
      retrieval: { returned_by_upstream: number; kept_after_relevance: number; kept_after_date_filter: number };
    }>(searchDivisions, SearchDivisionsInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.date_filtered).toBe(true);
    expect(res.data.date_filter_applied).toBe('server_side');
    expect(res.data.date_filter_note).toMatch(/does not accept a date range/);
    expect(res.data.window_source).toBe('from_date/to_date');
    expect(res.data.divisions.map((d) => d.division_id)).toEqual([1]);
    expect(res.data.divisions.every((d) => d.in_window)).toBe(true);
    expect(res.data.retrieval.returned_by_upstream).toBe(3);
    expect(res.data.retrieval.kept_after_date_filter).toBe(1);
  });

  it('does not send the range upstream, because that upstream ignores it', async () => {
    mock.set({ kind: 'ok', body: DIVISIONS });
    await call(searchDivisions, SearchDivisionsInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });
    expect(mock.requests.join()).not.toContain('startDate');
  });

  it('without a range it still reports date_filtered false and marks each division', async () => {
    mock.set({ kind: 'ok', body: DIVISIONS });
    const res = await call<{
      date_filtered: boolean;
      date_filter_applied: string;
      in_window_count: number;
      divisions: Array<{ division_id: number; in_window: boolean }>;
    }>(searchDivisions, SearchDivisionsInput, { query: 'climate change', lookback_days: 365 });

    expect(res.data.date_filtered).toBe(false);
    expect(res.data.date_filter_applied).toBe('none');
    // Nothing is dropped: a lookback is the default horizon, not an exclusion.
    expect(res.data.divisions).toHaveLength(3);
    expect(res.data.divisions.find((d) => d.division_id === 3)?.in_window).toBe(false);
  });

  it('a 500 with a range applied is still an upstream error, not an empty period', async () => {
    mock.set({ kind: 'status', status: 500 });
    const res = await call<{ divisions: unknown[] }>(searchDivisions, SearchDivisionsInput, {
      query: 'climate change',
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.divisions).toHaveLength(0);
    expect(res.meta.sources_status.commonsVotes?.status).toBe('upstream_error');
    expect(isReportableAbsence(res.meta.sources_status.commonsVotes)).toBe(false);
  });
});

describe('member_voting_history takes a range and filters the page it was given', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('commonsVotes', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    mock.reset();
    await cache.clear();
    __resetBreakers();
  });

  const vote = (id: number, date: string) => ({
    PublishedDivision: { DivisionId: id, Title: `Division ${id}`, Date: date, AyeCount: 1, NoCount: 1 },
    MemberVotedAye: true,
  });
  const VOTES = [vote(1, '2026-04-14T00:00:00'), vote(2, '2026-05-20T00:00:00'), vote(3, '2025-11-03T00:00:00')];

  it('keeps only the votes inside the range and says where the filter ran', async () => {
    mock.set({ kind: 'ok', body: VOTES });
    const res = await call<{
      date_filtered: boolean;
      date_filter_applied: string;
      window: { from: string; to: string };
      votes: Array<{ division_id: number }>;
      retrieval: { returned_by_upstream: number; kept_after_date_filter: number };
    }>(memberVotingHistory, MemberVotingHistoryInput, {
      member_id: 4514,
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.date_filtered).toBe(true);
    expect(res.data.date_filter_applied).toBe('server_side');
    expect(res.data.window).toEqual({ from: '2026-03-01', to: '2026-05-31' });
    expect(res.data.votes.map((v) => v.division_id)).toEqual([1, 2]);
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 3, kept_after_date_filter: 2 });
  });

  it('a lone to_date keeps everything up to that date', async () => {
    mock.set({ kind: 'ok', body: VOTES });
    const res = await call<{ votes: Array<{ division_id: number }> }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514, to_date: '2026-04-30' },
    );
    expect(res.data.votes.map((v) => v.division_id)).toEqual([1, 3]);
  });

  it('paging still describes the unfiltered record, so next_offset keeps working', async () => {
    mock.set({ kind: 'ok', body: VOTES });
    const res = await call<{ votes: unknown[]; total: number; has_more: boolean; next_offset: number | null }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514, from_date: '2026-03-01', to_date: '2026-05-31', limit: 3 },
    );
    expect(res.data.votes).toHaveLength(2);
    expect(res.data.has_more).toBe(true);
    expect(res.data.next_offset).toBe(3);
  });

  it('reports no filter at all when no range is given', async () => {
    mock.set({ kind: 'ok', body: VOTES });
    const res = await call<{ date_filtered: boolean; date_filter_applied: string; window: null; votes: unknown[] }>(
      memberVotingHistory,
      MemberVotingHistoryInput,
      { member_id: 4514 },
    );
    expect(res.data.date_filtered).toBe(false);
    expect(res.data.date_filter_applied).toBe('none');
    expect(res.data.window).toBeNull();
    expect(res.data.votes).toHaveLength(3);
  });

  it('rejects a reversed range before it calls anything', async () => {
    mock.set({ kind: 'ok', body: VOTES });
    await expect(
      call(memberVotingHistory, MemberVotingHistoryInput, {
        member_id: 4514,
        from_date: '2026-05-31',
        to_date: '2026-03-01',
      }),
    ).rejects.toBeInstanceOf(EngineError);
    expect(mock.requests).toHaveLength(0);
  });

  it('a dead connection is reported as one, not as a member who voted on nothing', async () => {
    mock.set({ kind: 'reset' });
    const res = await call<{ votes: unknown[] }>(memberVotingHistory, MemberVotingHistoryInput, {
      member_id: 4514,
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.votes).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.commonsVotes?.status).not.toBe('ok');
    expect(isReportableAbsence(res.meta.sources_status.commonsVotes)).toBe(false);
  });
});

describe('member_interests takes a range and filters by registration date', () => {
  const mock = new MockUpstream();

  beforeAll(async () => {
    setUpstream('interests', { base: await mock.start(), timeoutMs: 1_000, ttlMs: 60_000 });
  });
  afterAll(async () => {
    await mock.stop();
    resetUpstreams();
  });
  beforeEach(async () => {
    mock.reset();
    await cache.clear();
    __resetBreakers();
  });

  const INTERESTS = {
    items: [
      {
        id: 1,
        summary: 'Donation from a trust',
        registrationDate: '2026-04-02T00:00:00',
        category: { id: 2, name: 'Donations', number: '2' },
        member: { id: 4514, nameDisplayAs: 'A Member' },
      },
      {
        id: 2,
        summary: 'Overseas visit',
        registrationDate: '2025-09-11T00:00:00',
        category: { id: 4, name: 'Visits', number: '4' },
        member: { id: 4514, nameDisplayAs: 'A Member' },
      },
      {
        id: 3,
        summary: 'Shareholding, no date recorded',
        category: { id: 7, name: 'Shareholdings', number: '7' },
        member: { id: 4514, nameDisplayAs: 'A Member' },
      },
    ],
    totalResults: 3,
  };

  it('keeps entries registered inside the range and counts what it dropped', async () => {
    mock.set({ kind: 'ok', body: INTERESTS });
    const res = await call<{
      date_filtered: boolean;
      date_filter_applied: string;
      interests: Array<{ id: number }>;
      categories: Array<{ category: string; count: number }>;
      retrieval: { returned_by_upstream: number; kept_after_date_filter: number; excluded_undated: number };
    }>(memberInterests, MemberInterestsInput, {
      member_id: 4514,
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.date_filtered).toBe(true);
    expect(res.data.date_filter_applied).toBe('server_side');
    expect(res.data.interests.map((i) => i.id)).toEqual([1]);
    // An undated entry cannot be placed either side of the window, so it is
    // dropped and counted rather than assumed to belong.
    expect(res.data.retrieval).toEqual({ returned_by_upstream: 3, kept_after_date_filter: 1, excluded_undated: 1 });
    expect(res.data.categories).toEqual([{ category: 'Donations', count: 1 }]);
  });

  it('names the member even when the range excludes every entry', async () => {
    mock.set({ kind: 'ok', body: INTERESTS });
    const res = await call<{ member_name: string | null; interests: unknown[] }>(
      memberInterests,
      MemberInterestsInput,
      { member_id: 4514, from_date: '2019-01-01', to_date: '2019-12-31' },
    );
    expect(res.data.interests).toHaveLength(0);
    expect(res.data.member_name).toBe('A Member');
  });

  it('returns the whole register when no range is given', async () => {
    mock.set({ kind: 'ok', body: INTERESTS });
    const res = await call<{ date_filtered: boolean; window: null; interests: unknown[] }>(
      memberInterests,
      MemberInterestsInput,
      { member_id: 4514 },
    );
    expect(res.data.date_filtered).toBe(false);
    expect(res.data.window).toBeNull();
    expect(res.data.interests).toHaveLength(3);
  });

  it('rejects a reversed range', async () => {
    await expect(
      call(memberInterests, MemberInterestsInput, {
        member_id: 4514,
        from_date: '2026-05-31',
        to_date: '2026-03-01',
      }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('a timed-out register is a timeout, not a member with no interests in the period', async () => {
    mock.set({ kind: 'hang' });
    const res = await call<{ interests: unknown[] }>(memberInterests, MemberInterestsInput, {
      member_id: 4514,
      from_date: '2026-03-01',
      to_date: '2026-05-31',
    });

    expect(res.data.interests).toHaveLength(0);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.sources_status.interests?.status).toBe('timeout');
    expect(isReportableAbsence(res.meta.sources_status.interests)).toBe(false);
  });
});

describe('the four tools advertise the range on their own schemas', () => {
  const schemas = {
    parliament_search_hansard: SearchHansardInput,
    parliament_search_divisions: SearchDivisionsInput,
    parliament_member_voting_history: MemberVotingHistoryInput,
    parliament_member_interests: MemberInterestsInput,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} accepts from_date and to_date`, () => {
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape)).toContain('from_date');
      expect(Object.keys(shape)).toContain('to_date');
    });

    /**
     * The advertised schema is what a legacy caller is validated against, and it
     * is rebuilt by the compat layer rather than being the tool's own. A range
     * that the tool honours but `tools/list` never offers is no use to anybody.
     */
    it(`${name} advertises the range through the compat layer`, () => {
      const advertised = tools.find((t) => t.name === name)!.inputSchema as unknown as {
        shape: Record<string, unknown>;
      };
      expect(Object.keys(advertised.shape)).toContain('from_date');
      expect(Object.keys(advertised.shape)).toContain('to_date');
      expect(NOT_YET_SUPPORTED[name as keyof typeof NOT_YET_SUPPORTED] ?? []).not.toContain('from_date');
    });
  }
});
