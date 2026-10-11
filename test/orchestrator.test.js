'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runPipeline } = require('../src/orchestrator');
const { RunState } = require('../src/contracts');

const claim = (id, text = `Claim ${id}.`) => ({
  id,
  text,
  sources: [{ url: `https://example.com/${id}`, title: 'S' }],
});

const verdict = (id, v, feedback) => ({
  claimId: id,
  verdict: v,
  evidenceQuote: 'q',
  url: `https://example.com/${id}`,
  ...(feedback ? { feedback } : {}),
});

function pipelineFns({ claimsByRound, verdictsByRound = [] }) {
  const calls = { research: [], revise: [], verify: [], synthesize: [] };
  return {
    calls,
    researchFn: async (args) => {
      calls.research.push(args);
      return { subQuestions: ['q1'], claims: claimsByRound[0], usage: { total_tokens: 1 } };
    },
    reviseFn: async (args) => {
      calls.revise.push(args);
      return { subQuestions: ['q1'], claims: claimsByRound[calls.revise.length], usage: { total_tokens: 1 } };
    },
    verifyAllFn: async (claims, opts) => {
      calls.verify.push({ claims: claims.map((c) => c.id), opts });
      const round = calls.verify.length - 1;
      return (verdictsByRound[round] ?? claims.map((c) => verdict(c.id, 'supported'))).filter((v) =>
        claims.some((c) => c.id === v.claimId)
      );
    },
    synthesizeFn: async (args) => {
      calls.synthesize.push(args);
      return { report: '# Report\n\nBody with [c1](https://example.com/c1).', usage: { total_tokens: 2 }, supportedCount: 1 };
    },
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'quorum-test-'));
}

test('all supported in round 0: single round, artifacts written, state valid', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [[claim('c1'), claim('c2')]],
    verdictsByRound: [[verdict('c1', 'supported'), verdict('c2', 'supported')]],
  });

  const { state, runDir, roundsUsed } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    ...fns,
  });

  assert.equal(roundsUsed, 1);
  assert.equal(runDir, outDir);
  assert.equal(fns.calls.revise.length, 0);
  assert.deepEqual(state.dropped, []);
  assert.match(state.report, /# Report/);

  const disk = JSON.parse(await fs.readFile(path.join(outDir, 'state.json'), 'utf8'));
  RunState.parse(disk); // persisted state satisfies the contract
  assert.equal(disk.round, 0);
  const report = await fs.readFile(path.join(outDir, 'quorum-report.md'), 'utf8');
  assert.match(report, /# Report/);
});

test('failed claim triggers a revise round; dropped claims land in state.dropped', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [
      [claim('c1'), claim('c2', 'Wrong claim.')],
      [claim('c1')], // revise drops c2, keeps c1
    ],
    verdictsByRound: [
      [verdict('c1', 'supported'), verdict('c2', 'contradicted', 'wrong number')],
      [verdict('c1', 'supported')],
    ],
  });

  const events = [];
  const { state, roundsUsed } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    onEvent: (e, d) => events.push(e),
    ...fns,
  });

  assert.equal(roundsUsed, 2);
  // revise got the failed verdicts of round 0 with feedback
  assert.equal(fns.calls.revise[0].failedVerdicts.length, 1);
  assert.equal(fns.calls.revise[0].failedVerdicts[0].claimId, 'c2');
  assert.match(fns.calls.revise[0].failedVerdicts[0].feedback, /wrong number/);
  // dropped claim retained with its text
  assert.equal(state.dropped.length, 1);
  assert.equal(state.dropped[0].id, 'c2');
  assert.equal(state.dropped[0].text, 'Wrong claim.');
  // synthesizer saw the post-round-1 state
  assert.equal(fns.calls.synthesize[0].state.claims.map((c) => c.id).join(), 'c1');
  assert.ok(events.includes('round:start'));
  assert.ok(!events.includes('rounds:exhausted'));
});

