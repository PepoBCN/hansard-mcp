import { EngineError } from '../core/errors.js';

export interface Window {
  from: string;
  to: string;
}

export const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function windowFor(lookbackDays: number, now: Date = new Date()): Window {
  const from = new Date(now.getTime() - lookbackDays * 86_400_000);
  return { from: toIsoDate(from), to: toIsoDate(now) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Open-ended start for a "to_date only" range. Hansard's own record starts in
 * 1803, so nothing in any of these upstreams predates this; it is a lower bound
 * that cannot exclude a real result, not a claim about coverage.
 */
const OPEN_START = '1800-01-01';

function assertIso(value: string, field: string): string {
  const date = value.trim();
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new EngineError(
      'BAD_INPUT',
      `${field} must be a calendar date in YYYY-MM-DD form; received "${value}".`,
      `Re-send ${field} as YYYY-MM-DD, for example "2026-03-01".`,
    );
  }
  return date;
}

/**
 * Absolute range as a `Window`, so `withinWindow` and every upstream that takes
 * a start and end date keep working unchanged.
 *
 * Either end may be omitted: a lone `from` runs to today, a lone `to` runs from
 * the open start. A reversed range is rejected rather than quietly returning
 * nothing, because an empty result here would be indistinguishable from
 * Parliament having done nothing in the period.
 */
export function windowFromRange(
  from?: string | null,
  to?: string | null,
  now: Date = new Date(),
): Window | null {
  if (!from && !to) return null;
  const start = from ? assertIso(from, 'from_date') : OPEN_START;
  const end = to ? assertIso(to, 'to_date') : toIsoDate(now);
  if (start > end) {
    throw new EngineError(
      'BAD_INPUT',
      `from_date (${start}) is after to_date (${end}).`,
      'Swap the two dates, or drop one to leave that end of the range open.',
    );
  }
  return { from: start, to: end };
}

/** How the window in a response was arrived at, so the caller can see which input won. */
export type WindowSource = 'from_date/to_date' | 'lookback_days' | 'query_phrase';

export interface ResolvedWindow {
  window: Window;
  source: WindowSource;
}

/**
 * Picks the window from whichever inputs were given, most explicit first: an
 * absolute range beats a lookback, and both beat a date phrase inferred from the
 * query. Returns null when the caller asked for no window at all, which is not
 * the same as asking for an empty one.
 */
export function resolveWindow(opts: {
  fromDate?: string | null;
  toDate?: string | null;
  lookbackDays?: number;
  inferredLookbackDays?: number;
  now?: Date;
}): ResolvedWindow | null {
  const now = opts.now ?? new Date();
  const absolute = windowFromRange(opts.fromDate, opts.toDate, now);
  if (absolute) return { window: absolute, source: 'from_date/to_date' };
  if (opts.inferredLookbackDays !== undefined) {
    return { window: windowFor(opts.inferredLookbackDays, now), source: 'query_phrase' };
  }
  if (opts.lookbackDays !== undefined) {
    return { window: windowFor(opts.lookbackDays, now), source: 'lookback_days' };
  }
  return null;
}

const DATE_PHRASE =
  /\b(?:in|over|during|for|from|within)?\s*(?:the\s+)?(?:last|past|previous|recent)\s+\d+\s*(?:day|days|week|weeks|month|months|year|years)\b|\b(?:last|past)\s+(?:day|week|month|year|quarter)\b|\b(?:this|since)\s+(?:week|month|year)\b/gi;

const UNIT_DAYS: Record<string, number> = {
  day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365,
};

/**
 * Splits a natural topic phrase into a search term and an inferred window.
 *
 * Matching upstream is against titles, so passing the user's whole phrase —
 * "climate change last 90 days" — matches nothing and silently returns an empty
 * briefing. Stripping the date phrase turns that into a working query.
 */
export function splitTopicAndWindow(raw: string): { topic: string; lookbackDays?: number } {
  const match = raw.match(/\b(?:last|past|previous|recent)\s+(\d+)\s*(day|days|week|weeks|month|months|year|years)\b/i);
  let lookbackDays: number | undefined;
  if (match?.[1] && match[2]) {
    const n = Number.parseInt(match[1], 10);
    const perUnit = UNIT_DAYS[match[2].toLowerCase()] ?? 1;
    const days = n * perUnit;
    if (Number.isFinite(days) && days > 0) lookbackDays = Math.min(365, days);
  }
  const topic = raw.replace(DATE_PHRASE, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[,;:]+$/, '').trim();
  return { topic: topic.length >= 2 ? topic : raw.trim(), ...(lookbackDays ? { lookbackDays } : {}) };
}

/** Upstream dates arrive in several shapes; normalise before comparing. */
export function withinWindow(dateish: string | null | undefined, w: Window): boolean {
  if (!dateish) return false;
  const d = dateish.slice(0, 10);
  return d >= w.from && d <= w.to;
}
