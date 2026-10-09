'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyAll } = require('../src/verify');
const { Verdict } = require('../src/contracts');

const claim = (id) => ({
  id,
  text: `Claim ${id}.`,
  sources: [{ url: `https://example.com/${id}`, title: 'S' }],
});

const supported = (id) => Verdict.parse({
  claimId: id,
  verdict: 'supported',
  evidenceQuote: 'q',
  url: `https://example.com/${id}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('verifyAll preserves claim order and passes checker options through', async () => {
  const seen = [];
  const verdicts = await verifyAll([claim('c1'), claim('c2'), claim('c3')], {
    llm: {},
    tools: [],
    concurrency: 2,
    checkerModel: 'checker-x',
    verifyOne: async ({ claim, model }) => {
      seen.push(model);
      return supported(claim.id);
    },
  });
  assert.deepEqual(verdicts.map((v) => v.claimId), ['c1', 'c2', 'c3']);
  assert.deepEqual(seen, ['checker-x', 'checker-x', 'checker-x']);
});

test('verifyAll caps concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const claims = Array.from({ length: 6 }, (_, i) => claim(`c${i + 1}`));
  const verdicts = await verifyAll(claims, {
    llm: {},
    tools: [],
    concurrency: 2,
    verifyOne: async ({ claim }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active--;
      return supported(claim.id);
    },
  });
  assert.equal(verdicts.length, 6);
  assert.ok(maxActive <= 2, `max concurrent ${maxActive} exceeded cap 2`);
  assert.ok(maxActive === 2, `expected the cap to be reached, got ${maxActive}`);
});

test('verifyAll isolates per-claim crashes as unverifiable verdicts', async () => {
  const verdicts = await verifyAll([claim('c1'), claim('c2'), claim('c3')], {
    llm: {},
    tools: [],
    verifyOne: async ({ claim }) => {
      if (claim.id === 'c2') throw new Error('network gone');
      return supported(claim.id);
    },
  });
  assert.equal(verdicts[0].verdict, 'supported');
  assert.equal(verdicts[1].verdict, 'unverifiable');
  assert.match(verdicts[1].feedback, /verification crashed: network gone/);
  assert.equal(verdicts[2].verdict, 'supported');
});

test('verifyAll handles an empty claim list', async () => {
  const verdicts = await verifyAll([], { llm: {}, tools: [], verifyOne: async () => { throw new Error('never'); } });
  assert.deepEqual(verdicts, []);
});
