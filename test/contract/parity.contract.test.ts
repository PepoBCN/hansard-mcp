import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import { NOT_YET_SUPPORTED } from '../../src/compat.js';
import { tools as sourceTools } from '../../src/tools/index.js';

/**
 * Parity harness: the engine measured against the earlier mp-mcp 0.2.0 tool
 * interface it replaces.
 *
 * Existing connectors were built against the 0.2.0 surface, so the proof that
 * nothing was lost is read over the wire from both servers rather than trusted
 * from either codebase's account of itself.
 *
 * The two transports differ:
 *
 *   legacy  - session based, needs initialize + a session header
 *   engine  - stateless, a bare POST just works
 *
 * There are three things being compared, not two, because a deployment can lag
 * the repository: the legacy live surface, the engine's live surface, and the
 * surface this working tree would serve. A parameter present in the tree but
 * not on the box is a deploy that has not happened; a parameter in neither is a
 * lost ability. Only the second fails.
 *
 * The parity block only runs when PARITY_LEGACY_URL points at a running 0.2.0
 * server. The legacy-call checks at the bottom run against the engine alone.
 * Excluded from the default run for the same reason as the upstream contracts:
 * it needs the network.
 *
 *     PARITY_LEGACY_URL=http://localhost:3000/mcp npm run test:contract
 */
const LEGACY = process.env.PARITY_LEGACY_URL;
const ENGINE = process.env.PARITY_ENGINE_URL ?? 'https://hansard-mcp.feldberg.co/mcp';

/**
 * Parliament's upstreams are slow and uneven. `member_overview` measured 10.4s
 * against the deployed engine and the written-questions endpoint has been seen
 * at 25s cold. A parity test that times out faster than the thing it is
 * measuring reports a lost ability that is really just a slow CDN.
 */
const SLOW = 90_000;

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolDescriptor {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface PromptDescriptor {
  name: string;
  arguments?: { name: string }[];
}

/**
 * Both servers answer JSON-RPC over POST but reply as SSE, so the body is a
 * stream of `data: ` lines rather than a JSON document. Take the last frame:
 * that is the response to the request just sent.
 */
function parseSse(body: string): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) last = JSON.parse(line.slice(6)) as JsonRpcResponse;
  }
  if (last) return last;
  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    return null;
  }
}

const BASE_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'user-agent': 'parliament-mcp-engine/parity-test',
};

/**
 * One client covering both transports. The session handshake is the only
 * difference, so it is the only thing branched on; everything downstream sends
 * the same request either way.
 */
class McpClient {
  private sessionId: string | null = null;

  constructor(
    readonly label: string,
    readonly url: string,
    private readonly sessioned: boolean,
  ) {}

  private headers(): Record<string, string> {
    return this.sessionId ? { ...BASE_HEADERS, 'mcp-session-id': this.sessionId } : { ...BASE_HEADERS };
  }

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    expect(res.ok, `${this.label} ${method} -> HTTP ${res.status}: ${body.slice(0, 200)}`).toBe(true);

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const message = parseSse(body);
    expect(message, `${this.label} ${method} returned an unparseable body: ${body.slice(0, 200)}`).not.toBeNull();
    expect(
      message?.error,
      `${this.label} ${method} returned a JSON-RPC error: ${JSON.stringify(message?.error)}`,
    ).toBeUndefined();
    return message?.result ?? {};
  }

  async connect(): Promise<void> {
    if (!this.sessioned) return;
    await this.rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'parity-harness', version: '1.0.0' },
      },
      SLOW,
    );
    // The SDK will not serve tools/list until the client confirms it is ready.
    // This one is a notification, so there is no reply to read.
    await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(SLOW),
    });
  }

  async tools(): Promise<ToolDescriptor[]> {
    const result = await this.rpc('tools/list', {}, SLOW);
    return (result.tools ?? []) as ToolDescriptor[];
  }

  async prompts(): Promise<PromptDescriptor[]> {
    const result = await this.rpc('prompts/list', {}, SLOW);
    return (result.prompts ?? []) as PromptDescriptor[];
  }

  /** Returns the parsed envelope from the tool's single text content block. */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.rpc('tools/call', { name, arguments: args }, SLOW);
    expect(result.isError, `${this.label} ${name} reported isError`).toBeFalsy();
    const content = result.content as { type: string; text?: string }[] | undefined;
    const text = content?.find((c) => c.type === 'text')?.text;
    expect(text, `${this.label} ${name} returned no text content`).toBeTruthy();
    return JSON.parse(text as string) as Record<string, unknown>;
  }
}

