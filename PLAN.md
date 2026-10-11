# Quorum — Roadmap & Implementation Plan

> Canonical planning document. Status markers updated as phases complete.
> Last updated: 2026-10-10 (Phases 0–3 live-validated on Groq free tier + Tavily).

## 1. What Quorum is

A multi-agent research team that produces **verified** reports:

- **Researcher** — decomposes a question into sub-questions, searches the web, extracts
  discrete factual claims, each with citations.
- **Fact-checker** — independently verifies every claim against live sources; returns a
  verdict (`supported` / `contradicted` / `unverifiable`) with a verbatim evidence quote
  and URL.
- **Synthesizer** — writes the final report using *only* verified claims.
- **Orchestrator** — plain code that routes work and runs the feedback loop: failed
  claims go back to the researcher with the fact-checker's feedback, up to a max number
  of rounds.

```
question ──▶ Orchestrator
                │
                ▼
         ┌─────────────┐  search + fetch
         │ Researcher  │──────────────▶ web
         └──────┬──────┘
                ▼  claims[] with citations
         ┌──────────────┐  verify each claim (parallel)
         │ Fact-checker │──────────────▶ web
         └──────┬──────┘
                ▼  verdicts[]
     any failed? ──yes──▶ back to Researcher (max MAX_ROUNDS)
                │ no / maxed out
                ▼
         ┌──────────────┐
         │ Synthesizer  │──▶ quorum-report.md (supported claims only)
         └──────────────┘
```

**Core design principle:** agents exchange typed, Zod-validated objects
(`src/contracts.js`) — not free-form chat transcripts. This is what makes the system
debuggable, testable, and portable. Each agent is just: system prompt + tool loop +
one structured output. `contracts.js` is the only coupling between agents.

## 2. Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Language | Node.js (CommonJS), matching rag-app | one ecosystem; reuse config/LLM patterns |
| Orchestration | from scratch (plain async functions) | the verify/revise loop is a `while` loop; no framework magic to debug |
| LLM access | OpenAI-compatible REST via plain `fetch` (`src/llm.js`) | works with OpenAI, proxies, local endpoints |
| Contracts | Zod (only dependency) | runtime-validated inter-agent messages + structured output |
| Web search | Tavily API (plain `fetch`, no SDK) | built for agents; returns clean page content |
| Tracing | JSONL event log per run | zero infra, grep-able |
| Tests | built-in `node:test` | no new deps |
| Interface | CLI first → Express + SSE (Phase 6) | matches rag-app's shape |

Model assignment (env-overridable): strong model for researcher/synthesizer
(`RESEARCHER_MODEL`, falls back to `LLM_MODEL`), cheap fast model for the fact-checker
(`CHECKER_MODEL`) — per-claim verdicts run in parallel and are cheap to grade.

## 3. Current status

- [x] **Phase 0 — Scaffold** (rebuilt 2026-10-08): `src/config.js`, `src/contracts.js`
      (Source / Claim / Verdict / ResearchOutput / RunState), `src/llm.js` (`chat()` +
      `structuredChat()` with repair round-trips), `scripts/smoke.js`. Covered by
      `test/contracts.test.js` + `test/llm.test.js`. Smoke fails cleanly without a key.
      (The original Phase 0 files were lost; rebuilt together with Phase 1.)
- [x] **Phase 1 — Researcher with tools** (code complete 2026-10-08):
      `src/tools/search.js` (Tavily client + per-run query cache),
      `src/tools/fetch.js` (HTML→text extraction), `src/tools/index.js` (toolbelt),
      `src/agents/base.js` (`runToolLoop` — scripted-LLM testable),
      `src/agents/researcher.js` (tool loop → `structuredChat` → contract-validated
      claims with code-assigned ids `c1..cN`, invalid claims dropped with a warning),
      `src/cli.js` (prints sub-questions + claims + clickable citations, token/time
      summary).
