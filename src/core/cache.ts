import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { counter } from './metrics.js';

export type CacheState = 'hit' | 'miss' | 'stale' | 'bypass';

export interface CacheResult<T> {
  value: T;
  state: CacheState;
  ageSeconds: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  ttlMs: number;
  /** Negative entries are held briefly so a broken upstream is not hammered. */
  negative: boolean;
}

/**
 * Pluggable store so Redis can be dropped in behind the same interface without
 * touching callers. Phase 1 ships the in-process tier only; Redis is the shared
 * tier that survives restarts and warms across processes.
 */
export interface CacheStore {
  get(key: string): Promise<Entry<unknown> | undefined>;
  set(key: string, entry: Entry<unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements CacheStore {
  private lru: LRUCache<string, Entry<unknown>>;

  constructor(max = config.cacheMaxEntries) {
    this.lru = new LRUCache({ max });
  }
  async get(key: string) {
    return this.lru.get(key);
  }
  async set(key: string, entry: Entry<unknown>) {
    this.lru.set(key, entry);
  }
  async delete(key: string) {
    this.lru.delete(key);
  }
  async clear() {
    this.lru.clear();
  }
}

/** In-flight de-duplication: N concurrent misses on one key make one upstream call. */
const inflight = new Map<string, Promise<unknown>>();

export class Cache {
  constructor(
    private store: CacheStore = new MemoryStore(),
    private now: () => number = Date.now,
  ) {}

  /**
   * Stale-while-revalidate.
   *
   * A fresh entry returns immediately. A stale-but-serveable entry ALSO returns
   * immediately and kicks off a background refresh — this is what removes the
   * cold-start problem: the measured upstream took 25.1s cold and 0.24s warm, so
   * the refresh must never happen on the request path if it can be avoided.
   */
  async wrap<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { source?: string; isEmpty?: (v: T) => boolean } = {},
  ): Promise<CacheResult<T>> {
    const source = opts.source ?? 'unknown';
    if (!config.cacheEnabled) {
      return { value: await loader(), state: 'bypass', ageSeconds: 0 };
    }

    const entry = (await this.store.get(key)) as Entry<T> | undefined;
    const age = entry ? this.now() - entry.storedAt : Infinity;
    const effectiveTtl = entry?.negative ? config.cacheNegativeTtlMs : ttlMs;
    const staleLimit = effectiveTtl * config.cacheStaleMultiplier;

    if (entry && age <= effectiveTtl) {
      counter('cache_events_total', { source, state: 'hit' });
      return { value: entry.value, state: 'hit', ageSeconds: Math.round(age / 1000) };
    }

    if (entry && age <= staleLimit) {
      counter('cache_events_total', { source, state: 'stale' });
      void this.revalidate(key, ttlMs, loader, opts);
      return { value: entry.value, state: 'stale', ageSeconds: Math.round(age / 1000) };
    }

    counter('cache_events_total', { source, state: 'miss' });
    const value = await this.load(key, ttlMs, loader, opts);
    return { value, state: 'miss', ageSeconds: 0 };
  }

  private async load<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { isEmpty?: (v: T) => boolean },
  ): Promise<T> {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const value = await loader();
      const negative = opts.isEmpty?.(value) ?? false;
      await this.store.set(key, { value, storedAt: this.now(), ttlMs, negative });
      return value;
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  /** Background refresh. Failures are swallowed: the caller already has usable data. */
  private async revalidate<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { source?: string; isEmpty?: (v: T) => boolean },
  ): Promise<void> {
    if (inflight.has(key)) return;
    try {
      await this.load(key, ttlMs, loader, opts);
      counter('cache_revalidations_total', { source: opts.source ?? 'unknown', outcome: 'ok' });
    } catch {
      counter('cache_revalidations_total', { source: opts.source ?? 'unknown', outcome: 'error' });
    }
  }

  async clear(): Promise<void> {
    inflight.clear();
    await this.store.clear();
  }
}

export const cache = new Cache();

/**
 * Normalised cache key. Search terms are lowercased and params sorted so
 * "Climate Change" and "climate change" share one entry rather than each paying
 * the cold-start price.
 */
export function cacheKey(url: string, query: Record<string, unknown> = {}): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().toLowerCase()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `${url.toLowerCase()}?${parts.join('&')}`;
}
