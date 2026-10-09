'use strict';

// The only coupling between agents. Every inter-agent message is one of these
// Zod-validated objects; agents never exchange free-form chat transcripts.
const { z } = require('zod');

// A citation: where a claim came from.
const Source = z.object({
  url: z.url(),
  title: z.string().min(1).default('Untitled'),
  snippet: z.string().optional(),
});

// A discrete, checkable factual statement with at least one source.
// Claim ids are assigned by code (c1..cN), never trusted from the model.
const Claim = z.object({
  id: z.string().regex(/^c\d+$/),
  text: z.string().min(1),
  sources: z.array(Source).min(1),
});

// The fact-checker's judgment on one claim. evidenceQuote must be verbatim
// text found at `url` — this is what Phase 4's mechanical citation check
// will confirm.
const Verdict = z.object({
  claimId: z.string(),
  verdict: z.enum(['supported', 'contradicted', 'unverifiable']),
  evidenceQuote: z.string().min(1),
  url: z.url(),
  feedback: z.string().optional(),
});

// Researcher output: decomposition + claims.
const ResearchOutput = z.object({
  subQuestions: z.array(z.string()).min(1),
  claims: z.array(Claim),
});

// Everything known about one run; persisted to runs/<id>/state.json.
// `dropped` accumulates claims removed by revise rounds (for the report
// appendix), keyed by their original ids.
const RunState = z.object({
  question: z.string(),
  round: z.number().int().min(0),
  subQuestions: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  verdicts: z.array(Verdict).default([]),
  dropped: z.array(Claim).default([]),
  report: z.string().optional(),
});

module.exports = { Source, Claim, Verdict, ResearchOutput, RunState };
