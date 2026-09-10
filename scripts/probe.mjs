// Everything about the boundary that can be measured without asking a model.
// Deterministic, costs nothing (token counting is free), writes runs/probe.json.
//
//   npm run probe
//
//   A. definitions: what tools/list puts on the wire, what the client hands the
//      model after conversion, and how that differs from tools.mjs
//   B. latency: per-call round trip and server startup, direct vs stdio
//   C. error semantics: the same bad calls down all three paths
//   D. faults at the boundary: slow tool, crash, and stdout pollution

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { localExecutor, makeClient } from '../src/rig/agent.mjs';
import { toolDefs, runTool } from '../src/rig/tools.mjs';
import { SYSTEM, QUESTION } from '../src/rig/task.mjs';
import { connectFleet, SERVERS } from '../src/mcp/client.mjs';

const out = {};
const direct = localExecutor(runTool);

// ---------- helpers

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const obj = (v) => v !== null && typeof v === 'object';
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const found = keys.flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
    const common = Object.keys(a).filter((k) => k in b);
    const orderB = Object.keys(b).filter((k) => k in a);
    if (common.join() !== orderB.join()) found.push({ path: path || '(root)', kind: 'key order', a: common, b: orderB });
    return found;
  }
  return [{ path: path || '(root)', kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', a, b }];
}

// The protocol with no SDK on the client side: spawn the server, write three
// JSON-RPC lines to its stdin, read lines back from its stdout.
function wireToolsList(serverPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          p.kill();
          resolve({ line, msg });
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.on('error', reject);
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s.at(-1).toFixed(3) };
};

// ---------- A. definitions

console.log('\n## A. definitions');
out.definitions = {};
for (const variant of ['raw', 'zod']) {
  const f = await connectFleet({ variant });
  const wire = await wireToolsList(SERVERS[variant]);
  const onWire = wire.msg.result.tools;
  const d = f.tools.flatMap((t, i) => diff(toolDefs[i], t, t.name));
  const r = {
    byteIdentical: JSON.stringify(f.tools) === JSON.stringify(toolDefs),
    sameMeaning: JSON.stringify(canon(f.tools)) === JSON.stringify(canon(toolDefs)),
    wireKeysOfFirstSchema: Object.keys(onWire[0].inputSchema),
    clientKeysOfFirstSchema: Object.keys(f.mcpTools[0].inputSchema),
    wireEqualsClientParse: JSON.stringify(onWire) === JSON.stringify(f.mcpTools),
    wireEqualsClientParseIgnoringKeyOrder: JSON.stringify(canon(onWire)) === JSON.stringify(canon(f.mcpTools)),
    fieldsDroppedByConverter: [...new Set(f.mcpTools.flatMap((t) => Object.keys(t).filter((k) => !['name', 'description', 'inputSchema'].includes(k))))],
    diffs: d,
    toolsListBytes: wire.line.length,
  };
  out.definitions[variant] = r;
  if (variant === 'zod') out.zodTools = f.tools;
  console.log(variant, JSON.stringify({ ...r, diffs: undefined }));
  for (const x of d) console.log('   ', x.kind.padEnd(9), x.path, JSON.stringify(x.a), '->', JSON.stringify(x.b));
  await f.close();
}

// Token cost of the definitions, counted by the API rather than estimated.
const api = makeClient();
const count = (tools) =>
  api.messages
    .countTokens({ model: 'claude-opus-5', system: SYSTEM, messages: [{ role: 'user', content: QUESTION }], ...(tools ? { tools } : {}) })
    .then((r) => r.input_tokens);
const [none, directTok, zodTok] = [await count(null), await count(toolDefs), await count(out.zodTools)];
out.tokens = { noTools: none, direct: directTok, zod: zodTok, directDefs: directTok - none, zodDefs: zodTok - none };
out.tokens.zodDefsIncreasePct = +((100 * (zodTok - directTok)) / (directTok - none)).toFixed(1);
console.log('tokens', JSON.stringify(out.tokens));

// ---------- B. latency

