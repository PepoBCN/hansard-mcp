#!/usr/bin/env node
/**
 * Eval runner for test/evals/parliament.xml.
 *
 * Hits a live stateless MCP endpoint, chains the tool calls each question needs,
 * and compares what came back with the verified answer in the XML.
 *
 * Honesty rules this file is written to, because a green runner that checks
 * nothing is worse than no runner:
 *
 *   - A pair is only reported PASS when a tool response actually yields the
 *     answer string. Nine of the twelve are like that.
 *   - One pair asks which of several posts is the most senior. Seniority is not
 *     in the API, so ranking it is a judgement call. It is reported UNSCORED and
 *     the retrieved posts are printed for a human to read.
 *   - Two pairs ask whether a given response shape may be read as an absence.
 *     The answer is a matter of interpretation, not a value any tool returns, so
 *     they are run as CONTRACT checks: they assert the machine-readable evidence
 *     the correct answer depends on is present in a live response. A failing
 *     contract check is a real failure; a passing one is not a claim that the
 *     prose answer was scored.
 *
 * Usage:
 *   node scripts/run-evals.mjs [--base <url>] [--only <n,n>] [--verbose]
 *   MCP_BASE_URL=http://127.0.0.1:8093/mcp node scripts/run-evals.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = resolve(HERE, '../test/evals/parliament.xml');

const DEFAULT_BASE = 'https://hansard-mcp.feldberg.co/mcp';
const CALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { base: process.env.MCP_BASE_URL ?? DEFAULT_BASE, only: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') out.base = argv[++i];
    else if (arg === '--only') out.only = new Set(argv[++i].split(',').map((n) => Number(n.trim())));
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/run-evals.mjs [--base <url>] [--only 1,2,3] [--verbose]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

// ------------------------------------------------------------- XML parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

/**
 * Hand-rolled rather than a dependency: the file is a flat list of qa_pair
 * elements with two leaf children and no attributes or namespaces.
 */
function parseEvalXml(xml) {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const pairs = [];
  for (const block of withoutComments.matchAll(/<qa_pair>([\s\S]*?)<\/qa_pair>/g)) {
    const body = block[1];
    const question = /<question>([\s\S]*?)<\/question>/.exec(body);
    const answer = /<answer>([\s\S]*?)<\/answer>/.exec(body);
    if (!question || !answer) {
      throw new Error(`qa_pair is missing a question or an answer:\n${body.trim()}`);
    }
    pairs.push({
      question: decode(question[1]).replace(/\s+/g, ' ').trim(),
      answer: decode(answer[1]).replace(/\s+/g, ' ').trim(),
    });
  }
  if (pairs.length === 0) throw new Error('No qa_pair elements found.');
  return pairs;
}

// ---------------------------------------------------------------- MCP client

class McpError extends Error {}

/**
 * The engine speaks stateless Streamable HTTP: a bare JSON-RPC POST with no
 * initialize handshake, answered as a single SSE frame.
 */
function createClient(baseUrl, verbose) {
  let nextId = 1;
  // Several pairs need the same lookup. Reusing the first response keeps the run
  // short and stops one slow upstream being paid for twice.
  const memo = new Map();

  async function post(name, args) {
    const id = nextId++;
    const started = Date.now();
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    const body = await response.text();
    if (!response.ok) throw new McpError(`${name}: HTTP ${response.status} ${body.slice(0, 300)}`);

    const frames = [];
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) frames.push(line.slice(6));
    }
    // A server answering application/json rather than SSE is still valid.
    if (frames.length === 0) frames.push(body);

    let message = null;
    for (const frame of frames) {
      const parsed = JSON.parse(frame);
      if (parsed.id === id) message = parsed;
    }
    if (!message) throw new McpError(`${name}: no JSON-RPC response with id ${id}`);
    if (message.error) throw new McpError(`${name}: ${message.error.message ?? JSON.stringify(message.error)}`);

    const result = message.result ?? {};
    if (result.isError) {
      throw new McpError(`${name}: tool reported an error: ${JSON.stringify(result.content).slice(0, 300)}`);
    }

    const envelope = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null');
    if (!envelope) throw new McpError(`${name}: response carried no envelope`);

    if (verbose) console.log(`    -> ${name} ${Date.now() - started}ms`);
    return envelope;
  }

  function call(name, args) {
    const key = `${name}:${JSON.stringify(args)}`;
    if (!memo.has(key)) memo.set(key, post(name, args));
    return memo.get(key);
  }

  return { call };
}

