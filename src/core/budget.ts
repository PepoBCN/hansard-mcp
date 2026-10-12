import { config } from '../config.js';
import { EngineError } from './errors.js';
import type { CacheState } from './cache.js';
import { counter, observe } from './metrics.js';
import type { Logger } from './logger.js';

/**
 * The status vocabulary. This is the contract the whole rebuild turns on:
 * `ok` with an empty list means Parliament genuinely returned nothing, and
 * anything else means we do not know. Nothing downstream may conflate them.
 */
export type SourceOutcome = 'ok' | 'timeout' | 'upstream_error' | 'circuit_open' | 'unavailable';

export interface SourceStatus {
  status: SourceOutcome;
  ms: number;
  cache: CacheState | 'none';
  age_seconds?: number;
  detail?: string;
}

export interface SourceResult<T> {
  value: T | null;
  status: SourceStatus;
}

export interface FanOutTask<T> {
  key: string;
  run: (signal: AbortSignal) => Promise<{ value: T; cacheState?: CacheState; ageSeconds?: number }>;
}

export interface FanOutResult {
  results: Record<string, SourceResult<unknown>>;
  statuses: Record<string, SourceStatus>;
  partial: boolean;
  warnings: string[];
}

const outcomeFor = (e: unknown): SourceOutcome => {
  if (e instanceof EngineError) {
    switch (e.code) {
      case 'UPSTREAM_TIMEOUT':
        return 'timeout';
      case 'CIRCUIT_OPEN':
        return 'circuit_open';
      case 'UPSTREAM_ERROR':
        return 'upstream_error';
      default:
        return 'unavailable';
    }
  }
  return 'unavailable';
};

/**
 * Parallel fan-out under one overall budget, with per-source status capture.
 *
 * The critical difference from the engine this replaces: a task that fails or is
 * cut off does NOT silently become an empty value. It becomes `value: null` plus
 * a status explaining why, and the response is flagged `partial`. Callers decide
 * how to render that — but they can no longer fail to notice it.
 */
export async function fanOut(
  tasks: FanOutTask<unknown>[],
  opts: { budgetMs?: number; log?: Logger; tool?: string } = {},
): Promise<FanOutResult> {
  const budgetMs = opts.budgetMs ?? config.requestBudgetMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);

  const settled = await Promise.all(
    tasks.map(async (task): Promise<[string, SourceResult<unknown>]> => {
      const started = Date.now();
      try {
        const out = await task.run(controller.signal);
        const status: SourceStatus = {
          status: 'ok',
          ms: Date.now() - started,
          cache: out.cacheState ?? 'none',
        };
        if (out.cacheState === 'stale') status.age_seconds = out.ageSeconds ?? 0;
        return [task.key, { value: out.value, status }];
      } catch (error) {
        const outcome = outcomeFor(error);
        const detail = error instanceof EngineError ? error.message : String(error);
        return [
          task.key,
          {
            value: null,
            status: { status: outcome, ms: Date.now() - started, cache: 'none', detail },
          },
        ];
      }
    }),
  );

  clearTimeout(timer);

  const results: Record<string, SourceResult<unknown>> = {};
  const statuses: Record<string, SourceStatus> = {};
  const warnings: string[] = [];
  let partial = false;

  for (const [key, res] of settled) {
    results[key] = res;
    statuses[key] = res.status;
    observe('source_duration_ms', res.status.ms, { source: key, outcome: res.status.status });
    if (res.status.status !== 'ok') {
      partial = true;
      counter('source_failures_total', { source: key, outcome: res.status.status });
      warnings.push(
        `${key}: ${res.status.status} — treat as UNKNOWN, not as absence. ${res.status.detail ?? ''}`.trim(),
      );
      opts.log?.warn({ source: key, outcome: res.status.status, ms: res.status.ms }, 'source degraded');
    }
  }

  if (opts.tool) {
    counter('tool_calls_total', { tool: opts.tool });
    if (partial) counter('partial_responses_total', { tool: opts.tool });
  }

  return { results, statuses, partial, warnings };
}

/** Narrowing helper: returns the value only when the source genuinely succeeded. */
export function valueOf<T>(res: SourceResult<unknown> | undefined): T | null {
  if (!res || res.status.status !== 'ok') return null;
  return res.value as T;
}
