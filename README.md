# Quorum

A multi-agent research team. A **Researcher** decomposes a question and gathers cited
claims, a **Fact-checker** independently verifies every claim against live sources, and
a **Synthesizer** writes the final report from verified claims only. An orchestrator
routes the work and runs the verify-and-revise loop.

The full roadmap and implementation plan lives in [PLAN.md](PLAN.md).

## Status — Phase 3 (verify-and-revise loop)

- [x] Phase 0 — config, LLM client with Zod-validated structured output, agent contracts
- [x] Phase 1 — one agent with web-search tools + CLI
- [x] Phase 2 — two-agent pipeline (claims → verdicts)
- [x] Phase 3 — feedback loop + synthesis
- [ ] Phase 4 — quality hardening (mechanical citation checks)
- [ ] Phase 5 — tracing + eval scorecard

Live end-to-end validation is pending API keys (see PLAN.md "Current status").

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY (+ TAVILY_API_KEY for search)
npm run smoke          # one LLM round-trip → Zod-validated object
npm test               # full suite, no network needed
npm run cli -- "What is the current population of Tokyo?"   # full pipeline
```

Works with any OpenAI-compatible endpoint: set `OPENAI_BASE_URL` and `LLM_MODEL`
in `.env` if you are not using OpenAI directly.

## Design notes

- Agents exchange Zod-validated objects (`src/contracts.js`) — not chat transcripts.
  This file is the only coupling between agents.
- Plain `fetch` for LLM and search calls; the only dependency is `zod`.
- Everything is configurable via environment variables (`src/config.js`).
- `structuredChat()` asks the model for JSON, validates it with Zod, and runs one
  repair round-trip with the validation errors if the first attempt fails.
