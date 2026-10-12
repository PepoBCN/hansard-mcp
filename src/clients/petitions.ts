import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface Petition {
  id: number;
  attributes: {
    action: string;
    background?: string | null;
    additional_details?: string | null;
    state: string;
    signature_count: number;
    created_at?: string;
  };
}

interface PetitionsEnvelope {
  data?: Petition[];
}

/**
 * The upstream `q` parameter is unreliable, so it is sent but never trusted —
 * callers must rank the result with the relevance layer rather than assume the
 * API filtered anything.
 */
export async function searchPetitions(
  params: { search?: string; state?: 'open' | 'closed' | 'all' } & FetchCtx,
): Promise<Fetched<Petition[]>> {
  const res = await getJson<PetitionsEnvelope>({
    source: 'petitions',
    path: '/petitions.json',
    query: { q: params.search, state: params.state ?? 'open' },
    signal: params.signal,
    isEmpty: (v) => ((v as PetitionsEnvelope)?.data?.length ?? 0) === 0,
  });
  return {
    value: res.value.data ?? [],
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}