// ------------------------------------------------------------- comparison

const normalise = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function matches(actual, expected) {
  if (actual === null || actual === undefined) return false;
  const a = normalise(actual);
  const b = normalise(expected);
  if (a === b) return true;
  // Numbers are compared as numbers so "7,247" and 7247 agree.
  const an = Number(a.replace(/,/g, ''));
  const bn = Number(b.replace(/,/g, ''));
  return Number.isFinite(an) && Number.isFinite(bn) && an === bn;
}

// -------------------------------------------------------------- resolvers

const dateOnly = (value) => (typeof value === 'string' ? value.slice(0, 10) : null);

async function divisionByTitle(client, query, { title, onDate } = {}) {
  const search = await client.call('parliament_search_divisions', {
    query,
    lookback_days: 3650,
    limit: 50,
  });
  const wanted = (search.data?.divisions ?? []).filter(
    (d) =>
      (title === undefined || normalise(d.title) === normalise(title)) &&
      (onDate === undefined || dateOnly(d.date) === onDate),
  );
  if (wanted.length !== 1) {
    throw new McpError(`expected exactly one division matching ${title ?? query}, got ${wanted.length}`);
  }
  return client.call('parliament_get_division', { division_id: wanted[0].division_id, house: 'Commons' });
}

/**
 * `latest_only` is not a convenience here: the full-history upstream returns
 * elections without their candidate lists, so the winner is only reachable from
 * the latest-contest call. The election title is checked either way, so a later
 * contest would fail the pair rather than quietly answer about the wrong one.
 */
async function islingtonNorth2024(client, { withCandidates = false } = {}) {
  const found = await client.call('parliament_find_constituency', { query: 'Islington North' });
  const seat = (found.data?.constituencies ?? []).find((c) => normalise(c.name) === 'islington north');
  if (!seat) throw new McpError('Islington North was not resolved to a constituency id');
  const results = await client.call('parliament_get_election_results', {
    constituency_id: seat.constituency_id,
    latest_only: withCandidates,
  });
  const election = (results.data?.elections ?? []).find((e) => /2024 general election/i.test(e.election ?? ''));
  if (!election) throw new McpError('no 2024 general election result for Islington North');
  return election;
}

/**
 * Each check is matched to a qa_pair by a distinctive phrase from the question,
 * so reordering or editing the XML surfaces as an explicit mapping failure
 * rather than silently scoring the wrong pair.
 */
