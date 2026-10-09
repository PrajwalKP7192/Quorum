'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runToolLoop } = require('../src/agents/base');

const TOOLS = [
  {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (args) => [{ title: 'T', url: 'https://example.com', snippet: 's', content: 'c', query: args.query }],
  },
  {
    name: 'boom',
    description: 'always fails',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      throw new Error('kaboom');
    },
  },
];

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('runToolLoop executes tool calls and feeds results back until the model stops', async () => {
  const chats = [];
  const llm = {
    chat: async ({ messages }) => {
      chats.push(messages.map((m) => m.role));
      if (chats.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('t1', 'web_search', { query: 'tokyo' })],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return { message: { role: 'assistant', content: 'Done.' }, usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } };
    },
  };

  const { messages, finalMessage, usage, steps, hitMaxSteps } = await runToolLoop({
    llm,
    system: 'sys',
    messages: [{ role: 'user', content: 'q' }],
    tools: TOOLS,
  });

  assert.equal(finalMessage.content, 'Done.');
  assert.equal(hitMaxSteps, false);
  assert.equal(steps, 2);
  // roles: system, user, assistant(tool_calls), tool
  assert.deepEqual(chats[1], ['system', 'user', 'assistant', 'tool']);
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 't1');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload[0].query, 'tokyo'); // structured result passed through as JSON
  // usage accumulated across calls
  assert.equal(usage.total_tokens, 38);
});

test('runToolLoop handles multiple parallel tool calls in one message', async () => {
  let chats = 0;
  const llm = {
    chat: async () =>
      chats++ === 0
        ? { message: { role: 'assistant', content: null, tool_calls: [toolCall('a', 'web_search', { query: 'x' }), toolCall('b', 'boom', {})] } }
        : { message: { role: 'assistant', content: 'ok' } },
  };
  const { messages } = await runToolLoop({ llm, system: 's', tools: TOOLS });
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.deepEqual(JSON.parse(toolMsgs[0].content)[0].query, 'x'); // search result JSON
  assert.match(toolMsgs[1].content, /^Error: kaboom$/); // failed tool -> error string, not a throw
});

test('runToolLoop reports unknown tools as errors instead of crashing', async () => {
  let first = true;
  const llm = {
    chat: async () => {
      if (first) {
        first = false;
        return { message: { role: 'assistant', content: null, tool_calls: [toolCall('u', 'no_such_tool', {})] } };
      }
      return { message: { role: 'assistant', content: 'recovered' } };
    },
  };
  const { messages, finalMessage } = await runToolLoop({ llm, system: 's', tools: TOOLS });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /unknown tool "no_such_tool"/);
  assert.equal(finalMessage.content, 'recovered');
});

test('runToolLoop stops at maxSteps and flags hitMaxSteps', async () => {
  const llm = {
    chat: async () => ({
      message: { role: 'assistant', content: null, tool_calls: [toolCall('t', 'web_search', { query: 'loop' })] },
    }),
  };
  const { steps, hitMaxSteps } = await runToolLoop({ llm, system: 's', tools: TOOLS, maxSteps: 3 });
  assert.equal(steps, 3);
  assert.equal(hitMaxSteps, true);
});
