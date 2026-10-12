export interface FetchCtx {
  signal?: AbortSignal;
}

export interface Fetched<T> {
  value: T;
  cacheState: 'hit' | 'miss' | 'stale' | 'bypass';
  ageSeconds: number;
}
