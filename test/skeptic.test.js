'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { skeptic } = require('../src/agents/skeptic');

const state = () => ({
  question: 'Q?',
  round: 0,
  claims: [
    { id: 'c1', text: 'Claim one.', sources: [{ url: 'https://a.example', title: 'A' }] },
    { id: 'c2', text: 'Claim two.', sources: [{ url: 'https://b.example', title: 'B' }] },
  ],
  verdicts: [
    { claimId: 'c1', verdict: 'supported', evidenceQuote: 'q', url: 'https://a.example' },
    { claimId: 'c2', verdict: 'unverifiable', evidenceQuote: 'q', url: 'https://b.example' },
  ],
  dropped: [],
  objections: [],
});

test('skeptic returns objections filtered to supported, existing claim ids', async () => {
  const llm = {
    chat: async () => ({ message: { role: 'assistant', content: 'done' } }),
    structuredChat: async () => ({
      data: {
        objections: [
          { claimId: 'c1', objection: 'Largest by which measure — city proper or metro?' },
          { claimId: 'c2', objection: 'this claim was never supported' }, // filtered: not supported
          { claimId: 'c99', objection: 'no such claim' }, // filtered: unknown id
        ],
      },
      attempts: 1,
      usage: null,
    }),
  };
  const { objections } = await skeptic({ state: state(), llm, tools: [] });
  assert.equal(objections.length, 1);
  assert.equal(objections[0].claimId, 'c1');
  assert.match(objections[0].objection, /which measure/);
});

test('skeptic skips silently when there are no supported claims', async () => {
  const s = state();
  s.verdicts = s.verdicts.map((v) => ({ ...v, verdict: 'unverifiable' }));
  const llm = { chat: async () => { throw new Error('should not be called'); }, structuredChat: async () => { throw new Error('should not be called'); } };
  const { objections } = await skeptic({ state: s, llm, tools: [] });
  assert.deepEqual(objections, []);
});

test('skeptic fails soft: an error yields no objections, never a crashed run', async () => {
  const llm = {
    chat: async () => { throw new Error('rate limited'); },
    structuredChat: async () => { throw new Error('rate limited'); },
  };
  const { objections } = await skeptic({ state: state(), llm, tools: [] });
  assert.deepEqual(objections, []);
});
