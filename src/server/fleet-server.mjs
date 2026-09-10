// The fleet as an MCP server, written the way the SDK's high-level API wants.
//
//   node src/server/fleet-server.mjs
//
// It speaks MCP over stdio: the client spawns this process and talks JSON-RPC,
// one message per line, over its stdin and stdout. That makes stdout sacred.
// Anything else printed there is read by the client as a (broken) message, so
// every log in this file goes to stderr.
//
// McpServer.registerTool only accepts zod schemas, so the JSON Schema in
// src/rig/tools.mjs cannot be handed over as it is. It is re-authored below in
// zod, as faithfully as I can (same properties, same order, same enums, same
// description strings, no extra constraints), and the SDK converts it back to
// JSON Schema when a client asks for tools/list. Whether that round trip
// returns what went in is one of the things this repo measures.
//
// The handlers are the exact functions the direct path calls. Only the wiring
// is new.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { toolDefs, handlers, devices, FIELDS } from '../rig/tools.mjs';
import { makeFaults } from './faults.mjs';

const MODELS = [...new Set(devices.map((d) => d.model))];
const SITES = [...new Set(devices.map((d) => d.site))].sort();

// Reuse the direct definitions' wording so any difference is the SDK's doing.
const def = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
const P = def.top_devices.input_schema.properties;

const filters = {
  model: z.enum(MODELS).optional(),
  site: z.enum(SITES).optional().describe(P.site.description),
  firmware: z.string().optional().describe(P.firmware.description),
  min_hours: z.number().int().optional().describe(P.min_hours.description),
  max_hours: z.number().int().optional().describe(P.max_hours.description),
};

const shapes = {
  count_devices: { ...filters },
  top_devices: {
    field: z.enum(FIELDS).describe(P.field.description),
    limit: z.number().int().optional().describe(P.limit.description),
    ...filters,
  },
  get_device: {
    device_id: z.string().describe(def.get_device.input_schema.properties.device_id.description),
  },
};

const faults = makeFaults();
const server = new McpServer({ name: 'fleet', version: '0.1.0' });

for (const name of Object.keys(shapes)) {
  const run = faults.wrap(name, (args) => handlers[name](args));
  server.registerTool(
    name,
    { description: def[name].description, inputSchema: shapes[name] },
    // Same serialisation as localExecutor, so a successful result is the same
    // string on both paths. A throw is caught by McpServer and returned as an
    // isError result carrying the message.
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await run(args)) }] }),
  );
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[fleet] zod server ready on stdio${faults.fault ? `, fault=${faults.fault}` : ''}\n`);
