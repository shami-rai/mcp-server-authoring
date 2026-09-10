// An instrumented agent loop, written by hand for the same reason as in
// loop-engineering: the SDK's tool runner IS the loop, and the loop is what
// these experiments need to see into and change.
//
// Everything an experiment varies comes in as an argument:
//   tools          the definitions the model sees
//   execute        what actually runs, and what the model is shown back,
//                  including on failure (async, so MCP can sit behind it)
//   beforeRequest  a transform over the history before each request
//                  (compaction lives here)
//   parallel       whether one turn may issue several tool calls
//   model, effort  the model and how hard it thinks
//
// Turns and tool calls are counted separately. loop-engineering's first run
// was 6 turns and 19 tool calls, so either one alone misreports the work.

import Anthropic from '@anthropic-ai/sdk';
import { appendFile } from 'node:fs/promises';

// USD per million tokens. Cache writes bill at 1.25x input, reads at 0.1x.
export const PRICES = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function costOf(model, u) {
  const p = PRICES[model];
  if (!p) return null;
  return (u.input * p.in + u.cacheWrite * p.in * 1.25 + u.cacheRead * p.in * 0.1 + u.output * p.out) / 1e6;
}

// Retries cover 429s and 5xx. Several experiments run back to back, and a
// transient rate limit should cost time, not a data point.
export const makeClient = () => new Anthropic({ maxRetries: 8 });

function modelParams(model, effort) {
  // Haiku 4.5 takes no effort parameter and runs without thinking by default.
  if (model.startsWith('claude-haiku')) return {};
  return { output_config: { effort } };
}

// The default way to run a local tool: catch the throw and hand the message
// back as an error result. loop-engineering's control had no catch at all.
export function localExecutor(runTool) {
  return async (name, input) => {
    try {
      return { content: JSON.stringify(runTool(name, input)), isError: false };
    } catch (e) {
      return { content: String(e?.message ?? e), isError: true };
    }
  };
}

export async function runAgent({
  client = makeClient(),
  model = 'claude-opus-5',
  effort = 'high',
  maxTokens = 16000,
  system,
  question,
  tools,
  execute,
  parallel = true,
  maxTurns = 40,
  beforeRequest,
  extra = {},
  betas,
  tracePath,
  label = '',
}) {
  const messages = [{ role: 'user', content: question }];
  const trace = [];
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let toolCalls = 0;
  let toolErrors = 0;
  let peakContext = 0;
  let stop = 'end_turn';
  let answer = '';
  const started = Date.now();

  for (let turn = 1; ; turn++) {
    if (turn > maxTurns) {
      stop = 'max_turns';
      break;
    }

    const sent = beforeRequest ? await beforeRequest(messages, { turn, trace }) : messages;
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages: sent,
      cache_control: { type: 'ephemeral' },
      ...modelParams(model, effort),
      ...(parallel ? {} : { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }),
      ...extra,
    };

    let response;
    try {
      response = betas
        ? await client.beta.messages.create({ ...params, betas })
        : await client.messages.create(params);
    } catch (e) {
      stop = 'api_error';
      trace.push({ turn, error: String(e?.message ?? e) });
      break;
    }

    // Append everything verbatim, thinking blocks included.
    messages.push({ role: 'assistant', content: response.content });

    const u = response.usage;
    const context = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    peakContext = Math.max(peakContext, context);
    usage.input += u.input_tokens;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.output += u.output_tokens;

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const entry = { turn, context, output: u.output_tokens, stop_reason: response.stop_reason, text, calls: [] };
    trace.push(entry);

    if (response.stop_reason !== 'tool_use') {
      stop = response.stop_reason;
      answer = text;
      break;
    }

    // Every result from one turn goes back in one user message.
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolCalls++;
      const t = Date.now();
      const r = await execute(block.name, block.input, { turn });
      if (r.isError) toolErrors++;
      entry.calls.push({
        id: block.id,
        name: block.name,
        input: block.input,
        result: r.content,
        isError: Boolean(r.isError),
        ms: Date.now() - t,
      });
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  const run = {
    label,
    model,
    effort: model.startsWith('claude-haiku') ? null : effort,
    parallel,
    stop,
    answer,
    turns: trace.filter((t) => !t.error).length,
    toolCalls,
    toolErrors,
    peakContext,
    usage,
    costUSD: costOf(model, usage),
    wallMs: Date.now() - started,
    trace,
  };
  if (tracePath) await appendFile(tracePath, JSON.stringify(run) + '\n');
  return run;
}
