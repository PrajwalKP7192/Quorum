'use strict';

// Researcher v0: decomposes a question, searches the web with tools, then
// emits { subQuestions, claims } validated against src/contracts.js.
const { z } = require('zod');
const { runToolLoop } = require('./base');
const { ResearchOutput, Claim } = require('../contracts');

const SYSTEM = `You are a meticulous research assistant preparing claims that an independent fact-checker will verify.

Process:
1. Decompose the question into 2-5 concrete, self-contained sub-questions.
2. Search the web for each sub-question. Open promising pages when a snippet is not enough to state a fact precisely.
3. Collect discrete factual claims — single, checkable statements, each backed by at least one source you actually saw.

Rules:
- Every claim needs a source: the exact URL and page title from your tool results.
- Each claim must be a DISTINCT fact. Never restate the same fact with different wording; state it once, with the best source you have.
- Write claims as complete declarative sentences with names, numbers and dates where possible.
- Prefer primary or authoritative sources (official statistics, government, academic). Never invent a URL.
- Do not include your opinions or interpretations as claims.
- Once you have enough material, stop calling tools; you will be asked for the final JSON.`;

const OUTPUT_ASK = 'Based on everything above, return the final JSON: { "subQuestions": [...], "claims": [{ "text": "...", "sources": [{ "url": "...", "title": "..." }] }] }. Include every claim you found; ids are assigned for you.';

const REVISE_OUTPUT_ASK =
  'Based on everything above, return the final JSON: { "subQuestions": [...], "claims": [{ "id": "carry over the previous id for retained claims", "text": "...", "sources": [{ "url": "...", "title": "..." }] }] }. Omit claims you could not fix.';

// Re-id the model's claim list. In round 0 every claim gets a fresh c1..cN.
// In revise rounds, an id is kept only if it matches a prior claim (stable
// carry-over); everything else gets a fresh id continuing after the prior max.
// Near-duplicate claims (the model loves restating the same fact) are dropped:
// exact same normalized text, or a shared source plus heavy word overlap.
const words = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

function renumberClaims(rawClaims, priorIds = new Set()) {
  const priorMax = Math.max(0, ...[...priorIds].map((id) => Number(id.slice(1))));
  let counter = priorMax;
  const used = new Set();
  const kept = []; // { urls: Set, tokens: string[] } per accepted claim
  const claims = [];

  rawClaims.forEach((raw, i) => {
    const tokens = words(raw?.text);
    const duplicate = kept.find(
      (k) =>
        JSON.stringify(tokens) === JSON.stringify(k.tokens) ||
        (tokens.length && k.tokens.length &&
          jaccard(k.tokens, tokens) >= 0.5 && raw?.sources?.some((s) => k.urls.has(s.url)))
    );
    if (duplicate) {
      console.error(`researcher: dropped duplicate claim #${i + 1} (${raw?.text?.slice(0, 60) ?? 'no text'})`);
      return;
    }

    const candidate =
      typeof raw?.id === 'string' && /^c\d+$/.test(raw.id) && priorIds.has(raw.id) && !used.has(raw.id)
        ? raw.id
        : `c${++counter}`;
    const parsed = Claim.safeParse({ ...raw, id: candidate });
    if (parsed.success && !used.has(candidate)) {
      used.add(candidate);
      kept.push({ urls: new Set(parsed.data.sources.map((s) => s.url)), tokens });
      claims.push(parsed.data);
    } else {
      console.error(`researcher: dropped invalid claim #${i + 1} (${raw?.text?.slice(0, 60) ?? 'no text'})`);
    }
  });

  return claims;
}

async function research({ question, llm, tools, maxSteps = 10, model, temperature = 0.2, trace }) {
  const { messages, usage: toolUsage, hitMaxSteps } = await runToolLoop({
    llm,
    system: SYSTEM,
    messages: [{ role: 'user', content: question }],
    tools,
    maxSteps,
    temperature,
    trace,
  });

  if (hitMaxSteps) {
    console.error(`researcher: hit max steps (${maxSteps}); continuing to structured output anyway`);
  }

  const { data, attempts, usage } = await llm.structuredChat({
    system: 'You convert research notes into the requested JSON schema. Use only facts from the conversation.',
    messages: [...messages, { role: 'user', content: OUTPUT_ASK }],
    schema: ResearchOutput,
    model,
    temperature,
    trace,
  });

  return {
    subQuestions: data.subQuestions,
    claims: renumberClaims(data.claims),
    usage: { toolLoop: toolUsage, structured: usage },
    attempts,
  };
}

