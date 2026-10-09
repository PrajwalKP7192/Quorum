'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { research, revise, renumberClaims } = require('../src/agents/researcher');

const TOOLS = [
  {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (args) => [
      { title: 'Tokyo gov', url: 'https://tokyo.example.gov', snippet: 'snip', content: '37 million people' },
    ],
  },
];

function fakeLlm({ structuredOutput }) {
  const chats = [];
  return {
    chats,
    chat: async ({ messages }) => {
      chats.push(messages.map((m) => m.role));
      if (chats.length === 1) {
        return {
          message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"tokyo population"}' } }] },
        };
      }
      return { message: { role: 'assistant', content: 'I have enough material.' } };
    },
    structuredChat: async (args) => {
      structuredOutput.received = args;
      return { data: structuredOutput.data, attempts: 1, usage: { total_tokens: 100 } };
    },
  };
}

test('research runs the tool loop, then emits renumbered contract-valid claims', async () => {
  const structuredOutput = {
    data: {
      subQuestions: ['How many people live in Tokyo?', 'Is it the largest metro area?'],
      claims: [
        {
          text: 'The Tokyo metropolitan area has about 37 million residents.',
          sources: [{ url: 'https://tokyo.example.gov', title: 'Tokyo gov' }],
        },
        // model used its own id and omitted the title — both get normalized
        {
          id: 'zz-42',
          text: 'Tokyo is the largest metropolitan area in the world.',
          sources: [{ url: 'https://tokyo.example.gov' }],
        },
      ],
    },
  };
  const llm = fakeLlm({ structuredOutput });

  const { subQuestions, claims, usage } = await research({ question: 'tokyo?', llm, tools: TOOLS });

  assert.deepEqual(subQuestions, structuredOutput.data.subQuestions);
  assert.deepEqual(claims.map((c) => c.id), ['c1', 'c2']); // ids assigned by code
  assert.equal(claims[1].sources[0].title, 'Untitled');
  // the structured call received the full tool-loop transcript, not a fresh one
  const roles = structuredOutput.received.messages.map((m) => m.role);
  assert.ok(roles.includes('tool'));
  // usage from both phases is reported
  assert.equal(usage.structured.total_tokens, 100);
});

test('research drops claims that violate the contract instead of failing', async () => {
  const structuredOutput = {
    data: {
      subQuestions: ['q'],
      claims: [
        { text: 'Good claim.', sources: [{ url: 'https://example.gov', title: 'G' }] },
        { text: 'No sources.', sources: [] }, // dropped
        { text: 'Bad url.', sources: [{ url: 'not a url' }] }, // dropped
        { sources: [{ url: 'https://example.gov' }] }, // no text, dropped
      ],
    },
  };
  const llm = fakeLlm({ structuredOutput });
  const { claims } = await research({ question: 'q?', llm, tools: TOOLS });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, 'c1');
  assert.equal(claims[0].text, 'Good claim.');
});

test('research passes the model override down to the structured call', async () => {
  const structuredOutput = { data: { subQuestions: ['q'], claims: [] } };
  const llm = fakeLlm({ structuredOutput });
  await research({ question: 'q?', llm, tools: TOOLS, model: 'researcher-x' });
  assert.equal(structuredOutput.received.model, 'researcher-x');
});

test('revise keeps prior ids for carried claims and assigns fresh ids after the prior max', async () => {
  const priorClaims = [
    { id: 'c1', text: 'Kept.', sources: [{ url: 'https://a.example.com', title: 'A' }] },
    { id: 'c2', text: 'Fixed now.', sources: [{ url: 'https://b.example.com', title: 'B' }] },
    { id: 'c3', text: 'Dropped.', sources: [{ url: 'https://c.example.com', title: 'C' }] },
  ];
  const structuredOutput = {
    data: {
      subQuestions: ['q'],
      claims: [
        { id: 'c1', text: 'Kept.', sources: [{ url: 'https://a.example.com', title: 'A' }] },
        { id: 'c2', text: 'Fixed now.', sources: [{ url: 'https://b.example.com', title: 'B' }] },
        { id: 'c99', text: 'Bogus id not in prior list.', sources: [{ url: 'https://d.example.com', title: 'D' }] },
        { text: 'Brand new claim.', sources: [{ url: 'https://e.example.com', title: 'E' }] },
      ],
    },
  };
  const llm = fakeLlm({ structuredOutput });
  const failedVerdicts = [
    { claimId: 'c2', verdict: 'contradicted', evidenceQuote: 'q', url: 'https://x.example.com', feedback: 'wrong number' },
  ];

  const { claims } = await revise({ priorClaims, failedVerdicts, llm, tools: TOOLS });

  // c1, c2 carry their prior ids; c99 is unknown -> fresh; new claim -> fresh after priorMax(3)
  assert.deepEqual(claims.map((c) => c.id), ['c1', 'c2', 'c4', 'c5']);
  // The revise prompt contains the prior claims and the checker's feedback.
  assert.ok(llm.chats.length > 0); // tool loop ran
  const promptBlobs = structuredOutput.received.messages.map((m) => m.content ?? '').join('\n');
  assert.ok(promptBlobs.includes('wrong number'));
  assert.ok(promptBlobs.includes('Dropped.'));
});

test('renumberClaims dedupes repeated ids and drops invalid claims', () => {
  const claims = renumberClaims(
    [
      { id: 'c1', text: 'A.', sources: [{ url: 'https://a.example.com', title: 'A' }] },
      { id: 'c1', text: 'Duplicate id.', sources: [{ url: 'https://a.example.com', title: 'A' }] },
      { text: 'No sources.', sources: [] },
    ],
    new Set(['c1'])
  );
  assert.deepEqual(claims.map((c) => c.id), ['c1', 'c2']);
  assert.equal(claims[1].text, 'Duplicate id.');
});
