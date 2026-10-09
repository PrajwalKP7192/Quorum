'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Source, Claim, Verdict, ResearchOutput, RunState } = require('../src/contracts');

test('Claim accepts a valid claim and defaults missing source title', () => {
  const claim = Claim.parse({
    id: 'c1',
    text: 'Tokyo is the most populous metropolitan area in the world.',
    sources: [{ url: 'https://example.com/tokyo' }],
  });
  assert.equal(claim.sources[0].title, 'Untitled');
});

test('Claim rejects bad ids, empty text, missing or malformed sources', () => {
  const base = {
    text: 'Something factual.',
    sources: [{ url: 'https://example.com/a', title: 'A' }],
  };
  assert.throws(() => Claim.parse({ ...base, id: 'claim-1' }));
  assert.throws(() => Claim.parse({ ...base, id: 'c1', text: '' }));
  assert.throws(() => Claim.parse({ id: 'c1', text: base.text, sources: [] }));
  assert.throws(() => Claim.parse({ id: 'c1', text: base.text, sources: [{ url: 'not-a-url' }] }));
});

test('Verdict only allows the three verdict values', () => {
  const base = { claimId: 'c1', evidenceQuote: 'quote', url: 'https://example.com' };
  assert.equal(Verdict.parse({ ...base, verdict: 'supported' }).verdict, 'supported');
  assert.equal(Verdict.parse({ ...base, verdict: 'contradicted' }).verdict, 'contradicted');
  assert.equal(Verdict.parse({ ...base, verdict: 'unverifiable' }).verdict, 'unverifiable');
  assert.throws(() => Verdict.parse({ ...base, verdict: 'probably true' }));
  assert.throws(() => Verdict.parse({ verdict: 'supported', claimId: 'c1' })); // no quote, no url
});

test('Source rejects non-URLs', () => {
  assert.throws(() => Source.parse({ url: 'example.com', title: 'X' }));
  assert.equal(Source.parse({ url: 'https://example.com', title: 'X' }).url, 'https://example.com');
});

test('ResearchOutput requires at least one sub-question', () => {
  assert.throws(() => ResearchOutput.parse({ subQuestions: [], claims: [] }));
  const ok = ResearchOutput.parse({ subQuestions: ['q1'], claims: [] });
  assert.deepEqual(ok.claims, []);
});

test('RunState defaults empty collections', () => {
  const state = RunState.parse({ question: 'What?', round: 0 });
  assert.deepEqual(state.claims, []);
  assert.deepEqual(state.verdicts, []);
  assert.deepEqual(state.dropped, []);
  assert.equal(state.report, undefined);
});
