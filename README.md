# Quorum

A multi-agent research team. A **Researcher** decomposes a question and gathers cited
claims, a **Fact-checker** independently verifies every claim against live sources, and
a **Synthesizer** writes the final report from verified claims only. An orchestrator
routes the work and runs the verify-and-revise loop.

The full roadmap and implementation plan lives in [PLAN.md](PLAN.md).

## Status — Phase 3 complete, live-validated

- [x] Phase 0 — config, LLM client with Zod-validated structured output, agent contracts
- [x] Phase 1 — one agent with web-search tools + CLI
- [x] Phase 2 — two-agent pipeline (claims → verdicts)
- [x] Phase 3 — feedback loop + synthesis
- [x] Live end-to-end run (2026-10-10): 5/5 claims verified, cited report generated
- [x] Phase 4 — quality hardening (mechanical citation checks, claim dedupe, source ranking)
- [x] Phase 5 — tracing (JSONL per run) + eval scorecard (`npm run eval`)
- [ ] Optional: Phase 6 — web service + live dashboard

Runs on any OpenAI-compatible endpoint; validated on Groq's free tier
(`gpt-oss-20b`) with Tavily search. Free-tier quirks are handled: rate-limit
retries with provider hints, transcript trimming for TPM caps, and recovery
from provider-side tool-call parse rejections.

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY (+ TAVILY_API_KEY for search)
npm run smoke          # one LLM round-trip → Zod-validated object
npm test               # full suite, no network needed
npm run cli -- "What is the current population of Tokyo?"   # full pipeline
npm run eval -- --limit 3   # eval scorecard over the question set
```

Every run writes `runs/<id>/trace.jsonl` (one JSON line per LLM call, tool call
and round result) and `runs/<id>/state.json` (the verified claims and verdicts).

Works with any OpenAI-compatible endpoint: set `OPENAI_BASE_URL` and `LLM_MODEL`
in `.env` if you are not using OpenAI directly.

## Design notes

- Agents exchange Zod-validated objects (`src/contracts.js`) — not chat transcripts.
  This file is the only coupling between agents.
- Plain `fetch` for LLM and search calls; the only dependency is `zod`.
- Everything is configurable via environment variables (`src/config.js`).
- `structuredChat()` asks the model for JSON, validates it with Zod, and runs one
  repair round-trip with the validation errors if the first attempt fails.
- Known risk: fetched web content is fed to the agents unfiltered — treat report
  claims as untrusted until Phase 4's mechanical citation check and source
  ranking harden this further.