const legacy = new McpClient('legacy', LEGACY ?? '', true);
const engine = new McpClient('engine', ENGINE, false);

let legacyTools: Map<string, ToolDescriptor>;
let engineTools: Map<string, ToolDescriptor>;
let legacyPrompts: Map<string, PromptDescriptor>;
let enginePrompts: Map<string, PromptDescriptor>;

/**
 * Vitest 4 swallows `console.log` from a passing test, and the known-gap list
 * is the one thing here that has to be readable on a green run.
 */
const report = (lines: string[]) => process.stdout.write(`\n${lines.join('\n')}\n\n`);

const byName = <T extends { name: string }>(items: T[]) => new Map(items.map((i) => [i.name, i]));
const params = (t?: ToolDescriptor) => Object.keys(t?.inputSchema?.properties ?? {});
const required = (t?: ToolDescriptor) => t?.inputSchema?.required ?? [];

/**
 * Parameters the 0.2.0 surface advertises that the engine deliberately does not, because
 * honouring them needs code that is not written yet. Sourced from the engine's
 * own NOT_YET_SUPPORTED rather than retyped here, so the allowlist and the
 * code's account of the gap cannot drift apart: closing a gap without trimming
 * that constant fails the staleness test, and opening a new one fails parity.
 */
const KNOWN_GAPS: Record<string, readonly string[]> = NOT_YET_SUPPORTED;

/**
 * The surface this working tree would serve, read straight off the wrapped tool
 * definitions without starting a server.
 *
 * It exists to tell two very different situations apart. A parameter missing
 * from the deployed engine but present here is a deployment that has not caught
 * up, which is a fact about the box; a parameter missing from both, and not in
 * NOT_YET_SUPPORTED, is a lost ability, which is a fact about the code. Only the
 * second is a build failure.
 */
type Shape = Record<string, z.ZodTypeAny>;
const shapeOf = (schema: unknown): Shape =>
  ((schema as z.ZodObject<z.ZodRawShape>)?.shape as unknown as Shape) ?? {};

const sourceParams = new Map(sourceTools.map((t) => [t.name, Object.keys(shapeOf(t.inputSchema))]));

/** A field is required when the schema rejects its absence. */
const sourceRequired = new Map(
  sourceTools.map((t) => [
    t.name,
    Object.entries(shapeOf(t.inputSchema))
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key),
  ]),
);

beforeAll(async () => {
  await engine.connect();
  if (!LEGACY) return;
  await legacy.connect();
  const [lt, et, lp, ep] = await Promise.all([legacy.tools(), engine.tools(), legacy.prompts(), engine.prompts()]);
  legacyTools = byName(lt);
  engineTools = byName(et);
  legacyPrompts = byName(lp);
  enginePrompts = byName(ep);
}, SLOW * 2);

