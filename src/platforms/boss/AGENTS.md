# Boss Platform Instructions

## Scope and Inheritance

These instructions apply to Boss search, capture, forwarding, talent discovery, chat, position/JD
sync, and their action/parsing modules under src/platforms/boss/. Apply the root AGENTS.md,
src/platforms/AGENTS.md, src/browser/AGENTS.md, and src/server/AGENTS.md for queued HTTP or
scheduled work.

## Ownership and Boundaries

- Boss is normally selected as platform boss. Ordinary capture, batch, and search subscription may
  opt into it as the fourth `all` stage only with explicit `includeBoss`; Talent Mapping and every
  other Boss independent mode remain outside that loop. Its actions own page controls, selectors, compatibility paths,
  pacing, readiness, identity checks, and business postconditions; Boss adapter/workflow facades
  must not directly operate the page.
- Action modules do not enter TaskQueue, write receipts or job records, call models, or decide
  confirmation. Read actions remain separate from mutation actions. Workflows own confirmation,
  persistence, intent receipts, and mode isolation.

## Session, Capture, and Forwarding

- Reuse the Boss-scoped headed browser, profile, CDP port, and useful authenticated
  search/chat/talent/job-management tab. Do not repeatedly open login, create extra tabs, or
  replace a usable current page.
- Every high-level Boss search (`saved`, `direct`, condition-set apply, and the capture/batch/all
  callers that reuse them) must finish entering and verifying its conditions, then click one
  unique visible/enabled global search control. This click is mandatory even when every condition
  was already satisfied. Keyword input and filter auto-refreshes are preparation only; Enter and
  intermediate search fallbacks must not submit early. Candidate extraction waits for a new
  post-click result cycle (cards or explicit empty state) and fails closed when the cycle is not
  observable; after a click with uncertain outcome the action never clicks again. Preparation,
  discovery, single-condition, reset, and restore actions remain non-submitting.
- Direct search applies the keyword once, after job scope, filters, and viewed policy are stable.
  The unique final search control may be an icon only when it shares the keyword input's nearest
  search-input wrapper; an unrelated global search icon is never a fallback.
- Saved Boss search selects the native “我的订阅” card by typed identity evidence: name, page
  keyword, and hydrated condition identity remain separate fields. Card click is once-only; the
  action polls asynchronous condition hydration, applies runtime `match-priority` and any viewed
  override, then performs the same one final global search submit. Native subscription sort is not
  part of the saved condition fingerprint. Subscription-card enumeration must wait for the native
  subscription region itself to hydrate; an available search iframe with no mounted subscription
  region is not an empty subscription list. When the visible card omits native identity attributes,
  the Boss action may use the card component's platform business data to cross-check the native
  subscription ID, stable job ID/name, keyword, and keyed condition labels, but raw component state
  never leaves the action or enters persistence. Save outcomes are typed; a successful native-name edit
  is recorded as `renamed`, while same-name conflicts, ambiguous cards, hydration failure, and
  uncertain clicks fail closed.
- Native subscription save treats keyword as a separate exact identity field. Existing-card rename
  requires complete hydrated or authoritative condition proof; a no-ID `after - before` delta is
  valid only while every pre-click DOM identity remains continuous. Redraw, replacement, or lost
  continuity is uncertain and never authorizes editing an old card.
- Navigation, clicks, input, keys, forwarding, chat, contact, and candidate transitions use the
  shared paced continuous pointer path. Keyword, direct-chat, and remark typing use the sequential
  typing helper; search/remark replacement clears the prior value, direct chat preserves a
  non-empty draft, and fixed common phrases remain option selections.
