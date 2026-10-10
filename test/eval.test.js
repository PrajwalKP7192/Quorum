'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEval, summarize, expectedHit, totalTokens } = require('../evals/grade');

const QUESTIONS = [
  { question: 'What is the capital of Australia?', expected: ['canberra'] },
  { question: 'What is the capital of Japan?', expected: ['tokyo'] },
];

const claim = (id, text) => ({ id, text, sources: [{ url: `https://x.example/${id}`, title: 'S' }] });

function fakePipeline(overrides = {}) {
  return async ({ question }) => ({
    state: {
      question,
      round: 0,
      claims: overrides.claims ?? [claim('c1', 'The capital of Australia is Canberra, and the capital of Japan is Tokyo.')],
      verdicts: overrides.verdicts ?? [{ claimId: 'c1', verdict: 'supported', evidenceQuote: 'q', url: 'https://x.example/c1' }],
      dropped: [],
      report: '# r',
    },
    usage: overrides.usage ?? { rounds: [{ toolLoop: { total_tokens: 100 }, structured: { total_tokens: 50 } }], synthesis: { total_tokens: 25 } },
    runDir: '/tmp/x',
    roundsUsed: 1,
  });
}

test('expectedHit matches keywords case-insensitively', () => {
  assert.equal(expectedHit('Canberra is the capital.', ['canberra']), true);
  assert.equal(expectedHit('Sydney is often mistaken for it.', ['canberra']), false);
});

test('totalTokens sums tool loop + structured + synthesis', () => {
  assert.equal(totalTokens({ rounds: [{ toolLoop: { total_tokens: 100 }, structured: { total_tokens: 50 } }], synthesis: { total_tokens: 25 } }), 175);
  assert.equal(totalTokens(null), 0);
});

test('runEval scores coverage and citation validity over all questions', async () => {
  const score = await runEval({
    questions: QUESTIONS,
    runPipelineFn: fakePipeline(),
    checkCitationsFn: async () => [{ claimId: 'c1', ok: true, reason: 'quote-found' }],
  });
  assert.equal(score.runs, 2);
  assert.equal(score.runErrors, 0);
  assert.equal(score.coverage, 100); // both claims contain their expected answer
  assert.equal(score.citationValidity, 100);
  assert.equal(score.totalTokens, 350); // 175 per run
  assert.equal(score.avgClaims, 1);
});

test('runEval counts a miss when no supported claim matches, and tolerates run errors', async () => {
  let first = true;
  const score = await runEval({
    questions: QUESTIONS,
    runPipelineFn: async (args) => {
      if (first) {
        first = false;
        return fakePipeline({
          claims: [claim('c1', 'Sydney is the largest city in Australia.')],
        })(args);
      }
      throw new Error('rate limited');
    },
    checkCitationsFn: async () => [],
  });
  assert.equal(score.runs, 2);
  assert.equal(score.runErrors, 1);
  assert.equal(score.coverage, 0); // the one successful run did not answer the question
  assert.ok(score.results[1].error.includes('rate limited'));
});

test('summarize handles an empty result set', () => {
  const s = summarize([]);
  assert.equal(s.runs, 0);
  assert.equal(s.coverage, null);
  assert.equal(s.citationValidity, null);
});
