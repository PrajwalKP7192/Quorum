'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrace } = require('../src/trace');

test('memory-only trace records typed, timestamped events', async () => {
  const trace = await createTrace(null);
  await trace.event('llm_call', { model: 'm', latencyMs: 100 });
  await trace.event('tool_call', { name: 'web_search', ok: true });
  assert.equal(trace.events.length, 2);
  assert.equal(trace.file, null);
  assert.equal(trace.events[0].type, 'llm_call');
  assert.equal(trace.events[0].model, 'm');
  assert.ok(trace.events[0].ts); // ISO timestamp
});

test('file trace writes valid JSONL, one record per line', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quorum-trace-'));
  const trace = await createTrace(dir);
  await trace.event('run:start', { question: 'Q?' });
  await trace.event('agent_event', { round: 1, claims: 3 });
  await trace.event('run:done', {});

  const raw = await fs.readFile(trace.file, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l)); // throws if any line is invalid
  assert.deepEqual(parsed.map((p) => p.type), ['run:start', 'agent_event', 'run:done']);
  assert.equal(parsed[1].claims, 3);
});
