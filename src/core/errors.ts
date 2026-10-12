/**
 * Error taxonomy. Every failure that can reach a tool must map to one of these,
 * because the code is what ends up in `meta.sources_status[...].status` — and a
 * caller has to be able to tell "Parliament said nothing" from "we never asked".
 */
export type ErrorCode =
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CIRCUIT_OPEN'
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class EngineError extends Error {
  readonly code: ErrorCode;
  /** What the caller (usually a model) should do next. Never a bare restatement. */
  readonly remedy: string;
  readonly source?: string;
  readonly status?: number;

  constructor(
    code: ErrorCode,
    message: string,
    remedy: string,
    opts: { source?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'EngineError';
    this.code = code;
    this.remedy = remedy;
    this.source = opts.source;
    this.status = opts.status;
  }
}

export const isEngineError = (e: unknown): e is EngineError => e instanceof EngineError;

export function timeoutError(source: string, ms: number): EngineError {
  return new EngineError(
    'UPSTREAM_TIMEOUT',
    `${source} did not respond within ${ms}ms.`,
    'Treat this section as unknown, not empty. Retry once — this upstream is much faster when its CDN is warm.',
    { source },
  );
}

export function upstreamError(source: string, status: number, statusText: string): EngineError {
  return new EngineError(
    'UPSTREAM_ERROR',
    `${source} responded ${status} ${statusText}.`,
    'Parliament APIs return transient errors. Retry once; if it persists the data is genuinely unavailable, not absent.',
    { source, status },
  );
}

export function circuitOpenError(source: string): EngineError {
  return new EngineError(
    'CIRCUIT_OPEN',
    `${source} is failing repeatedly; requests are paused.`,
    'Do not assert an absence of results. Retry after the breaker closes.',
    { source },
  );
}
