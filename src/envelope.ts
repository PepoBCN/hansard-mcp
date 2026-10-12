import { z } from 'zod';
import type { SourceStatus } from './core/budget.js';
import { SERVER_VERSION, BUILD_SHA } from './config.js';

export interface Source {
  title: string;
  url: string;
}

export interface Envelope<T> {
  data: T;
  sources: Source[];
  meta: {
    request_id: string;
    generated_at: string;
    engine: { version: string; sha: string };
    partial: boolean;
    sources_status: Record<string, SourceStatus>;
    warnings?: string[];
  };
}

export const SourceStatusSchema = z.object({
  status: z.enum(['ok', 'timeout', 'upstream_error', 'circuit_open', 'unavailable']),
  ms: z.number(),
  cache: z.enum(['hit', 'miss', 'stale', 'bypass', 'none']),
  age_seconds: z.number().optional(),
  detail: z.string().optional(),
});

export const MetaSchema = z.object({
  request_id: z.string(),
  generated_at: z.string(),
  engine: z.object({ version: z.string(), sha: z.string() }),
  partial: z.boolean(),
  sources_status: z.record(z.string(), SourceStatusSchema),
  warnings: z.array(z.string()).optional(),
});

/** Wraps every tool result. There is no other way to return data from a tool. */
export function buildEnvelope<T>(
  data: T,
  sources: Source[],
  opts: {
    requestId: string;
    statuses: Record<string, SourceStatus>;
    partial: boolean;
    warnings?: string[];
  },
): Envelope<T> {
  return {
    data,
    sources: dedupeSources(sources),
    meta: {
      request_id: opts.requestId,
      generated_at: new Date().toISOString(),
      engine: { version: SERVER_VERSION, sha: BUILD_SHA },
      partial: opts.partial,
      sources_status: opts.statuses,
      ...(opts.warnings?.length ? { warnings: opts.warnings } : {}),
    },
  };
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/**
 * The rule this engine exists to enforce, made executable.
 *
 * An empty section is only reportable as "there were none" when its source
 * status is `ok`. Anything else is unknown, and callers must say so. Prompts and
 * tests both consult this rather than re-deriving the logic.
 */
export function isReportableAbsence(status: SourceStatus | undefined): boolean {
  return status?.status === 'ok';
}

export function absenceLabel(section: string, status: SourceStatus | undefined): string {
  return isReportableAbsence(status)
    ? `No ${section} found in this window.`
    : `${section} could not be retrieved (${status?.status ?? 'unknown'}) — this is not evidence that none exist.`;
}
