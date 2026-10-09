'use strict';

// One LLM round-trip into a Zod-validated object. Fails loudly and cleanly
// when no API key is configured.
const llm = require('../src/llm');
const { z } = require('zod');

const Answer = z.object({
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

async function main() {
  console.log('smoke: contracts OK, calling LLM ...');
  const { data, attempts } = await llm.structuredChat({
    system: 'Answer the user question briefly.',
    messages: [{ role: 'user', content: 'What is 2 + 2? Also give a confidence between 0 and 1.' }],
    schema: Answer,
  });
  console.log(`smoke: OK after ${attempts} attempt(s):`, data);
}

main().catch((err) => {
  const msg = String(err.message || err);
  if (/OPENAI_API_KEY is not set/.test(msg)) {
    console.error('smoke: SKIPPED — no OPENAI_API_KEY. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  console.error('smoke: FAILED —', msg);
  process.exit(1);
});
