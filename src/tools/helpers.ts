import { z } from 'zod';
import { fanOut, valueOf } from '../core/budget.js';
import { buildEnvelope, type Source } from '../envelope.js';
import { callLogger } from '../core/logger.js';
import { EngineError } from '../core/errors.js';
import type { CacheState } from '../core/cache.js';

type Loaded<T> = { value: T; cacheState?: CacheState; ageSeconds?: number };

/**
 * The common shape: fan out to one or more sources, then build an envelope from
 * whatever came back. Keeps every tool on the same status contract instead of
 * each reinventing how a failure is reported.
 */
export async function withSources<T>(
  opts: {
    tool: string;
    requestId: string;
    sources: Record<string, (signal: AbortSignal) => Promise<Loaded<unknown>>>;
  },
  build: (get: <V>(key: string) => V | null) => { data: T; citations: Source[] },
) {
  const log = callLogger(opts.requestId, opts.tool);
  const fan = await fanOut(
    Object.entries(opts.sources).map(([key, run]) => ({ key, run })),
    { log, tool: opts.tool },
  );
  const get = <V,>(key: string): V | null => valueOf<V>(fan.results[key]);
  const { data, citations } = build(get);
  return buildEnvelope(data, citations, {
    requestId: opts.requestId,
    statuses: fan.statuses,
    partial: fan.partial,
    warnings: fan.warnings,
  });
}

/**
 * For lookups of one specific record: if the source failed we must not pretend
 * the record does not exist. Distinguishes "no such thing" from "we couldn't ask".
 */
export function requireFound<V>(
  value: V | null,
  opts: { key: string; what: string; statuses: Record<string, { status: string }> },
): V | null {
  const status = opts.statuses[opts.key]?.status;
  if (value === null && status && status !== 'ok') {
    throw new EngineError(
      'UPSTREAM_UNAVAILABLE',
      `Could not load ${opts.what}: ${opts.key} reported ${status}.`,
      'This is not evidence the record does not exist. Retry, and do not report it as missing.',
      { source: opts.key },
    );
  }
  return value;
}

/** Standard pagination block, so every list tool reports it the same way. */
export function page(offset: number, limit: number, returned: number, total: number) {
  const seen = offset + returned;
  return {
    total,
    offset,
    limit,
    has_more: seen < total,
    next_offset: seen < total ? seen : null,
  };
}

/**
 * `response_format` was on all 15 tools of the earlier mp-mcp 0.2.0 interface; the rebuild kept it only on
 * topic_tracker, where it selects extra per-section fields. That richer,
 * hand-tuned behaviour stays as it is.
 *
 * For every other tool this is the shared meaning: `detailed` returns the
 * response untouched, `concise` shortens long free text and nothing else. It
 * never removes a key, never touches `meta`, `sources` or any status, and never
 * changes a count. A compact shape that dropped a status field would turn a
 * failed lookup back into an apparent absence, which is the bug this engine
 * exists to prevent.
 */
export const RESPONSE_FORMAT_VALUES = ['concise', 'detailed'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMAT_VALUES)[number];

/** Longer free-text than this is trimmed in `concise`. Structure is untouched. */
const CONCISE_TEXT_LIMIT = 300;

export function conciseText(value: string): string {
  return value.length <= CONCISE_TEXT_LIMIT ? value : `${value.slice(0, CONCISE_TEXT_LIMIT).trimEnd()}…`;
}

/**
 * Applies `concise` to a tool's `data` block only. Callers must never pass the
 * envelope itself, so `meta` and `sources` cannot be reached from here.
 */
export function shortenFreeText<T>(data: T): T {
  if (typeof data === 'string') return conciseText(data) as unknown as T;
  if (Array.isArray(data)) return data.map((v) => shortenFreeText(v)) as unknown as T;
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = shortenFreeText(v);
    return out as T;
  }
  return data;
}

/**
 * Absolute date range, as the legacy 0.2.0 surface spelled it. Declared once so all four
 * tools that take a range advertise it identically; the range itself is turned
 * into a `Window` by `resolveWindow`, which is also where a reversed range is
 * rejected.
 */
export const fromDateField = z
  .string()
  .optional()
  .describe('Earliest date to include, YYYY-MM-DD. Takes precedence over `lookback_days`.');

export const toDateField = z
  .string()
  .optional()
  .describe('Latest date to include, YYYY-MM-DD. Defaults to today when only `from_date` is given.');

/**
 * Said in the response whenever a date range was applied to the page an upstream
 * returned rather than to the query itself. The distinction is the difference
 * between "nothing happened in March" and "nothing in the most recent page
 * happened in March", and the caller has no way to tell them apart otherwise.
 */
export const SERVER_SIDE_DATE_NOTE =
  'The upstream does not accept a date range, so the window was applied here, to the page it returned. Entries outside the window were removed; older matches beyond this page were never fetched, so treat this as a filtered page, not an exhaustive search of the period. Page further with `next_offset` to widen it.';

/** Shared wording so no tool description forgets to explain the status contract. */
export const STATUS_NOTE =
  'IMPORTANT: an empty result means "none exist" ONLY when every entry in `meta.sources_status` reads "ok". Any other status means the lookup could not be completed — say so rather than asserting an absence.';