console.log('\n## B. latency');
const mix = [
  ['count_devices', { max_hours: 500 }],
  ['top_devices', { field: 'downtime_min', max_hours: 500, limit: 10 }],
  ['get_device', { device_id: 'AV3-007' }],
];
const N = 300;
async function timeCalls(exec) {
  const ms = [];
  for (let i = 0; i < N; i++) {
    const [name, input] = mix[i % mix.length];
    const t = performance.now();
    await exec(name, input);
    ms.push(performance.now() - t);
  }
  return stats(ms.slice(30)); // drop warm-up
}
out.latency = { direct: await timeCalls(direct) };
for (const variant of ['raw', 'zod']) {
  const f = await connectFleet({ variant });
  out.latency[variant] = await timeCalls(f.execute);
  await f.close();
}
const starts = { raw: [], zod: [] };
for (let i = 0; i < 10; i++) {
  for (const variant of ['raw', 'zod']) {
    const f = await connectFleet({ variant });
    starts[variant].push(f.stats.startupMs[0]);
    await f.close();
  }
}
out.startupMs = { raw: stats(starts.raw), zod: stats(starts.zod) };
console.log(JSON.stringify(out.latency));
console.log('startup', JSON.stringify(out.startupMs));

// ---------- C. error semantics

console.log('\n## C. error semantics');
const cases = [
  ['handler throws (unknown device)', 'get_device', { device_id: 'XX9-999' }],
  ['limit as a string', 'top_devices', { field: 'alerts', limit: '5' }],
  ['limit out of range', 'top_devices', { field: 'alerts', limit: 50 }],
  ['required field missing', 'top_devices', { limit: 3 }],
  ['enum violation (wrong case)', 'count_devices', { model: 'Aeris v3' }],
  ['non-integer bound', 'count_devices', { max_hours: 499.5 }],
  ['unknown field', 'count_devices', { min_operating_hours: 10 }],
  ['unknown tool', 'rank_by_rate', {}],
];
const fleets = { raw: await connectFleet({ variant: 'raw' }), zod: await connectFleet({ variant: 'zod' }) };
out.errors = [];
for (const [label, name, input] of cases) {
  const row = { label, name, input, direct: await direct(name, input) };
  for (const v of ['raw', 'zod']) row[v] = await fleets[v].execute(name, input);
  out.errors.push(row);
  console.log(`\n${label}: ${name} ${JSON.stringify(input)}`);
  for (const p of ['direct', 'raw', 'zod']) {
    const r = row[p];
    console.log(`  ${p.padEnd(6)} ${r.isError ? 'ERROR' : 'ok   '} ${r.via ?? 'local'}  ${r.content.slice(0, 260)}`);
  }
}
for (const f of Object.values(fleets)) await f.close();

// ---------- D. faults at the boundary

console.log('\n## D. faults');
out.faults = {};
const call = ['top_devices', { field: 'downtime_min', limit: 3 }];
async function faultCase(key, opts, calls) {
  const f = await connectFleet({ variant: 'zod', ...opts });
  const results = [];
  for (const [name, input] of calls) {
    const t = performance.now();
    const r = await f.execute(name, input);
    results.push({ name, ms: Math.round(performance.now() - t), isError: r.isError, via: r.via, retried: Boolean(r.retried), content: r.content.slice(0, 200) });
  }
  await new Promise((r) => setTimeout(r, 200)); // let late messages and stderr arrive
  await f.close();
  out.faults[key] = { opts, results, stats: { ...f.stats, stderr: f.stats.stderr.slice(-3) } };
  console.log(`\n${key}`);
  for (const r of results) console.log(`  ${r.name} ${r.ms}ms ${r.isError ? 'ERROR' : 'ok'} ${r.via}${r.retried ? ' retried' : ''}  ${r.content.slice(0, 120)}`);
  console.log(`  spawns=${f.stats.spawns} restarts=${f.stats.restarts} transportErrors=${JSON.stringify(f.stats.transportErrors.slice(0, 2))}`);
}
await faultCase('slow, client timeout 1.5 s', { env: { FLEET_FAULT: 'slow', FLEET_SLOW_MS: '3000' }, timeoutMs: 1500 }, [call, call]);
await faultCase('crash on call 2, no restart', { env: { FLEET_FAULT: 'crash', FLEET_CRASH_AT: '2' } }, [call, call, call]);
await faultCase('crash on call 2, restart and retry', { env: { FLEET_FAULT: 'crash', FLEET_CRASH_AT: '2' }, restart: true }, [call, call, call]);
await faultCase('console.log on stdout', { env: { FLEET_FAULT: 'noisy-line' }, timeoutMs: 3000 }, [call, call]);
await faultCase('stdout.write with no newline', { env: { FLEET_FAULT: 'noisy-raw' }, timeoutMs: 3000 }, [call, call]);

writeFileSync('runs/probe.json', JSON.stringify(out, null, 2) + '\n');
console.log('\nwrote runs/probe.json');
