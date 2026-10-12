import { describe, it, expect, beforeEach } from 'vitest';
import { Cache, MemoryStore, cacheKey } from '../../src/core/cache.js';

describe('cache key normalisation', () => {
  it('shares one entry across casing and param order', () => {
    // Otherwise "Climate Change" and "climate change" each pay the 25s cold start.
    expect(cacheKey('https://api/x', { q: 'Climate Change', take: 5 }))
      .toBe(cacheKey('https://api/x', { take: 5, q: 'climate change' }));
  });

  it('separates genuinely different queries', () => {
    expect(cacheKey('https://api/x', { q: 'climate' })).not.toBe(cacheKey('https://api/x', { q: 'nhs' }));
  });
});

describe('stale-while-revalidate', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('serves fresh from cache without calling the loader again', async () => {
    const cache = new Cache(new MemoryStore(), clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { v: calls };
    };

    const a = await cache.wrap('k', 60_000, load);
    expect(a.state).toBe('miss');
    const b = await cache.wrap('k', 60_000, load);
    expect(b.state).toBe('hit');
    expect(calls).toBe(1);
  });

  it('serves stale immediately and refreshes in the background', async () => {
    const cache = new Cache(new MemoryStore(), clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { v: calls };
    };

    await cache.wrap('k', 1_000, load);
    now += 5_000; // past TTL, inside the stale window

    const stale = await cache.wrap('k', 1_000, load);
    // The caller is not made to wait for the slow upstream.
    expect(stale.state).toBe('stale');
    expect(stale.value).toEqual({ v: 1 });
    expect(stale.ageSeconds).toBe(5);

    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2); // refreshed off the request path
  });

  it('treats a very old entry as a miss', async () => {
    const cache = new Cache(new MemoryStore(), clock);
    const load = async () => ({ v: 1 });
    await cache.wrap('k', 1_000, load);
    now += 10_000_000;
    expect((await cache.wrap('k', 1_000, load)).state).toBe('miss');
  });

  it('collapses concurrent misses into one upstream call', async () => {
    const cache = new Cache(new MemoryStore(), clock);
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { v: calls };
    };
    const [a, b, c] = await Promise.all([
      cache.wrap('k', 60_000, load),
      cache.wrap('k', 60_000, load),
      cache.wrap('k', 60_000, load),
    ]);
    expect(calls).toBe(1);
    expect(a.value).toEqual(b.value);
    expect(b.value).toEqual(c.value);
  });
});