- [x] **Phase 2 — Two-agent pipeline** (code complete 2026-10-08):
      `src/agents/fact-checker.js` (`verifyClaim` at temperature 0, adversarial
      prompt, verbatim `evidenceQuote` + URL required; unusable checker output
      degrades to an `unverifiable` verdict carrying the reason as feedback),
      `src/verify.js` (`verifyAll` — worker-pool parallelism capped at
      `VERIFY_CONCURRENCY`, claim-order preserved, per-claim crashes isolated),
      `src/orchestrator.js` (`runPipeline` — research → verifyAll → `RunState`
      persisted to `runs/<timestamp>/state.json`; agent fns injectable).
- [x] **Phase 3 — Feedback loop + synthesis** (code complete 2026-10-08):
      revise round in `src/agents/researcher.js` (`revise` — failed verdicts +
      feedback go back to the researcher; claim ids stay stable for carried
      claims, new claims continue after the prior max), dropped-claim tracking
      (`RunState.dropped`), `src/agents/synthesizer.js` (report from supported
      claims only, `[cN](url)` inline citations, "Excluded claims" appendix),
      CLI verdict table + `--rounds N` / `--out FILE`. 48 tests green, no network.
- [x] **Live validation of Phases 1–3** (2026-10-10, Groq free tier + Tavily):
      `node src/cli.js "What is the current population of Tokyo?" --rounds 0` →
      5 claims, **5 supported / 0 failed**, report with inline `[cN](url)` citations
      and verbatim evidence quotes (nippon.com / stat.go.jp), artifacts in
      `runs/2026-10-10T16-42-32-161Z/`. Answer: 14,002,534 (Tokyo prefecture).
      Known quality gap for Phase 4: researcher emitted near-duplicate claims
      (all 5 were the same fact).
- [x] **Phase 5 — Tracing + evals** (code complete 2026-10-10):
      `src/trace.js` (JSONL event log per run at `runs/<id>/trace.jsonl`:
      `llm_call` with model/latency/token counts, `tool_call` with args/duration,
      `agent_event` per round, `run:start`/`run:done`); threaded through llm.js,
      the tool loop, all three agents and the orchestrator.
      `evals/questions.json` (20 stable factual questions with expected-answer
      labels) + `evals/grade.js` (`npm run eval [-- --limit N] [-- --rounds N]`):
      scorecard for coverage, mechanical citation validity, supported rate,
      tokens and latency; results saved to `evals/results-<ts>.json`.
      68 tests green.
- **Remaining Phase 4/5 exit numbers**: run `npm run eval -- --limit 5` once the
  free-tier daily budget has recovered to fill in the actual percentages for
  PLAN.md/resume. Phase 6 (service + UI) optional.
- **Free-tier hardening added during live testing** (all regression-tested):
      429 retry with provider hint parsing (seconds + minutes), transient network
      retries, transcript trimming to fit 8K TPM request caps, tool-result size
      caps, recovery from provider-side tool-call rejections (hallucinated tool
      names, narrated tool calls, tools-blocked-on-final-call), repair temperature
      escalation. Default model: `openai/gpt-oss-20b` (120b exhausts its 200K/day
      free bucket in ~2 runs; 20b TPM is also 8K — a full run takes ~10 min, mostly
      rate-limit waits).

## 4. Phases

### Phase 1 — One agent with tools (researcher v0)

**Build:**

- `src/tools/search.js` — `webSearch(query, { maxResults })`: Tavily REST call, returns
  `{ title, url, snippet, content }[]`. Cache results per run (Map keyed by query).
- `src/tools/fetch.js` — `fetchPage(url)`: built-in fetch + HTML→text extraction
  (strip scripts/styles/tags, collapse whitespace; port the approach from rag-app's
  `extract.js`). Size-capped.
