import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { getJson } from '../../src/core/http.js';
import { fanOut, valueOf } from '../../src/core/budget.js';
import { cache } from '../../src/core/cache.js';
import { __resetBreakers } from '../../src/core/breaker.js';
import { EngineError } from '../../src/core/errors.js';
import { isReportableAbsence, absenceLabel } from '../../src/envelope.js';

const mock = new MockUpstream();
let base = '';

beforeAll(async () => {
  base = await mock.start();
});
afterAll(async () => {
  await mock.stop();
  resetUpstreams();
});
beforeEach(async () => {
  mock.reset();
  await cache.clear();
  __resetBreakers();
  setUpstream('bills', { base, timeoutMs: 400, ttlMs: 60_000 });
});

const call = (signal?: AbortSignal) =>
  getJson<{ items: unknown[] }>({ source: 'bills', path: '/Bills', signal });

describe('a degraded upstream is never silently empty', () => {
  it('reports a timeout as timeout, not as an empty result', async () => {
    mock.set({ kind: 'hang' });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });

    expect(fan.statuses.bills?.status).toBe('timeout');
    expect(fan.results.bills?.value).toBeNull();
    expect(fan.partial).toBe(true);
    // The invariant the whole engine exists to enforce.
    expect(isReportableAbsence(fan.statuses.bills)).toBe(false);
    expect(absenceLabel('Bills', fan.statuses.bills)).toContain('could not be retrieved');
  });

  it('reports an upstream 500 as upstream_error', async () => {
    mock.set({ kind: 'status', status: 500 });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });

    expect(fan.statuses.bills?.status).toBe('upstream_error');
    expect(fan.partial).toBe(true);
    expect(isReportableAbsence(fan.statuses.bills)).toBe(false);
  });

  it('reports malformed JSON as a failure rather than throwing', async () => {
    mock.set({ kind: 'malformed' });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });

    expect(fan.statuses.bills?.status).not.toBe('ok');
    expect(fan.results.bills?.value).toBeNull();
    expect(fan.partial).toBe(true);
  });

  it('reports a dropped connection as a failure', async () => {
    mock.set({ kind: 'reset' });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });
    expect(fan.statuses.bills?.status).not.toBe('ok');
    expect(fan.partial).toBe(true);
  });

  it('genuinely empty data IS reportable as absence', async () => {
    mock.set({ kind: 'ok', body: { items: [], totalResults: 0 } });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });

    expect(fan.statuses.bills?.status).toBe('ok');
    expect(fan.partial).toBe(false);
    expect(isReportableAbsence(fan.statuses.bills)).toBe(true);
    expect(absenceLabel('Bills', fan.statuses.bills)).toContain('No Bills found');
  });
});

describe('one slow upstream does not take the response down with it', () => {
  it('fast sources still return while a slow one times out', async () => {
    const slow = new MockUpstream();
    const slowBase = await slow.start();
    slow.set({ kind: 'hang' });
    setUpstream('writtenQuestions', { base: slowBase, timeoutMs: 500, ttlMs: 60_000 });
    mock.set({ kind: 'ok', body: { items: [{ billId: 1, shortTitle: 'Test Bill', isAct: false }] } });

    const started = Date.now();
    const fan = await fanOut(
      [
        { key: 'bills', run: (s) => call(s) },
        {
          key: 'written_questions',
          run: (s) => getJson({ source: 'writtenQuestions', path: '/questions', signal: s }),
        },
      ],
      { budgetMs: 5_000 },
    );
    const elapsed = Date.now() - started;

    expect(fan.statuses.bills?.status).toBe('ok');
    expect(fan.statuses.written_questions?.status).toBe('timeout');
    expect(fan.partial).toBe(true);
    // Ran in parallel: total time is the slowest source, not the sum.
    expect(elapsed).toBeLessThan(3_000);
    expect(valueOf(fan.results.bills)).not.toBeNull();

    await slow.stop();
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and reports circuit_open', async () => {
    mock.set({ kind: 'status', status: 500 });
    // Threshold is 5 by default; each call also retries once internally.
    for (let i = 0; i < 6; i += 1) {
      await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });
      await cache.clear();
    }
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });
    expect(fan.statuses.bills?.status).toBe('circuit_open');
    expect(isReportableAbsence(fan.statuses.bills)).toBe(false);
  });
});

describe('warnings', () => {
  it('names every degraded source and says what it means', async () => {
    mock.set({ kind: 'hang' });
    const fan = await fanOut([{ key: 'bills', run: (s) => call(s) }], { budgetMs: 3_000 });
    expect(fan.warnings.join(' ')).toMatch(/bills/);
    expect(fan.warnings.join(' ')).toMatch(/UNKNOWN, not as absence/);
  });
});

describe('error shape', () => {
  it('surfaces an actionable remedy, not an opaque string', async () => {
    mock.set({ kind: 'hang' });
    await expect(call()).rejects.toBeInstanceOf(EngineError);
    await call().catch((e: EngineError) => {
      expect(e.code).toBe('UPSTREAM_TIMEOUT');
      expect(e.remedy.length).toBeGreaterThan(20);
      expect(e.source).toBe('bills');
    });
  });
});