describe.skipIf(!LEGACY)('parity with the mp-mcp 0.2.0 interface', () => {
  it('advertises every tool the 0.2.0 surface advertises', () => {
    const missing = [...legacyTools.keys()].filter((n) => !engineTools.has(n));
    const extra = [...engineTools.keys()].filter((n) => !legacyTools.has(n));
    // A superset is the goal, so extras are reported and allowed.
    if (extra.length) report([`PARITY: engine adds tools the 0.2.0 surface does not have: ${extra.join(', ')}`]);
    expect(missing, `tools the 0.2.0 surface advertises that the engine does not: ${missing.join(', ')}`).toEqual([]);
  });

  it('this working tree advertises every input parameter the 0.2.0 surface does, except the known gaps', () => {
    // Checked against the source rather than the deployment, so a lost ability
    // fails the build the moment it is written rather than after a deploy.
    const surprises: string[] = [];
    const known: string[] = [];

    for (const [name, legacyTool] of legacyTools) {
      const advertised = new Set(sourceParams.get(name) ?? []);
      const missing = params(legacyTool).filter((p) => !advertised.has(p));
      if (!missing.length) continue;

      const allowed = new Set(KNOWN_GAPS[name] ?? []);
      const expected = missing.filter((p) => allowed.has(p));
      const unexpected = missing.filter((p) => !allowed.has(p));

      if (expected.length) known.push(`  ${name}: ${expected.join(', ')}`);
      if (unexpected.length) surprises.push(`  ${name}: ${unexpected.join(', ')}`);
    }

    if (known.length) {
      report(['PARITY KNOWN GAPS (tracked in NOT_YET_SUPPORTED, not implemented yet):', ...known]);
    }
    expect(
      surprises,
      ['parameters the 0.2.0 surface advertises that the engine has lost, and which nothing is tracking:', ...surprises].join('\n'),
    ).toEqual([]);
  });

  it('keeps the known-gap list honest in both directions', () => {
    // A gap that has quietly been closed is good news, but leaving it in
    // NOT_YET_SUPPORTED turns the allowlist above into a place where a real
    // regression could hide. Trim the constant when the parameter lands.
    const stale: string[] = [];
    for (const [name, listed] of Object.entries(KNOWN_GAPS)) {
      const advertised = sourceParams.get(name);
      if (!advertised) {
        stale.push(`  ${name}: no such tool in src/tools`);
        continue;
      }
      const nowPresent = listed.filter((p) => advertised.includes(p));
      if (nowPresent.length) stale.push(`  ${name}: ${nowPresent.join(', ')}`);
    }
    expect(
      stale,
      ['NOT_YET_SUPPORTED lists parameters the engine now advertises. Delete these entries:', ...stale].join('\n'),
    ).toEqual([]);
  });

  it('the deployed engine advertises everything the 0.2.0 surface does, or is only behind this tree', () => {
    const lost: string[] = [];
    const pending: string[] = [];

    for (const [name, legacyTool] of legacyTools) {
      const engineTool = engineTools.get(name);
      if (!engineTool) continue; // Already failed above; do not double-report.

      const live = new Set(params(engineTool));
      const inSource = new Set(sourceParams.get(name) ?? []);
      const allowed = new Set(KNOWN_GAPS[name] ?? []);

      const missing = params(legacyTool).filter((p) => !live.has(p) && !allowed.has(p));
      const notDeployed = missing.filter((p) => inSource.has(p));
      const gone = missing.filter((p) => !inSource.has(p));

      if (notDeployed.length) pending.push(`  ${name}: ${notDeployed.join(', ')}`);
      if (gone.length) lost.push(`  ${name}: ${gone.join(', ')}`);
    }

    if (pending.length) {
      report([
        `PENDING DEPLOY: ${ENGINE} is behind this working tree. Implemented here, not yet serving:`,
        ...pending,
      ]);
    }
    expect(
      lost,
      ['parameters missing from the deployed engine and absent from this tree as well:', ...lost].join('\n'),
    ).toEqual([]);
  });

  it('requires nothing that the 0.2.0 surface left optional', () => {
    const tightened: string[] = [];
    for (const [name, legacyTool] of legacyTools) {
      const wasRequired = new Set(required(legacyTool));
      // Both the deployment and this tree, because a newly required field is a
      // rejected call either way and neither view is the whole story.
      const nowRequired = new Set(
        [...required(engineTools.get(name)), ...(sourceRequired.get(name) ?? [])].filter((f) => !wasRequired.has(f)),
      );
      if (nowRequired.size) tightened.push(`  ${name}: ${[...nowRequired].join(', ')}`);
    }
    expect(
      tightened,
      ['fields the engine requires that the 0.2.0 surface did not, so a working call would now be rejected:', ...tightened].join(
        '\n',
      ),
    ).toEqual([]);
  });

  it('advertises every prompt and every prompt argument the 0.2.0 surface advertises', () => {
    const missingPrompts = [...legacyPrompts.keys()].filter((n) => !enginePrompts.has(n));
    expect(missingPrompts, `prompts the 0.2.0 surface advertises that the engine does not: ${missingPrompts.join(', ')}`).toEqual(
      [],
    );

    const missingArgs: string[] = [];
    for (const [name, legacyPrompt] of legacyPrompts) {
      const enginePrompt = enginePrompts.get(name);
      if (!enginePrompt) continue;
      const advertised = new Set((enginePrompt.arguments ?? []).map((a) => a.name));
      const gone = (legacyPrompt.arguments ?? []).map((a) => a.name).filter((a) => !advertised.has(a));
      if (gone.length) missingArgs.push(`  ${name}: ${gone.join(', ')}`);
    }
    expect(
      missingArgs,
      ['prompt arguments the 0.2.0 surface advertises that the engine has lost:', ...missingArgs].join('\n'),
    ).toEqual([]);
  });
});

