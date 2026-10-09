'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { synthesize } = require('../src/agents/synthesizer');

function state() {
  return {
    question: 'How tall is the Eiffel Tower?',
    round: 1,
    subQuestions: ['q1'],
    claims: [
      { id: 'c1', text: 'The Eiffel Tower is 330 metres tall.', sources: [{ url: 'https://a.example.com', title: 'A' }] },
      { id: 'c2', text: 'The Eiffel Tower is 400 metres tall.', sources: [{ url: 'https://b.example.com', title: 'B' }] },
    ],
    verdicts: [
      { claimId: 'c1', verdict: 'supported', evidenceQuote: 'q', url: 'https://a.example.com' },
      { claimId: 'c2', verdict: 'contradicted', evidenceQuote: 'q', url: 'https://b.example.com', feedback: 'wrong height' },
    ],
    dropped: [
      { id: 'c3', text: 'Built in 1900.', sources: [{ url: 'https://c.example.com', title: 'C' }] },
    ],
  };
}

test('synthesize feeds only supported claims as facts and lists the rest in the appendix data', async () => {
  let captured;
  const llm = {
    chat: async ({ messages, model, temperature }) => {
      captured = { messages, model, temperature };
      return { message: { role: 'assistant', content: '  # Answer\n\n330 m [c1](https://a.example.com).\n\n## Excluded claims\n- none\n' } };
    },
  };

  const { report, supportedCount } = await synthesize({ state: state(), llm, model: 'writer-1' });

  const prompt = captured.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('The Eiffel Tower is 330 metres tall.')); // supported -> usable fact
  assert.ok(prompt.includes('400 metres')); // failed claim appears only in the excluded list
  assert.ok(prompt.includes('"verdict":"contradicted"') || prompt.includes('"verdict": "contradicted"'));
  assert.ok(prompt.includes('Built in 1900.')); // dropped claim also in the excluded list
  assert.equal(captured.model, 'writer-1');
  assert.equal(supportedCount, 1);
  assert.equal(report, '# Answer\n\n330 m [c1](https://a.example.com).\n\n## Excluded claims\n- none'); // trimmed
});

test('synthesize handles a run with zero supported claims', async () => {
  const s = state();
  s.verdicts = s.verdicts.map((v) => ({ ...v, verdict: 'unverifiable' }));
  let prompt;
  const llm = {
    chat: async ({ messages }) => {
      prompt = messages.map((m) => m.content).join('\n');
      return { message: { role: 'assistant', content: '# Answer\n\nNo verified claims.\n\n## Excluded claims\n- all' } };
    },
  };
  const { supportedCount, report } = await synthesize({ state: s, llm });
  assert.equal(supportedCount, 0);
  assert.ok(prompt.includes('[]')); // empty supported list
  assert.match(report, /No verified claims/);
});