- `src/agents/base.js` — `runToolLoop({ llm, system, messages, tools, maxSteps })`:
  OpenAI tool-calling loop — model returns `tool_calls`, execute them, append
  `role: 'tool'` results, repeat until the model stops calling tools or `maxSteps` is
  hit. Takes the LLM client as a parameter so tests inject a scripted fake.
- `src/agents/researcher.js` — `research(question, tools)` → `{ subQuestions, claims }`
  via `structuredChat` after the tool loop. Claim ids `c1..cN`.
- `src/cli.js` — `node src/cli.js "question"` → prints the answer with clickable
  citations.

**Exit:** one agent answers a question citing real, clickable URLs.
**Tests:** tool loop driven by a fake LLM (scripted tool_calls); Tavily client with
mocked fetch. **Effort:** 1–2 days.

### Phase 2 — Two-agent pipeline

**Build:**

- `src/agents/fact-checker.js` — `verifyClaim(claim, tools)` → `Verdict`, temperature 0,
  adversarial system prompt, must quote evidence verbatim + URL.
- `src/verify.js` — `verifyAll(claims)`: per-claim in parallel with a concurrency limit
  (`VERIFY_CONCURRENCY`, default 4); one claim's failure never fails the batch.
- `src/orchestrator.js` — basic pipeline: research → verifyAll → assemble `RunState`,
  persisted to `runs/<timestamp>/state.json`.
- CLI prints a verdict table (claim → verdict → evidence URL).

**Exit:** end-to-end JSON artifact (claims → verdicts) on 5 sample questions.
**Effort:** 2–3 days.

### Phase 3 — Feedback loop + synthesis

**Build:**

- Orchestrator revise loop (the heart of the system):

```js
for (round = 0; round <= MAX_ROUNDS; round++) {
  state.claims   = round === 0
    ? await researcher(state, tools)
    : await researcher.revise(state, state.failedVerdicts, tools);
  state.verdicts = await verifyAll(state.claims, tools);
  state.failed   = state.verdicts.filter(v => v.verdict !== 'supported');
  if (state.failed.length === 0) break;
}
state.report = await synthesizer(state, tools);   // supported claims only
```

- `src/agents/synthesizer.js` — report from supported claims only; every paragraph
  links its citations; unsupported claims listed in an appendix with their verdicts.
- Output: `quorum-report.md` + updated `state.json`.
- CLI flags: `--rounds N`, `--out FILE`.

**Exit:** contradicted claims actually get revised or dropped; runs always terminate;
dropped claims are visible in the report appendix. **Effort:** 2–3 days.

### Phase 4 — Quality hardening

**Build:**

- `src/tools/citation-check.js` — mechanical, no LLM: fetch each cited URL, normalize
  whitespace, confirm `evidenceQuote` actually appears on the page. Flag mismatches.
- Source heuristics in search results: domain weighting (gov/edu/primary sources),
  recency preference, dedupe by URL.
- Prompt iteration against failures observed in real runs.
- Config: `CITATION_CHECK=strict|warn|off` (default `warn`).

**Exit:** citation validity > 90% on the eval set. **Effort:** 2–3 days.

### Phase 5 — Tracing + evals

**Build:**

- `src/trace.js` — JSONL event log per run in `runs/<id>/trace.jsonl`: one line per
  `llm_call` (model, tokens, latency), `tool_call` (name, args, duration),
  `agent_event` (round, claim counts). Zero-infra, grep-able.
- `evals/questions.json` — 20 questions with expected-answer labels.
- `evals/grade.js` — scorecard: verdict accuracy vs. labels, citation validity,
  claim coverage, cost (from usage), latency. `npm run eval`.

**Exit:** `npm run eval` prints a scorecard you can regress against after any change.
**Effort:** 2 days.

### Phase 6 — Service + UI (optional)

**Build:** Express server (rag-app pattern): `POST /research` streams agent activity as
SSE events; `GET /runs/:id` serves past runs; minimal web page showing the pipeline
live (claims appearing, verdicts landing, rounds turning).

