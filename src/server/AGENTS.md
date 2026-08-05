# Server and Console Instructions

## Scope and Inheritance

These instructions apply to HTTP routes, task normalization, the console assistant, shared TaskQueue,
and scheduler behavior under src/server/. Apply root AGENTS.md first. Frontend and CLI changes that
consume these APIs preserve this contract; read frontend/AGENTS.md and the owning domain document
when they are affected.

## Ownership and Boundaries

- Server code owns routes, request validation, normalizers, queue/scheduler orchestration, internal
  API boundaries, assistant draft handling, and task result presentation contracts.
- HTTP tasks, assistant-confirmed tasks, and scheduled tasks reuse TaskQueue. Shared validation and
  argv construction belong in task-normalizers.ts; preview argv is explanatory, never execution
  authority.
- Do not add assistant- or scheduler-specific runners that bypass normalizers, queueing, platform
  isolation, CLI semantics, domain confirmation, or identity checks. Routes do not call live Boss
  browser modules directly.

## Assistant and Model Safety

- cli-assistant.ts produces structured drafts, warnings, and missing-field prompts only. Reject
  arbitrary shell, script, and file-write requests; never execute or persist model-suggested
  commands.
- Drop or warn about unsafe fields before confirmation, then normalize again at confirmation.
  assistant/confirm submits through TaskQueue and never trusts preview argv.
- Boss immediate match, greet, and chat mutation need both mode-specific confirmed true and final
  assistant risk acceptance. Read-only drafts never acquire mutation authority by sharing a kind.
- Web UI baseUrl, model, and apiKey overrides apply only to assistant draft generation and console
  RAG answering. Never store, log, or send an API key to normal task execution or domain facts.

## API, Queue, and Scheduler Contracts

- Preserve CLI isolation and platform constraints for capture, batch, search subscription, login,
  Boss, RAG, and Mapping modes. HTTP and assistant-confirmed Boss work normalizes then queues before
  browser activity.
- `includeBoss` belongs to normal capture/batch and search subscription with `platform=all`. It
  defaults false for hand-created and persisted schedule inputs; normalizers may add Boss as the
  fourth stage only when it is explicitly true. Search-subscription Boss work remains limited to
  native subscription search/save and never authorizes capture, forwarding, chat, or job sync.
  Preview warnings must disclose possible reuse of saved Boss forwarding for capture, but preview
  remains non-authoritative.
- Boss screening input uses the primary Boss forwarding target plus `bossSecondaryEmail`/
  `bossSecondaryCc` for candidate-level rejected-resume email. Legacy secondary-forward mode,
  recipient, and CC fields are accepted only far enough to return a clear rejection; they must
  never enter a normalized task, snapshot, argv, or scheduler record.
- Assistant rag-answer is standalone: no task, browser, capture, scoring, export, or email.
  Stored-job and temporary-JD answers preserve the RAG fact, isolation, and no-answer contracts.
- Internal HTTP endpoints are not a full auth gateway. Host binding, body limits, static paths, and
  optional API keys are configuration; do not hard-code secrets or deployment addresses.
- The queue is serial and deterministic. The persistence-backed scheduler is completion-driven,
  normalizes identifiers/time windows, preserves DST behavior, and supports stop-after-current-task
  semantics without inferring state from UI previews.
- A scheduler/assistant may compose existing modes but never broaden them. Boss position/JD sync may
  be scheduled; talent matching, greet, and atomic chat mutations are not. Talent Mapping scheduling
  is limited to card-only scan-stage plans; reject enrichment/all and detail-capable plans before
  queueing.
- Preserve intent IDs in task input/summaries for audit. Platform receipts enforce mutation retry
  idempotency; queue delivery is not assumed exactly once.
- A failed all-platform search-subscription task retains structured summaries for completed stages
  and the exact stopped platform while remaining failed. Earlier external saves are never rolled
  back or hidden by a later-stage error.
- Dashboard health includes aggregate Boss rejection-email outbox counts, including `sending` and
  `retryExhausted`; exhausted entries are not counted as automatically recoverable. Task detail owns
  immutable recipients, candidate-level delivery states, and the `sending`/`uncertain`/
  `retryExhausted` manual-verification warnings. Neither read
  model exposes rejection-email body content or SMTP credentials.

## Verification

- HTTP routes and assistant behavior: src/scripts/test-server-api.ts.
- Scheduler persistence, time, order, and task restrictions: src/scripts/test-task-scheduler.ts.
- Shared execution and CLI isolation: src/scripts/test-scoring-run-semantics.ts and the matching
  Boss/Talent Mapping CLI tests.
- Run npm run typecheck after server contract changes and expand to npm run test and npm run build
  for shared API, queue, scheduler, or domain-normalizer changes.
