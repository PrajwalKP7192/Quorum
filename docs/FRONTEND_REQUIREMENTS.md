# Quorum — Frontend Requirements

> Status: v0 shipped (`src/dashboard.js`, zero dependencies, SSE live view).
> This document defines what v1 ("proper frontend") adds, in priority order.
> Backend capabilities each requirement depends on are noted where relevant.

## 1. Users & goals

- **Visitor / recruiter** — land, submit a question, watch the pipeline verify
  claims live, read the report, browse past runs. Must work without explanation.
- **Power user** — inspect why a claim failed: verdicts, evidence quotes, traces,
  token/latency costs. Compare runs before and after a change.

## 2. Functional requirements (v1)

### F1 — Ask & run control
- Question input with trim/length validation; Enter submits; button disabled
  while a run is in flight (server allows one run at a time → surface a
  "run in progress" state instead of a silent 409).
- Example-question chips; last question preserved in `localStorage`.
- Errors surface as an inline banner: budget exhausted, rate limited, server
  unreachable — each with a "what to do" hint. *Backend: SSE `error` event (exists).*

### F2 — Live run view
- Stage progress (Researcher → Fact-checker → Synthesizer) with active/done
  states. *(exists)*
- **Verdicts stream individually** as they land (currently they arrive as one
  batch per round). *Backend: add a per-verdict `verify:claim` event in
  `verifyAll` — small change.*
- Live counters: claims found, supported/failed, elapsed time, tokens used so
  far. *Backend: usage is in `RunState`/trace; needs a `usage` SSE event.*
- Citation-check failures flagged inline on the affected claim card. *(exists)*

### F3 — Report rendering
- Rendered markdown: headings, bold, lists, links; citations clickable
  (new tab). Escape-then-format, always. *(exists)*
- Copy-to-clipboard and "Download .md" buttons.
- Deep-linkable: `/runs/:id` opens the report directly. *(backend exists;
  needs client routing)*

### F4 — History
- Runs grid (exists) + sort (date, support rate) and text search.
- Delete a run (with confirm). *Backend: needs `DELETE /runs/:id`.*
- **Compare two runs side-by-side** (before/after a change) — claims, verdicts,
  tokens, duration.

### F5 — Run detail / observability
- Claims table: id, text, sources, verdict, evidence quote, feedback.
- **Trace timeline** from `trace.jsonl`: each LLM call (model, latency, tokens,
  retries) and tool call (name, args, duration) on a scrollable timeline.
  *Backend: `GET /runs/:id/trace` — add.*
- Eval scorecard page rendering `evals/results-*.json`. *Backend:
  `GET /evals` — add.*

### F6 — Resilience
- SSE auto-reconnect (EventSource does this natively) with "connection lost"
  feedback *(hint exists)* and resume-safe rendering (idempotent events).
- If SSE is unavailable (proxies), fall back to polling `GET /runs/:id`.

## 3. UX / visual requirements

- Responsive from 375 px to desktop; single-column on mobile, stage cards stack.
- Dark theme default; light theme toggle (persisted).
- Accessibility: labeled inputs, WCAG AA contrast, `aria-live="polite"` on the
  live feed, visible focus rings, respects `prefers-reduced-motion`.
- Loading skeletons for history/report; empty states that prompt the first run.

## 4. Non-functional requirements

- **Zero runtime dependencies beyond zod; no build step** for the default path —
  this is a project identity constraint. Plain ES modules or one inlined page.
- All model/web-derived strings escaped before `innerHTML` (XSS).
- No secrets in client code; the client only ever talks to this server.
- Page weight budget: < 50 KB unminified inline assets; no external fonts/CDNs.
- Node 24 compatible, CommonJS consistent with the codebase.

## 5. Technology decision

| Path | When to choose | Trade-off |
|---|---|---|
| **A. Vanilla (current)** | Default. Portfolio story: "full-stack app, zero frontend deps, no build step" | More manual DOM code as features grow |
| **B. Vite + React + TS** | Only if demonstrating React on the resume matters more than the zero-dep story | New toolchain, build step, bigger repo |

Both paths consume the same API/SSE contract defined above.

## 6. Acceptance criteria (checkable)

1. Submitting a question streams stage changes and per-claim verdicts within
   the run; the report renders with clickable citations when done.
2. With the API budget exhausted, a clear banner appears in < 1 s (fail-fast).
3. `/runs/:id` deep link opens the run detail (report + verdicts) after reload.
4. The trace timeline shows every LLM/tool call of a past run with latencies.
5. Layout usable at 375 px; keyboard-only submission works; feed announces via
   `aria-live`.
6. `npm test` stays green; new server endpoints covered by tests.

## 7. Nice-to-have (v2, unscheduled)

- Live token/latency meter during runs (from trace events).
- Side-by-side eval history chart (coverage % over time).
- Shareable read-only public run pages (static export).
- Light "inspect the contracts" view rendering `state.json` against the Zod
  schemas for teaching purposes.
