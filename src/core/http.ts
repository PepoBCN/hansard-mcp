import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { config, USER_AGENT, UPSTREAMS, type SourceKey } from '../config.js';
import { EngineError, timeoutError, upstreamError, circuitOpenError } from './errors.js';
import { breakerFor } from './breaker.js';
import { bulkheadFor } from './bulkhead.js';
import { cache, cacheKey, type CacheState } from './cache.js';
import { counter, observe } from './metrics.js';
import { logger } from './logger.js';

setGlobalDispatcher(
  new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 64 }),
);

export interface GetJsonOptions {
  source: SourceKey;
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Overrides the per-upstream default from UPSTREAMS. */
  timeoutMs?: number;
  ttlMs?: number;
  signal?: AbortSignal;
  isEmpty?: (v: unknown) => boolean;
}

export interface FetchOutcome<T> {
  value: T;
  cacheState: CacheState;
  ageSeconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) =>
  config.upstreamBaseBackoffMs * 2 ** (attempt - 1) * (0.5 + Math.random());

const RETRYABLE_NAMES = new Set(['AbortError', 'TimeoutError']);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function buildUrl(base: string, path: string, query: Record<string, string | number | undefined> = {}): string {
  const u = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * The one place an upstream is actually called.
 *
 * Order matters: cache first (a hit never touches the breaker or the network),
 * then breaker, then bulkhead, then the timed fetch with retries. Every exit
 * path produces either a value or an EngineError with a code the fan-out layer
 * can turn into a reportable status — never an undifferentiated throw.
 */
export async function getJson<T>(opts: GetJsonOptions): Promise<FetchOutcome<T>> {
  const spec = UPSTREAMS[opts.source];
  const url = buildUrl(spec.base, opts.path, opts.query);
  const key = cacheKey(url);
  const ttl = opts.ttlMs ?? spec.ttlMs;
  const timeoutMs = opts.timeoutMs ?? spec.timeoutMs;

  const result = await cache.wrap<T>(
    key,
    ttl,
    () => fetchWithPolicy<T>(opts.source, url, timeoutMs, opts.signal),
    { source: opts.source, isEmpty: opts.isEmpty as ((v: T) => boolean) | undefined },
  );

  return { value: result.value, cacheState: result.state, ageSeconds: result.ageSeconds };
}

async function fetchWithPolicy<T>(
  source: SourceKey,
  url: string,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  const breaker = breakerFor(source);
  if (!breaker.canRequest()) {
    counter('upstream_requests_total', { source, outcome: 'circuit_open' });
    throw circuitOpenError(source);
  }

  return bulkheadFor(source).run(async () => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.upstreamMaxAttempts; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => controller.abort();
      external?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const res = await undiciFetch(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = upstreamError(source, res.status, res.statusText);
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < config.upstreamMaxAttempts && !external?.aborted) {
            lastError = err;
            observe('upstream_duration_ms', Date.now() - started, { source, outcome: 'retry' });
            await sleep(backoff(attempt));
            continue;
          }
          breaker.onFailure();
          counter('upstream_requests_total', { source, outcome: 'error' });
          observe('upstream_duration_ms', Date.now() - started, { source, outcome: 'error' });
          throw err;
        }

        const json = (await res.json()) as T;
        breaker.onSuccess();
        counter('upstream_requests_total', { source, outcome: 'ok' });
        observe('upstream_duration_ms', Date.now() - started, { source, outcome: 'ok' });
        return json;
      } catch (error) {
        const elapsed = Date.now() - started;
        if (error instanceof EngineError) throw error;

        // The external signal firing means the overall request budget is spent;
        // retrying would only burn time the caller no longer has.
        const externallyAborted = external?.aborted === true;
        const isTimeout = isAbortLike(error) && !externallyAborted;
        const wrapped = isTimeout
          ? timeoutError(source, timeoutMs)
          : externallyAborted
            ? timeoutError(source, elapsed)
            : new EngineError(
                'UPSTREAM_UNAVAILABLE',
                `Network error contacting ${source}: ${errMessage(error)}`,
                'The upstream is unreachable. Report this section as unavailable rather than empty.',
                { source, cause: error },
              );

        lastError = wrapped;
        const retryable = !externallyAborted && attempt < config.upstreamMaxAttempts && isRetryable(error);
        if (retryable) {
          logger.debug({ source, attempt, err: errMessage(error) }, 'upstream retry');
          observe('upstream_duration_ms', elapsed, { source, outcome: 'retry' });
          await sleep(backoff(attempt));
          continue;
        }

        breaker.onFailure();
        counter('upstream_requests_total', { source, outcome: isTimeout ? 'timeout' : 'error' });
        observe('upstream_duration_ms', elapsed, { source, outcome: isTimeout ? 'timeout' : 'error' });
        throw wrapped;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      }
    }

    throw lastError instanceof EngineError
      ? lastError
      : new EngineError('UPSTREAM_UNAVAILABLE', `${source} failed.`, 'Retry once.', { source });
  });
}

const isAbortLike = (e: unknown): boolean =>
  e instanceof Error && (RETRYABLE_NAMES.has(e.name) || /aborted/i.test(e.message));

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (RETRYABLE_NAMES.has(error.name)) return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_CODES.has(code)) return true;
    const causeCode = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;
  }
  return false;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
