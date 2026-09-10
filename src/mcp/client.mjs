// The MCP client side: what a harness has to do so that an agent loop can use
// tools that live in another process.
//
// connectFleet() spawns a fleet server over stdio, lists its tools, converts
// them into Anthropic tool definitions, and returns an execute() with the same
// shape as localExecutor, so runAgent cannot tell the two paths apart. Every
// job the direct path never had lives here:
//   - converting definitions (MCP inputSchema to Anthropic input_schema, and
//     dropping MCP-only fields the Messages API has no slot for)
//   - mapping two kinds of failure onto one: a tool-level error (a result with
//     isError) and a protocol-level error (callTool throws: timeout, closed
//     connection, JSON-RPC error)
//   - a request timeout, which an in-process function call never needed
//   - optionally, restarting a dead server and retrying the call once. That is
//     only safe because every fleet tool is read-only.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SERVERS = {
  zod: 'src/server/fleet-server.mjs',
  raw: 'src/server/fleet-server-raw.mjs',
};

// The Messages API tool shape has name, description and input_schema. MCP tools
// can also carry title, annotations, outputSchema, execution and _meta; there is
// nowhere to put them, so they are dropped and the caller is told which.
export function toAnthropicTool(t) {
  return {
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.inputSchema,
  };
}

export function droppedFields(tools) {
  return [...new Set(tools.flatMap((t) => Object.keys(t).filter((k) => !['name', 'description', 'inputSchema'].includes(k))))];
}

function toResult(r) {
  const content = (r.content ?? []).map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n');
  return { content, isError: Boolean(r.isError), via: 'result' };
}

// A protocol error has no tool result to show. Hand the model the message, as
// an off-the-shelf harness would.
function fromThrow(e) {
  return { content: String(e?.message ?? e), isError: true, via: 'throw', code: e instanceof McpError ? e.code : null };
}

const isConnectionLoss = (e) =>
  (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) || e?.message === 'Not connected';

export async function connectFleet({
  variant = 'zod',
  env = {},
  timeoutMs, // undefined means the SDK default, 60 s
  restart = false,
  restartEnv = {}, // the restarted server gets this instead of env, so a crash fault does not recur
} = {}) {
  const stats = { spawns: 0, restarts: 0, startupMs: [], closes: 0, stderr: [], transportErrors: [], toolsChangedOnRestart: false };
  let conn;
  let firstTools;

  async function spawn(serverEnv) {
    const t0 = performance.now();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, SERVERS[variant])],
      cwd: ROOT,
      // getDefaultEnvironment passes only HOME, PATH and similar. The API key in
      // this process never reaches the server unless someone puts it here.
      env: { ...getDefaultEnvironment(), ...serverEnv },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => stats.stderr.push(String(d).trim()));
    const client = new Client({ name: 'fleet-harness', version: '0.1.0' });
    const c = { client, alive: true };
    client.onclose = () => {
      c.alive = false;
      stats.closes++;
    };
    client.onerror = (e) => stats.transportErrors.push(String(e?.message ?? e).slice(0, 300));
    await client.connect(transport);
    const { tools } = await client.listTools();
    c.tools = tools;
    stats.spawns++;
    stats.startupMs.push(Math.round(performance.now() - t0));
    return c;
  }

  async function respawn() {
    try {
      await conn.client.close();
    } catch {}
    conn = await spawn(restartEnv);
    stats.restarts++;
    if (JSON.stringify(conn.tools) !== JSON.stringify(firstTools)) stats.toolsChangedOnRestart = true;
  }

  conn = await spawn(env);
  firstTools = conn.tools;

  const call = (name, input) =>
    conn.client.callTool({ name, arguments: input ?? {} }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);

  async function execute(name, input) {
    if (restart && !conn.alive) await respawn();
    try {
      return toResult(await call(name, input));
    } catch (e) {
      if (!(restart && isConnectionLoss(e))) return fromThrow(e);
      await respawn();
      try {
        return { ...toResult(await call(name, input)), retried: true };
      } catch (e2) {
        return fromThrow(e2);
      }
    }
  }

  return {
    tools: firstTools.map(toAnthropicTool),
    mcpTools: firstTools,
    execute,
    stats,
    close: async () => {
      try {
        await conn.client.close();
      } catch {}
    },
  };
}
