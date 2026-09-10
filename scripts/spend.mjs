// Running total of API spend: the sum of costUSD over every run record in runs/.
// Debugging runs count too. The experiment runner calls spentSoFar() before
// every run and refuses to start one that could cross the budget.
//
//   node scripts/spend.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs');

export function readRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(RUNS, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ file: f, ...JSON.parse(l) })),
    );
}

export const spentSoFar = () => readRuns().reduce((s, r) => s + (r.costUSD ?? 0), 0);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runs = readRuns();
  const byFile = {};
  for (const r of runs) {
    byFile[r.file] ??= { runs: 0, usd: 0 };
    byFile[r.file].runs++;
    byFile[r.file].usd += r.costUSD ?? 0;
  }
  for (const [f, v] of Object.entries(byFile)) console.log(`${f.padEnd(40)} ${String(v.runs).padStart(3)} runs  $${v.usd.toFixed(4)}`);
  console.log(`\ntotal ${runs.length} runs  $${spentSoFar().toFixed(4)}`);
}
