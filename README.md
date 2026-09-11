# MCP server authoring

The three fleet tools from [loop-engineering](https://github.com/shami-rai/loop-engineering)
(count, rank by one stored field, fetch one device, over a synthetic fleet of 400 connected medical
devices) moved out of the agent's process and into a Model Context Protocol server, so the same
agent, task and model can be run with the tools handed over directly or reached over a protocol
boundary, and the two compared: what the model is shown, whether it behaves differently, what a
call costs in time, and what failure looks like from each side. The writeup lives on
[shamirai.ai](https://shamirai.ai/e/mcp-server-authoring/).

## Run it

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # gitignored; only the agent needs it, the server never sees it

npm run smoke -- --effort low                # one direct run, no MCP, to prove the rig
npm run experiment -- --condition mcp --effort low --n 5
npm run report                               # the results table below, from runs/*.jsonl
npm run spend                                # total API spend so far
npm run probe                                # the no-model measurements (free), writes runs/probe.json
```

The server on its own:

```bash
npm run server        # McpServer (zod schemas), stdio; waits for JSON-RPC on stdin, logs to stderr
npm run server:raw    # low-level Server, handed the exact JSON Schema from src/rig/tools.mjs
```

It speaks newline-delimited JSON-RPC on stdin and stdout, so it can be driven by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"by-hand","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"count_devices","arguments":{"max_hours":500}}}' \
  | node src/server/fleet-server.mjs
```

Any MCP client that can launch a stdio server can use it with the command
`node src/server/fleet-server.mjs`. Nothing here registers it with any client.

## Layout

```text
src/rig/          shared agent rig: fleet and tools, task and ground truth, hand-written loop, grader
src/server/       fleet-server.mjs (McpServer + zod), fleet-server-raw.mjs (low-level Server), faults.mjs
src/mcp/client.mjs  spawns a server, converts its tools to Anthropic definitions, maps errors, optional restart
scripts/          experiment.mjs (model runs), probe.mjs (no-model measurements), report.mjs, spend.mjs
runs/             every run record as JSONL, plus probe.json
```

## Experiment design

Held fixed across every condition: the fleet, the three tool handlers, the 10-row cap, the task
(among devices under 500 operating hours, which had the most unplanned downtime per 100 hours, and
how does its vendor risk score compare with the highest-risk device of the same model; correct
answer `AV3-007 vs AV3-024`), the system prompt, and the hand-written loop in `src/rig/agent.mjs`
(prompt caching on, parallel tool calls allowed, 40-turn cap). Only the path between the loop and
the handlers changes.

| condition | what the model is handed, and how its calls run |
|---|---|
| `direct` | `toolDefs` from `src/rig/tools.mjs`; handlers called in-process, a throw becomes an `is_error` result |
| `mcp` | tools listed from `fleet-server.mjs` (SDK `McpServer`, schemas re-authored in zod) over stdio, one server process per run |
| `mcp-raw` | tools listed from `fleet-server-raw.mjs` (SDK low-level `Server`, handed the exact JSON Schema) over stdio |
| `mcp-slow` | `mcp`, but the first `top_devices` call sleeps 3 s and the client request timeout is 1.5 s |
| `mcp-crash` | `mcp`, but the server process exits while handling its 6th `tools/call`; no recovery |
| `mcp-crash-explained` | the same crash, unrecovered, but the client replaces the SDK's "Not connected" with a plain statement that the server has exited and will not come back |
| `mcp-crash-restart` | the same crash; the client respawns the server and retries the failed call once |

The client (`src/mcp/client.mjs`) turns each MCP tool into `{name, description, input_schema}`,
dropping MCP-only fields, and maps both failure channels onto the rig's `{content, isError}`: a
result with `isError: true`, and a `callTool` that throws (timeout, closed connection, JSON-RPC
error), whose message is passed to the model as an error result.

Primary model `claude-opus-5` at low and high effort. A secondary arm on `claude-haiku-4-5` (no
thinking) repeats direct vs `mcp`, as a less capable reader of the same definitions. Every run is
graded by `src/rig/grade.mjs` from its `FINAL:` line. Runs were strictly sequential.

`scripts/probe.mjs` measures what needs no model: the `tools/list` payload as sent on the wire and
as parsed by the client, a field-level diff against `toolDefs`, definition token counts from the
token counting endpoint, per-call latency over 270 warm calls, server startup, the same eight
malformed calls sent down all three paths, and five faults (slow tool, crash with and without
restart, a newline-terminated log on stdout, an unterminated write on stdout).

Not covered: the Messages API's remote MCP connector, which needs a publicly reachable server URL
(this server is stdio only and is never exposed); Streamable HTTP transport; more than one task.
Per-call times in run records use a millisecond clock, so the probe's figures are the precise ones.

## Results

Model runs, from `npm run report`. Means exclude runs that ended in `api_error`. Per-call times
come from a millisecond clock inside real runs; `mcp-slow` includes the 1.5 s timeout.

| condition | model | effort | n | correct | compare correct | mean turns | mean tool calls | mean tool errors | mean peak context | mean cost (USD) | mean ms per call | stop reasons | mean restarts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | haiku-4-5 | - | 6 | 0/6 | 0/6 | 4.2 | 7.0 | 0.0 | 2,903 | 0.014 | 0.1 | end_turn 6, api_error 4 | - |
| mcp | haiku-4-5 | - | 6 | 0/6 | 0/6 | 4.3 | 3.8 | 0.0 | 2,549 | 0.013 | 2.3 | end_turn 6, api_error 3 | 0.0 |
| direct | opus-5 | low | 5 | 5/5 | 5/5 | 6.2 | 19.0 | 0.0 | 5,506 | 0.076 | 0.1 | end_turn 5 | - |
| mcp | opus-5 | low | 5 | 5/5 | 5/5 | 6.0 | 18.4 | 0.0 | 5,542 | 0.077 | 1.3 | end_turn 5 | 0.0 |
| mcp-raw | opus-5 | low | 5 | 5/5 | 5/5 | 5.8 | 15.2 | 0.0 | 4,924 | 0.067 | 1.2 | end_turn 5 | 0.0 |
| mcp-slow | opus-5 | low | 5 | 5/5 | 5/5 | 7.0 | 18.4 | 1.0 | 5,439 | 0.075 | 83.0 | end_turn 5 | 0.0 |
| mcp-crash | opus-5 | low | 7 | 0/7 | 0/7 | 7.7 | 21.3 | 16.3 | 4,217 | 0.075 | 0.7 | end_turn 7 | 0.0 |
| mcp-crash-restart | opus-5 | low | 5 | 5/5 | 5/5 | 6.0 | 17.6 | 0.0 | 5,446 | 0.072 | 6.9 | end_turn 5 | 1.0 |
| direct | opus-5 | high | 5 | 5/5 | 5/5 | 6.6 | 18.4 | 0.0 | 6,822 | 0.132 | 0.1 | end_turn 5 | - |
| mcp | opus-5 | high | 5 | 5/5 | 5/5 | 6.0 | 19.6 | 0.0 | 7,075 | 0.133 | 1.2 | end_turn 5 | 0.0 |

Notes on the table:

- Every `mcp-crash` run answered `FINAL: IL7-032 vs IL7-032`, the task's known shortcut answer, and
  every one said in its text that the tools had dropped out. The crash landed on the 6th call in
  all 7 runs (turn 2 in 6 of them), after which the model made 11 to 21 more calls, all failing.
- In `mcp-slow` the model reissued the identical timed-out call in the next turn in 5/5 runs.
- `mcp-crash-restart`: one restart per run; the retried call took 94 to 114 ms.
- Haiku 4.5 gave the same wrong answer on both paths. Its call-count gap comes from turn 2:
  the direct path fetched all ten ranked devices in 2 of 6 runs, the MCP path in 0 of 6.
- The turn-1 tool calls were identical in all 23 runs of the first Opus matrix, across all three paths.

No-model probe (`runs/probe.json`):

| measure | direct | `mcp-raw` | `mcp` (McpServer + zod) |
|---|---|---|---|
| definitions byte-identical to `toolDefs` | yes | yes | no |
| definition tokens (token counting endpoint) | 1,264 | 1,264 | 1,466 (+16%) |
| per-call latency, 270 warm calls, mean / p95 | 0.022 / 0.048 ms | 0.090 / 0.126 ms | 0.093 / 0.139 ms |
| server startup (spawn, initialize, tools/list), mean of 10 | - | 74.5 ms | 78.7 ms |

What changed in the `mcp` definitions: every integer property gained `minimum: -9007199254740991`
and `maximum: 9007199254740991` (including `limit`, described as 1 to 10); each `input_schema`
gained `"$schema": "http://json-schema.org/draft-07/schema#"`, sent first on the wire and moved
last by the client SDK's parse; `description` moved ahead of `type` in every described property;
and each tool carried `execution: {taskSupport: "forbidden"}`, which the converter drops.

The same malformed calls down each path (content shown is what the model would read):

| call | direct | `mcp-raw` | `mcp` |
|---|---|---|---|
| unknown device id (handler throws) | error, handler message | `MCP error -32603:` + handler message (JSON-RPC error, thrown by `callTool`) | error result, handler message, byte-identical to direct |
| `limit: "5"` | error: `limit must be an integer from 1 to 10, got 5.` | same, with `-32603` prefix | `MCP error -32602: Input validation error: ... expected number, received string at limit` |
| `limit: 50` | handler error | same, with `-32603` prefix | handler error (passes schema validation) |
| `field` missing | `Cannot rank by "undefined" ...` | same, with `-32603` prefix | `-32602` validation error naming the allowed values |
| `model: "Aeris v3"` (wrong case) | ok, `{"count":0}` | ok, `{"count":0}` | `-32602` validation error |
| `max_hours: 499.5` | ok, `{"count":254}` | ok, `{"count":254}` | `-32602` validation error |
| unknown property | ok, ignored | ok, ignored | ok, stripped |
| unknown tool | `No such tool: rank_by_rate.` | `-32603` | error result `MCP error -32602: Tool rank_by_rate not found` |

Faults, all on the `mcp` server:

| fault | what the harness gets back |
|---|---|
| tool sleeps 3 s, client timeout 1.5 s | `MCP error -32001: Request timed out` at 1,501 ms; the server finishes anyway and its late reply is dropped; the next call takes 3 ms |
| server exits mid-call | `MCP error -32000: Connection closed`, then `Not connected` for every later call |
| server exits, client restarts and retries | the call succeeds; 81 ms extra in the probe |
| `console.log` on the server's stdout | calls succeed; each stray line raises a transport `onerror` |
| `process.stdout.write` with no newline | every call times out: each response is glued to the stray text and discarded |

## Spend and what was cut

61 run records, $3.85 total API spend, all runs sequential. The API credit on the shared key ran
out mid-way through the last batch (`credit balance is too low`, HTTP 400), which cut three things:
the `mcp-crash-explained` condition was never run (two attempts before it were launched with the
client option unwired, so the model saw the SDK's messages exactly as in `mcp-crash`; they are
recorded as `mcp-crash` runs with a note), Haiku stopped at 6 complete runs per path instead of 10,
and the 7 `api_error` records from those attempts stay in `runs/` and are excluded from the means.
