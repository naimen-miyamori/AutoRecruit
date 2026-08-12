# Stable Mode Runner Instructions

## Scope and Inheritance

These instructions apply to stable business-mode orchestration under `src/mode-runners/`. Apply the
root `AGENTS.md` and every owning domain document used by a runner.

## Ownership and Boundaries

- `src/index.ts` owns argv parsing, compatibility announcements, public dispatch, and shared
  platform-selection order. A mode runner owns one stable business intent after classification.
- CLI, HTTP, assistant, and scheduler surfaces reuse the same normalizers and runner owner. Do not
  create surface-specific business implementations or accept raw argv in a runner.
- Runners compose typed domain workflows and platform actions, enforce orchestration order, and
  return typed results. They do not own selectors, raw DOM mechanics, TaskQueue persistence, HTTP
  request parsing, or frontend authorization.
- Capture runners resolve every selected platform locally before the first browser session. Core
  targets pin identity, record revision/hash, source and complete search plan; Zhilian may carry a
  prospective native verification request only for a new saved job, while an existing saved job
  requires its already-bound native target. The Boss target only nests the validated v4 snapshot.
  Raw public input cannot inject execution conditions or targets.
- Keep irreversible boundaries explicit. Queue admission is not evidence that an external mutation
  completed; preserve identity, confirmation, receipt/outbox, and ambiguous-no-retry contracts.
- Login-owned platform runtime leases cover only the browser phase. Release the legacy Boss search
  lease first and the platform runtime lease second after final page cleanup, before ordinary
  offline scoring, export, report aggregation, or SMTP. The only SMTP overlap is the browser-free
  Boss rejection-email dispatcher after that exact rejected detail is strictly closed and its
  immutable routing/outbox evidence is durably read back; the browser producer only enqueues and
  never awaits delivery. Release the runtime before dispatcher drain and before aggregate-report
  SMTP. The documented Boss same-detail model wait remains the only exception that retains an open
  detail during non-browser work.
- Shared runner context contains explicit, replaceable dependencies only. Do not hide execution
  authority in mutable globals or duplicate public mode semantics outside `src/operation-modes.ts`.

## Migration and Verification

- Move one stable mode or one shared capture owner at a time. Preserve compatibility exports only as
  narrow facades with an explicit removal condition.
- Architecture tests must reject raw argv parsing, TaskQueue entry, platform selectors, and private
  page-action runtime imports from this directory.
- Run `src/scripts/test-operation-modes.ts`, the owning domain tests, CLI/run-semantics tests, and
  `npm run typecheck` for every migration; expand to the full suite and build for shared changes.