- Normal capture reuses the current search page. Boss forwarding mode and recipient appear together
  and only on Boss; they include the stable candidate ID and select exactly one colleague or fill
  one email recipient. Boss exposes no native CC field: an email CC configuration means reopening
  the dialog and independently forwarding to each deduplicated address, with the same candidate ID
  written and verified in every message. CC is valid only for email forwarding. With Boss
  post-score screening disabled, retain the legacy order: forward
  before parsing or seen marking, so a pre-capture failure remains retryable. With enabled
  post-score screening, skip that legacy forwarding hook: parse and persist the exact resume, write
  pending-score/seen, and score from that persisted resume while the same verified detail remains
  open. Model waiting performs no page action. After the model returns, orchestration starts one
  fresh bounded continuation and revalidates the same candidate; the normal path never opens the
  detail a second time. A model/provider/schema failure remains pending, records de-identified phase
  diagnostics, and must not create a routing artifact, forwarding outbox, rejection email, report
  audience, or colleague-communication read. After a successful decision, persist the routing
  decision/outbox. Only `qualified` and `review` may continue in the same detail and forward to the
  primary target. For email forwarding only, first read a boolean indicating whether the verified
  current detail has a colleague communication record; if true, append the simple line
  `同事已沟通` after the candidate ID in every recipient message. Do not read, return, persist, or
  report colleague names, times, or details. A proven `rejected` candidate must never perform that
  read or call the Boss forwarding action; strictly close its one detail first, then create a
  separate candidate-level rejection-email outbox carrying the verified close and send one SMTP
  message containing all missing reasons and the complete structured resume to the configured
  secondary email/CC. Page actions never decide this route or write its facts. Persist a
  pending-score work item before seen so an interruption or scoring failure before the first decision can recover
  only that exact candidate under the same policy. A pending or known pre-confirmation failed forwarding outbox may
  retry in a later run by opening the exact candidate once and must use its stored target deliveries; this recovery
  lifecycle is not a normal-path second open.
  Rejection email recovery uses only its persisted resume/routing facts and never reopens detail.
  Persist the verified `detailClosedAt` before the detail lifecycle returns and start SMTP only
  afterward. A missing close proof never authorizes SMTP but remains visible in the current run;
  recovered outcomes remain reportable even when the candidate is absent or already indexed by a
  historical run.
  Boss page-forwarding primary and copy addresses have separate durable states; sent and uncertain
  confirmations are never auto-retried, and a failed copy must not repeat a successful primary
  delivery. A rejection email's TO and CC addresses instead form one SMTP delivery and share one
  state. Execute each rejection delivery under an atomic cross-process lock, re-read its outbox
  entry inside that lock, and cap it at two actual SMTP calls. Only `EDNS + CONN` proves a safe
  immediate retry; AUTH and MAIL may retain one deferred attempt. Treat ETIMEDOUT, ESOCKET,
  ECONNECTION, every other CONN, RCPT, DATA, resolved partial-recipient results, unknown phases,
  and inherited `sending` as `uncertain`, because Nodemailer may label a post-DATA socket failure
  as CONN. Never infer retry safety from error text. A policy-version migration may mark unfinished
  old-policy deliveries as `superseded`; that terminal state is never retried. Explicit
  normal-capture forwarding and screening settings persist only on that Boss job record; they must
  not rewrite the auto-chat platform default. Only explicit auto-chat input may update the latter.
- HTTP, assistant, batch, and scheduler capture tasks use the server-created Boss settings v3/task v4 snapshot:
  stable identity, complete search plan, immutable delivery targets, screening policy, and source
  configuration revision. Explicit patches use JobStore CAS before browser work; a revision
  conflict fails closed. RunResult routing facts own report recipients and CC, so manual replay
  cannot be retargeted by later job edits.
- Explicit `searchSource=saved` is a source selection, not permission to discard its dependent
  identity: when the same authoritative JobRecord is currently saved, the capture-plan resolver
  may reuse and revalidate its complete native saved-search reference. A direct JobRecord's stale
  residual reference is never reused; missing or mismatched identity remains `saved-reference-required`
  or `saved-reference-invalid` before the browser.
- Every ordinary Boss capture run truncates the extracted result order to the first 20 resumes
  before seen, recovery, detail, scoring, forwarding, or persistence work. Seen candidates inside
  that window do not backfill from position 21 onward. For each stable ID in that bounded window
  already present in the validated current-job `seen-ids.json`, ordinary capture performs exactly
  one read-only detail open/identity-check/close lifecycle unless an outbox-retry or pending-score lifecycle
  already covers it. A newly decided qualified/review candidate continues its original detail
  lifecycle for forwarding; only a later retryable outbox recovery may open that exact candidate in
  a separate forwarding lifecycle. That recovery is not a history-view action. History view never
  parses, scores, forwards, contacts, or writes history, and a failed close stops later card
  operations. Boss standalone modes and other platforms do not inherit this cap or view-sync
  contract.
- A candidate enters captured history only after the current detail identity is verified, the parsed
  resume ID matches the requested card, and the resume file is written and read back successfully.
  RunResult v2 records `capturedCandidateIds` and stage-specific retryable failures; legacy v1
  `newCandidateIds` remain read-only attempt history and are never inferred to be captured.
- Boss search details support both the legacy `/web/frame/c-resume/` canvas and the current parent-
  page `.dialog-lib-resume` Vue detail. Native readiness and parsing use the currently hydrated
  `resumeInfo.expectId` and resume fields from that exact detail instance; parent-page performance
  history is not identity evidence because it may refer to an earlier candidate. A native detail's
  own “搜索畅聊卡” footer never classifies the detail as a purchase dialog.
- Opening or confirming forwarding must move the shared pointer and then use a freshly resolved
  native locator click, never a stale coordinate that can land on `联系Ta`. Detect a visible search-
  chat-card purchase dialog before and after opening forwarding, close its unique safe close control,
  and fail before confirmation if it appeared instead of the forwarding dialog. A purchase dialog
  exposed by a detail click is the same fatal page-safety condition: cleanup is allowed, but the
  current run must stop rather than continue to another card. `sent` requires a dispatched confirm
  click plus a new visible Boss success indication; a known pre-confirmation failure is retryable,
  while a dispatched click without success evidence is `uncertain` and is never auto-retried.
- In the current native detail, the forwarding action is the unique
  `.share[aria-label="转发牛人"]` at the right edge of the 收藏/不合适/举报/转发行; verify that
  structure again immediately before clicking. The current no-close forwarding dialog is dismissed
  only through a unique uncovered layer point with a verified postcondition. Never use Escape for
  that cleanup: it can close the underlying resume while leaving the forwarding dialog visible.
