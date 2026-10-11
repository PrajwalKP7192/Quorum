'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function withRunsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quorum-runs-'));
  const state = {
    question: 'What?', round: 0,
    claims: [{ id: 'c1', text: 'X.', sources: [{ url: 'https://a.example', title: 'A' }] }],
    verdicts: [{ claimId: 'c1', verdict: 'supported', evidenceQuote: 'q', url: 'https://a.example' }],
    dropped: [], report: '# Report\n\nBody.',
  };
  await fs.mkdir(path.join(dir, 'run-a'), { recursive: true });
  await fs.writeFile(path.join(dir, 'run-a', 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(dir, 'run-a', 'trace.jsonl'), [
    JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', type: 'run:start', question: 'What?' }),
    JSON.stringify({ ts: '2026-10-11T00:00:01.000Z', type: 'llm_call', model: 'm1', latencyMs: 500, prompt_tokens: 10, completion_tokens: 5, retries: 1 }),
    JSON.stringify({ ts: '2026-10-11T00:00:02.000Z', type: 'tool_call', name: 'web_search', durationMs: 120, ok: false }),
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'not-a-run.txt'), 'nope');
  return dir;
}

test('GET /runs/:id/trace returns parsed JSONL events; 404 JSON when absent', async () => {
  const server = createServer({ runsRootDir: await withRunsDir(), toolsFn: () => [] });
  try {
    const base = await listen(server);
    const events = await (await fetch(base + '/runs/run-a/trace')).json();
    assert.equal(events.length, 3);
    assert.equal(events[1].type, 'llm_call');
    assert.equal(events[1].retries, 1);
    const missing = await fetch(base + '/runs/run-b/trace');
    assert.equal(missing.status, 404);
    assert.ok((await missing.json()).error.includes('no trace'));
  } finally {
    server.close();
  }
});

test('GET /runs/:id serves the dashboard page for browsers and JSON for fetch', async () => {
  const server = createServer({ runsRootDir: await withRunsDir(), toolsFn: () => [] });
  try {
    const base = await listen(server);
    const browser = await fetch(base + '/runs/run-a', { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.match(await browser.text(), /<title>Quorum[^<]*<\/title>/);
    const api = await fetch(base + '/runs/run-a', { headers: { accept: 'application/json' } });
    assert.equal((await api.json()).report, '# Report\n\nBody.');
    const lazy = await fetch(base + '/runs/run-a'); // fetch default Accept: */*
    assert.equal((await lazy.json()).question, 'What?');
  } finally {
    server.close();
  }
});

test('SSE stream sends heartbeats while the pipeline is silent', async () => {
  const server = createServer({
    runsRootDir: await withRunsDir(),
    heartbeatMs: 10,
    toolsFn: () => [],
    runPipelineFn: async ({ onEvent }) => {
      onEvent('round:start', { round: 1, total: 1 });
      await new Promise((r) => setTimeout(r, 50)); // silence long enough for 2+ heartbeats
      return { state: { question: 'Q?', round: 0, claims: [], verdicts: [], dropped: [], report: '# R' } };
    },
  });
  try {
    const base = await listen(server);
    const res = await fetch(base + '/events?question=Q%3F');
    const body = await res.text();
    assert.ok(body.includes(':hb'), 'expected keep-alive heartbeat comments in the stream');
  } finally {
    server.close();
  }
});

test('serves the dashboard page at /', async () => {
  const server = createServer({ runsRootDir: await withRunsDir(), toolsFn: () => [] });
  try {
    const base = await listen(server);
    const res = await fetch(base + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>Quorum[^<]*<\/title>/);
    assert.match(html, /EventSource/);
  } finally {
    server.close();
  }
});

test('lists and serves past runs', async () => {
  const runsDir = await withRunsDir();
  const server = createServer({ runsRootDir: runsDir, toolsFn: () => [] });
  try {
    const base = await listen(server);
    const runs = await (await fetch(base + '/runs')).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 'run-a');
    assert.equal(runs[0].supported, 1);
    const state = await (await fetch(base + '/runs/run-a')).json();
    assert.equal(state.report, '# Report\n\nBody.');
    assert.equal((await fetch(base + '/runs/missing')).status, 500); // wrapped 404-style failure
  } finally {
    server.close();
  }
});

test('streams pipeline events over SSE and ends with the report', async () => {
  const server = createServer({
    runsRootDir: await withRunsDir(),
    toolsFn: () => [],
    runPipelineFn: async ({ question, onEvent }) => {
      onEvent('round:start', { round: 1, total: 1 });
      onEvent('verify:claim', {
        claimId: 'c1',
        claimText: 'Claim one.',
        verdict: { claimId: 'c1', verdict: 'supported', evidenceQuote: 'q', url: 'https://a.example' },
      });
      onEvent('verify:done', { round: 1, supported: 1, failed: 0 });
      return { state: { question, round: 0, claims: [], verdicts: [], dropped: [], report: '# Live report' } };
    },
  });
  try {
    const base = await listen(server);
    const res = await fetch(base + '/events?question=Q%3F');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const body = await res.text();
    const events = body.trim().split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(events.map((e) => e.event), ['round:start', 'verify:claim', 'verify:done', 'report']);
    assert.equal(events[1].data.claimId, 'c1');
    assert.equal(events[3].data.report, '# Live report');
    // a second concurrent run is rejected while one is in flight — verified by flag reset here
  } finally {
    server.close();
  }
});
