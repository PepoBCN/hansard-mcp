import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface CommitteeSummary {
  id: number;
  name: string;
  category?: string;
  // The API sends `house` as 'Commons' | 'Lords' | 'Joint'; the booleans are
  // kept only as a fallback in case an older shape comes back.
  house?: string | null;
  isCommons?: boolean;
  isLords?: boolean;
  startDate?: string;
  endDate?: string | null;
  purpose?: string | null;
}

interface CommitteeListEnvelope {
  items?: CommitteeSummary[];
  totalResults?: number;
}

export async function searchCommittees(
  params: { searchTerm?: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<{ items: CommitteeSummary[]; total: number }>> {
  const res = await getJson<CommitteeListEnvelope>({
    source: 'committees',
    path: '/Committees',
    query: { SearchTerm: params.searchTerm, Skip: params.skip ?? 0, Take: params.take ?? 20 },
    signal: params.signal,
    isEmpty: (v) => ((v as CommitteeListEnvelope)?.items?.length ?? 0) === 0,
  });
  return {
    value: { items: res.value.items ?? [], total: res.value.totalResults ?? 0 },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export async function getCommittee(
  params: { committeeId: number } & FetchCtx,
): Promise<Fetched<CommitteeSummary | null>> {
  const res = await getJson<CommitteeSummary>({
    source: 'committees',
    path: `/Committees/${params.committeeId}`,
    signal: params.signal,
  });
  return { value: res.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

// Shape measured against committees-api.parliament.uk on 25 Sep 2026: the
// display name is `memberInfo.displayAs` (not the Members API's
// `nameDisplayAs`), lay members carry only the top-level `name`, and each role
// is nested as `roles[].role.name`.
export interface CommitteeMember {
  name?: string;
  isLayMember?: boolean;
  memberInfo?: { mnisId?: number; displayAs?: string; party?: string; house?: string };
  roles?: Array<{ role?: { name?: string }; endDate?: string | null }>;
}

export async function getCommitteeMembers(
  params: { committeeId: number; take?: number } & FetchCtx,
): Promise<Fetched<CommitteeMember[]>> {
  const res = await getJson<{ items?: CommitteeMember[] }>({
    source: 'committees',
    path: `/Committees/${params.committeeId}/Members`,
    // Without MembershipStatus the API returns past members too, oldest first,
    // so the first page is mostly people who left years ago.
    query: { MembershipStatus: 'Current', Take: params.take ?? 50 },
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  return { value: res.value.items ?? [], cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface OralEvidenceSession {
  id: number;
  activityId?: number;
  meetingDate?: string;
  publicationDate?: string;
  committeeBusinesses?: Array<{ id?: number; title?: string }>;
  witnesses?: Array<{
    name?: string | null;
    organisations?: Array<{ name?: string; role?: string }>;
  }>;
}

/**
 * Oral evidence sessions. A separate endpoint from /Committees, which carries
 * structure only; there is no sessions collection on the committee record.
 */
export async function getCommitteeOralEvidence(
  params: { committeeId: number; take?: number } & FetchCtx,
): Promise<Fetched<{ items: OralEvidenceSession[]; total: number }>> {
  const res = await getJson<{ items?: OralEvidenceSession[]; totalResults?: number }>({
    source: 'committees',
    path: '/OralEvidence',
    query: { CommitteeId: params.committeeId, Take: params.take ?? 10 },
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  return {
    value: { items: res.value.items ?? [], total: res.value.totalResults ?? res.value.items?.length ?? 0 },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface CommitteePublication {
  id: number;
  description?: string;
  publicationStartDate?: string;
  type?: { id?: number; name?: string };
  hcNumber?: { number?: string } | null;
  hlPaper?: { number?: string } | null;
}

/** Published output: reports, government responses, formal minutes and the rest. */
export async function getCommitteePublications(
  params: { committeeId: number; take?: number } & FetchCtx,
): Promise<Fetched<{ items: CommitteePublication[]; total: number }>> {
  const res = await getJson<{ items?: CommitteePublication[]; totalResults?: number }>({
    source: 'committees',
    path: '/Publications',
    query: { CommitteeId: params.committeeId, Take: params.take ?? 10 },
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  return {
    value: { items: res.value.items ?? [], total: res.value.totalResults ?? res.value.items?.length ?? 0 },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface CommitteeMembershipOfMember {
  committee?: { id: number; name: string };
  roles?: Array<{ name?: string; startDate?: string; endDate?: string | null }>;
}

export async function getMemberCommittees(
  params: { memberId: number; take?: number } & FetchCtx,
): Promise<Fetched<CommitteeMembershipOfMember[]>> {
  const res = await getJson<{ items?: CommitteeMembershipOfMember[] }>({
    source: 'committees',
    path: '/Members',
    query: { MembershipStatus: 'Current', Take: params.take ?? 30, MnisId: params.memberId },
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  return { value: res.value.items ?? [], cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}
