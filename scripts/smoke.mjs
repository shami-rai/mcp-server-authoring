// One run of the unmodified task. Proves the plumbing and prices a run.
//   npm run smoke -- [--effort low] [--model claude-opus-5] [--serial]

import { runAgent, localExecutor } from '../src/rig/agent.mjs';
import { toolDefs, runTool } from '../src/rig/tools.mjs';
import { SYSTEM, QUESTION } from '../src/rig/task.mjs';
import { grade } from '../src/rig/grade.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const run = await runAgent({
  model: arg('model', 'claude-opus-5'),
  effort: arg('effort', 'low'),
  parallel: !process.argv.includes('--serial'),
  system: SYSTEM,
  question: QUESTION,
  tools: toolDefs,
  execute: localExecutor(runTool),
  tracePath: 'runs/smoke.jsonl',
  label: 'smoke',
});

for (const t of run.trace) {
  console.log(`turn ${t.turn} ctx ${t.context} out ${t.output} ${t.stop_reason}`);
  for (const c of t.calls ?? []) console.log(`  ${c.name} ${JSON.stringify(c.input)}${c.isError ? '  ERROR' : ''}`);
}
console.log('\n' + run.answer.split('\n').slice(-4).join('\n'));
console.log('\nstop', run.stop, '| turns', run.turns, '| tool calls', run.toolCalls, '| peak ctx', run.peakContext);
console.log('usage', JSON.stringify(run.usage), '| cost $' + run.costUSD.toFixed(4));
console.log('grade', JSON.stringify(grade(run)));
