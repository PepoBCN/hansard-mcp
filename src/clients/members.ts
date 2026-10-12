import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface MemberValue {
  id: number;
  nameDisplayAs: string;
  nameFullTitle?: string;
  latestParty?: { name?: string; abbreviation?: string };
  latestHouseMembership?: {
    membershipFrom?: string;
    membershipFromId?: number;
    house?: number;
    membershipStatus?: { statusIsActive?: boolean };
  };
  gender?: string;
  thumbnailUrl?: string;
}

interface MemberSearchEnvelope {
  items?: Array<{ value: MemberValue }>;
  totalResults?: number;
}

/**
 * `House` and `IsCurrentMember` are both honoured by the upstream, verified
 * against the live API rather than assumed: `House=1`/`House=2` return only
 * Commons/Lords rows, and `IsCurrentMember=true` returns 24 of the 53 rows an
 * unfiltered name search returns. Both therefore change `totalResults`, so
 * paging over a filtered search still walks the whole filtered record.
 *
 * `IsCurrentMember=false` is not "unrestricted", it is the complement: former
 * members only. "Current and former" is the parameter omitted, which is why
 * `currentOnly: false` drops it rather than sending false.
 *
 * Note the search returns former members with `statusIsActive` still true on
 * their latest membership, so that field cannot be used to re-check
 * `IsCurrentMember` locally. The upstream flag is the only reliable answer.
 */
