'use strict';

// Skeptic agent: after the verify-and-revise loop converges, argue AGAINST the
// supported claims before synthesis. The point is not to overturn verdicts but
// to surface the strongest honest objection per claim — alternative
// interpretations, scope gaps, source reliability — so the report can address
// them instead of hiding them. Never fails the run: on error, no objections.
const { z } = require('zod');
const { runToolLoop } = require('./base');
const { Objection } = require('../contracts');
const config = require('../config');

const SkepticOutput = z.object({
  objections: z.array(Objection).max(20),
});

const SYSTEM = `You are a skeptical reviewer playing devil's advocate. You receive claims that an independent fact-checker has already marked as supported. Your job is to find the strongest HONEST objection to each claim:

- an alternative interpretation of the same evidence,
- a scope or wording gap ("largest" by which measure? as of which date?),
- source reliability concerns (single source, commercial source, outdated page),
- cherry-picking (what relevant context is missing?).

Rules:
- Use your tools to look for counter-evidence or better context before objecting.
- Object only when the objection is specific and honest. If a claim is genuinely solid, say nothing about it — do not manufacture doubts.
- One objection per claim, one or two sentences, concrete.

Return JSON: { "objections": [{ "claimId": "cN", "objection": "..." }] }.`;

async function skeptic({ state, llm, tools, model = config.CHECKER_MODEL, maxSteps = 4, temperature = 0.2, trace }) {
  const byId = new Map(state.claims.map((c) => [c.id, c]));
  const supported = state.verdicts
    .filter((v) => v.verdict === 'supported' && byId.has(v.claimId))
    .map((v) => ({ id: v.claimId, text: byId.get(v.claimId).text, sources: byId.get(v.claimId).sources }));
  if (!supported.length) return { objections: [], usage: null };

  try {
    const { messages } = await runToolLoop({
      llm,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Challenge these supported claims:\n${JSON.stringify(supported, null, 2)}`,
      }],
      tools,
      maxSteps,
      temperature,
      trace,
    });

    const { data } = await llm.structuredChat({
      system: 'You output the skeptic review as JSON, using only the conversation.',
      messages: [...messages, { role: 'user', content: 'Return the final JSON now.' }],
      schema: SkepticOutput,
      model,
      temperature,
      trace,
    });

    const validIds = new Set(supported.map((s) => s.id));
    const objections = data.objections.filter(
      (o) => validIds.has(o.claimId) && !/\bnote?:/i.test(o.objection)
    );
    return { objections, usage: null };
  } catch (err) {
    // The skeptic is an enhancement, never a gate: fail soft.
    console.error(`skeptic: skipped (${err.message.slice(0, 120)})`);
    return { objections: [], usage: null };
  }
}

module.exports = { skeptic, SYSTEM };
