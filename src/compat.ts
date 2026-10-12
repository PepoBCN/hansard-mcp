/**
 * Backwards compatibility with the earlier mp-mcp 0.2.0 tool interface.
 *
 * The engine keeps the same 15 tool names but renamed a lot of their inputs, so
 * calls written against the 0.2.0 surface would fail against this one. Existing
 * connectors were built against that surface, so the engine has to accept
 * everything it accepts.
 *
 * The rule is a superset, never a replacement:
 *
 *   1. every parameter the 0.2.0 surface advertises is advertised, accepted and honoured,
 *   2. every parameter the engine added stays,
 *   3. where an upstream cannot honour a parameter, the response says so in
 *      `data` rather than pretending it applied.
 *
 * Point 3 matters more than it looks. Accepting a parameter and quietly
 * ignoring it is the same class of bug as reporting a timed-out source as an
 * empty result: the caller is told something that is not true. Anything in here
 * that cannot be honoured yet is listed in NOT_YET below rather than silently
 * accepted.
 *
 * Mechanically: each tool's schema is widened (legacy fields added, some
 * required fields relaxed) so `tools/list` advertises the full surface and the
 * SDK stops rejecting legacy calls. Arguments are then mapped back to canonical
 * names and re-parsed with the tool's original schema, so the tool bodies in
 * `src/tools/` never learn that any of this exists.
 */
import { z } from 'zod';
import type { ToolDefinition } from './tools/registry.js';
import { RESPONSE_FORMAT_VALUES, shortenFreeText, type ResponseFormat } from './tools/helpers.js';

type Args = Record<string, unknown>;

interface CompatSpec {
  /** Legacy-only fields to advertise and accept. Always optional. */
  legacy?: z.ZodRawShape;
  /** Canonical fields the 0.2.0 surface did not require, so the schema must not either. */
  relax?: string[];
  /**
   * Canonical fields that a legacy name can supply, so their default must not
   * be applied by the widened schema.
   *
   * This is subtle and it bit once: the SDK parses with the widened schema
   * before the handler runs, so a field declared `.default('Commons')` arrives
   * already set to "Commons". The rename then sees a value present, declines to
   * overwrite it, and `assembly: "Lords"` silently returns Commons data. Which
   * is precisely the silent-ignore failure this layer exists to prevent.
   *
   * Listing the field here strips the default from the widened schema only. The
   * tool's own schema still applies it after the rename, so the default still
   * happens, just in the right order.
   */
  defer?: string[];
  /** Maps legacy argument names onto canonical ones. */
  normalise?: (args: Args) => Args;
}

/**
 * Things the 0.2.0 surface accepts that are not yet honoured.
 *
 * **Currently empty: every parameter on that surface is now accepted and
 * honoured.** Kept, rather than deleted, because it is the mechanism that keeps
 * this layer honest. Anything listed here is asserted by the test suite NOT to
 * be advertised, and the parity harness fails both ways: a parameter that goes
 * missing fails, and one listed here that the code has started advertising also
 * fails, telling you to delete the entry.
 *
 * If a future parameter cannot be honoured, list it here rather than
 * advertising it. Advertising one the engine drops on the floor is worse than
 * not offering it, because the caller cannot tell the difference between a
 * filter that found nothing and a filter that never ran.
 */
export const NOT_YET_SUPPORTED: Record<string, readonly string[]> = {} as const;

/** The 0.2.0 surface spells the chamber `assembly`; the engine calls it `house`. */
const assemblyField = z
  .string()
  .optional()
  .describe('Legacy name for `house`. "Commons", "Lords", or "both" where the tool allows it.');

const HOUSES = ['Commons', 'Lords', 'both'] as const;

/** Accepts "commons", "COMMONS", "Commons" and returns the canonical casing. */
function canonicalHouse(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return HOUSES.find((h) => h.toLowerCase() === value.trim().toLowerCase());
}

/** Copies `from` onto `to` only when the canonical name was not given. */
function alias(args: Args, from: string, to: string): Args {
  if (args[from] === undefined) return args;
  const out = { ...args };
  if (out[to] === undefined) out[to] = out[from];
  delete out[from];
  return out;
}

function aliasHouse(args: Args): Args {
  if (args.assembly === undefined) return args;
  const out = { ...args };
  const house = canonicalHouse(out.assembly);
  if (out.house === undefined && house !== undefined) out.house = house;
  delete out.assembly;
  return out;
}

/**
 * Per-tool compatibility. Only renames and `response_format` are here; the
 * genuinely missing abilities are tracked in NOT_YET_SUPPORTED above.
 */
