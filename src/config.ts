import { z } from 'zod';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

/**
 * Real build metadata. The engine this replaces hard-coded `0.0.0`, which made it
 * impossible to tell from the wire whether a deployment was current.
 */
export const SERVER_NAME = 'parliament-mcp-engine';
export const SERVER_VERSION = process.env.MP_BUILD_VERSION ?? pkg.version;
export const BUILD_SHA = process.env.MP_BUILD_SHA ?? 'dev';
export const REPO_URL = 'https://github.com/PepoBCN/hansard-mcp';

const ConfigSchema = z.object({
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  port: z.coerce.number().int().min(1).max(65535).default(8093),
  host: z.string().default('127.0.0.1'),

  /**
   * Overall ceiling for one tool call. Deliberately generous: a slow section must
   * degrade to a reported status, never take the whole response down with it.
   */
  requestBudgetMs: z.coerce.number().int().min(1000).max(60_000).default(15_000),

  /** Default per-upstream timeout. Individual clients override this (see UPSTREAMS). */
  upstreamTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(6_000),
  upstreamMaxAttempts: z.coerce.number().int().min(1).max(5).default(2),
  upstreamBaseBackoffMs: z.coerce.number().int().min(0).max(5000).default(200),

  /** Per-upstream concurrency cap, so one slow API cannot starve the other nine. */
  bulkheadLimit: z.coerce.number().int().min(1).max(200).default(16),

  breakerFailureThreshold: z.coerce.number().int().min(1).max(50).default(5),
  breakerOpenMs: z.coerce.number().int().min(1000).max(600_000).default(30_000),

  cacheEnabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v !== 'false' && v !== '0' : v))
    .default(true),
  cacheMaxEntries: z.coerce.number().int().min(16).max(500_000).default(5_000),
  /** Serve stale up to this multiple of TTL while revalidating in the background. */
  cacheStaleMultiplier: z.coerce.number().min(1).max(100).default(10),
  /** Errors and empties are held briefly so a broken upstream is not hammered. */
  cacheNegativeTtlMs: z.coerce.number().int().min(0).max(600_000).default(60_000),

  userAgentSuffix: z.string().default(''),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Fail fast and loud on a bad value rather than booting into a broken state. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    logLevel: env.MP_LOG_LEVEL,
    port: env.MP_PORT,
    host: env.MP_HOST,
    requestBudgetMs: env.MP_REQUEST_BUDGET_MS,
    upstreamTimeoutMs: env.MP_UPSTREAM_TIMEOUT_MS,
    upstreamMaxAttempts: env.MP_UPSTREAM_MAX_ATTEMPTS,
    upstreamBaseBackoffMs: env.MP_UPSTREAM_BASE_BACKOFF_MS,
    bulkheadLimit: env.MP_BULKHEAD_LIMIT,
    breakerFailureThreshold: env.MP_BREAKER_FAILURE_THRESHOLD,
    breakerOpenMs: env.MP_BREAKER_OPEN_MS,
    cacheEnabled: env.MP_CACHE_ENABLED,
    cacheMaxEntries: env.MP_CACHE_MAX_ENTRIES,
    cacheStaleMultiplier: env.MP_CACHE_STALE_MULTIPLIER,
    cacheNegativeTtlMs: env.MP_CACHE_NEGATIVE_TTL_MS,
    userAgentSuffix: env.MP_USER_AGENT_SUFFIX,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export const USER_AGENT = [
  `${SERVER_NAME}/${SERVER_VERSION} (+${REPO_URL})`,
  config.userAgentSuffix,
]
  .filter(Boolean)
  .join(' ');

/**
 * Per-upstream tuning. Timeouts are set from observed p99, not one global number:
 * written questions measured 25.1s cold against 0.24s warm, and Hansard search 19.8s.
 * A single shared deadline is what silently dropped sections in the previous engine.
 */
export interface UpstreamSpec {
  key: SourceKey;
  base: string;
  timeoutMs: number;
  /** Default cache TTL for this upstream, overridable per call. */
  ttlMs: number;
}

export type SourceKey =
  | 'members'
  | 'postcodes'
  | 'hansard'
  | 'bills'
  | 'commonsVotes'
  | 'lordsVotes'
  | 'writtenQuestions'
  | 'petitions'
  | 'committees'
  | 'interests';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const envBase = (key: SourceKey, fallback: string): string =>
  process.env[`MP_UPSTREAM_BASE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`] ?? fallback;

export const UPSTREAMS: Record<SourceKey, UpstreamSpec> = {
  members: { key: 'members', base: envBase('members', 'https://members-api.parliament.uk/api'), timeoutMs: 6_000, ttlMs: DAY },
  postcodes: { key: 'postcodes', base: envBase('postcodes', 'https://api.postcodes.io'), timeoutMs: 4_000, ttlMs: 30 * DAY },
  hansard: { key: 'hansard', base: envBase('hansard', 'https://hansard-api.parliament.uk'), timeoutMs: 12_000, ttlMs: HOUR },
  bills: { key: 'bills', base: envBase('bills', 'https://bills-api.parliament.uk/api/v1'), timeoutMs: 8_000, ttlMs: HOUR },
  commonsVotes: { key: 'commonsVotes', base: envBase('commonsVotes', 'https://commonsvotes-api.parliament.uk/data'), timeoutMs: 6_000, ttlMs: HOUR },
  lordsVotes: { key: 'lordsVotes', base: envBase('lordsVotes', 'https://lordsvotes-api.parliament.uk/data'), timeoutMs: 6_000, ttlMs: HOUR },
  writtenQuestions: {
    key: 'writtenQuestions',
    base: envBase('writtenQuestions', 'https://questions-statements-api.parliament.uk/api/writtenquestions'),
    timeoutMs: 12_000,
    ttlMs: HOUR,
  },
  petitions: { key: 'petitions', base: envBase('petitions', 'https://petition.parliament.uk'), timeoutMs: 6_000, ttlMs: 15 * MIN },
  committees: { key: 'committees', base: envBase('committees', 'https://committees-api.parliament.uk/api'), timeoutMs: 8_000, ttlMs: HOUR },
  interests: { key: 'interests', base: envBase('interests', 'https://interests-api.parliament.uk/api/v1'), timeoutMs: 8_000, ttlMs: DAY },
};

/**
 * Redirect or retune an upstream at runtime. Used by the failure-injection suite
 * to point a client at a controllable mock, and by staging deployments that need
 * to hit a mirror rather than the live Parliament APIs.
 */
export function setUpstream(key: SourceKey, patch: Partial<Omit<UpstreamSpec, 'key'>>): void {
  UPSTREAMS[key] = { ...UPSTREAMS[key], ...patch };
}

const ORIGINAL_UPSTREAMS: Record<SourceKey, UpstreamSpec> = JSON.parse(JSON.stringify(UPSTREAMS));

export function resetUpstreams(): void {
  for (const k of Object.keys(ORIGINAL_UPSTREAMS) as SourceKey[]) {
    UPSTREAMS[k] = { ...ORIGINAL_UPSTREAMS[k] };
  }
}
