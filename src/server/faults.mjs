// Fault injection for the boundary experiments. Everything is off unless
// FLEET_FAULT is set, so a server started with no environment is the plain one.
//
//   FLEET_FAULT=slow        the first call to FLEET_SLOW_TOOL (default top_devices)
//                           sleeps FLEET_SLOW_MS (default 3000) before answering
//   FLEET_FAULT=crash       the process exits while handling tools/call number
//                           FLEET_CRASH_AT (default 6), without replying
//   FLEET_FAULT=noisy-line  each call first console.logs a debug line to stdout
//   FLEET_FAULT=noisy-raw   each call first writes to stdout with no newline
//
// The two noisy modes break the one rule a stdio server has: stdout is the
// protocol channel, and nothing else may ever be written to it.
//
// Faults wrap a handler. The handlers in src/rig/tools.mjs are never edited.

export function makeFaults(env = process.env) {
  const fault = env.FLEET_FAULT ?? '';
  const slowTool = env.FLEET_SLOW_TOOL ?? 'top_devices';
  const slowMs = Number(env.FLEET_SLOW_MS ?? 3000);
  const crashAt = Number(env.FLEET_CRASH_AT ?? 6);
  let calls = 0;
  const slowed = new Set();

  return {
    fault,
    wrap(name, fn) {
      return async (input) => {
        calls++;
        if (fault === 'crash' && calls === crashAt) {
          process.stderr.write(`[fleet] crashing on tools/call ${calls} (${name})\n`);
          process.exit(1);
        }
        if (fault === 'slow' && name === slowTool && !slowed.has(name)) {
          slowed.add(name);
          process.stderr.write(`[fleet] sleeping ${slowMs} ms in ${name}\n`);
          await new Promise((r) => setTimeout(r, slowMs));
        }
        if (fault === 'noisy-line') console.log(`debug: ${name} called`);
        if (fault === 'noisy-raw') process.stdout.write(`debug: ${name} called `);
        return fn(input);
      };
    },
  };
}
