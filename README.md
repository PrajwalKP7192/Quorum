# Quorum

[![CI](https://github.com/PrajwalKP7192/Quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/PrajwalKP7192/Quorum/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-68%20passing-brightgreen)
![deps](https://img.shields.io/badge/runtime%20deps-1%20%28zod%29-blue)

A multi-agent research team. A **Researcher** decomposes a question and gathers cited
claims, a **Fact-checker** independently verifies every claim against live sources, and
a **Synthesizer** writes the final report from verified claims only. An orchestrator
routes the work and runs the verify-and-revise loop.

The full roadmap and implementation plan lives in [PLAN.md](PLAN.md).

## How it works

```
question ──▶ Orchestrator
                 │
                 ▼
          ┌─────────────┐  web_search + open_page
          │ Researcher  │──────────────▶ Tavily
          └──────┬──────┘
                 ▼  claims[] with citations (Zod-validated)
          ┌──────────────┐  verify each claim (parallel, temp 0)
          │ Fact-checker │──────────────▶ Tavily
          └──────┬───────┘
                 ▼  verdicts[] (verbatim evidence quote + URL)
      any failed? ──yes──▶ back to Researcher (max MAX_ROUNDS)
                 │ no
                 ▼
          ┌──────────────┐
          │ Synthesizer  │──▶ report from supported claims only
          └──────────────┘     + "Excluded claims" appendix
```

Design principles:

- **Agents exchange typed, Zod-validated objects** (`src/contracts.js`) — never free-form
  chat transcripts. This file is the only coupling between agents, so any agent can be
  swapped in a one-file rewrite.
- **Never trust the model at the boundary:** claim ids are assigned in code, verdicts
  must quote evidence verbatim with a URL, structured outputs get schema-repair
  round-trips, and a mechanical (no-LLM) citation check confirms quotes really appear
  on the cited pages.
- **Plain `fetch` everywhere;** the only runtime dependency is `zod`. Works with any
  OpenAI-compatible endpoint.
- **Failures are contained:** per-claim verification is failure-isolated, rate limits
  and transient network errors are retried with provider hints, and transcripts are
  auto-trimmed to fit token-per-minute ceilings.

## Status

- [x] Phase 0 — config, LLM client with Zod-validated structured output, agent contracts
- [x] Phase 1 — one agent with web-search tools + CLI
- [x] Phase 2 — two-agent pipeline (claims → verdicts)
- [x] Phase 3 — feedback loop + synthesis
- [x] Live end-to-end run (2026-10-10): 5/5 claims verified, cited report generated
- [x] Phase 4 — quality hardening (mechanical citation checks, claim dedupe, source ranking)
- [x] Phase 5 — tracing (JSONL per run) + eval scorecard (`npm run eval`)
- [x] Phase 6 — live web dashboard (`npm start`, zero added dependencies)

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY (+ TAVILY_API_KEY for search)
npm test               # 68 tests, no network or API keys needed
npm run smoke          # one LLM round-trip → Zod-validated object
npm run cli -- "What is the current population of Tokyo?"   # full pipeline
npm run eval -- --limit 3   # eval scorecard over the question set
npm start                   # live dashboard at http://localhost:8080
```

The dashboard (`npm start`) streams the pipeline live over Server-Sent Events —
watch claims appear, verdicts land and rounds turn — and lists past runs.
Built on plain `node:http`; still only one runtime dependency (`zod`).

Works with any OpenAI-compatible endpoint: set `OPENAI_BASE_URL` and `LLM_MODEL`
in `.env` if you are not using OpenAI directly. Validated on Groq's free tier
(`openai/gpt-oss-20b`) with Tavily search.

## Example (live run, 2026-10-10)

```
## Verdicts (round 1)
  ✓ [c1] supported     The population of Tokyo prefecture was 14,002,534 residents ...
      https://www.nippon.com/en/japan-data/h02503
  ✓ [c2] supported     ...
```

> **Current Population of Tokyo Prefecture** — The most recent official estimates
> indicate that Tokyo prefecture has a population of **14,002,534 residents** …
> cited inline as `[cN](url)`, with excluded claims listed in an appendix.

Every run persists `runs/<id>/state.json` (claims, verdicts, report) and
`runs/<id>/trace.jsonl` — one JSON line per LLM call, tool call and round result.

## Known limitations

- Fetched web content is fed to the agents unfiltered — treat report claims as
  untrusted until further hardening (prompt-injection surface).
- On Groq's free tier a full run takes ~10 minutes, mostly rate-limit waits;
  higher limits (or any paid endpoint) make it far faster.

## License

[MIT](LICENSE)
