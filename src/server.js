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

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Quorum</title><style>
  body{background:#111;color:#ddd;font:14px/1.5 ui-monospace,monospace;max-width:860px;margin:2rem auto;padding:0 1rem}
  h1{color:#7c9} input{background:#1b1b1b;color:#eee;border:1px solid #333;padding:.5rem;width:60%}
  button{background:#284;padding:.5rem 1rem;color:#fff;border:0;cursor:pointer}
  #log div{padding:.15rem 0;border-bottom:1px solid #1e1e1e} .ok{color:#7c9}.bad{color:#e66}.dim{color:#888}
  pre{white-space:pre-wrap;background:#161616;padding:1rem;border:1px solid #222}
  a{color:#7c9}
</style></head><body>
<h1>Quorum — verified research</h1>
<p><input id="q" placeholder="Ask a research question..." size="60"><button onclick="go()">Research</button></p>
<div id="log"></div><pre id="report" hidden></pre>
<h2>Past runs</h2><ul id="runs"></ul>
<script>
function add(t, cls){ const d=document.createElement('div'); if(cls)d.className=cls; d.textContent=t;
  document.getElementById('log').prepend(d); }
async function loadRuns(){
  const rs = await (await fetch('/runs')).json();
  document.getElementById('runs').innerHTML = rs.map(r=>
    '<li><a href="#" onclick="showRun(\\''+r.id+'\\');return false">'+r.id+'</a> — '+r.question+
    ' ('+r.supported+'/'+r.claims+' supported)</li>').join('');
}
async function showRun(id){
  const r = await (await fetch('/runs/'+id)).json();
  const el=document.getElementById('report'); el.hidden=false; el.textContent=r.report||'(no report)';
  window.scrollTo(0,document.body.scrollHeight);
}
function go(){
  const q=document.getElementById('q').value.trim(); if(!q)return;
  document.getElementById('report').hidden=true;
  add('▶ '+q,'dim');
  const es=new EventSource('/events?question='+encodeURIComponent(q));
  es.onmessage=(m)=>{ const {event,data}=JSON.parse(m.data);
    if(event==='error'){ add('✗ '+data.message,'bad'); es.close(); }
    if(event==='round:start') add('── round '+data.round+'/'+data.total+' ──','dim');
    if(event==='verify:start') add('verifying '+data.claims+' claim(s)...','dim');
    if(event==='verify:done') add(data.supported+' supported, '+data.failed+' failed', data.failed?'bad':'ok');
    if(event==='citation-check:start') add('citation check ('+data.mode+')...','dim');
    if(event==='citation-check:fail') add('  ✗ citation failed ['+data.claimId+'] '+data.reason,'bad');
    if(event==='report') { document.getElementById('report').hidden=false;
      document.getElementById('report').textContent=data.report; es.close(); loadRuns(); }
  };
  es.onerror=()=>{ es.close(); };
}
loadRuns();
</script></body></html>`;

function sse(res, event, data) {
  res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
}

function createServer({ runsRootDir = runsRoot, runPipelineFn = runPipeline, llmClient = llm } = {}) {
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
        const id = path.basename(url.pathname);
        const state = JSON.parse(await fs.readFile(path.join(runsRootDir, id, 'state.json'), 'utf8'));
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
        try {
          const { state } = await runPipelineFn({
            question,
            llm: llmClient,
            tools: buildTools({ searchCache: new Map() }),
            researcherModel: config.RESEARCHER_MODEL,
            checkerModel: config.CHECKER_MODEL,
            synthesizerModel: config.LLM_MODEL,
            onEvent: (event, data) => sse(res, event, data),
          });
          sse(res, 'report', { report: state.report });
        } catch (err) {
          sse(res, 'error', { message: String(err.message).slice(0, 300) });
        } finally {
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
