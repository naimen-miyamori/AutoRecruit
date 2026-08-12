# Stable Mode Runner Instructions

## Scope and Inheritance

These instructions apply to stable business-mode orchestration under `src/mode-runners/`. Apply the
root `AGENTS.md` and every owning domain document used by a runner. As applicable, read
`src/platforms/AGENTS.md`, `src/browser/AGENTS.md`, `src/server/AGENTS.md`, `src/rag/AGENTS.md`, and
`src/talent-mapping/AGENTS.md`; their domain contracts remain authoritative inside the runner.

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
- A runner owns phase ordering, not the underlying browser, Boss, or reporting contract. Follow the
  root and owning scoped documents for lease order, page cleanup, same-detail model waiting, and the
  sole browser-free rejection-email overlap. Keep ordinary offline work and aggregate SMTP after
  runtime release; do not restate a second lifecycle policy in this directory.
- Shared runner context contains explicit, replaceable dependencies only. Do not hide execution
  authority in mutable globals or duplicate public mode semantics outside `src/operation-modes.ts`.

## Migration

- Move one stable mode or one shared capture owner at a time. Preserve compatibility exports only as
  narrow facades with an explicit removal condition.

## Verification

- Architecture tests must reject raw argv parsing, TaskQueue entry, platform selectors, and private
  page-action runtime imports from this directory: `src/scripts/test-mode-runner-boundaries.ts`.
- Public mode classification and CLI/run semantics: `src/scripts/test-operation-modes.ts` and
  `src/scripts/test-scoring-run-semantics.ts`, plus the owning domain tests.
- Run `rtk npm run typecheck` for every migration; expand to `rtk npm run test` and
  `rtk npm run build` for shared changes.
