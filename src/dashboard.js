'use strict';

// The dashboard: a single inlined page, no build step, no dependencies.
// Model- and web-derived strings are ALWAYS escaped before touching innerHTML.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function mdToHtml(md) {
  const lines = esc(md).split('\\n');
  let out = '', inList = false;
  for (const line of lines) {
    let t = line
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const trimmed = t.trim();
    const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
    if (trimmed.startsWith('### ')) { closeList(); out += '<h3>' + trimmed.slice(4) + '</h3>'; }
    else if (trimmed.startsWith('## ')) { closeList(); out += '<h2>' + trimmed.slice(3) + '</h2>'; }
    else if (trimmed.startsWith('# ')) { closeList(); out += '<h1>' + trimmed.slice(2) + '</h1>'; }
    else if (trimmed.startsWith('- ')) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + trimmed.slice(2) + '</li>'; }
    else if (trimmed === '') { closeList(); }
    else { closeList(); out += '<p>' + trimmed + '</p>'; }
  }
  if (inList) out += '</ul>';
  return out;
}

const STAGES = { researcher: $('stage-researcher'), checker: $('stage-checker'), synth: $('stage-synth') };
const rendered = new Set(); // claim ids already shown — verify:claim streams + verify:done batch must not duplicate
function showVerdict(v, claimText) {
  if (rendered.has(v.claimId)) return;
  rendered.add(v.claimId);
  $('feed').insertAdjacentHTML('afterbegin', card(v, claimText, true));
}
function stage(name, state) {
  for (const [k, el] of Object.entries(STAGES)) {
    el.classList.toggle('active', k === name && state === 'active');
    el.classList.toggle('done', k !== name && state === 'done');
  }
  if (state === 'done') for (const el of Object.values(STAGES)) el.classList.add('done');
  if (state === 'active' && name) STAGES[name].classList.add('active');
}
function reset() {
  rendered.clear();
  $('feed').innerHTML = ''; $('report').hidden = true; $('error').hidden = true;
  for (const el of Object.values(STAGES)) el.classList.remove('active', 'done');
  stage('researcher', 'active');
}
function card(v, claimText, cite) {
  const cls = v.verdict === 'supported' ? 'ok' : v.verdict === 'contradicted' ? 'bad' : 'warn';
  return '<div class="claim ' + cls + '">' +
    '<div class="claim-head"><span class="badge ' + cls + '">' + esc(v.verdict) + '</span>' +
    '<span class="claim-id">' + esc(v.claimId) + '</span></div>' +
    '<div class="claim-text">' + esc(claimText || '') + '</div>' +
    '<div class="claim-src">' + (cite ? '<a href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer">' + esc(v.url) + '</a>' : '') +
    (v.feedback ? '<div class="fb">' + esc(v.feedback) + '</div>' : '') + '</div></div>';
}

async function loadRuns() {
  const rs = await (await fetch('/runs')).json();
  $('runs').innerHTML = rs.length ? rs.map((r) =>
    '<div class="run" onclick="showRun(\\'' + esc(r.id) + '\\')">' +
    '<div class="run-q">' + esc(r.question) + '</div>' +
    '<div class="run-meta"><span class="badge ' + (r.supported === r.claims && r.claims > 0 ? 'ok' : r.supported ? 'warn' : 'bad') + '">' +
    r.supported + '/' + r.claims + ' supported</span><span class="dim">' + esc(r.id.slice(0, 16)) + '</span></div></div>'
  ).join('') : '<p class="dim">No runs yet — ask your first question above.</p>';
}

