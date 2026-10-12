import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { MockUpstream } from '../helpers/mockUpstream.js';
import { setUpstream, resetUpstreams } from '../../src/config.js';
import { cache } from '../../src/core/cache.js';

let client: Client;
const mock = new MockUpstream();

beforeAll(async () => {
  const base = await mock.start();
  mock.set({ kind: 'ok', body: { items: [], totalResults: 0 } });
  setUpstream('members', { base, timeoutMs: 500, ttlMs: 1_000 });
  await cache.clear();

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'conformance', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await mock.stop();
  resetUpstreams();
});

describe('MCP protocol conformance', () => {
  it('advertises all 15 tools with read-only annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'parliament_find_constituency',
      'parliament_find_member',
      'parliament_get_bill',
      'parliament_get_committee',
      'parliament_get_debate',
      'parliament_get_division',
      'parliament_get_election_results',
      'parliament_get_ministerial_roles',
      'parliament_get_state_of_parties',
      'parliament_member_interests',
      'parliament_member_overview',
      'parliament_member_voting_history',
      'parliament_search_divisions',
      'parliament_search_hansard',
      'parliament_topic_tracker',
    ]);

    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.inputSchema).toBeTruthy();
      // Every description must tell the model how to read a degraded result —
      // the contract is worthless if a tool forgets to explain it.
      expect(t.description, `${t.name} description omits the status contract`)
        .toMatch(/sources_status/);
    }
  });

  it('returns structuredContent alongside text', async () => {
    const res = await client.callTool({
      name: 'parliament_find_member',
      arguments: { query: 'Diane Abbott' },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { meta?: { request_id?: string } } | undefined;
    expect(structured?.meta?.request_id).toBeTruthy();

    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it('coerces a numeric string rather than rejecting it', async () => {
    // The previous engine hard-failed on lookback_days: "90" while its own
    // prompt told the model to send exactly that.
    const res = await client.callTool({
      name: 'parliament_search_hansard',
      arguments: { query: 'climate change', lookback_days: '90' },
    });
    expect(res.isError).toBeFalsy();
  });

  it('rejects genuinely invalid input, naming the offending field', async () => {
    // Schema violations are caught by the SDK before the handler runs. That is
    // fine: they are reproducible from the arguments alone, so unlike an
    // upstream failure they need no server-side request_id to diagnose. What
    // they must do is say which field is wrong.
    const res = await client.callTool({
      name: 'parliament_find_member',
      arguments: { query: 'x' }, // below min length
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/query/);
    expect(content[0]!.text).toMatch(/-32602/);
  });

  it('clamps an out-of-range value instead of failing the call', async () => {
    const res = await client.callTool({
      name: 'parliament_search_hansard',
      arguments: { query: 'climate change', limit: 9999 },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { data?: { limit?: number } };
    expect(structured?.data?.limit).toBe(10);
  });

  it('reports an unknown tool as an error result', async () => {
    const res = await client.callTool({ name: 'parliament_nope', arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/not found/);
  });
});

describe('prompts', () => {
  it('advertises the four prompts', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'draft-constituent-letter',
      'mp-report-card',
      'topic-tracker',
      'vote-explainer',
    ]);
  });

  it('every prompt carries the status contract', async () => {
    const { prompts } = await client.listPrompts();
    for (const p of prompts) {
      const got = await client.getPrompt({
        name: p.name,
        arguments: Object.fromEntries((p.arguments ?? []).map((a) => [a.name, 'climate change'])),
      });
      const text = (got.messages[0]!.content as { text: string }).text;
      expect(text, `${p.name} omits the status contract`).toMatch(/sources_status/);
      expect(text, `${p.name} omits the absence rule`).toMatch(/could not be retrieved/);
      expect(text, `${p.name} omits the licence line`).toMatch(/Open Parliament\s+Licence/);
    }
  });

  it('tells the model to pass lookback_days as a number, not a string', async () => {
    // The engine this replaces shipped a prompt saying "pass as a string number",
    // which primed the model to send "90" and trip the tool's own validation.
    const got = await client.getPrompt({
      name: 'topic-tracker',
      arguments: { topic: 'climate change', lookback_days: '90' },
    });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/lookback_days=90/);
    expect(text).toMatch(/\*\*number\*\*, not a string/);
    expect(text).not.toMatch(/as a string number/);
  });
});