const CHECKS = [
  {
    match: /Credit Limit\) Order 2026\. What was the majority/,
    kind: 'scored',
    tools: 'search_divisions -> get_division',
    async run(client) {
      const division = await divisionByTitle(client, 'Draft Climate Change Act 2008 (Credit Limit) Order 2026', {
        title: 'Draft Climate Change Act 2008 (Credit Limit) Order 2026',
      });
      return division.data?.majority;
    },
  },
  {
    match: /simply titled "Climate Change" on 20 July 2016/,
    kind: 'scored',
    tools: 'search_divisions -> get_division',
    async run(client) {
      const division = await divisionByTitle(client, 'Climate Change', {
        title: 'Climate Change',
        onDate: '2016-07-20',
      });
      return division.data?.majority;
    },
  },
  {
    match: /which party contributed the most aye votes/,
    kind: 'scored',
    tools: 'search_divisions -> get_division',
    async run(client) {
      const division = await divisionByTitle(client, 'Draft Climate Change Act 2008 (Credit Limit) Order 2026', {
        title: 'Draft Climate Change Act 2008 (Credit Limit) Order 2026',
      });
      // The tool already returns the breakdown sorted by count, descending.
      return division.data?.aye_breakdown_by_party?.[0]?.party;
    },
  },
  {
    match: /bill with id 195/,
    kind: 'scored',
    tools: 'get_bill',
    async run(client) {
      const bill = await client.call('parliament_get_bill', { bill_id: 195, include_stages: false });
      if (bill.data?.found !== true) throw new McpError('bill 195 was not found');
      return bill.data.is_act ? 'yes' : 'no';
    },
  },
  {
    match: /postcode SW1A 0AA/,
    kind: 'scored',
    tools: 'find_constituency',
    async run(client) {
      const found = await client.call('parliament_find_constituency', { query: 'SW1A 0AA' });
      return found.data?.matched_constituency_name;
    },
  },
  {
    match: /Who won the 2024 general election in Islington North/,
    kind: 'scored',
    tools: 'find_constituency -> get_election_results',
    async run(client) {
      const election = await islingtonNorth2024(client, { withCandidates: true });
      // Candidates come back ranked, so the winner is the first entry.
      const winner = election.candidates?.[0];
      if (!winner) throw new McpError('the 2024 result carried no candidate list');
      return winner.party;
    },
  },
  {
    match: /majority in Islington North at the 2024 general election/,
    kind: 'scored',
    tools: 'find_constituency -> get_election_results',
    async run(client) {
      const election = await islingtonNorth2024(client);
      return election.majority;
    },
  },
  {
    match: /Diane Abbott has held several shadow cabinet posts/,
    kind: 'unscored',
    tools: 'find_member -> get_ministerial_roles',
    reason: 'ranking shadow posts by seniority is a judgement the Members API does not encode',
    async run(client) {
      const found = await client.call('parliament_find_member', { query: 'Diane Abbott' });
      const member = (found.data?.members ?? [])[0];
      if (!member) throw new McpError('Diane Abbott was not found');
      const roles = await client.call('parliament_get_ministerial_roles', {
        member_id: member.member_id,
        include_historical: true,
      });
      return (roles.data?.opposition_posts ?? []).map((p) => p.name).join('; ');
    },
  },
  {
    match: /Climate Change: Resilience Planning/,
    kind: 'scored',
    tools: 'search_hansard',
    async run(client) {
      const search = await client.call('parliament_search_hansard', {
        query: 'Climate Change: Resilience Planning',
        house: 'Commons',
        lookback_days: 3650,
        limit: 20,
      });
      const debates = (search.data?.debates ?? []).filter(
        (d) => normalise(d.title) === 'climate change: resilience planning',
      );
      if (debates.length === 0) throw new McpError('the debate was not found in Hansard');
      return dateOnly(debates[0].date);
    },
  },
  {
    match: /committee id of the Treasury Committee/,
    kind: 'scored',
    tools: 'get_committee',
    async run(client) {
      const search = await client.call('parliament_get_committee', { query: 'Treasury Committee', limit: 20 });
      const exact = (search.data?.committees ?? []).filter((c) => normalise(c.name) === 'treasury committee');
      if (exact.length !== 1) throw new McpError(`expected one committee named Treasury Committee, got ${exact.length}`);
      return exact[0].committee_id;
    },
  },
  {
    match: /written questions section comes back empty/,
    kind: 'contract',
    tools: 'topic_tracker',
    claim: 'an empty written_questions section carries a status saying whether it is an absence or a failure',
    async run(client) {
      const tracker = await client.call('parliament_topic_tracker', { topic: 'climate change', lookback_days: 90 });
      const status = tracker.meta?.sources_status?.written_questions;
      if (!status?.status) {
        throw new McpError('meta.sources_status.written_questions is missing, so an empty list is unreadable');
      }
      const empty = (tracker.data?.recent_written_questions ?? []).length === 0;
      if (status.status !== 'ok') {
        if (tracker.meta?.partial !== true) throw new McpError(`status ${status.status} but meta.partial is not true`);
        const warned = (tracker.meta?.warnings ?? []).some((w) => /written_questions/.test(w));
        if (!warned) throw new McpError(`status ${status.status} but no warning names written_questions`);
        return `status "${status.status}", partial true, warning present, section empty: ${empty}`;
      }
      return `status "ok" on this run, so the degraded path was not exercised; the status field is present and readable`;
    },
  },
  {
    match: /returned_by_upstream 14 and kept_after_relevance 0/,
    kind: 'contract',
    tools: 'topic_tracker',
    claim: 'retrieval counts separate "upstream returned nothing" from "nothing returned was relevant"',
    async run(client) {
      const tracker = await client.call('parliament_topic_tracker', { topic: 'climate change', lookback_days: 90 });
      const retrieval = tracker.data?.retrieval?.petitions;
      const status = tracker.meta?.sources_status?.petitions;
      if (typeof retrieval?.returned_by_upstream !== 'number' || typeof retrieval?.kept_after_relevance !== 'number') {
        throw new McpError('data.retrieval.petitions does not carry both counts, so the two cases are indistinguishable');
      }
      if (!status?.status) throw new McpError('meta.sources_status.petitions is missing');
      return `returned_by_upstream ${retrieval.returned_by_upstream}, kept_after_relevance ${retrieval.kept_after_relevance}, status "${status.status}"`;
    },
  },
];

