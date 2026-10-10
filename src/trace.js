'use strict';

// JSONL event log per run — zero infra, grep-able. One line per event:
//   {"ts":"...","type":"llm_call","model":"...","latencyMs":412,...}
// Modes: createTrace(dir) appends to <dir>/trace.jsonl; createTrace(null) is
// memory-only (tests). Events are also kept in memory for programmatic reads.
const fs = require('node:fs/promises');
const path = require('node:path');

async function createTrace(dir) {
  const events = [];
  let file = null;
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, 'trace.jsonl');
  }

  async function event(type, data = {}) {
    const record = { ts: new Date().toISOString(), type, ...data };
    events.push(record);
    if (file) {
      try {
        await fs.appendFile(file, JSON.stringify(record) + '\n');
      } catch (err) {
        // Tracing must never break a run.
        console.error(`trace: write failed (${err.message})`);
      }
    }
  }

  return { event, events, file };
}

module.exports = { createTrace };