const REVISE_SYSTEM = `${SYSTEM}

This is a REVISE round. You previously produced a list of claims; the fact-checker rejected some. Fix the rejected claims using the feedback (usually: wrong number/date/name, or the source does not state the fact) — search again for better sources. If a claim cannot be fixed, drop it. Keep verified claims as they are (same wording) so their ids stay stable.`;

// Decompose-only pass: just the sub-questions, no claims.
const DecomposeOutput = z.object({ subQuestions: z.array(z.string().min(1)).min(1) });

// Per-sub-question research claims (fan-out worker output).
const SubResearchOutput = z.object({ claims: z.array(z.object({
  text: z.string().min(1),
  sources: z.array(z.object({ url: z.url(), title: z.string().min(1).default('Untitled') })).min(1),
})) });

// Phase 7: one researcher per sub-question, run concurrently and merged.
// Costs ~#subQuestions LLM calls per round — enable with PARALLEL_RESEARCH=on
// when the rate limit allows (paid tier or patient free tier).
async function researchParallel({ question, llm, tools, maxSteps = 6, model, temperature = 0.2, concurrency = 3, trace }) {
  const { data: decomp } = await llm.structuredChat({
    system: 'You decompose research questions. Respond with JSON only.',
    messages: [{
      role: 'user',
      content: `Decompose this question into 2-5 concrete, self-contained sub-questions that together fully answer it: "${question}"`,
    }],
    schema: DecomposeOutput,
    model,
    temperature,
    trace,
  });
  const subQuestions = decomp.subQuestions;

  const subClaims = new Array(subQuestions.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= subQuestions.length) return;
      const sub = subQuestions[i];
      try {
        const { messages } = await runToolLoop({
          llm,
          system: SYSTEM,
          messages: [{ role: 'user', content: sub }],
          tools,
          maxSteps,
          temperature,
          trace,
        });
        const { data } = await llm.structuredChat({
          system: 'You convert research notes into the requested JSON schema. Use only facts from the conversation.',
          messages: [...messages, { role: 'user', content: OUTPUT_ASK }],
          schema: SubResearchOutput,
          model,
          temperature,
          trace,
        });
        subClaims[i] = data.claims;
      } catch (err) {
        console.error(`researcher: sub-question "${sub.slice(0, 50)}" failed (${err.message.slice(0, 80)})`);
        subClaims[i] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, subQuestions.length)) }, worker));

  const claims = renumberClaims(subClaims.flat());
  return { subQuestions, claims, usage: null };
}

async function revise({ priorClaims, failedVerdicts, llm, tools, maxSteps = 10, model, temperature = 0.2, trace }) {
  const priorIds = new Set(priorClaims.map((c) => c.id));
  const { messages, usage: toolUsage, hitMaxSteps } = await runToolLoop({
    llm,
    system: REVISE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Prior claims:\n${JSON.stringify(priorClaims.map(({ id, text, sources }) => ({ id, text, sources })), null, 2)}\n\n` +
          `Rejected by the fact-checker:\n${JSON.stringify(failedVerdicts, null, 2)}\n\n` +
          `Fix or drop the rejected claims; keep the rest unchanged. Search for better sources where needed.`,
      },
    ],
    tools,
    maxSteps,
    temperature,
    trace,
  });

  if (hitMaxSteps) {
    console.error(`researcher: revise hit max steps (${maxSteps}); continuing to structured output anyway`);
  }

  const { data, attempts, usage } = await llm.structuredChat({
    system: 'You convert research notes into the requested JSON schema. Use only facts from the conversation.',
    messages: [...messages, { role: 'user', content: REVISE_OUTPUT_ASK }],
    schema: ResearchOutput,
    model,
    temperature,
    trace,
  });

  return {
    subQuestions: data.subQuestions,
    claims: renumberClaims(data.claims, priorIds),
    usage: { toolLoop: toolUsage, structured: usage },
    attempts,
  };
}

module.exports = { research, revise, researchParallel, renumberClaims, SYSTEM };
