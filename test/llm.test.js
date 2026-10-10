'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');
const { z } = require('zod');

const Answer = z.object({ answer: z.string().min(1) });

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return respond(calls.length, url, opts);
  };
  fn.calls = calls;
  return fn;
}

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => '',
  };
}

test('structuredChat parses a bare JSON object', async () => {
  const fetchImpl = fakeFetch(() => okResponse('{"answer": "42"}'));
  const { data, attempts, usage } = await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema: Answer,
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(data.answer, '42');
  assert.equal(attempts, 1);
  assert.equal(usage.total_tokens, 15);
});

test('structuredChat parses fenced JSON', async () => {
  const fetchImpl = fakeFetch(() => okResponse('```json\n{"answer": "forty-two"}\n```'));
  const { data } = await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema: Answer,
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(data.answer, 'forty-two');
});

test('structuredChat repairs invalid output with the validation errors', async () => {
  const schema = z.object({ answer: z.string(), count: z.number().int() });
  const fetchImpl = fakeFetch((n) =>
    okResponse(n === 1 ? '{"answer": "x", "count": "not a number"}' : '{"answer": "x", "count": 3}')
  );
  const { data, attempts } = await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema,
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.deepEqual(data, { answer: 'x', count: 3 });
  assert.equal(attempts, 2);
  // The repair prompt names the offending field (call #2 = the repair round-trip).
  const repairCall = JSON.parse(fetchImpl.calls[1].opts.body);
  const lastUser = [...repairCall.messages].reverse().find((m) => m.role === 'user');
  assert.match(lastUser.content, /count/);
});

test('structuredChat throws after exhausting repair attempts', async () => {
  const fetchImpl = fakeFetch(() => okResponse('not json at all'));
  await assert.rejects(
    llm.structuredChat({
      messages: [{ role: 'user', content: 'q' }],
      schema: Answer,
      apiKey: 'test-key',
      fetchImpl,
      maxRepairAttempts: 1,
    }),
    /failed schema validation after 2 attempt/
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('chat surfaces HTTP errors with status and body', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 401,
    text: async () => '{"error": "bad key"}',
  }));
  await assert.rejects(
    llm.chat({ messages: [{ role: 'user', content: 'q' }], apiKey: 'bad', fetchImpl }),
    /LLM API error 401.*bad key/s
  );
});

test('chat retries transient network errors and succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('fetch failed');
      e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
      throw e;
    }
    return okResponse('{"answer": "ok"}');
  };
  const { data } = await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema: Answer,
    apiKey: 'test-key',
    fetchImpl,
    retryBaseDelayMs: 1,
  });
  assert.equal(data.answer, 'ok');
  assert.equal(calls, 2);
});

test('structuredChat recovers when tools are blocked on the final call (Groq tool_use_failed)', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              code: 'tool_use_failed',
              message: 'Tool choice is none, but model called a tool',
              failed_generation: '{"name": "web_open", "arguments": {}}',
            },
          }),
      };
    }
    return okResponse('{"answer": "recovered"}');
  };
  const { data } = await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema: Answer,
    apiKey: 'test-key',
    fetchImpl,
    retryBaseDelayMs: 1,
  });
  assert.equal(data.answer, 'recovered');
  assert.equal(calls, 2);
});

test('chat escalates temperature on repair retries', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return okResponse('{"answer": 123}'); // fails schema
    return okResponse('{"answer": "fine"}');
  };
  await llm.structuredChat({
    messages: [{ role: 'user', content: 'q' }],
    schema: Answer,
    apiKey: 'test-key',
    fetchImpl,
    temperature: 0,
  });
  assert.equal(bodies[0].temperature, 0);
  assert.ok(bodies[1].temperature >= 0.3, 'repair attempt should raise temperature');
});

test('chat throws a clear error without an API key', async () => {
  await assert.rejects(
    llm.chat({ messages: [{ role: 'user', content: 'q' }], apiKey: '', fetchImpl: async () => { throw new Error('should not fetch'); } }),
    /OPENAI_API_KEY is not set/
  );
});

test('chat forwards tools and model in the request body', async () => {
  const fetchImpl = fakeFetch(() => okResponse(null));
  await llm.chat({
    messages: [{ role: 'user', content: 'q' }],
    model: 'm-test',
    tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
    apiKey: 'k',
    fetchImpl,
  });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.model, 'm-test');
  assert.equal(body.tools.length, 1);
});

test('extractJson handles bare, fenced and embedded JSON', () => {
  assert.deepEqual(llm.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(llm.extractJson('```json\n{"a": 2}\n```'), { a: 2 });
  assert.deepEqual(llm.extractJson('Here you go: {"a": 3} hope that helps'), { a: 3 });
  assert.throws(() => llm.extractJson('no json here'));
});
