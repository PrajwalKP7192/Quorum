'use strict';

// Synthesizer: writes the final markdown report from SUPPORTED claims only.
// Every cited sentence links [cN](url); failed and dropped claims go to an
// appendix so the reader sees what was excluded and why.
const { contentText } = require('../llm');
const config = require('../config');

const SYSTEM = `You are a precise report writer. You receive verified claims (each with an id and sources) and write a research report in markdown.

Rules:
- Use ONLY the provided supported claims. Never add facts, numbers, or dates that are not in them.
- Cite inline at the sentence level as [cN](url), using the claim's id and source url. Every paragraph must carry its citations.
- Structure: a "# <title>" heading answering the question, then 2-4 "## <section>" headings grouping related claims.
- Neutral, factual tone. No hedging beyond what the claims support.
- After the report body, add a "## Excluded claims" section listing each unsupported or dropped claim as "- <text> — <verdict> (<feedback>)". Include it even if brief; write "(none)" if the list is empty.
Output only the markdown.`;

async function synthesize({ state, llm, model = config.LLM_MODEL, temperature = 0.3, trace }) {
  const byId = new Map(state.claims.map((c) => [c.id, c]));
  const supported = state.verdicts
    .filter((v) => v.verdict === 'supported')
    .map((v) => {
      const claim = byId.get(v.claimId);
      return claim && { id: claim.id, text: claim.text, sources: claim.sources.map((s) => ({ url: s.url, title: s.title })) };
    })
    .filter(Boolean);

  const unsupported = [
    ...state.verdicts
      .filter((v) => v.verdict !== 'supported')
      .map((v) => ({ text: byId.get(v.claimId)?.text ?? '(claim text missing)', verdict: v.verdict, feedback: v.feedback ?? '' })),
    ...state.dropped.map((c) => ({ text: c.text, verdict: 'dropped', feedback: 'removed during a revise round' })),
  ];

  const user = `Question: ${state.question}

Supported claims (use only these in the report body):
${JSON.stringify(supported, null, 2)}

Claims to list in the "## Excluded claims" appendix (do NOT use them as facts):
${JSON.stringify(unsupported, null, 2)}`;

  const { message, usage } = await llm.chat({ messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ], model, temperature, trace });

  return { report: contentText(message).trim(), usage, supportedCount: supported.length };
}

module.exports = { synthesize, SYSTEM };