export async function searchMembers(
  params: {
    name?: string;
    constituencyId?: number;
    house?: 'Commons' | 'Lords';
    currentOnly?: boolean;
    skip?: number;
    take?: number;
  } & FetchCtx,
): Promise<Fetched<{ items: MemberValue[]; total: number }>> {
  const res = await getJson<MemberSearchEnvelope>({
    source: 'members',
    path: '/Members/Search',
    query: {
      Name: params.name,
      ...(params.constituencyId !== undefined ? { ConstituencyId: params.constituencyId } : {}),
      ...(params.house !== undefined ? { House: params.house === 'Lords' ? 2 : 1 } : {}),
      ...((params.currentOnly ?? true) ? { IsCurrentMember: 'true' } : {}),
      skip: params.skip ?? 0,
      take: params.take ?? 20,
    },
    signal: params.signal,
    isEmpty: (v) => ((v as MemberSearchEnvelope)?.items?.length ?? 0) === 0,
  });
  return {
    value: {
      items: (res.value.items ?? []).map((i) => i.value),
      total: res.value.totalResults ?? res.value.items?.length ?? 0,
    },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface ConstituencyValue {
  id: number;
  name: string;
  startDate?: string;
  endDate?: string | null;
  currentRepresentation?: { member?: { value?: MemberValue } };
}

interface ConstituencySearchEnvelope {
  items?: Array<{ value: ConstituencyValue }>;
  totalResults?: number;
}

export async function searchConstituencies(
  params: { searchText?: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<ConstituencyValue[]>> {
  const res = await getJson<ConstituencySearchEnvelope>({
    source: 'members',
    path: '/Location/Constituency/Search',
    query: { searchText: params.searchText, skip: params.skip ?? 0, take: params.take ?? 10 },
    signal: params.signal,
    isEmpty: (v) => ((v as ConstituencySearchEnvelope)?.items?.length ?? 0) === 0,
  });
  return {
    value: (res.value.items ?? []).map((i) => i.value),
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface MemberDetail extends MemberValue {
  latestHouseMembership?: MemberValue['latestHouseMembership'] & {
    membershipStartDate?: string;
    membershipEndDate?: string | null;
  };
}

export async function getMember(
  params: { memberId: number } & FetchCtx,
): Promise<Fetched<MemberDetail | null>> {
  const res = await getJson<{ value?: MemberDetail }>({
    source: 'members',
    path: `/Members/${params.memberId}`,
    signal: params.signal,
  });
  return { value: res.value?.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

/** Small text/list endpoints on the member record, all the same envelope shape. */
async function memberScalar<T>(memberId: number, path: string, signal?: AbortSignal): Promise<Fetched<T | null>> {
  const res = await getJson<{ value?: T }>({
    source: 'members',
    path: `/Members/${memberId}/${path}`,
    signal,
  });
  return { value: res.value?.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export const getSynopsis = (p: { memberId: number } & FetchCtx) =>
  memberScalar<string>(p.memberId, 'Synopsis', p.signal);

export const getFocus = (p: { memberId: number } & FetchCtx) =>
  memberScalar<Array<{ category?: string; focus?: string[] }>>(p.memberId, 'Focus', p.signal);

export const getContact = (p: { memberId: number } & FetchCtx) =>
  memberScalar<Array<{ type?: string; line1?: string; email?: string; phone?: string }>>(
    p.memberId, 'Contact', p.signal);

export const getContributionSummary = (p: { memberId: number } & FetchCtx) =>
  memberScalar<Array<{ house?: string; recentContributionCount?: number }>>(
    p.memberId, 'ContributionSummary', p.signal);

export interface Post {
  id?: number;
  name?: string;
  house?: number;
  startDate?: string;
  endDate?: string | null;
  /** Upstream carries the department here rather than in a named field. */
  additionalInfo?: string | null;
  additionalInfoLink?: string | null;
}

export interface Biography {
  governmentPosts?: Post[];
  oppositionPosts?: Post[];
  otherPosts?: Post[];
  committeeMemberships?: Post[];
  partyAffiliations?: Post[];
  houseMemberships?: Post[];
  representations?: Array<{ name?: string; startDate?: string; endDate?: string | null }>;
}

/**
 * One call for every post type. There is no per-post-type endpoint — asking for
 * /Members/{id}/GovernmentPosts returns 404 — and the biography carries
 * government, opposition, other posts and committee memberships together.
 */
export async function getBiography(
  params: { memberId: number } & FetchCtx,
): Promise<Fetched<Biography | null>> {
  const res = await getJson<{ value?: Biography }>({
    source: 'members',
    path: `/Members/${params.memberId}/Biography`,
    signal: params.signal,
  });
  return { value: res.value?.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

/** One government or opposition post, with whoever currently holds it. */
export interface PostHolding {
  post_id?: number;
  post: string;
  hansard_name?: string;
  department: string | null;
  holder: string | null;
  holder_member_id: number | null;
  holder_party: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
}

interface RawPostHolder {
  member?: { value?: { id?: number; nameDisplayAs?: string; latestParty?: { name?: string } } };
  startDate?: string;
  endDate?: string | null;
}

interface RawPost {
  id?: number;
  name?: string;
  hansardName?: string;
  postHolders?: RawPostHolder[];
  governmentDepartments?: Array<{ name?: string }>;
  departments?: Array<{ name?: string }>;
}

function shapePosts(raw: RawPost[]): PostHolding[] {
  const out: PostHolding[] = [];
  for (const post of raw) {
    const department = post.governmentDepartments?.[0]?.name ?? post.departments?.[0]?.name ?? null;
    // A post with no holder is still a post; report it with a null holder
    // rather than dropping it, so a vacancy is visible instead of invisible.
    const holders = post.postHolders?.length ? post.postHolders : [undefined];
    for (const h of holders) {
      const member = h?.member?.value;
      out.push({
        post_id: post.id,
        post: post.name ?? 'Unknown post',
        hansard_name: post.hansardName,
        department,
        holder: member?.nameDisplayAs ?? null,
        holder_member_id: member?.id ?? null,
        holder_party: member?.latestParty?.name ?? null,
        start_date: h?.startDate ?? null,
        end_date: h?.endDate ?? null,
        is_current: Boolean(h) && !h?.endDate,
      });
    }
  }
  return out;
}

/**
 * Every government or opposition post at once, which is a different question
 * from "what has this member held" and needs a different endpoint.
 *
 * These are top-level `/Posts/...` collections. Note the per-member equivalents
 * do not exist: `/Members/{id}/GovernmentPosts` returns 404, which is why
 * `getBiography` above carries the per-member view instead.
 */
export async function getPosts(
  params: { branch: 'government' | 'opposition' } & FetchCtx,
): Promise<Fetched<PostHolding[]>> {
  const path = params.branch === 'opposition' ? '/Posts/OppositionPosts' : '/Posts/GovernmentPosts';
  const res = await getJson<Array<{ value?: RawPost }>>({
    source: 'members',
    path,
    signal: params.signal,
    isEmpty: (v) => (Array.isArray(v) ? v.length === 0 : true),
  });
  const raw = (Array.isArray(res.value) ? res.value : [])
    .map((r) => r.value)
    .filter((v): v is RawPost => Boolean(v));
  return { value: shapePosts(raw), cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface PartyStanding {
  name: string;
  abbreviation?: string;
  total: number;
}

export async function getStateOfParties(
  params: { house: 'Commons' | 'Lords'; forDate?: string } & FetchCtx,
): Promise<Fetched<PartyStanding[]>> {
  const date = params.forDate ?? new Date().toISOString().slice(0, 10);
  const houseId = params.house === 'Lords' ? 2 : 1;
  type Row = { total?: number; party?: { name?: string; abbreviation?: string } };
  const res = await getJson<{ items?: Array<{ value?: Row }> }>({
    source: 'members',
    path: `/Parties/StateOfTheParties/${houseId}/${date}`,
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  // The party name is nested under value.party, not value itself.
  const items = (res.value.items ?? [])
    .map((i) => i.value)
    .filter((v): v is Row => Boolean(v))
    .map((v) => ({
      name: v.party?.name ?? 'Unknown',
      abbreviation: v.party?.abbreviation,
      total: v.total ?? 0,
    }));
  return { value: items, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface ElectionResult {
  electionTitle?: string;
  electionDate?: string;
  majority?: number;
  turnout?: number;
  electorate?: number;
  result?: string;
  candidates?: Array<{
    name?: string;
    party?: { name?: string };
    votes?: number;
    resultChange?: string;
    rankOrder?: number;
  }>;
}

export async function getElectionResults(
  params: { constituencyId: number } & FetchCtx,
): Promise<Fetched<ElectionResult[]>> {
  const res = await getJson<{ value?: ElectionResult[] }>({
    source: 'members',
    path: `/Location/Constituency/${params.constituencyId}/ElectionResults`,
    signal: params.signal,
  });
  return { value: res.value?.value ?? [], cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export async function getLatestElectionResult(
  params: { constituencyId: number } & FetchCtx,
): Promise<Fetched<ElectionResult | null>> {
  const res = await getJson<{ value?: ElectionResult }>({
    source: 'members',
    path: `/Location/Constituency/${params.constituencyId}/ElectionResult/Latest`,
    signal: params.signal,
  });
  return { value: res.value?.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}
