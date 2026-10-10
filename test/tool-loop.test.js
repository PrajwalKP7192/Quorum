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

test('runToolLoop recovers when the provider rejects an invented tool name', async () => {
  // Groq-style failure: the model hallucinated "web_open"; the API 400s.
  const chats = [];
  const llm = {
    chat: async ({ messages }) => {
      chats.push(messages.map((m) => m.role));
      if (chats.length === 1) {
        const err = new Error(
          `LLM API error 400: attempted to call tool 'web_open' which was not in request.tools`
        );
        throw err;
      }
      if (chats.length === 2) {
        return {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'web_search', { query: 'tokyo' })] },
        };
      }
      return { message: { role: 'assistant', content: 'recovered' } };
    },
  };
  const { finalMessage, messages } = await runToolLoop({ llm, system: 's', tools: TOOLS });
  assert.equal(finalMessage.content, 'recovered');
  // the correction prompt went back in and the next call used the real tool
  const correction = messages.find((m) => m.role === 'user' && /no tool named "web_open"/.test(m.content));
  assert.ok(correction, 'expected a tool-name correction message in the transcript');
  assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
});

test('runToolLoop rethrows non-tool-name errors unchanged', async () => {
  const llm = {
    chat: async () => {
      throw new Error('LLM API error 503: overloaded');
    },
  };
  await assert.rejects(runToolLoop({ llm, system: 's', tools: TOOLS, maxSteps: 2 }), /503/);
});

test('runToolLoop trims old tool results when the transcript outgrows the token budget', async () => {
  const seen = [];
  let chats = 0;
  const bigResult = 'X'.repeat(20000); // ~5000 tokens
  const llm = {
    chat: async ({ messages }) => {
      chats++;
      seen.push(messages);
      if (chats === 1) {
        return { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'web_search', { query: 'big' })] } };
      }
      if (chats === 2) {
        return { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'web_search', { query: 'small' })] } };
      }
      return { message: { role: 'assistant', content: 'done' } };
    },
  };
  const tools = [{
    ...TOOLS[0],
    execute: async (args) => (args.query === 'big' ? bigResult : 'tiny'),
  }];
  const { messages } = await runToolLoop({ llm, system: 's', tools, tokenBudget: 1200 });
  // by the third call the big first result must have been truncated
  const toolContents = seen[2].filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(toolContents[0].includes('[trimmed'), 'oldest tool result should be trimmed');
  assert.equal(toolContents[1], 'tiny'); // recent result untouched
  // and the final transcript reflects the trim too
  assert.ok(messages.find((m) => m.role === 'tool').content.includes('[trimmed'));
});

test('runToolLoop recovers when the model narrates a tool call (Groq output_parse_failed)', async () => {
  let chats = 0;
  const llm = {
    chat: async () => {
      chats++;
      if (chats === 1) {
        throw new Error(
          'LLM API error 400: {"error":{"code":"output_parse_failed","failed_generation":"We need to open pages. Use open_page for Wikipedia."}}'
        );
      }
      if (chats === 2) {
        return { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'web_search', { query: 'tokyo' })] } };
      }
      return { message: { role: 'assistant', content: 'done' } };
    },
  };
  const { messages, finalMessage } = await runToolLoop({ llm, system: 's', tools: TOOLS });
  assert.equal(finalMessage.content, 'done');
  const nudge = messages.find((m) => m.role === 'user' && /could not be parsed/.test(m.content));
  assert.ok(nudge, 'expected a parse-failure nudge in the transcript');
});
