#!/usr/bin/env node
'use strict';

// CLI: node src/cli.js "question" [--rounds N] [--out FILE]
// Runs the full pipeline (research → verify → revise → synthesize), prints
// progress + a verdict table, and writes the run to runs/<timestamp>/.

const fs = require('node:fs/promises');
const config = require('./config');
const llm = require('./llm');
const { buildTools } = require('./tools');
const { runPipeline } = require('./orchestrator');

const SYMBOL = { supported: '✓', contradicted: '✗', unverifiable: '?' };

function parseArgs(argv) {
  const args = { question: '', rounds: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds') args.rounds = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--out') args.out = argv[++i];
    else args.question += (args.question ? ' ' : '') + argv[i];
  }
  return args;
}

function usage() {
  console.error('usage: node src/cli.js "question" [--rounds N] [--out FILE]');
  console.error('example: node src/cli.js "What is the current population of Tokyo?"');
}

function printVerdictTable(state) {
  const byId = new Map(state.claims.map((c) => [c.id, c]));
  console.log(`\n## Verdicts (round ${state.round + 1})`);
  for (const v of state.verdicts) {
    const claim = byId.get(v.claimId);
    const mark = SYMBOL[v.verdict] ?? ' ';
    const text = (claim?.text ?? '(claim missing)').slice(0, 70);
    console.log(`  ${mark} [${v.claimId}] ${v.verdict.padEnd(13)} ${text}`);
    console.log(`      ${v.url}`);
    if (v.verdict !== 'supported' && v.feedback) {
      console.log(`      feedback: ${v.feedback.slice(0, 100)}`);
    }
  }
  for (const c of state.dropped) {
    console.log(`  − [${c.id}] dropped        ${c.text.slice(0, 70)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question || (args.rounds !== undefined && !(args.rounds >= 0))) {
    usage();
    process.exit(1);
  }
  if (!config.OPENAI_API_KEY) {
    console.error('error: OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  if (!config.TAVILY_API_KEY) {
    console.error('error: TAVILY_API_KEY is not set. Add it to .env to enable web search.');
    process.exit(1);
  }

  const started = Date.now();
  const { state, runDir, roundsUsed } = await runPipeline({
    question: args.question,
    llm,
    tools: buildTools({ searchCache: new Map() }),
    maxRounds: args.rounds ?? config.MAX_ROUNDS,
    researcherModel: config.RESEARCHER_MODEL,
    checkerModel: config.CHECKER_MODEL,
    synthesizerModel: config.LLM_MODEL,
    concurrency: config.VERIFY_CONCURRENCY,
    onEvent: (event, data) => {
      if (event === 'round:start') console.error(`\n── round ${data.round}/${data.total} ──`);
      if (event === 'verify:start') console.error(`verifying ${data.claims} claim(s) ...`);
      if (event === 'verify:claim') {
        const mark = SYMBOL[data.verdict.verdict] ?? ' ';
        console.error(`  ${mark} [${data.claimId}] ${data.verdict.verdict} — ${(data.claimText || '').slice(0, 70)}`);
      }
      if (event === 'verify:done') console.error(`${data.supported} supported, ${data.failed} failed`);
      if (event === 'rounds:exhausted') console.error(`max rounds reached; ${data.failed} claim(s) remain unverified`);
      if (event === 'report:start') console.error('synthesizing report ...');
      if (event === 'report:done') console.error(`report: ${data.supported} supported claims`);
    },
  });

  printVerdictTable(state);
  console.log(`\n# Report\n\n${state.report}`);

  if (args.out) {
    await fs.writeFile(args.out, state.report + '\n');
    console.error(`\nreport written to ${args.out}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\nrun dir: ${runDir} | rounds: ${roundsUsed} | ${seconds}s`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