/**
 * Advertising a parameter is not the same as honouring it, and the whole point
 * of this project is that the difference has to be visible. These are calls
 * written the way existing connectors write them, in the 0.2.0 names, checked for a
 * result someone could actually use rather than merely a 200.
 */
describe('legacy calls still work against the engine', () => {
  it('search_divisions accepts `topic` where the engine calls it `query`', async () => {
    const env = await engine.call('parliament_search_divisions', { topic: 'climate change' });
    const data = env.data as { query?: string; divisions?: unknown[] };
    expect(data.query, 'the legacy `topic` was not mapped onto `query`').toBe('climate change');
    expect(Array.isArray(data.divisions) && data.divisions.length, 'no divisions returned for a broad topic').toBeTruthy();
  });

  it('get_committee accepts `name` where the engine calls it `query`', async () => {
    const env = await engine.call('parliament_get_committee', { name: 'Treasury' });
    const data = env.data as { found?: boolean; committees?: { name?: string }[] };
    expect(data.found, 'the Treasury Committee was not found from the legacy `name`').toBe(true);
    const names = (data.committees ?? []).map((c) => c.name ?? '');
    expect(names.some((n) => n.includes('Treasury')), `no Treasury committee in ${JSON.stringify(names)}`).toBe(true);
  });

  it('get_state_of_parties accepts `assembly: "Lords"` and really returns the Lords', async () => {
    const env = await engine.call('parliament_get_state_of_parties', { assembly: 'Lords' });
    const data = env.data as { house?: string; total_seats?: number; parties?: unknown[] };
    // The failure this guards is silent, not loud: an unmapped `assembly` used
    // to leave the Commons default in place and hand back the wrong chamber
    // with no error at all.
    expect(data.house, 'asked for the Lords and got another chamber').toBe('Lords');
    expect(data.total_seats ?? 0, 'no seats returned for the Lords').toBeGreaterThan(0);
    expect(Array.isArray(data.parties) && data.parties.length).toBeTruthy();
  });

  it('get_ministerial_roles with no arguments lists the government', async () => {
    const env = await engine.call('parliament_get_ministerial_roles', {});
    const data = env.data as { roles?: { post?: string; holder?: string }[] };
    const roles = data.roles ?? [];
    expect(roles.length, 'asking who is in the government returned nothing').toBeGreaterThan(5);
    expect(
      roles.some((r) => (r.post ?? '').toLowerCase().includes('prime minister')),
      'a government listing with no Prime Minister in it is not a government listing',
    ).toBe(true);
  });

  it('get_debate accepts a pasted Hansard URL', async () => {
    // Pinning a URL would rot, so take a live one from the engine's own
    // citations. That also checks the two halves agree: a URL this server
    // published as a source has to be one it can read back.
    const search = await engine.call('parliament_search_hansard', { query: 'climate change', limit: 3 });
    const sources = (search.sources ?? []) as { url?: string }[];
    const url = sources.map((s) => s.url ?? '').find((u) => u.includes('/debates/'));
    expect(url, 'search_hansard cited no debate URL to feed back in').toBeTruthy();

    const env = await engine.call('parliament_get_debate', { hansard_url: url });
    const data = env.data as { resolved_from?: string; found?: boolean; title?: string | null };
    expect(data.resolved_from, 'the URL was not recognised as the source of the id').toBe('url');
    expect(data.found, `the debate at ${url} was not found`).toBe(true);
    expect(data.title, 'the debate came back without a title').toBeTruthy();
  });
});