**Exit:** demo-able in a browser. **Effort:** 2–3 days.

### Phase 7 — Extensions

**Done 2026-10-11:**

- [x] **Skeptic agent** (`src/agents/skeptic.js`) — after the loop converges, a
      fourth agent challenges every supported claim (counter-evidence via tools,
      scope gaps, source reliability) and raises at most one honest objection per
      claim. Objections live in `RunState.objections`, are shown in the CLI and
      dashboard claims table, and the synthesizer must address them in a
      "Counter-considerations" section. `SKEPTIC=on|off` (default on); fails soft.
- [x] **Parallel researcher fan-out** (`researchParallel`) — decompose once, then
      one researcher per sub-question under a concurrency pool; merged claims are
      deduped and renumbered. `PARALLEL_RESEARCH=on|off` (default off — multiplies
      LLM calls per run, best on a paid tier), `RESEARCH_CONCURRENCY=3`.
- [x] **Docker** (`Dockerfile` + `.dockerignore`) — node:24-alpine, non-root user,
      keys via env at runtime: `docker build -t quorum . && docker run -p 8080:8080
      --env-file .env quorum`.

**Still open (pick later):**

- `search_docs` tool wrapping a BM25 index — researcher works over your own corpus.
- Human approval gate before the final report.

## 5. Cross-cutting concerns

- **Error handling:** every tool call and LLM call wrapped; per-claim verification
  failures don't fail the batch; timeouts via `AbortSignal.timeout`.
- **Cost control:** capped rounds (`MAX_ROUNDS`, default 2), cheap checker model,
  parallel verification, per-run search cache, token usage recorded in the trace.
- **Degradation:** missing `TAVILY_API_KEY` → tools error clearly; missing
  `OPENAI_API_KEY` → nothing runs (announced loudly, as now).
- **Testing:** agents take `llm` and `tools` as parameters; tests inject scripted fakes
  (`node:test`), so no network in CI.

## 6. Known pitfalls → mitigations

| Pitfall | Mitigation |
|---|---|
| Sycophancy (checker rubber-stamps researcher) | verbatim quote + URL required per verdict; checker at temperature 0; adversarial prompt |
| Hallucinated citations | Phase 4 mechanical citation check — fetch + string match, no LLM |
| Cost/latency blowup | capped rounds, cheap checker model, parallel per-claim checks, search cache |
| Non-termination | hard `MAX_ROUNDS`; fallback = drop unverified claims, synthesize from the rest |
| Framework lock-in | all coupling lives in `contracts.js`; orchestrator swap is a one-file rewrite |

## 7. Environment variable reference

| Var | Default | Used |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | all LLM calls |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | LLM endpoint |
| `LLM_MODEL` | `gpt-4o-mini` | default model |
| `RESEARCHER_MODEL` / `CHECKER_MODEL` | fall back to `LLM_MODEL` | Phase 1+ |
| `REQUEST_TIMEOUT_MS` | `60000` | LLM/tool timeouts |
| `MAX_REPAIR_ATTEMPTS` | `1` | structuredChat repairs |
| `TAVILY_API_KEY` | — (Phase 1) | web search |
| `MAX_ROUNDS` | `2` | Phase 3 |
| `VERIFY_CONCURRENCY` | `4` | Phase 2 |
| `CITATION_CHECK` | `warn` | Phase 4 |
| `PORT` | `8080` | Phase 6 |

## 8. Timeline

Phases 0–3 are code-complete and covered by 48 network-free tests. The next steps:
add `OPENAI_API_KEY` + `TAVILY_API_KEY` to `.env` and validate Phases 1–3 live
(see "Current status"), then start Phase 4. Original pacing below still applies
for the remaining phases: Phase 4 ≈ 2–3 days, Phase 5 ≈ 2 days — Phase 6 only if
wanted.
