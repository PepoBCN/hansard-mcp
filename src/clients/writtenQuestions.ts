import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface WrittenQuestion {
  id?: number;
  askingMemberId?: number;
  house: string;
  uin: string;
  questionText: string | null;
  dateTabled: string;
  dateAnswered?: string | null;
  answeringBodyName?: string;
}

interface WrittenQuestionsEnvelope {
  results?: Array<{ value: WrittenQuestion } | WrittenQuestion>;
  totalResults?: number;
}

/**
 * The slowest upstream measured: 25.1s cold against 0.24s warm, and a 500 at 32s.
 * It gets a 12s per-call budget (see UPSTREAMS) and leans hardest on the cache.
 */
export async function searchWrittenQuestions(
  params: {
    searchTerm: string;
    askedStartDate?: string;
    askedEndDate?: string;
    memberId?: number;
    skip?: number;
    take?: number;
  } & FetchCtx,
): Promise<Fetched<WrittenQuestion[]>> {
  const res = await getJson<WrittenQuestionsEnvelope>({
    source: 'writtenQuestions',
    path: '/questions',
    query: {
      searchTerm: params.searchTerm,
      askedStartDate: params.askedStartDate,
      askedEndDate: params.askedEndDate,
      ...(params.memberId !== undefined ? { askingMemberId: params.memberId } : {}),
      take: params.take ?? 20,
      skip: params.skip ?? 0,
    },
    signal: params.signal,
    isEmpty: (v) => ((v as WrittenQuestionsEnvelope)?.results?.length ?? 0) === 0,
  });
  const rows = (res.value.results ?? []).map((e) =>
    e && typeof e === 'object' && 'value' in e ? (e as { value: WrittenQuestion }).value : (e as WrittenQuestion),
  );
  return { value: rows, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}
