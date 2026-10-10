'use strict';

// Eval scorecard: run the full pipeline over evals/questions.json and measure
// what matters — did supported claims answer the question, do citations hold
// up mechanically, what did it cost and how long did it take.
//   npm run eval                 # all questions
//   npm run eval -- --limit 3    # quick sample
//   npm run eval -- --rounds 1   # allow revise rounds (slower, pricier)
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');
const llm = require('../src/llm');
const { buildTools } = require('../src/tools');
const { runPipeline } = require('../src/orchestrator');
const { checkCitations } = require('../src/tools/citation-check');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');

function expectedHit(claimText, expected) {
  const text = norm(claimText);
  return expected.some((k) => text.includes(norm(k)));
}

function totalTokens(usage) {
  const perRound = (u) => (u?.toolLoop?.total_tokens ?? 0) + (u?.structured?.total_tokens ?? 0);
  return (usage?.rounds ?? []).reduce((sum, u) => sum + perRound(u), 0) + (usage?.synthesis?.total_tokens ?? 0);
}

async function evalOne(q, { maxRounds, concurrency, runPipelineFn, checkCitationsFn }) {
  const started = Date.now();
  const { state, usage } = await runPipelineFn({
    question: q.question,
    llm,
    tools: buildTools({ searchCache: new Map() }),
    maxRounds,
    concurrency,
    researcherModel: config.RESEARCHER_MODEL,
    checkerModel: config.CHECKER_MODEL,
    synthesizerModel: config.LLM_MODEL,
    citationCheck: 'off', // graded separately below, so the loop must not double-count it
  });

  const byId = new Map(state.claims.map((c) => [c.id, c]));
  const supported = state.verdicts.filter((v) => v.verdict === 'supported');
  const covered = supported.some((v) => byId.has(v.claimId) && expectedHit(byId.get(v.claimId).text, q.expected));

  const checks = supported.length ? await checkCitationsFn(state.verdicts, {}) : [];
  return {
    question: q.question,
    ok: true,
    claims: state.claims.length,
    supported: supported.length,
    covered,
    citationChecks: checks.length,
    citationsValid: checks.filter((c) => c.ok).length,
    tokens: totalTokens(usage),
    seconds: (Date.now() - started) / 1000,
  };
}

function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
  return {
    runs: results.length,
    runErrors: results.length - ok.length,
    coverage: pct(ok.filter((r) => r.covered).length, ok.length),
    citationValidity: pct(ok.reduce((s, r) => s + r.citationsValid, 0), ok.reduce((s, r) => s + r.citationChecks, 0)),
    supportedRate: pct(ok.reduce((s, r) => s + r.supported, 0), ok.reduce((s, r) => s + r.claims, 0)),
    avgClaims: ok.length ? +(ok.reduce((s, r) => s + r.claims, 0) / ok.length).toFixed(1) : null,
    totalTokens: ok.reduce((s, r) => s + r.tokens, 0),
    avgSeconds: ok.length ? Math.round(ok.reduce((s, r) => s + r.seconds, 0) / ok.length) : null,
    results,
  };
}

async function runEval({ questions, maxRounds = 0, concurrency = 2, limit, runPipelineFn = runPipeline, checkCitationsFn = checkCitations } = {}) {
  const selected = limit ? questions.slice(0, limit) : questions;
  const results = [];
  for (const [i, q] of selected.entries()) {
    process.stderr.write(`[${i + 1}/${selected.length}] ${q.question}\n`);
    try {
      results.push(await evalOne(q, { maxRounds, concurrency, runPipelineFn, checkCitationsFn }));
    } catch (err) {
      results.push({ question: q.question, ok: false, error: String(err.message).slice(0, 200) });
    }
  }
  return summarize(results);
}

function printScorecard(score) {
  console.log('\n=== Quorum eval scorecard ===');
  console.log(`runs: ${score.runs} (${score.runErrors} errored)`);
  console.log(`coverage:            ${score.coverage ?? 'n/a'}%  (questions whose supported claims contain the expected answer)`);
  console.log(`citation validity:   ${score.citationValidity ?? 'n/a'}%  (mechanical quote-vs-page checks)`);
  console.log(`supported rate:      ${score.supportedRate ?? 'n/a'}%  (claims passing fact-check)`);
  console.log(`avg claims per run:  ${score.avgClaims ?? 'n/a'}`);
  console.log(`total tokens:        ${score.totalTokens}`);
  console.log(`avg seconds per run: ${score.avgSeconds ?? 'n/a'}`);
  for (const r of score.results) {
    const mark = !r.ok ? '!' : r.covered ? '✓' : '·';
    console.log(`  ${mark} ${r.question}`);
    if (!r.ok) console.log(`      error: ${r.error}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    const v = i !== -1 ? Number.parseInt(argv[i + 1], 10) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const questions = JSON.parse(await fs.readFile(path.join(__dirname, 'questions.json'), 'utf8'));
  const score = await runEval({
    questions,
    maxRounds: flag('rounds', 0),
    limit: flag('limit', undefined),
  });
  printScorecard(score);
  const out = path.join(__dirname, `results-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(score, null, 2));
  console.log(`\nsaved: ${out}`);
}

module.exports = { runEval, summarize, expectedHit, totalTokens };

if (require.main === module) main().catch((err) => {
  console.error(`eval failed: ${err.message}`);
  process.exit(1);
});
