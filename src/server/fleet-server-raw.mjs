// The same fleet server, written against the SDK's low-level Server class.
//
//   node src/server/fleet-server-raw.mjs
//
// This is the control for fleet-server.mjs. The low-level class takes a
// handler per JSON-RPC method and does nothing for you: no schema conversion,
// no input validation, no error wrapping. So tools/list can return the exact
// JSON Schema from src/rig/tools.mjs, and a handler that throws is not caught
// here. The SDK's protocol layer turns the throw into a JSON-RPC error
// response instead of a tool result, and the client has to decide what the
// model sees. Same rule as the other server: stdout is the protocol, logs go
// to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefs, runTool } from '../rig/tools.mjs';
import { makeFaults } from './faults.mjs';

const faults = makeFaults();
const server = new Server({ name: 'fleet-raw', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: toolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const out = await faults.wrap(name, (input) => runTool(name, input))(args);
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[fleet] raw server ready on stdio${faults.fault ? `, fault=${faults.fault}` : ''}\n`);
