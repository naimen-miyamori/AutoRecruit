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
- Keep irreversible boundaries explicit. Queue admission is not evidence that an external mutation
  completed; preserve identity, confirmation, receipt/outbox, and ambiguous-no-retry contracts.
- Login-owned platform runtime leases cover only the browser phase. Release the legacy Boss search
  lease first and the platform runtime lease second after final page cleanup, before ordinary
  offline scoring, export, report aggregation, or SMTP; the documented Boss same-detail model wait
  remains the sole retention exception.
- Shared runner context contains explicit, replaceable dependencies only. Do not hide execution
  authority in mutable globals or duplicate public mode semantics outside `src/operation-modes.ts`.

## Migration and Verification

- Move one stable mode or one shared capture owner at a time. Preserve compatibility exports only as
  narrow facades with an explicit removal condition.
- Architecture tests must reject raw argv parsing, TaskQueue entry, platform selectors, and private
  page-action runtime imports from this directory.
- Run `src/scripts/test-operation-modes.ts`, the owning domain tests, CLI/run-semantics tests, and
  `npm run typecheck` for every migration; expand to the full suite and build for shared changes.
