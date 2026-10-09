'use strict';

// Orchestrator: plain code routing work between agents and running the
// verify-and-revise loop. Agent functions are injectable for tests.
//
//   for (round = 0; round <= maxRounds; round++) {
//     claims   = round === 0 ? research() : revise(priorClaims, failed);
//     verdicts = verifyAll(claims);
//     if (no failures) break;
//   }
//   report = synthesize(supported claims only);
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { RunState } = require('./contracts');
const { research, revise } = require('./agents/researcher');
const { verifyAll } = require('./verify');
const { synthesize } = require('./agents/synthesizer');

const runsRoot = path.join(process.cwd(), 'runs');

async function persistState(runDir, state) {
  await fs.mkdir(runDir, { recursive: true });
  const validated = RunState.parse(state); // what goes on disk always satisfies the contract
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(validated, null, 2));
  return validated;
}

async function runPipeline({
  question,
  llm,
  tools,
  researcherModel = config.RESEARCHER_MODEL,
  checkerModel = config.CHECKER_MODEL,
  synthesizerModel = config.LLM_MODEL,
  maxRounds = config.MAX_ROUNDS,
  concurrency = config.VERIFY_CONCURRENCY,
  outDir,
  onEvent = () => {},
  // Injectable agent functions (tests pass fakes):
  researchFn = research,
  reviseFn = revise,
  verifyAllFn = verifyAll,
  synthesizeFn = synthesize,
}) {
  if (!question || typeof question !== 'string') throw new Error('runPipeline: question is required');

  const runDir = outDir || path.join(runsRoot, new Date().toISOString().replace(/[:.]/g, '-'));

  const state = RunState.parse({ question, round: 0 });
  const claimHistory = []; // full claim list per round, for dropped-claim lookups
  const usage = { rounds: [] };
  let roundsUsed = 0;

  for (let round = 0; round <= maxRounds; round++) {
    onEvent('round:start', { round: round + 1, total: maxRounds + 1 });
    state.round = round;

    const priorClaims = claimHistory[round - 1] ?? [];
    const priorIds = new Set(priorClaims.map((c) => c.id));
    const failedVerdicts = state.verdicts.filter((v) => v.verdict !== 'supported');

    const result =
      round === 0
        ? await researchFn({ question, llm, tools, model: researcherModel })
        : await reviseFn({ priorClaims, failedVerdicts, llm, tools, model: researcherModel });
    state.subQuestions = result.subQuestions;
    state.claims = result.claims;
    usage.rounds.push(result.usage ?? null);
    claimHistory[round] = state.claims.map((c) => structuredClone(c));

    if (round > 0) {
      // Claims the researcher removed in this revise round: prior ids that vanished.
      const keptIds = new Set(state.claims.map((c) => c.id));
      const alreadyDropped = new Set(state.dropped.map((c) => c.id));
      state.dropped.push(
        ...priorClaims.filter((c) => !keptIds.has(c.id) && !alreadyDropped.has(c.id))
      );
    }

    onEvent('verify:start', { round: round + 1, claims: state.claims.length });
    state.verdicts = await verifyAllFn(state.claims, { llm, tools, concurrency, checkerModel });

    const failed = state.verdicts.filter((v) => v.verdict !== 'supported');
    roundsUsed = round + 1;
    onEvent('verify:done', {
      round: round + 1,
      supported: state.verdicts.length - failed.length,
      failed: failed.length,
      verdicts: state.verdicts,
    });
    await persistState(runDir, state);

    if (failed.length === 0) break;
    if (round === maxRounds) onEvent('rounds:exhausted', { total: maxRounds + 1, failed: failed.length });
  }

  onEvent('report:start', {});
  const synth = await synthesizeFn({ state, llm, model: synthesizerModel });
  state.report = synth.report;
  usage.synthesis = synth.usage ?? null;

  await persistState(runDir, state);
  await fs.writeFile(path.join(runDir, 'quorum-report.md'), synth.report + '\n');

  onEvent('report:done', { runDir, supported: synth.supportedCount ?? 0 });
  return { state: RunState.parse(state), runDir, roundsUsed, usage };
}

module.exports = { runPipeline, runsRoot };
