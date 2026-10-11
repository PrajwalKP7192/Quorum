'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { researchParallel } = require('../src/agents/researcher');

const TOOLS = [{
  name: 'web_search',
  description: 'search',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  execute: async () => [{ title: 'T', url: 'https://s.example', snippet: 's', content: 'c' }],
}];

// Fake llm: structuredChat answers per-schema — decompose first, then per-sub claims.
function fakeLlm(subClaims) {
  const calls = [];
  return {
    calls,
    chat: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    structuredChat: async ({ schema, messages }) => {
      calls.push(messages[0].content);
      if (messages.length === 1) { // decompose call: single user message
        return { data: { subQuestions: ['sub one', 'sub two', 'sub three'] }, attempts: 1, usage: null };
      }
      const which = subClaims[calls.filter((c) => !c.includes('Decompose')).length - 1] ?? [];
      void which;
      // respond based on the user question text to keep tests deterministic
      if (messages[1].content.includes('sub one')) return { data: { claims: subClaims[0] }, attempts: 1, usage: null };
      if (messages[1].content.includes('sub two')) return { data: { claims: subClaims[1] }, attempts: 1, usage: null };
      return { data: { claims: subClaims[2] }, attempts: 1, usage: null };
    },
  };
}

test('researchParallel fans out per sub-question and merges renumbered claims', async () => {
  const llm = fakeLlm([
    [{ text: 'Claim A.', sources: [{ url: 'https://a.example', title: 'A' }] }],
    [], // sub two found nothing
    [
      { text: 'Claim B.', sources: [{ url: 'https://b.example', title: 'B' }] },
      { text: 'Claim C.', sources: [{ url: 'https://c.example', title: 'C' }] },
    ],
  ]);

  const { subQuestions, claims } = await researchParallel({ question: 'Q?', llm, tools: TOOLS, concurrency: 2 });

  assert.deepEqual(subQuestions, ['sub one', 'sub two', 'sub three']);
  assert.deepEqual(claims.map((c) => c.id), ['c1', 'c2', 'c3']); // merged + renumbered, gap from empty sub filled
  assert.deepEqual(claims.map((c) => c.text), ['Claim A.', 'Claim B.', 'Claim C.']);
});

test('researchParallel caps concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const base = fakeLlm([[{ text: 'X.', sources: [{ url: 'https://x.example', title: 'X' }] }]]);
  const llm = {
    chat: base.chat,
    structuredChat: async (args) => {
      if (args.messages.length === 1) { // decompose call: single user message
        return { data: { subQuestions: ['a', 'b', 'c', 'd', 'e'] }, attempts: 1, usage: null };
      }
      const sub = args.messages[1].content;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { data: { claims: [{ text: `Claim for ${sub}.`, sources: [{ url: `https://${sub}.example`, title: 'X' }] }] }, attempts: 1, usage: null };
    },
  };
  const { claims } = await researchParallel({ question: 'Q?', llm, tools: TOOLS, concurrency: 2 });
  assert.equal(claims.length, 5);
  assert.ok(maxActive <= 2, `concurrency cap exceeded: ${maxActive}`);
});

test('researchParallel isolates a failing sub-question', async () => {
  const llm = fakeLlm([
    [{ text: 'Good.', sources: [{ url: 'https://g.example', title: 'G' }] }],
  ]);
  llm.structuredChat = async (args) => {
    if (args.messages.length === 1) { // decompose call: single user message
      return { data: { subQuestions: ['ok sub', 'bad sub'] }, attempts: 1, usage: null };
    }
    if (args.messages[1].content.includes('bad sub')) throw new Error('rate limited');
    return { data: { claims: [{ text: 'Good.', sources: [{ url: 'https://g.example', title: 'G' }] }] }, attempts: 1, usage: null };
  };
  const { claims } = await researchParallel({ question: 'Q?', llm, tools: TOOLS });
  assert.deepEqual(claims.map((c) => c.text), ['Good.']); // the failed sub contributed nothing
});