const SPECS: Record<string, CompatSpec> = {
  // No `defer` here: find_member's `house` is optional with no default, so
  // there is no default arriving early to block the rename. See `defer` above
  // for why that distinction matters.
  parliament_find_member: { legacy: { assembly: assemblyField }, normalise: aliasHouse },
  parliament_search_divisions: {
    legacy: {
      topic: z.string().min(2).optional().describe('Legacy name for `query`.'),
    },
    relax: ['query'],
    normalise: (a) => alias(a, 'topic', 'query'),
  },
  parliament_get_committee: {
    legacy: {
      name: z.string().min(2).optional().describe('Legacy name for `query`.'),
    },
    normalise: (a) => alias(a, 'name', 'query'),
  },
  parliament_get_state_of_parties: {
    legacy: {
      assembly: assemblyField,
      on_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Legacy name for `for_date`.'),
    },
    defer: ['house'],
    normalise: (a) => aliasHouse(alias(a, 'on_date', 'for_date')),
  },
  parliament_member_voting_history: {
    legacy: { assembly: assemblyField },
    defer: ['house'],
    normalise: aliasHouse,
  },
  parliament_search_hansard: {
    legacy: { assembly: assemblyField },
    defer: ['house'],
    normalise: aliasHouse,
  },
  parliament_get_division: {
    legacy: { assembly: assemblyField },
    defer: ['house'],
    normalise: aliasHouse,
  },
};

/**
 * `response_format` goes on every tool. topic_tracker already reads it itself
 * and selects extra fields per section, so it is passed straight through there
 * and applied centrally everywhere else.
 */
const SELF_HANDLES_RESPONSE_FORMAT = new Set(['parliament_topic_tracker']);

const responseFormatField = z
  .enum(RESPONSE_FORMAT_VALUES)
  .default('concise')
  .describe('`concise` (default) shortens long free text. `detailed` returns everything. Counts and statuses are identical either way.');

/**
 * Returns the field without its default, keeping the underlying type so the
 * advertised schema still documents the allowed values. Unwraps repeatedly
 * because a field can be wrapped more than once.
 */
function withoutDefault(field: z.ZodTypeAny): z.ZodTypeAny {
  let inner = field as z.ZodTypeAny & { def?: { type?: string; innerType?: z.ZodTypeAny } };
  while (inner?.def?.type === 'default' && inner.def.innerType) {
    inner = inner.def.innerType as typeof inner;
  }
  return inner.optional();
}

/**
 * Rebuilding the object from its shape drops any `.refine()` the tool declared,
 * such as get_debate's "one of debate_ext_id or hansard_url" and get_committee's
 * "one of committee_id or query".
 *
 * That is deliberate and safe. Those cross-field rules are relaxations as often
 * as they are constraints, and the tool's own schema still enforces them when
 * the handler re-parses, so an invalid call gets a clear BAD_INPUT error naming
 * the problem. What it costs is that the advertised schema is slightly more
 * permissive than the tool; each such tool says the rule in its description so
 * the model is still told.
 */
function widen(schema: z.ZodTypeAny, spec: CompatSpec): z.ZodTypeAny {
  const base = schema as unknown as z.ZodObject<z.ZodRawShape>;
  // Zod 4 types `.shape` as a readonly index signature of its internal base
  // type; the runtime values are ordinary schemas, so widen the type here
  // rather than fighting it at every use.
  const shape = base.shape as unknown as Record<string, z.ZodTypeAny> | undefined;
  if (!shape) return schema;

  const widened: Record<string, z.ZodTypeAny> = { ...shape };
  for (const key of spec.relax ?? []) {
    const field = widened[key];
    if (field) widened[key] = field.optional();
  }
  for (const key of spec.defer ?? []) {
    const field = widened[key];
    if (field) widened[key] = withoutDefault(field);
  }
  return z.object({ ...widened, ...(spec.legacy ?? {}), response_format: responseFormatField });
}

/**
 * Wraps one tool so it accepts the legacy surface. The tool's own schema still
 * does the real validation, so its handler cannot receive anything it did not
 * already understand.
 */
export function withCompat(tool: ToolDefinition): ToolDefinition {
  const spec = SPECS[tool.name] ?? {};
  const selfHandles = SELF_HANDLES_RESPONSE_FORMAT.has(tool.name);

  return {
    ...tool,
    inputSchema: widen(tool.inputSchema, spec) as ToolDefinition['inputSchema'],
    handler: async (input: unknown, ctx: { requestId: string }) => {
      const raw = { ...(input as Args) };
      const format = (raw.response_format as ResponseFormat | undefined) ?? 'concise';
      if (!selfHandles) delete raw.response_format;

      const normalised = spec.normalise ? spec.normalise(raw) : raw;
      // The tool's original schema is the authority: legacy names have been
      // mapped away by here, so anything still invalid is genuinely invalid.
      const parsed = tool.inputSchema.parse(normalised);
      const result = await tool.handler(parsed, ctx);

      if (selfHandles || format === 'detailed') return result;
      return conciseEnvelope(result);
    },
  };
}

/**
 * Shortens long free text inside `data` only. `meta` and `sources` are copied
 * across untouched, so no status, warning or citation can be lost to a
 * formatting choice.
 */
export function conciseEnvelope(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const env = result as Record<string, unknown>;
  if (!('data' in env)) return result;
  return { ...env, data: shortenFreeText(env.data) };
}

export const compatTools = (tools: ToolDefinition[]): ToolDefinition[] => tools.map(withCompat);

/**
 * Exposed for tests: maps legacy argument names onto canonical ones for a tool,
 * without touching the network. This is the whole of the rename behaviour, so
 * testing it here tests the thing that actually matters.
 */
export function normaliseArgs(toolName: string, args: Args): Args {
  const spec = SPECS[toolName];
  return spec?.normalise ? spec.normalise({ ...args }) : { ...args };
}
