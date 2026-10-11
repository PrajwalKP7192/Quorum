'use strict';

// Live dashboard + API. Zero dependencies: plain node:http, SSE for the live
// pipeline feed, one inlined HTML page. One pipeline run at a time (free tier).
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runPipeline, runsRoot } = require('./orchestrator');
const llm = require('./llm');
const { buildTools } = require('./tools');
const config = require('./config');
const { PAGE } = require('./dashboard');

function listRuns(runsRootDir) {
  return fs.readdir(runsRootDir).then((entries) =>
    Promise.all(
      entries.map(async (id) => {
        try {
          const state = JSON.parse(await fs.readFile(path.join(runsRootDir, id, 'state.json'), 'utf8'));
          const supported = state.verdicts.filter((v) => v.verdict === 'supported').length;
          return { id, question: state.question, round: state.round, claims: state.claims.length, supported };
        } catch {
          return null; // half-written or non-run directory
        }
      })
    )
  ).then((rs) => rs.filter(Boolean).sort((a, b) => b.id.localeCompare(a.id)));
}


function sse(res, event, data) {
  res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
}

function createServer({ runsRootDir = runsRoot, runPipelineFn = runPipeline, llmClient = llm, toolsFn = buildTools, heartbeatMs = 15000 } = {}) {
  let running = false; // one pipeline at a time — the free tier cannot take more

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE);
      }
      if (url.pathname === '/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(await listRuns(runsRootDir)));
      }
      if (url.pathname.startsWith('/runs/')) {
        const [id, sub] = url.pathname.slice('/runs/'.length).split('/');
        const runDir = path.join(runsRootDir, id);
        // Trace endpoint: raw event log as a JSON array.
        if (sub === 'trace') {
          try {
            const raw = await fs.readFile(path.join(runDir, 'trace.jsonl'), 'utf8');
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
          } catch (err) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: `no trace for run ${id}` }));
          }
        }
        const state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'));
        // Browser navigation (deep link) gets the page; fetch() gets JSON.
        if ((req.headers.accept || '').includes('text/html')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end(PAGE);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state));
      }
      if (url.pathname === '/events') {
        const question = url.searchParams.get('question') || '';
        if (!question) {
          res.writeHead(400).end();
          return;
        }
        if (running) {
          res.writeHead(409).end();
          return;
        }
        running = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // SSE keep-alive: during rate-limit waits nothing streams for minutes,
        // and idle connections get reaped by browsers/proxies.
        const hb = setInterval(() => res.write(':hb\n\n'), heartbeatMs);
        try {
          const { state } = await runPipelineFn({
            question,
            llm: llmClient,
            tools: toolsFn({ searchCache: new Map() }),
            researcherModel: config.RESEARCHER_MODEL,
            checkerModel: config.CHECKER_MODEL,
            synthesizerModel: config.LLM_MODEL,
            onEvent: (event, data) => sse(res, event, data),
          });
          sse(res, 'report', { report: state.report });
        } catch (err) {
          sse(res, 'error', { message: String(err.message).slice(0, 300) });
        } finally {
          clearInterval(hb);
          running = false;
          res.end();
        }
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function main() {
  const port = config.PORT;
  createServer().listen(port, () => {
    console.log(`Quorum dashboard: http://localhost:${port}`);
  });
}

module.exports = { createServer };
module.exports.main = main;

if (require.main === module) main();
