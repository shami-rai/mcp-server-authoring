// Runs one condition n times, strictly one after another, and appends every run
// record to runs/<condition>_<model>_<effort>.jsonl.
//
//   npm run experiment -- --condition mcp --effort low --n 5 [--model claude-opus-5]
//
// Conditions:
//   direct             tools.mjs definitions, handlers called in-process
//   mcp                the zod server (McpServer, the SDK's high-level API) over stdio
//   mcp-raw            the low-level server, handed the exact JSON Schema, over stdio
//   mcp-slow           zod server; first top_devices call takes 3 s, client timeout 1.5 s
//   mcp-crash          zod server; the process exits on tools/call 6; no restart
//   mcp-crash-restart  same crash; the harness restarts the server and retries once
//
// Budget: refuses to start a run once total spend in runs/ is within $0.50 of $8.

import { appendFileSync, mkdirSync } from 'node:fs';
import { runAgent, localExecutor } from '../src/rig/agent.mjs';
import { toolDefs, runTool } from '../src/rig/tools.mjs';
import { SYSTEM, QUESTION } from '../src/rig/task.mjs';
import { grade } from '../src/rig/grade.mjs';
import { connectFleet } from '../src/mcp/client.mjs';
import { spentSoFar } from './spend.mjs';

const BUDGET_USD = 8;
const MARGIN_USD = 0.5;

const CRASH = { FLEET_FAULT: 'crash', FLEET_CRASH_AT: '6' };
export const CONDITIONS = {
  direct: { path: 'direct' },
  mcp: { path: 'mcp', variant: 'zod' },
  'mcp-raw': { path: 'mcp', variant: 'raw' },
  'mcp-slow': { path: 'mcp', variant: 'zod', env: { FLEET_FAULT: 'slow', FLEET_SLOW_MS: '3000' }, timeoutMs: 1500 },
  'mcp-crash': { path: 'mcp', variant: 'zod', env: CRASH },
  'mcp-crash-restart': { path: 'mcp', variant: 'zod', env: CRASH, restart: true },
  // The same unrecovered crash, but the harness tells the model what the harness knows,
  // instead of passing the SDK's "Not connected" through. Facts only, no instruction.
  'mcp-crash-explained': {
    path: 'mcp',
    variant: 'zod',
    env: CRASH,
    lossMessage:
      'The fleet tool server has exited and this harness cannot restart it. ' +
      'Every further call to any fleet tool in this session will fail. ' +
      'Results returned before the failure are unaffected.',
  },
};

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const condition = arg('condition', 'direct');
const model = arg('model', 'claude-opus-5');
const effort = arg('effort', 'low');
const n = Number(arg('n', 1));
const c = CONDITIONS[condition];
if (!c) throw new Error(`unknown condition ${condition}; one of ${Object.keys(CONDITIONS).join(', ')}`);

mkdirSync('runs', { recursive: true });
const tag = model.replace('claude-', '');
const file = `runs/${condition}_${tag}_${model.startsWith('claude-haiku') ? 'noeffort' : effort}.jsonl`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0, apiRetries = 0; i < n; ) {
  const spent = spentSoFar();
  if (spent + MARGIN_USD > BUDGET_USD) {
    console.log(`budget stop: $${spent.toFixed(4)} spent`);
    break;
  }

  let tools = toolDefs;
  let execute = localExecutor(runTool);
  let fleet = null;
  if (c.path === 'mcp') {
    fleet = await connectFleet({ variant: c.variant, env: c.env, timeoutMs: c.timeoutMs, restart: c.restart });
    tools = fleet.tools;
    // Keep what the rig's trace does not: whether a failure came back as a tool
    // result or as a thrown protocol error, and whether the call was retried.
    const inner = fleet.execute;
    fleet.calls = [];
    execute = async (name, input, ctx) => {
      const r = await inner(name, input, ctx);
      fleet.calls.push({ turn: ctx.turn, name, via: r.via, code: r.code ?? null, retried: Boolean(r.retried), isError: r.isError });
      return r;
    };
  }

  const startedAt = new Date().toISOString();
  const run = await runAgent({ model, effort, system: SYSTEM, question: QUESTION, tools, execute, label: condition });
  if (fleet) await fleet.close();

  const rec = {
    condition,
    ...c,
    i,
    startedAt,
    ...run,
    grade: grade(run),
    mcp: fleet ? { ...fleet.stats, calls: fleet.calls } : null,
  };
  appendFileSync(file, JSON.stringify(rec) + '\n');

  const g = rec.grade;
  const callMs = run.trace.flatMap((t) => t.calls ?? []).map((x) => x.ms);
  const meanMs = callMs.length ? callMs.reduce((a, b) => a + b, 0) / callMs.length : 0;
  console.log(
    `${condition} ${tag} ${effort} #${i}: stop=${run.stop} ${g.answerId} vs ${g.compareId} correct=${g.correct} ` +
      `turns=${run.turns} calls=${run.toolCalls} errors=${run.toolErrors} peak=${run.peakContext} ` +
      `$${(run.costUSD ?? 0).toFixed(4)} callMs=${meanMs.toFixed(1)} total=$${(spent + (run.costUSD ?? 0)).toFixed(4)}` +
      (fleet ? ` spawns=${fleet.stats.spawns} restarts=${fleet.stats.restarts}` : ''),
  );

  if (run.stop === 'api_error' && apiRetries < 3) {
    apiRetries++;
    console.log(`api_error, waiting 60 s and repeating run #${i}: ${run.trace.at(-1)?.error}`);
    await sleep(60_000);
    continue;
  }
  apiRetries = 0;
  i++;
}
