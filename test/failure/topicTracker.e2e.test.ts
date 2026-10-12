import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams, type SourceKey } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { topicTracker } from '../../src/tools/topicTracker.js';

// Fixture dates are relative to today: fixed dates drifted out of the 90-day
// window and failed the suite with no code change (first seen 25 Sep 2026).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 19);
import { isReportableAbsence } from '../../src/envelope.js';

const KEYS: SourceKey[] = ['bills', 'hansard', 'commonsVotes', 'writtenQuestions', 'petitions'];
const mocks = new Map<SourceKey, MockUpstream>();

const BODIES: Record<SourceKey, unknown> = {
  bills: {
    items: [
      { billId: 2903, shortTitle: 'Climate Change Bill', isAct: false, currentStage: { description: '2nd reading' } },
      { billId: 195, shortTitle: 'Climate Change Act 2008', isAct: true, currentStage: { description: 'Royal Assent' } },
    ],
  },
  hansard: {
    Results: [
      { DebateSectionExtId: 'abc', Title: 'Climate Change: Resilience Planning', House: 'Commons', SittingDate: daysAgo(20) },
    ],
    TotalResultCount: 1,
  },
  commonsVotes: [
    { DivisionId: 2394, Title: 'Draft Climate Change Act 2008 (Credit Limit) Order 2026', Date: daysAgo(30), AyeCount: 330, NoCount: 93 },
    { DivisionId: 116, Title: 'Climate Change', Date: '2016-07-20T00:00:00', AyeCount: 309, NoCount: 207 },
  ],
  writtenQuestions: {
    results: [
      { value: { house: 'Commons', uin: '1', questionText: 'To ask about climate change adaptation funding.', dateTabled: daysAgo(25), dateAnswered: null } },
    ],
  },
  petitions: {
    data: [
      { id: 761127, attributes: { action: 'Legislate to ban FPNs related to school attendance', background: 'Parents want this changed.', state: 'open', signature_count: 126_790 } },
      { id: 767687, attributes: { action: 'Hold a UK-wide briefing on climate and nature risks', background: 'Climate change poses systemic risks.', state: 'open', signature_count: 113_960 } },
    ],
  },
  members: {}, postcodes: {}, lordsVotes: {}, committees: {}, interests: {},
};

beforeAll(async () => {
  for (const k of KEYS) {
    const m = new MockUpstream();
    const base = await m.start();
    mocks.set(k, m);
    setUpstream(k, { base, timeoutMs: 500, ttlMs: 60_000 });
  }
});

afterAll(async () => {
  for (const m of mocks.values()) await m.stop();
  resetUpstreams();
});

beforeEach(async () => {
  await cache.clear();
  __resetBreakers();
  for (const k of KEYS) mocks.get(k)!.set({ kind: 'ok', body: BODIES[k] });
});

const run = (topic = 'climate change') =>
  topicTracker({ topic, lookback_days: 90, response_format: 'detailed' }, { requestId: 'TEST' });

describe('topic_tracker under partial upstream failure', () => {
  it('marks written questions unknown rather than empty when it times out', async () => {
    mocks.get('writtenQuestions')!.set({ kind: 'hang' });
    const env = await run();

    expect(env.data.recent_written_questions).toEqual([]);
    expect(env.meta.sources_status.written_questions?.status).toBe('timeout');
    expect(env.meta.partial).toBe(true);
    // The exact failure that produced "there have been no written questions".
    expect(isReportableAbsence(env.meta.sources_status.written_questions)).toBe(false);
    expect(env.meta.warnings?.join(' ')).toMatch(/written_questions/);

    // Everything else still came back.
    expect(env.data.recent_debates.length).toBeGreaterThan(0);
    expect(env.meta.sources_status.bills?.status).toBe('ok');
  });

  it('is not partial when every source succeeds', async () => {
    const env = await run();
    expect(env.meta.partial).toBe(false);
    expect(env.meta.warnings).toBeUndefined();
    expect(isReportableAbsence(env.meta.sources_status.written_questions)).toBe(true);
  });
});

