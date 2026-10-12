import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface LordsDivision {
  divisionId: number;
  date: string;
  number?: number;
  title: string;
  contentCount: number;
  notContentCount: number;
  contents?: Array<{ memberId: number; name: string; party?: string }>;
  notContents?: Array<{ memberId: number; name: string; party?: string }>;
}

export async function getLordsDivision(
  params: { divisionId: number } & FetchCtx,
): Promise<Fetched<LordsDivision | null>> {
  const res = await getJson<LordsDivision>({
    source: 'lordsVotes',
    path: `/Divisions/${params.divisionId}`,
    signal: params.signal,
  });
  return { value: res.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface LordsMemberVote {
  divisionId: number;
  date: string;
  title: string;
  memberVotedContent?: boolean;
  memberWasTeller?: boolean;
}

/**
 * What the endpoint actually sends: the division sits under `publishedDivision`
 * and the member's own vote is `memberWasContent`. Flattened below so callers
 * keep the shape they already read; the flat fields are still accepted so a
 * fixture written against the old assumption is not silently emptied.
 */
interface LordsMemberVoteRaw extends Partial<LordsMemberVote> {
  memberWasContent?: boolean;
  memberWasTeller?: boolean;
  publishedDivision?: { divisionId?: number; date?: string; title?: string };
}

export async function getLordsMemberVoting(
  params: { memberId: number; searchTerm?: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<LordsMemberVote[]>> {
  const res = await getJson<LordsMemberVoteRaw[]>({
    source: 'lordsVotes',
    path: '/Divisions/membervoting',
    query: {
      MemberId: params.memberId,
      // Measured as a live title substring match. The tool re-checks it locally.
      SearchTerm: params.searchTerm,
      skip: params.skip ?? 0,
      take: params.take ?? 25,
    },
    signal: params.signal,
    isEmpty: (v) => (Array.isArray(v) ? v.length === 0 : true),
  });
  const rows = Array.isArray(res.value) ? res.value : [];
  return {
    value: rows.map((r) => ({
      divisionId: r.publishedDivision?.divisionId ?? r.divisionId ?? 0,
      date: r.publishedDivision?.date ?? r.date ?? '',
      title: r.publishedDivision?.title ?? r.title ?? '',
      memberVotedContent: r.memberWasContent ?? r.memberVotedContent,
      memberWasTeller: r.memberWasTeller,
    })),
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}
