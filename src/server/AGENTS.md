# Server and Console Instructions

These instructions apply to HTTP routes, task normalization, the console assistant, the shared task
queue, and scheduler behavior under `src/server/`. Frontend and CLI changes that consume these APIs
must preserve the same contracts.

## Shared Execution Path

- HTTP tasks, assistant-confirmed tasks, and scheduled tasks must reuse the existing `TaskQueue`.
- Shared request validation and argv construction belong in `task-normalizers.ts`.
- Do not add an assistant-specific or scheduler-specific execution runner that bypasses normalizers,
  queueing, platform isolation, or CLI semantics.
- Preview argv is explanatory only and is never the execution source of truth.
- Preserve the CLI's mode isolation and platform constraints for normal capture, batch,
  search-subscription, login refresh, Boss auto-chat, RAG operations, and standalone RAG answers.

## Console Assistant Safety

- `cli-assistant.ts` is a structured draft layer. A model may produce an `AssistantDraft`, warnings,
  and missing-field prompts only.
- Reject arbitrary shell, script, and file-write requests. Never execute or persist model-suggested
  commands.
- Drop or warn about unsupported/unsafe fields before confirmation. Confirmation must still pass
  through shared normalizers and fail there when the final request is invalid.
- `/api/assistant/confirm` finalizes the draft and submits through the shared queue; it must not trust
  preview argv.

## Request-Scoped Model Settings

- Web UI `baseUrl`, `model`, and `apiKey` overrides apply only to assistant draft generation and
  console RAG question answering.
- Never store an API key in task records, assistant drafts, persisted config, logs, answer logs, or
  model input.
- Request-scoped model settings must not alter confirmed task execution.

## Assistant RAG Answers

- Assistant `rag-answer` is standalone and must not create tasks, open browsers, capture or score
  resumes, export reports, or send email.
- Stored-job answers use persisted RAG and do not reparse JD.
- Temporary JD answers use only the provided JD and must not create job records, persistent indexes,
  or production answer logs.
- Follow `src/rag/AGENTS.md` for fact trust, isolation, and no-answer behavior.

## Internal API Boundary

- `rag:api` and the console HTTP server are internal product interfaces, not full auth gateways.
- Optional API keys are lightweight internal-entry protection. Do not imply built-in multi-tenancy,
  RBAC, rate limiting, centralized audit, or alerting.
- Request body limits, host binding, API keys, and static frontend paths remain runtime configuration;
  do not hard-code secrets or deployment-specific addresses.

## Queue and Scheduler

- The queue is single-process and serial. Preserve deterministic task ordering and existing task
  state transitions.
- The scheduler is persistence-backed and completion-driven. It shares `TaskQueue`, maintains
  schedule/round records, and supports stop-after-current-task semantics.
- Normalize schedule identifiers and time windows through the shared schedule modules. Preserve DST
  behavior and do not infer scheduler state solely from UI previews.
- A scheduler or assistant feature may compose existing task modes but must not broaden what those
  modes are allowed to do.

## Focused Verification

- HTTP routes and assistant behavior: `src/scripts/test-server-api.ts`
- Scheduler persistence/time/order behavior: `src/scripts/test-task-scheduler.ts`
- Shared execution and CLI isolation: `src/scripts/test-scoring-run-semantics.ts`
- RAG API behavior: matching `src/scripts/test-rag-api.ts` and other `test-rag-*.ts` files

Run `rtk npm run typecheck` after server contract changes and expand to the full test suite according
to risk.