test('loop stops at maxRounds when claims never converge', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [[claim('c1')], [claim('c1')], [claim('c1')]],
    verdictsByRound: [
      [verdict('c1', 'unverifiable', 'no source')],
      [verdict('c1', 'unverifiable', 'no source')],
      [verdict('c1', 'unverifiable', 'no source')],
    ],
  });

  const events = [];
  const { state, roundsUsed } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    maxRounds: 2, // 3 passes total
    outDir,
    onEvent: (e) => events.push(e),
    ...fns,
  });

  assert.equal(roundsUsed, 3); // rounds 0, 1, 2
  assert.equal(state.round, 2);
  assert.equal(state.verdicts[0].verdict, 'unverifiable');
  assert.ok(events.includes('rounds:exhausted'));
  assert.match(state.report, /# Report/); // still synthesizes from what's supported
});

test('checker concurrency and models flow through to verifyAll', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({ claimsByRound: [[claim('c1')]] });
  await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    concurrency: 7,
    checkerModel: 'cheap-1',
    researcherModel: 'big-1',
    synthesizerModel: 'big-1',
    ...fns,
  });
  assert.equal(fns.calls.verify[0].opts.concurrency, 7);
  assert.equal(fns.calls.verify[0].opts.checkerModel, 'cheap-1');
  assert.equal(fns.calls.research[0].model, 'big-1');
});

test('skeptic pass runs before synthesis and objections reach state + synthesizer', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [[claim('c1')]],
    verdictsByRound: [[verdict('c1', 'supported')]],
  });
  let skepticCalled = 0;
  const { state } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    skepticEnabled: true,
    skepticFn: async () => {
      skepticCalled++;
      return { objections: [{ claimId: 'c1', objection: 'Largest by which measure?' }] };
    },
    ...fns,
  });
  assert.equal(skepticCalled, 1);
  assert.deepEqual(state.objections, [{ claimId: 'c1', objection: 'Largest by which measure?' }]);
  assert.deepEqual(fns.calls.synthesize[0].state.objections[0].objection, 'Largest by which measure?');
});

test('skeptic can be disabled', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({ claimsByRound: [[claim('c1')]] });
  await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    skepticEnabled: false,
    skepticFn: async () => { throw new Error('skeptic must not run'); },
    ...fns,
  });
  assert.deepEqual(fns.calls.synthesize[0].state.objections, []);
});

test('runPipeline requires a question', async () => {
  await assert.rejects(runPipeline({ llm: {}, tools: [] }), /question is required/);
});

test('citation check warn mode reports but keeps verdicts', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [[claim('c1')]],
    verdictsByRound: [[verdict('c1', 'supported')]],
  });
  const events = [];
  const { state } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    citationCheck: 'warn',
    onEvent: (e, d) => events.push([e, d]),
    citationCheckFn: async () => [{ claimId: 'c1', url: 'https://example.com/c1', ok: false, reason: 'quote-not-found-on-page' }],
    ...fns,
  });
  assert.equal(state.verdicts[0].verdict, 'supported'); // warn does not demote
  assert.ok(events.some(([e, d]) => e === 'citation-check:fail' && d.claimId === 'c1'));
});

test('citation check strict mode demotes unsupported quotes to unverifiable', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({
    claimsByRound: [[claim('c1')]],
    verdictsByRound: [[verdict('c1', 'supported')]],
  });
  const { state } = await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    maxRounds: 0, // the demotion is visible without a revise round
    citationCheck: 'strict',
    citationCheckFn: async () => [{ claimId: 'c1', url: 'https://example.com/c1', ok: false, reason: 'quote-not-found-on-page' }],
    ...fns,
  });
  assert.equal(state.verdicts[0].verdict, 'unverifiable');
  assert.match(state.verdicts[0].feedback, /citation check failed: quote-not-found-on-page/);
});

test('citation check off skips the check entirely', async () => {
  const outDir = await tmpDir();
  const fns = pipelineFns({ claimsByRound: [[claim('c1')]] });
  let called = false;
  await runPipeline({
    question: 'Q?',
    llm: {},
    tools: [],
    outDir,
    citationCheck: 'off',
    citationCheckFn: async () => {
      called = true;
      return [];
    },
    ...fns,
  });
  assert.equal(called, false);
});
