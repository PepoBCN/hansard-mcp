import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface DivisionSummary {
  DivisionId: number;
  Date: string;
  Number?: number;
  Title: string;
  AyeCount: number;
  NoCount: number;
}

export async function searchCommonsDivisions(
  params: { searchTerm: string; startDate?: string; endDate?: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<DivisionSummary[]>> {
  const res = await getJson<DivisionSummary[]>({
    source: 'commonsVotes',
    path: '/divisions.json/search',
    query: {
      'queryParameters.searchTerm': params.searchTerm,
      // Upstream matches a literal title substring and is most-recent-first.
      // Dates are passed when supplied; the tool decides whether to trust them
      // and must label the result honestly either way.
      'queryParameters.startDate': params.startDate,
      'queryParameters.endDate': params.endDate,
      'queryParameters.skip': params.skip ?? 0,
      'queryParameters.take': params.take ?? 20,
    },
    signal: params.signal,
    isEmpty: (v) => (Array.isArray(v) ? v.length === 0 : true),
  });
  return {
    value: Array.isArray(res.value) ? res.value : [],
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface DivisionDetail extends DivisionSummary {
  DivisionId: number;
  AyeTellers?: Array<{ MemberId: number; Name: string; Party?: string }>;
  NoTellers?: Array<{ MemberId: number; Name: string; Party?: string }>;
  Ayes?: Array<{ MemberId: number; Name: string; Party?: string }>;
  Noes?: Array<{ MemberId: number; Name: string; Party?: string }>;
}

export async function getCommonsDivision(
  params: { divisionId: number } & FetchCtx,
): Promise<Fetched<DivisionDetail | null>> {
  const res = await getJson<DivisionDetail>({
    source: 'commonsVotes',
    path: `/division/${params.divisionId}.json`,
    signal: params.signal,
  });
  return { value: res.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface MemberVoteRecord {
  PublishedDivision: DivisionSummary;
  MemberWasTeller?: boolean;
  MemberVotedAye?: boolean;
}

export async function getMemberVoting(
  params: { memberId: number; searchTerm?: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<MemberVoteRecord[]>> {
  const res = await getJson<MemberVoteRecord[]>({
    source: 'commonsVotes',
    path: '/divisions.json/membervoting',
    query: {
      queryParameters: undefined,
      'queryParameters.memberId': params.memberId,
      // Measured as a live title substring match, unlike the written-questions
      // searchTerm which is inert. The tool re-checks it locally anyway, so an
      // upstream that quietly stops filtering cannot pass unfiltered rows off as
      // filtered ones.
      'queryParameters.searchTerm': params.searchTerm,
      'queryParameters.skip': params.skip ?? 0,
      'queryParameters.take': params.take ?? 25,
    },
    signal: params.signal,
    isEmpty: (v) => (Array.isArray(v) ? v.length === 0 : true),
  });
  return {
    value: Array.isArray(res.value) ? res.value : [],
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}
