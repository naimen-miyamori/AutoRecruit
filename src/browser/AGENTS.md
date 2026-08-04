# Browser Instructions

## Scope and Inheritance

These instructions apply to shared browser sessions, page readiness, pacing, pointer state, and the
documented heuristic resume parser under src/browser/. Apply root AGENTS.md first. Platform UI
behavior, selectors, login destinations, modal/popup variants, forwarding, chat, and filters belong
to the matching src/platforms/<platform>/AGENTS.md.

## Ownership and Boundaries

- Browser helpers are selector-free and platform-neutral. Promote a helper only when at least two
  platforms share the same typed inputs, outputs, and failure semantics.
- Browser code owns session/profile lifecycle, reusable browser/context/page selection, deadline
  utilities, user-like pacing, continuous pointer tracking, and common parser primitives.
- Platform actions own platform pacing application, sequential input semantics, selectors,
  compatibility clicks, readiness variants, and business postconditions. Workflows own persistence,
  confirmation, and task execution.

## Session and Reuse

- Use platform-scoped storage state and leave STORAGE_STATE_PATH unset for normal multi-platform
  runs. Reject unsafe shared or cross-platform state overrides.
- A missing or expired session may refresh through manual headed login and then verify persisted
  state. Headless runs cannot refresh and must fail with an actionable rerun instruction.
- Reuse the authenticated context and useful page whenever supported. Do not create repeated login
  tabs or replace a usable current page; close only stale tabs or detail pages when the owning
  platform contract requires it.
- Browser engine and reusable-profile defaults remain configuration concerns. Do not duplicate
  platform port, profile, or login-page inventories here.

## Deadlines and Readiness

- Orchestration creates one search deadline and passes it through search entry and candidate
  extraction. Detail operations use one bounded detail deadline.
- Use remaining-time calculations and race valid readiness paths within the existing budget. Do not
  stack sequential full-timeout waits, reset deadlines after navigation, or add unbudgeted waiting.
- A stable empty list or explicit platform empty state is successful readiness. API fallback is
  short and subordinate to DOM readiness.
- Pacing happens before an action; readiness waits for its result. Multi-action flows budget both
  intentionally instead of silently consuming the whole deadline.

## Pacing and Pointer Contracts

- Use src/browser/pacing.ts for user-action and candidate-transition timing. The shared default
  range remains 2000–4000ms with the configured weighted distribution; platform configuration may
  provide compatible overrides.
- Pointer-driven operations preserve one context-scoped continuous trajectory across pages and
  popup/modal transitions. Native locator, forced, or DOM-event compatibility paths first move the
  shared pointer to the target; no helper may teleport or bypass the tracker.
- Pointer steps use a visible human-speed cadence with slower departure/arrival and a faster middle
  phase. The whole timed movement belongs to the caller's existing deadline; never drop delays,
  increase speed, or jump to the destination when the remaining budget is insufficient.
- Shared typing helpers preserve intentional sequential input behavior. The owning platform decides
  when it is required and whether clearing an existing value is allowed; browser helpers must not
  silently degrade required typing to whole-value fill.
- DOM reads, deterministic parsing, model calls, local writes, and SMTP do not need artificial
  browser pacing.

## Candidate Detail and Parsing

- A detail-open or extraction failure stays retryable; only a successful capture becomes seen.
  Platform actions enforce their required post-ready dwell and successful cleanup/inspection
  behavior.
- Parse the intended detail subtree, never unrelated page chrome. Keep platform modal/popup logic
  out of shared browser helpers.
- src/browser/resume-detail.ts remains the heuristic-heavy 51job extraction fallback. Preserve
  original field text, require page-structure evidence, and never invent histories by splitting
  same-company multi-role records. Validate changes with stored snapshots and offline reparsing.
- Crawl4AI is optional. The built-in parser remains usable when the local Python environment or
  Crawl4AI is unavailable.

## Verification

- Shared session, pacing, resume parsing, registry, and capture semantics:
  src/scripts/test-platform-registry.ts, src/scripts/test-51job-actions.ts, and
  src/scripts/test-scoring-run-semantics.ts.
- Action ownership and pointer/deadline boundary behavior:
  src/scripts/test-platform-action-boundaries.ts plus the matching platform action tests.
- Parser work uses the documented offline reparse/validation scripts before any live-flow change.
