'use strict';

// Fact-checker: independently verifies one claim against live sources.
// Temperature 0, adversarial prompt, verbatim evidence quote + URL required.
// The claimId on the returned Verdict is set from the input claim, never
// trusted from the model.
const { z } = require('zod');
const { runToolLoop } = require('./base');
const { Verdict } = require('../contracts');
const config = require('../config');

// Agent-internal shape (not an inter-agent contract): the claim id is added
// in code after parsing.
const CheckResult = z.object({
  verdict: z.enum(['supported', 'contradicted', 'unverifiable']),
  evidenceQuote: z.string().min(1),
  url: z.url(),
  feedback: z.string().optional(),
});

const SYSTEM = `You are a skeptical, adversarial fact-checker. You get one claim and the sources the researcher cited. Verify it INDEPENDENTLY.

Method:
- Search the web yourself for the subject of the claim. Open the cited URLs AND your own search results when needed.
- Compare the claim against what the pages actually say — exact numbers, dates, names, and scope.

Verdict rules:
- "supported" — a reliable page states the same fact.
- "contradicted" — a reliable page states a materially different fact.
- "unverifiable" — you cannot find any page that confirms or denies it.

Evidence rules:
- evidenceQuote MUST be a verbatim quote copied exactly from the page at "url" that justifies your verdict. No paraphrasing.
- In "feedback", tell the researcher precisely what is wrong or missing (wrong number, date, name, or no source found).
Judge only from what your tools return, never from your own memory.`;

const OUTPUT_ASK =
  'Return the final JSON: { "verdict": "supported"|"contradicted"|"unverifiable", "evidenceQuote": "...", "url": "...", "feedback": "..." }.';

function fallbackVerdict(claim, reason) {
  // A claim always has >= 1 source with a valid url (contract), so this is safe.
  return Verdict.parse({
    claimId: claim.id,
    verdict: 'unverifiable',
    evidenceQuote: '(verification could not be completed)',
    url: claim.sources[0].url,
    feedback: reason,
  });
}

async function verifyClaim({ claim, llm, tools, model = config.CHECKER_MODEL, maxSteps = 6 }) {
  if (!claim) throw new Error('verifyClaim: claim is required');

  const claimBrief = JSON.stringify(
    { id: claim.id, text: claim.text, citedSources: claim.sources.map((s) => ({ url: s.url, title: s.title })) },
    null,
    2
  );

  try {
    const { messages } = await runToolLoop({
      llm,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Claim to verify:\n${claimBrief}` }],
      tools,
      maxSteps,
      temperature: 0,
    });

    const { data } = await llm.structuredChat({
      system: 'You output the fact-check verdict as JSON, using only evidence from the conversation.',
      messages: [...messages, { role: 'user', content: OUTPUT_ASK }],
      schema: CheckResult,
      model,
      temperature: 0,
    });

    return Verdict.parse({ claimId: claim.id, ...data });
  } catch (err) {
    // Never fail the batch: an unusable checker result degrades to "unverifiable"
    // with the reason attached as feedback for the revise round.
    return fallbackVerdict(claim, `verification failed: ${err.message}`);
  }
}

module.exports = { verifyClaim, fallbackVerdict, SYSTEM };
