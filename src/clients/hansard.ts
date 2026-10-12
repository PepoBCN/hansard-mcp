import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface DebateResult {
  DebateSectionExtId: string;
  Title: string;
  House: string;
  SittingDate: string;
  DebateSection?: string;
  Rank?: number;
}

interface HansardSearchEnvelope {
  Results?: DebateResult[];
  TotalResultCount?: number;
}

export async function searchHansardDebates(
  params: {
    searchTerm: string;
    startDate?: string;
    endDate?: string;
    house?: 'Commons' | 'Lords';
    skip?: number;
    take?: number;
  } & FetchCtx,
): Promise<Fetched<{ results: DebateResult[]; total: number }>> {
  const res = await getJson<HansardSearchEnvelope>({
    source: 'hansard',
    path: '/search/debates.json',
    query: {
      'queryParameters.searchTerm': params.searchTerm,
      'queryParameters.startDate': params.startDate,
      'queryParameters.endDate': params.endDate,
      'queryParameters.house': params.house,
      'queryParameters.skip': params.skip ?? 0,
      'queryParameters.take': params.take ?? 20,
    },
    signal: params.signal,
    isEmpty: (v) => ((v as HansardSearchEnvelope)?.Results?.length ?? 0) === 0,
  });
  return {
    value: {
      results: res.value.Results ?? [],
      total: res.value.TotalResultCount ?? res.value.Results?.length ?? 0,
    },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

/**
 * One contribution by one member. Note the field names read differently from the
 * debate search above: here `DebateSection` is the debate's own title and
 * `Section` is the Hansard section it sat in ("Commons Chamber", "Westminster
 * Hall", "Written Statements"). The debate search reuses `DebateSection` for the
 * section instead, which is why the two are mapped separately at the tool.
 */
export interface ContributionResult {
  MemberId?: number;
  MemberName?: string;
  AttributedTo?: string;
  ContributionExtId?: string;
  ContributionText?: string;
  DebateSection?: string;
  DebateSectionExtId?: string;
  Section?: string;
  House?: string;
  SittingDate?: string;
}

interface ContributionsEnvelope {
  Results?: ContributionResult[];
  TotalResultCount?: number;
}

/**
 * Contributions by one member. The debate-search endpoint advertises a memberId
 * parameter but ignores it (measured: identical results and identical
 * TotalResultCount with, without, and with a nonexistent member), so restricting
 * to a member has to come from this endpoint, which does honour it.
 */
export async function searchHansardContributions(
  params: {
    searchTerm: string;
    memberId: number;
    contributionType?: 'Spoken' | 'Written';
    startDate?: string;
    endDate?: string;
    house?: 'Commons' | 'Lords';
    skip?: number;
    take?: number;
  } & FetchCtx,
): Promise<Fetched<{ results: ContributionResult[]; total: number }>> {
  const res = await getJson<ContributionsEnvelope>({
    source: 'hansard',
    path: `/search/contributions/${params.contributionType ?? 'Spoken'}.json`,
    query: {
      'queryParameters.searchTerm': params.searchTerm,
      'queryParameters.memberId': params.memberId,
      'queryParameters.startDate': params.startDate,
      'queryParameters.endDate': params.endDate,
      'queryParameters.house': params.house,
      'queryParameters.skip': params.skip ?? 0,
      'queryParameters.take': params.take ?? 20,
    },
    signal: params.signal,
    isEmpty: (v) => ((v as ContributionsEnvelope)?.Results?.length ?? 0) === 0,
  });
  return {
    value: {
      results: res.value.Results ?? [],
      total: res.value.TotalResultCount ?? res.value.Results?.length ?? 0,
    },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface DebateDetail {
  Overview?: {
    Id?: number;
    ExtId?: string;
    Title?: string;
    HRSTag?: string;
    Date?: string;
    House?: string;
    Location?: string;
  };
  Items?: Array<{
    ItemType?: string;
    MemberName?: string;
    MemberId?: number;
    Value?: string;
    AttributedTo?: string;
    OrderInSection?: number;
  }>;
  ChildDebates?: unknown[];
}

export async function getDebateByExtId(
  params: { extId: string } & FetchCtx,
): Promise<Fetched<DebateDetail | null>> {
  const res = await getJson<DebateDetail>({
    source: 'hansard',
    path: `/debates/debate/${params.extId}.json`,
    signal: params.signal,
  });
  return { value: res.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}