- Each normal Boss screening detail starts with one bounded page-action segment for open, identity,
  parsing, and persistence. Model evaluation may then wait outside page actions while that same
  verified detail remains open; after the model returns, the workflow creates one fresh bounded
  continuation, revalidates the same candidate, and performs communication detection, qualified/
  review forwarding, or strict close in that original detail. The normal path never opens a second
  detail. A later retryable outbox recovery may open the exact candidate once in its own bounded
  lifecycle; rejection-email recovery never opens detail. Actions reserve cleanup time before
  spending user-like pace, recompute remaining timeout after pacing, and revalidate the exact
  candidate/control again after pointer movement immediately before dispatch. Actions must not
  extend their caller deadline; unfinished deliveries remain pending/retryable while strict close
  owns the reserved budget.

## Talent Discovery and Atomic Conversations

- Recommendation and native deep search are standalone and read-only by default. They do not enter
  normal capture, batch, search subscription, auto-chat, or opt-in all-platform capture. Candidate
  execution uses stable Boss IDs, never name or visual card order.
- Deep-search requirement synchronization distinguishes core and bonus requirements, verifies the
  resulting form, and requires at least one core item, remaining quota, enabled match control, and
  explicit confirmation before matching. Reading form/cards never consumes quota, and a match
  returns at most the latest twenty candidates.
- A single greet requires exact candidate ID, expected candidate and job identity, revalidation
  immediately before mutation, and available Boss job ID. Existing continue-chat is already
  contacted, not a new greet.
- Conversation reads and mutations are separate. Every mutation targets an exact conversation ID,
  revalidates hydrated identities when supplied, requires confirmed true plus a non-empty intent
  ID, and persists/reuses a successful receipt. A reused intent for another operation or
  conversation fails.
- Never overwrite an existing draft. Generic text, remark, not-fit, attachment-resume, phone, and
  WeChat actions need one unambiguous visible control, pacing, required dialog confirmation, and
  verified postcondition. Atomic chat mutations are never schedulable.

## Position Sync and Auto-chat

- Position/JD sync reads open, pending, and closed positions. Stable Boss job ID is the identity:
  same-name positions never merge, hydration matches both expected ID/name, and closed positions
  remain available for unread-conversation context.
- Hash normalized JD before parsing. An unchanged hash neither reparses nor rewrites jd.json; a
  changed JD parses before save, and a parse/detail failure cannot replace the last valid record.
  Preserve prior creation, forwarding, delivery, and search settings on success. Persist snapshots
  and timestamped runs while normal Boss job records remain the authoritative JD copy.
- Auto-chat resolves by Boss job ID first; name fallback requires one unambiguous stored job.
  Optional pre-review sync defaults off and aborts review if a requested position fails. Boss
  auto-chat is standalone; only position/JD sync is schedulable.
- Automation settings have the documented Boss-local scope and precedence. Chat-summary delivery is
  separate from ordinary report delivery; replying to unmatched candidates stays disabled unless the
  explicit run flag enables the fixed rejection phrase.

## Conversation Review and Strict Matching

- Snapshot all unread/red-dot conversations before opening any. Hydrate current conversation,
  candidate summary, and messages before branching. A current red dot is always processable;
  reviewed IDs suppress only failed recovery with no new red dot.
- Previously chatted conversations use the documented evidence priority, persist the last unread
  candidate-authored messages with typed non-text placeholders, record follow_up_reply, and stop.
  They do not open resumes, read/evaluate JD, score, forward, send phrases, or request phone.
  Missing first-contact JD/forwarding and unreliable message extraction remain retryable failures.
- The property-electrician strict rule applies only to its configured role. It requires explicit
  evidence for every criterion; current/expected Shanghai is not native-place evidence, and missing
  evidence never authorizes inference. The narrow Shanghai-school clarification path asks only the
  fixed question, records awaiting_clarification, and performs no forward/reject/contact/review
  completion. It preserves any draft.
- Resume reading uses the validated native action and hydrated target identity; never persist raw
  decrypted payload. Qualified and enabled-unqualified phrases use the fixed common-phrase path.
  Preserve the documented matched and unmatched operation order, idempotent contact behavior, and
  post-forward failure state: a failed contact retains forwarded true and is never auto-forwarded
  again, while pre-forward failures remain recoverable.

## Verification

- Action context and ownership: src/scripts/test-boss-action-context.ts and
  src/scripts/test-boss-action-boundaries.ts.
- Chat, conversation, talent, atomic operation, sync, and CLI isolation:
  src/scripts/test-boss-chat.ts, src/scripts/test-boss-conversation-actions.ts,
  src/scripts/test-boss-talent.ts, src/scripts/test-boss-chat-operations.ts,
  src/scripts/test-boss-job-sync.ts, and src/scripts/test-boss-cli-modes.ts.
- Queue, API, scheduler, and cross-platform boundaries: src/scripts/test-server-api.ts,
  src/scripts/test-task-scheduler.ts, and src/scripts/test-platform-action-boundaries.ts.
