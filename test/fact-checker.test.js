'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyClaim, fallbackVerdict } = require('../src/agents/fact-checker');
const { Verdict } = require('../src/contracts');

const CLAIM = {
  id: 'c7',
  text: 'The Eiffel Tower is 330 metres tall.',
  sources: [{ url: 'https://example.com/eiffel', title: 'Eiffel facts' }],
};

function fakeLlm({ checkResult, failStructured = false }) {
  const calls = { chat: [], structured: [] };
  return {
    calls,
    chat: async ({ messages, temperature }) => {
      calls.chat.push({ roles: messages.map((m) => m.role), temperature });
      return { message: { role: 'assistant', content: 'Enough evidence.' } };
    },
    structuredChat: async (args) => {
      calls.structured.push(args);
      if (failStructured) throw new Error('schema validation exploded');
      return { data: checkResult, attempts: 1, usage: { total_tokens: 5 } };
    },
  };
}

test('verifyClaim returns a contract-valid Verdict with the claim id forced', async () => {
  const llm = fakeLlm({
    checkResult: {
      verdict: 'supported',
      evidenceQuote: 'The tower is 330 metres (1,083 ft) tall.',
      url: 'https://example.com/eiffel',
      feedback: undefined,
    },
  });
  const verdict = await verifyClaim({ claim: CLAIM, llm, tools: [] });
  assert.equal(verdict.claimId, 'c7'); // from the claim, not the model
  Verdict.parse(verdict); // full contract validation passes
  assert.equal(llm.calls.chat[0].temperature, 0); // checker runs cold
  // The claim brief reaches the tool loop.
  const userMsg = llm.calls.structured[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('Eiffel Tower'));
});

test('verifyClaim degrades to an unverifiable fallback when the checker output is unusable', async () => {
  const llm = fakeLlm({ checkResult: null, failStructured: true });
  const verdict = await verifyClaim({ claim: CLAIM, llm, tools: [] });
  assert.equal(verdict.verdict, 'unverifiable');
  assert.equal(verdict.claimId, 'c7');
  assert.match(verdict.feedback, /verification failed/);
  Verdict.parse(verdict);
});

test('fallbackVerdict quotes the claim\'s first cited URL', () => {
  const v = fallbackVerdict(CLAIM, 'boom');
  assert.equal(v.url, 'https://example.com/eiffel');
  assert.equal(v.verdict, 'unverifiable');
});