describe('topic_tracker correctness fixes', () => {
  it('excludes enacted Acts from bills in progress', async () => {
    const env = await run();
    const titles = env.data.bills_in_progress.map((b) => b.short_title);
    expect(titles).toContain('Climate Change Bill');
    expect(titles).not.toContain('Climate Change Act 2008');
  });

  it('labels divisions honestly instead of implying a date filter', async () => {
    const env = await run();
    expect(env.data.related_votes.date_filtered).toBe(false);
    const old = env.data.related_votes.items.find((v) => v.division_id === 116);
    expect(old?.in_window).toBe(false);
    const recent = env.data.related_votes.items.find((v) => v.division_id === 2394);
    expect(recent?.in_window).toBe(true);
    expect(env.data.related_votes.in_window_count).toBe(1);
  });

  it('keeps unrelated petitions out of the briefing', async () => {
    const env = await run();
    const actions = env.data.active_petitions.map((p) => p.action);
    expect(actions).toContain('Hold a UK-wide briefing on climate and nature risks');
    expect(actions.some((a) => a.includes('school attendance'))).toBe(false);
  });

  it('accepts the whole user phrase as a topic', async () => {
    const env = await run('climate change last 90 days');
    // Previously this matched no titles and returned an empty briefing.
    expect(env.data.topic).toBe('climate change');
    expect(env.data.window_inferred_from_topic).toBe(true);
    expect(env.data.recent_debates.length).toBeGreaterThan(0);
  });

  it('accepts lookback_days as a numeric string', async () => {
    const { TopicTrackerInput } = await import('../../src/tools/topicTracker.js');
    const parsed = TopicTrackerInput.parse({ topic: 'climate change', lookback_days: '90' });
    expect(parsed.lookback_days).toBe(90);
  });

  it('clamps an out-of-range lookback instead of hard-failing', async () => {
    const { TopicTrackerInput } = await import('../../src/tools/topicTracker.js');
    expect(TopicTrackerInput.parse({ topic: 'x y', lookback_days: 400 }).lookback_days).toBe(90);
  });

  it('carries a server-generated request id', async () => {
    const env = await run();
    expect(env.meta.request_id).toBe('TEST');
    expect(env.sources.length).toBeGreaterThan(0);
  });
});

describe('retrieval transparency', () => {
  it('distinguishes "upstream returned nothing" from "nothing was relevant"', async () => {
    // Upstream answers, but with questions about something else entirely —
    // exactly what Parliament's written-questions search does for "climate change".
    mocks.get('writtenQuestions')!.set({
      kind: 'ok',
      body: {
        results: [
          { value: { house: 'Lords', uin: 'HL2560', questionText: 'To ask about NHS waiting list reporting.', dateTabled: '2026-07-22T00:00:00' } },
          { value: { house: 'Lords', uin: 'HL2575', questionText: 'To ask about hospital discharge delays.', dateTabled: '2026-07-22T00:00:00' } },
        ],
      },
    });
    const env = await run();

    expect(env.data.recent_written_questions).toEqual([]);
    expect(env.meta.sources_status.written_questions?.status).toBe('ok');
    // The empty list is honest only because the counts explain it.
    expect(env.data.retrieval.written_questions.returned_by_upstream).toBe(2);
    expect(env.data.retrieval.written_questions.kept_after_relevance).toBe(0);
  });

  it('reports counts for a section that genuinely had nothing', async () => {
    mocks.get('writtenQuestions')!.set({ kind: 'ok', body: { results: [] } });
    const env = await run();
    expect(env.data.retrieval.written_questions.returned_by_upstream).toBe(0);
    expect(env.data.retrieval.written_questions.kept_after_relevance).toBe(0);
  });
});
