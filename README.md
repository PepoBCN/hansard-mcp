# hansard-mcp

An MCP server that gives AI assistants sourced, live access to UK Parliament data: Hansard debates, Commons and Lords votes, bills, select committees, members, ministerial posts, registered interests, written questions, petitions and election results. Every answer carries the official parliament.uk URLs it came from, so the assistant can cite them.

It runs as a hosted connector at `https://hansard-mcp.feldberg.co/mcp`, or locally over stdio.

## The rule it exists for

If Parliament's API times out or fails, the server says so. It never turns a failed lookup into an empty result that reads as "Parliament did nothing".

Every tool returns `{ data, sources, meta }`, and `meta.sources_status` reports each upstream separately:

```jsonc
"sources_status": {
  "bills":             { "status": "ok",      "ms": 324,   "cache": "hit"  },
  "written_questions": { "status": "timeout", "ms": 12000, "cache": "miss" }
}
```

An empty section is evidence of absence only when its source status is `ok`. Any other status (`timeout`, `upstream_error`, `circuit_open`, `unavailable`) means the data is unknown, and `meta.partial` and `meta.warnings` say which sections were affected. `isReportableAbsence()` in `src/envelope.ts` makes the rule executable, and the tests in `test/failure/` check it holds under injected timeouts, 500s, malformed bodies, dropped connections and an open circuit breaker.

`data.retrieval` also separates "the upstream returned nothing" from "the upstream returned things and none were relevant". That matters here because some of Parliament's own search endpoints are weak: the written-questions search will report thousands of matches for a phrase and hand back questions on unrelated subjects.

Every tool description and every prompt is checked by the test suite to carry this contract.

## Tools

| Tool | What it does |
| --- | --- |
| `parliament_find_member` | Find an MP or Lord by name or postcode |
| `parliament_member_overview` | One-page profile of a member |
| `parliament_member_voting_history` | How a member voted, optionally filtered by topic |
| `parliament_member_interests` | A member's registered financial interests |
| `parliament_get_ministerial_roles` | Government and opposition posts, for one member or a whole front bench |
| `parliament_find_constituency` | Find a constituency by name or postcode |
| `parliament_get_election_results` | General election results for a constituency |
| `parliament_get_state_of_parties` | Party standings in the Commons or the Lords |
| `parliament_search_hansard` | Search Hansard debates |
| `parliament_get_debate` | Get the text of a debate, by id or a pasted Hansard link |
| `parliament_search_divisions` | Search Commons divisions |
| `parliament_get_division` | Get a division with a party breakdown and optional rebellions |
| `parliament_get_bill` | Get a bill and its stages |
| `parliament_get_committee` | Get or search select committees, with members and evidence |
| `parliament_topic_tracker` | Track a policy topic across bills, debates, votes, written questions and petitions |

There are also four prompts: `topic-tracker`, `mp-report-card`, `vote-explainer` and `draft-constituent-letter`.

The tools stay compatible with the input names of the earlier mp-mcp 0.2.0 tool interface, so connectors written against that interface keep working. `src/compat.ts` explains how.

## Use the hosted connector

The hosted server is at:

```
https://hansard-mcp.feldberg.co/mcp
```

It needs no authentication and is stateless, so a bare POST works with no session handshake.

To add it in Claude, go to Settings, then Connectors, then Add custom connector. Give it a name and paste the URL above.

In Claude Code:

```bash
claude mcp add --transport http hansard https://hansard-mcp.feldberg.co/mcp
```

## Run it locally

Needs Node 20 or later.

```bash
npm ci
npm run build
npm run start:http    # Streamable HTTP on 127.0.0.1:8093
npm run start:stdio   # stdio, for local MCP clients and the Inspector
```

HTTP endpoints: `POST /mcp`, `GET /healthz`, `GET /readyz`, `GET /metrics`.

To use the stdio build with Claude Code:

```bash
claude mcp add hansard -- node /path/to/hansard-mcp/dist/stdio.js
```

There's also a `Dockerfile` and a `compose.yml` that run the HTTP server as an unprivileged user, bound to loopback.

### Configuration

All settings come from environment variables and are checked at startup. A bad value stops the process with the variable named, rather than booting into a broken state.

| Variable | Default | Notes |
| --- | --- | --- |
| `MP_PORT` / `MP_HOST` | `8093` / `127.0.0.1` | |
| `MP_LOG_LEVEL` | `info` | |
| `MP_REQUEST_BUDGET_MS` | `15000` | Ceiling for one tool call |
| `MP_UPSTREAM_MAX_ATTEMPTS` | `2` | Retries on 429, 5xx and network errors only |
| `MP_BULKHEAD_LIMIT` | `16` | Concurrency cap per upstream |
| `MP_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before the breaker opens |
| `MP_BREAKER_OPEN_MS` | `30000` | How long the breaker stays open |
| `MP_CACHE_ENABLED` | `true` | In-memory cache with stale-while-revalidate |
| `MP_CACHE_STALE_MULTIPLIER` | `10` | Serve stale up to 10 times the TTL while refreshing |
| `MP_UPSTREAM_BASE_<KEY>` | | Point one upstream somewhere else, for tests or mirrors |

Timeouts are set per upstream from measured response times in `src/config.ts`, not one global number. Hansard and written questions get 12 seconds, faster endpoints 4 to 8.

### Layout

```
src/core/       http, cache, breaker, bulkhead, budget, metrics, logging
src/clients/    one typed client per Parliament API
src/domain/     relevance, dates, citations, Parliament URL parsing
src/tools/      the 15 tools: Zod in, envelope out
src/prompts/    the 4 prompts
src/compat.ts   the 0.2.0-compatible input names
src/envelope.ts the status contract
```

## Tests

```bash
npm test                # offline: unit, failure injection, protocol, compatibility
npm run test:contract   # live: hits the real Parliament APIs
npm run evals           # 12 verified question and answer pairs against a running server
```

The offline suite needs no network. The contract suite catches Parliament changing a response shape without notice, which happens: party names that moved under a new key, rows that arrived wrapped in an extra object and an endpoint that turned out not to exist. Some contract tests can fail when a Parliament API is slow on the day, which is the server reporting it correctly.

## Licence

MIT, see [LICENSE](LICENSE). Portions are derived from mp-mcp under the MIT License, see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Data

Data comes from the UK Parliament APIs and postcodes.io. When you show this server's output to anyone else, please attribute it as:

> Contains Parliamentary information licensed under the Open Parliament Licence v3.0.

See the [Open Parliament Licence](https://www.parliament.uk/site-information/copyright-parliament/open-parliament-licence/).
