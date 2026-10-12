import { getJson } from '../core/http.js';
import type { FetchCtx, Fetched } from './types.js';

export interface BillSummary {
  billId: number;
  shortTitle: string;
  currentHouse?: string;
  isAct: boolean;
  isDefeated?: boolean;
  lastUpdate?: string;
  currentStage?: { description?: string; house?: string };
}

interface BillsEnvelope {
  items?: BillSummary[];
  totalResults?: number;
}

export async function searchBills(
  params: { searchTerm: string; skip?: number; take?: number } & FetchCtx,
): Promise<Fetched<{ items: BillSummary[]; total: number }>> {
  const res = await getJson<BillsEnvelope>({
    source: 'bills',
    path: '/Bills',
    query: { SearchTerm: params.searchTerm, Skip: params.skip ?? 0, Take: params.take ?? 20 },
    signal: params.signal,
    isEmpty: (v) => ((v as BillsEnvelope)?.items?.length ?? 0) === 0,
  });
  return {
    value: { items: res.value.items ?? [], total: res.value.totalResults ?? 0 },
    cacheState: res.cacheState,
    ageSeconds: res.ageSeconds,
  };
}

export interface BillDetail extends BillSummary {
  longTitle?: string;
  summary?: string | null;
  originatingHouse?: string;
  introducedSessionId?: number;
  sponsors?: Array<{ member?: { name?: string; party?: string; memberId?: number } }>;
}

export async function getBill(
  params: { billId: number } & FetchCtx,
): Promise<Fetched<BillDetail | null>> {
  const res = await getJson<BillDetail>({
    source: 'bills',
    path: `/Bills/${params.billId}`,
    signal: params.signal,
  });
  return { value: res.value ?? null, cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}

export interface BillStage {
  id: number;
  stageId?: number;
  description?: string;
  house?: string;
  stageSittings?: Array<{ date?: string }>;
}

export async function getBillStages(
  params: { billId: number; take?: number } & FetchCtx,
): Promise<Fetched<BillStage[]>> {
  const res = await getJson<{ items?: BillStage[] }>({
    source: 'bills',
    path: `/Bills/${params.billId}/Stages`,
    query: { Take: params.take ?? 30 },
    signal: params.signal,
    isEmpty: (v) => ((v as { items?: unknown[] })?.items?.length ?? 0) === 0,
  });
  return { value: res.value.items ?? [], cacheState: res.cacheState, ageSeconds: res.ageSeconds };
}
