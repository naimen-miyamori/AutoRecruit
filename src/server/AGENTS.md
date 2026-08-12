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
- Public capture payloads must reject private execution plans, executable conditions, and
  per-platform targets. Exact job identity/name authority, JD title, saved-search name, and page
  keyword are separate read-model fields; the server must not synthesize one from another.
- Do not add assistant- or scheduler-specific runners that bypass normalizers, queueing, platform
  isolation, CLI semantics, domain confirmation, or identity checks. Routes do not call live Boss
  browser modules directly.

## Assistant and Model Safety

- cli-assistant.ts produces structured drafts, warnings, and missing-field prompts only. Reject
  arbitrary shell, script, and file-write requests; never execute or persist model-suggested
  commands.
- Drop or warn about unsafe fields before confirmation, then normalize again at confirmation.
  assistant/confirm submits through TaskQueue and never trusts preview argv.
- Assistant drafts use a registered business `modeId` as the intent authority. The server derives
  the legacy task kind and any implied `searchSource`; clients and models must not freely combine
  `kind`, `searchSource`, or mode labels. The exact terms “订阅搜索”, “直接搜索”, and “订阅管理”
  map to one mode each; conflicts or multiple terms require clarification before queueing.
- Legacy capture drafts with an omitted source compile to the no-override mode and remain identical
  across repeated finalize/validate/confirm passes. An unknown model mode produces a no-draft
  clarification response rather than an executable fallback or an unclassified HTTP error.
- `src/operation-modes.ts` owns the shared public catalog. `GET /api/operation-modes` may expose only
  its read-only labels, surfaces, and declared effects; `src/server/api-contracts.ts` exposes the
  browser-safe surface-aware runtime parser, while `src/operation-modes.ts` also owns the forward
  compiler for the five search modes. Normalizers derive `modeId`, `modeLabel`, `declaredEffects`,
  and `resolvedEffects` in `inputSummary`. A client-supplied mode field is never authorization and
  public task input schemas remain unchanged.
- A single-platform Boss normal-capture or batch draft always carries a conservative risk warning:
  queue preflight may reuse stored forwarding, report delivery, or screening settings even when the
  draft contains no explicit delivery fields. Confirmation therefore requires risk acceptance.
- A Boss `saved` capture may reuse a complete saved-search reference only from the same current
  saved JobRecord after identity and fingerprint validation. Missing or stale references fail
  before browser/session creation; never fall back to a name-only or legacy saved entry.
- Boss immediate match, greet, and chat mutation need both mode-specific confirmed true and final
  assistant risk acceptance. Read-only drafts never acquire mutation authority by sharing a kind.
- Web UI baseUrl, model, and apiKey overrides apply only to assistant draft generation and console
  RAG answering. Never store, log, or send an API key to normal task execution or domain facts.

## API, Queue, and Scheduler Contracts

- Preserve CLI isolation and platform constraints for capture, batch, search subscription, login,
  Boss, RAG, and Mapping modes. HTTP and assistant-confirmed Boss work normalizes then queues before
  browser activity.
- `npm run search:run` is the required CLI safety launcher for the five search operation IDs. The
  launcher only checks presence and membership; `src/index.ts` remains the semantic classifier and
  rejects a conflicting `--mode-id` before JobStore/session work. Legacy `npm run dev` calls may
  omit the assertion and receive a compatibility warning.
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
- Scheduled search-subscription work is no-save. The shared schedulable normalizer rejects
  `saveSearchSubscription=true` or `searchSubscriptionName` before persistence and before every
  recovered/run-now round; only hand-created or assistant-confirmed standalone tasks may explicitly
  save or rename a platform subscription.
- A scheduler/assistant may compose existing modes but never broaden them. Boss position/JD sync may
  be scheduled; talent matching, greet, and atomic chat mutations are not. Talent Mapping scheduling
  is limited to card-only scan-stage plans; reject enrichment/all and detail-capable plans before
  queueing.
- Preserve intent IDs in task input/summaries for audit. Platform receipts enforce mutation retry
  idempotency; queue delivery is not assumed exactly once.
- Browser-runtime status endpoints are read-only safe views: no TaskQueue construction, Playwright
  attach, navigation, repair, cookie, absolute profile path, full URL, or page content. Runtime
  failures retain their stable code and are classified as pre-acceptance infrastructure failures;
  queue admission and a status view never prove attach authorization.
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
