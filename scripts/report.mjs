// Aggregates every run record in runs/ into one row per condition.
//
//   npm run report
//
// Runs that ended in api_error are shown in the stop column but left out of
// every mean; their cost still counts toward the total.

import { readRuns, spentSoFar } from './spend.mjs';

const ORDER = ['direct', 'mcp', 'mcp-raw', 'mcp-slow', 'mcp-crash', 'mcp-crash-restart'];
const EFFORT = { low: 0, medium: 1, high: 2, null: 3 };

const runs = readRuns();
const groups = new Map();
for (const r of runs) {
  const key = `${r.condition}|${r.model}|${r.effort}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x) => (Number.isNaN(x) ? '-' : x.toFixed(1));

const rows = [...groups.entries()]
  .map(([key, rs]) => {
    const [condition, model, effort] = key.split('|');
    const ok = rs.filter((r) => r.stop !== 'api_error');
    const callMs = ok.flatMap((r) => r.trace.flatMap((t) => t.calls ?? []).map((c) => c.ms));
    const stops = {};
    for (const r of rs) stops[r.stop] = (stops[r.stop] ?? 0) + 1;
    return {
      condition,
      model: model.replace('claude-', ''),
      effort: effort === 'null' ? '-' : effort,
      n: ok.length,
      correct: `${ok.filter((r) => r.grade.correct).length}/${ok.length}`,
      compare: `${ok.filter((r) => r.grade.compareCorrect).length}/${ok.length}`,
      turns: f1(mean(ok.map((r) => r.turns))),
      calls: f1(mean(ok.map((r) => r.toolCalls))),
      errors: f1(mean(ok.map((r) => r.toolErrors))),
      peak: Math.round(mean(ok.map((r) => r.peakContext))).toLocaleString('en-US'),
      cost: mean(ok.map((r) => r.costUSD)).toFixed(3),
      ms: mean(callMs).toFixed(1),
      stops: Object.entries(stops).map(([k, v]) => `${k} ${v}`).join(', '),
      restarts: ok.some((r) => r.mcp) ? f1(mean(ok.map((r) => r.mcp?.restarts ?? 0))) : '-',
      _sort: [ORDER.indexOf(condition), model, EFFORT[effort] ?? 9],
    };
  })
  .sort((a, b) => a._sort[1].localeCompare(b._sort[1]) || a._sort[2] - b._sort[2] || a._sort[0] - b._sort[0]);

console.log('| condition | model | effort | n | correct | compare correct | mean turns | mean tool calls | mean tool errors | mean peak context | mean cost (USD) | mean ms per call | stop reasons | mean restarts |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.condition} | ${r.model} | ${r.effort} | ${r.n} | ${r.correct} | ${r.compare} | ${r.turns} | ${r.calls} | ${r.errors} | ${r.peak} | ${r.cost} | ${r.ms} | ${r.stops} | ${r.restarts} |`);
}
console.log(`\n${runs.length} run records, total spend $${spentSoFar().toFixed(2)}`);
