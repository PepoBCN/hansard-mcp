/**
 * Parsing Parliament's own URLs back into ids.
 *
 * The legacy 0.2.0 tools accepted a pasted Hansard link, and pasting a link is the
 * natural way to ask about a specific debate or vote. The rebuild only accepted
 * internal ids, so that stopped working.
 *
 * Everything here is deliberately strict: a URL that cannot be parsed produces
 * an explicit failure naming what was expected. It must never fall through to
 * "no results", because an unreadable input silently returning an empty debate
 * is the same lie as a timed-out source returning an empty list.
 */

import { EngineError } from '../core/errors.js';

/** Hansard debate ids are GUIDs in the URL path after `/debates/`. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedDebateRef {
  ext_id: string;
  /** Where the value came from, so a caller can see it was a URL, not an id. */
  source: 'ext_id' | 'url';
}

export interface ParsedDivisionRef {
  division_id: number;
  house?: 'Commons' | 'Lords';
  source: 'division_id' | 'url';
}

/**
 * A bad reference is the caller's to fix, so this is BAD_INPUT rather than
 * INTERNAL. The distinction is not cosmetic: INTERNAL tells the caller to report
 * a request id and go looking in the server log, which would send someone
 * chasing a fault that does not exist.
 */
export class UnparseableReference extends EngineError {
  constructor(
    readonly input: string,
    readonly expected: string,
  ) {
    super(
      'BAD_INPUT',
      `Could not read "${input.slice(0, 120)}". Expected ${expected}.`,
      'Correct the reference and retry. Do not report this as no results found: nothing was looked up.',
    );
    this.name = 'UnparseableReference';
  }
}

function segments(raw: string): string[] | null {
  try {
    const url = new URL(raw.trim());
    if (!/(^|\.)parliament\.uk$/i.test(url.hostname)) return null;
    return url.pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
}

const houseOf = (parts: string[]): 'Commons' | 'Lords' | undefined =>
  parts.some((p) => p.toLowerCase() === 'lords')
    ? 'Lords'
    : parts.some((p) => p.toLowerCase() === 'commons')
      ? 'Commons'
      : undefined;

/**
 * Accepts a raw DebateSectionExtId or a hansard.parliament.uk debate URL, e.g.
 * https://hansard.parliament.uk/Commons/2026-01-14/debates/<guid>/<slug>
 */
export function parseDebateRef(raw: string): ParsedDebateRef {
  const value = raw.trim();
  if (!value) throw new UnparseableReference(raw, 'a debate ext id or a hansard.parliament.uk debate URL');

  if (!/^https?:\/\//i.test(value)) {
    // Not a URL, so treat it as an id. Ext ids are GUIDs, but accept any
    // sufficiently long opaque token rather than rejecting a valid id whose
    // format changes upstream.
    if (value.length >= 8 && !value.includes(' ')) return { ext_id: value, source: 'ext_id' };
    throw new UnparseableReference(raw, 'a debate ext id or a hansard.parliament.uk debate URL');
  }

  const parts = segments(value);
  if (!parts) {
    throw new UnparseableReference(raw, 'a URL on parliament.uk, e.g. https://hansard.parliament.uk/Commons/2026-01-14/debates/<id>/<title>');
  }

  const at = parts.findIndex((p) => p.toLowerCase() === 'debates');
  const candidate = at >= 0 ? parts[at + 1] : parts.find((p) => GUID.test(p));
  if (!candidate) {
    throw new UnparseableReference(raw, 'a Hansard debate URL containing /debates/<id>');
  }
  return { ext_id: decodeURIComponent(candidate), source: 'url' };
}

/**
 * Accepts a numeric DivisionId, or a votes.parliament.uk or hansard.parliament.uk
 * division URL, e.g. https://votes.parliament.uk/Votes/Commons/Division/1234
 */
export function parseDivisionRef(raw: string): ParsedDivisionRef {
  const value = String(raw).trim();
  if (!value) throw new UnparseableReference(raw, 'a numeric division id or a parliament.uk division URL');

  if (/^\d+$/.test(value)) return { division_id: Number(value), source: 'division_id' };

  const parts = segments(value);
  if (!parts) {
    throw new UnparseableReference(raw, 'a numeric division id, or a URL such as https://votes.parliament.uk/Votes/Commons/Division/1234');
  }

  // The id is the last numeric segment, whether the path says /Division/1234 or
  // /divisions/commons/1234.
  const numeric = [...parts].reverse().find((p) => /^\d+$/.test(p));
  if (!numeric) {
    throw new UnparseableReference(raw, 'a division URL ending in a numeric id');
  }
  return { division_id: Number(numeric), house: houseOf(parts), source: 'url' };
}