async function showRun(id) {
  const r = await (await fetch('/runs/' + id)).json();
  reset();
  $('q').value = r.question;
  const byId = Object.fromEntries((r.claims || []).map((c) => [c.id, c.text]));
  $('feed').innerHTML = (r.verdicts || []).map((v) => card(v, byId[v.claimId], true)).join('');
  if (r.report) { $('report').innerHTML = mdToHtml(r.report); $('report').hidden = false; }
  for (const el of Object.values(STAGES)) el.classList.add('done');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function go(q) {
  q = (q || $('q').value).trim(); if (!q) return;
  $('q').value = q;
  reset();
  const es = new EventSource('/events?question=' + encodeURIComponent(q));
  es.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    const { event, data } = e;
    if (event === 'round:start') { stage('researcher', 'active'); log('Round ' + data.round + ' of ' + data.total, 'dim'); }
    if (event === 'verify:start') { stage('checker', 'active'); log('Verifying ' + data.claims + ' claim' + (data.claims === 1 ? '' : 's') + '…', 'dim'); }
    if (event === 'verify:claim') showVerdict(data.verdict, data.claimText);
    if (event === 'verify:done') {
      stage('synth', 'active');
      log(data.supported + ' supported · ' + data.failed + ' failed', data.failed ? 'bad' : 'ok');
      data.verdicts.forEach((v) => showVerdict(v, null)); // fill any the stream missed
    }
    if (event === 'citation-check:start') log('Mechanical citation check (' + data.mode + ')…', 'dim');
    if (event === 'citation-check:fail') log('Citation failed [' + data.claimId + ']: ' + data.reason, 'bad');
    if (event === 'report') {
      for (const el of Object.values(STAGES)) { el.classList.remove('active'); el.classList.add('done'); }
      $('report').innerHTML = mdToHtml(data.report || ''); $('report').hidden = false;
      es.close(); loadRuns();
    }
    if (event === 'error') { $('error').textContent = data.message; $('error').hidden = false; es.close(); }
  };
  es.onerror = () => { es.close(); log('Connection closed — no result. The server may be busy or restarting; try again.', 'bad'); };
}
function log(t, cls) {
  const d = document.createElement('div');
  d.className = 'line ' + (cls || '');
  d.textContent = t;
  $('feed').prepend(d);
}
$('q').addEventListener('keydown', (k) => { if (k.key === 'Enter') go(); });
loadRuns();
`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quorum — verified research</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#21262d;--fg:#c9d1d9;--dim:#8b949e;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#58a6ff}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-size:15px;line-height:1.55;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  main{max-width:920px;margin:0 auto;padding:0 1.25rem 4rem}
  header{display:flex;align-items:center;gap:.7rem;padding:1.4rem 0 1rem;border-bottom:1px solid var(--line)}
  .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#238636,#58a6ff);display:grid;place-items:center;font-weight:800;color:#fff}
  header h1{font-size:1.15rem;margin:0} header .sub{color:var(--dim);font-size:.8rem}
  .hero{padding:2.2rem 0 1rem} .hero h2{font-size:1.6rem;margin:0 0 1.1rem;font-weight:650}
  .search{display:flex;gap:.6rem} .search input{flex:1;background:var(--card);border:1px solid var(--line);color:var(--fg);
    border-radius:10px;padding:.85rem 1rem;font-size:1rem;outline:none} .search input:focus{border-color:var(--accent)}
  .search button{background:#238636;border:0;color:#fff;border-radius:10px;padding:.85rem 1.4rem;font-size:1rem;font-weight:600;cursor:pointer}
  .search button:hover{background:#2ea043} .search button:disabled{opacity:.5;cursor:default}
  .chips{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem} .chip{background:var(--card);border:1px solid var(--line);
    color:var(--dim);border-radius:99px;padding:.3rem .8rem;font-size:.8rem;cursor:pointer} .chip:hover{color:var(--fg);border-color:var(--accent)}
  .stages{display:flex;gap:.7rem;margin:1.6rem 0} .stage{flex:1;background:var(--card);border:1px solid var(--line);
    border-radius:12px;padding:.8rem 1rem;position:relative;transition:.3s}
  .stage .n{font-size:1.2rem} .stage .t{font-weight:600;font-size:.92rem} .stage .d{color:var(--dim);font-size:.75rem}
  .stage.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)} .stage.active .n{animation:pulse 1.1s infinite}
  .stage.done{border-color:#238636} .stage.done .n::after{content:' ✓';color:var(--ok)}
  @keyframes pulse{50%{opacity:.35}}
  .error{background:#2d1114;border:1px solid var(--bad);color:#ffb3ad;border-radius:10px;padding:.8rem 1rem;margin:1rem 0}
  #feed{display:flex;flex-direction:column;gap:.6rem}
  .line{color:var(--dim);font-size:.88rem;padding:.15rem .2rem} .line.ok{color:var(--ok)} .line.bad{color:var(--bad)}
  .claim{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:10px;padding:.8rem 1rem}
  .claim.ok{border-left-color:var(--ok)} .claim.bad{border-left-color:var(--bad)} .claim.warn{border-left-color:var(--warn)}
  .claim-head{display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem}
  .badge{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:99px;padding:.12rem .6rem}
  .badge.ok{background:#12351c;color:var(--ok)} .badge.bad{background:#3d1216;color:var(--bad)} .badge.warn{background:#33270e;color:var(--warn)}
  .claim-id{color:var(--dim);font-size:.78rem} .claim-src a{color:var(--accent);font-size:.82rem;word-break:break-all;text-decoration:none}
  .claim-src a:hover{text-decoration:underline} .fb{color:var(--dim);font-size:.8rem;margin-top:.3rem}
  #report{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.4rem 1.6rem;margin-top:1.4rem}
  #report h1{font-size:1.35rem;border-bottom:1px solid var(--line);padding-bottom:.5rem} #report h2{font-size:1.1rem;margin-top:1.4rem}
  #report a{color:var(--accent)} #report[hidden]{display:none}
  h2.sec{font-size:1.05rem;margin:2.4rem 0 1rem;color:var(--fg)} 
  #runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.7rem}
  .run{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem;cursor:pointer}
  .run:hover{border-color:var(--accent)} .run-q{font-size:.9rem;margin-bottom:.5rem} .run-meta{display:flex;justify-content:space-between;align-items:center}
  .dim{color:var(--dim);font-size:.78rem}
  @media(max-width:640px){.stages{flex-direction:column}}
</style></head><body>
<main>
<header><div class="logo">Q</div><div><h1>Quorum</h1><div class="sub">multi-agent research · every claim independently verified</div></div></header>

<section class="hero">
  <h2>Ask. Get answers with receipts.</h2>
  <div class="search"><input id="q" placeholder="Ask a research question…" autofocus>
  <button id="go" onclick="go()">Research</button></div>
  <div class="chips">
    <span class="chip" onclick="go(this.textContent)">What is the current population of Tokyo?</span>
    <span class="chip" onclick="go(this.textContent)">What is the speed of light?</span>
    <span class="chip" onclick="go(this.textContent)">How many bones are in the adult human body?</span>
  </div>
</section>

<div class="stages">
  <div class="stage" id="stage-researcher"><div class="n">🔎</div><div class="t">Researcher</div><div class="d">decomposes · searches · claims</div></div>
  <div class="stage" id="stage-checker"><div class="n">🧪</div><div class="t">Fact-checker</div><div class="d">verifies · quotes evidence</div></div>
  <div class="stage" id="stage-synth"><div class="n">📝</div><div class="t">Synthesizer</div><div class="d">report from verified only</div></div>
</div>

<div id="error" class="error" hidden></div>
<div id="feed"></div>
<div id="report" hidden></div>

<h2 class="sec">Past runs</h2>
<div id="runs"></div>
</main>
<script>${CLIENT_JS}</script></body></html>`;

module.exports = { PAGE };