// ------------------------------------------------------------------- runner

function mapChecks(pairs) {
  const used = new Set();
  return pairs.map((pair, index) => {
    const hits = CHECKS.filter((c) => c.match.test(pair.question));
    if (hits.length !== 1) {
      return { pair, index, error: `question maps to ${hits.length} checks, expected 1` };
    }
    if (used.has(hits[0])) return { pair, index, error: 'check already used by an earlier question' };
    used.add(hits[0]);
    return { pair, index, check: hits[0] };
  });
}

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const colour = process.stdout.isTTY ? (c, s) => `${c}${s}${RESET}` : (_c, s) => s;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pairs = parseEvalXml(await readFile(EVAL_FILE, 'utf8'));
  const client = createClient(args.base, args.verbose);

  console.log(`Evals: ${EVAL_FILE}`);
  console.log(`Server: ${args.base}`);
  console.log(`${pairs.length} pairs\n`);

  const results = [];
  for (const entry of mapChecks(pairs)) {
    const number = entry.index + 1;
    if (args.only && !args.only.has(number)) continue;

    const label = `${String(number).padStart(2)}. ${entry.pair.question.slice(0, 88)}`;
    if (entry.error) {
      console.log(`${colour(RED, 'FAIL')} ${label}\n      ${entry.error}\n`);
      results.push({ number, outcome: 'fail' });
      continue;
    }

    const { check } = entry;
    let actual;
    try {
      actual = await check.run(client);
    } catch (error) {
      console.log(`${colour(RED, 'FAIL')} ${label}`);
      console.log(`      ${colour(DIM, check.tools)}`);
      console.log(`      ${error instanceof Error ? error.message : String(error)}\n`);
      results.push({ number, outcome: 'fail' });
      continue;
    }

    if (check.kind === 'scored') {
      const ok = matches(actual, entry.pair.answer);
      console.log(`${ok ? colour(GREEN, 'PASS') : colour(RED, 'FAIL')} ${label}`);
      console.log(`      ${colour(DIM, check.tools)}`);
      console.log(`      expected "${entry.pair.answer}", got "${actual}"\n`);
      results.push({ number, outcome: ok ? 'pass' : 'fail' });
    } else if (check.kind === 'contract') {
      console.log(`${colour(GREEN, 'CONT')} ${label}`);
      console.log(`      ${colour(DIM, check.tools)}`);
      console.log(`      ${colour(DIM, `checks: ${check.claim}`)}`);
      console.log(`      ${actual}`);
      console.log(`      ${colour(DIM, `the stated answer ("${entry.pair.answer}") is interpretation and is NOT scored`)}\n`);
      results.push({ number, outcome: 'contract' });
    } else {
      console.log(`SKIP ${label}`);
      console.log(`      ${colour(DIM, check.tools)}`);
      console.log(`      ${colour(DIM, `not scored: ${check.reason}`)}`);
      console.log(`      expected "${entry.pair.answer}", retrieved "${actual}"\n`);
      results.push({ number, outcome: 'unscored' });
    }
  }

  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  const failed = results.filter((r) => r.outcome === 'fail');

  console.log('-'.repeat(72));
  console.log(`scored:    ${count('pass')} passed, ${failed.length} failed of ${count('pass') + failed.length}`);
  console.log(`contract:  ${count('contract')} checked (evidence only, the prose answer is not scored)`);
  console.log(`unscored:  ${count('unscored')} needs a judge, not scored`);
  if (failed.length > 0) console.log(`\nfailing pairs: ${failed.map((r) => r.number).join(', ')}`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
