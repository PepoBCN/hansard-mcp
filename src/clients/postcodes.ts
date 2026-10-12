import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

interface PostcodeEnvelope {
  status: number;
  result?: {
    postcode: string;
    parliamentary_constituency?: string;
    parliamentary_constituency_2024?: string;
    admin_district?: string;
    country?: string;
  };
}

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export const looksLikePostcode = (s: string): boolean => POSTCODE_RE.test(s.trim());

export async function lookupPostcode(
  params: { postcode: string } & FetchCtx,
): Promise<Fetched<{ postcode: string; constituency: string | null; district: string | null }>> {
  const clean = params.postcode.trim().toUpperCase().replace(/\s+/g, '');
  const res = await getJson<PostcodeEnvelope>({
    source: 'postcodes',
    path: `/postcodes/${encodeURIComponent(clean)}`,
    signal: params.signal,
  });
  const r = res.value.result;
  return {
    value: {
      postcode: r?.postcode ?? params.postcode,
      // The 2024 boundaries are the current ones; fall back for older records.
      constituency: r?.parliamentary_constituency_2024 ?? r?.parliamentary_constituency ?? null,
      district: r?.admin_district ?? null,
    },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}
