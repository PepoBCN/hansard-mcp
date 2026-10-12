import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface InterestCategory {
  id: number;
  name: string;
  number?: string;
}

export interface RegisteredInterest {
  id: number;
  summary?: string | null;
  registrationDate?: string | null;
  publishedDate?: string | null;
  category?: InterestCategory;
  member?: { id: number; nameDisplayAs?: string };
  fields?: Array<{ name?: string; values?: string[] }>;
}

interface InterestsEnvelope {
  items?: Array<{ value: RegisteredInterest } | RegisteredInterest>;
  totalResults?: number;
}

interface CategoriesEnvelope {
  items?: InterestCategory[];
  totalResults?: number;
}

/**
 * The register's category index. Needed because the register is filterable by
 * category *id* while the published register, and the legacy 0.2.0 surface, name a
 * category by its *number* ("2", "1.1"). The two are unrelated integers, so the
 * mapping is read rather than assumed.
 */
export async function getInterestCategories(
  params: FetchCtx,
): Promise<Fetched<InterestCategory[]>> {
  const res = await getJson<CategoriesEnvelope>({
    source: 'interests',
    path: '/Categories',
    query: { Take: 100 },
    signal: params.signal,
    isEmpty: (v) => ((v as CategoriesEnvelope)?.items?.length ?? 0) === 0,
  });
  return { value: res.value.items ?? [], cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export async function searchInterests(
  params: { memberId: number; categoryId?: number; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<{ items: RegisteredInterest[]; total: number }>> {
  const res = await getJson<InterestsEnvelope>({
    source: 'interests',
    path: '/Interests/',
    query: {
      MemberId: params.memberId,
      // Measured as a live filter. `CategoryNumber` and `Category` are not: both
      // are accepted and ignored, which is why only the id is sent.
      CategoryId: params.categoryId,
      Skip: params.skip ?? 0,
      Take: params.take ?? 50,
    },
    signal: params.signal,
    isEmpty: (v) => ((v as InterestsEnvelope)?.items?.length ?? 0) === 0,
  });
  const items = (res.value.items ?? []).map((e) =>
    e && typeof e === 'object' && 'value' in e
      ? (e as { value: RegisteredInterest }).value
      : (e as RegisteredInterest),
  );
  return {
    value: { items, total: res.value.totalResults ?? items.length },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}
