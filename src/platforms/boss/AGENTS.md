# Boss Platform Instructions

## Scope and Inheritance

These instructions apply to Boss search, capture, forwarding, talent discovery, chat, position/JD
sync, and their action/parsing modules under src/platforms/boss/. Apply the root AGENTS.md,
src/platforms/AGENTS.md, src/browser/AGENTS.md, and src/server/AGENTS.md for queued HTTP or
scheduled work.

## Ownership and Boundaries

- Boss is normally selected as platform boss. Ordinary capture and batch may opt into it as the
  fourth `all` stage only with explicit `includeBoss`; Talent Mapping and every Boss independent
  mode remain outside that loop. Its actions own page controls, selectors, compatibility paths,
  pacing, readiness, identity checks, and business postconditions; Boss adapter/workflow facades
  must not directly operate the page.
- Action modules do not enter TaskQueue, write receipts or job records, call models, or decide
  confirmation. Read actions remain separate from mutation actions. Workflows own confirmation,
  persistence, intent receipts, and mode isolation.

## Session, Capture, and Forwarding

- Reuse the Boss-scoped headed browser, profile, CDP port, and useful authenticated
  search/chat/talent/job-management tab. Do not repeatedly open login, create extra tabs, or
  replace a usable current page.
- Navigation, clicks, input, keys, forwarding, chat, contact, and candidate transitions use the
  shared paced continuous pointer path. Keyword, direct-chat, and remark typing use the sequential
  typing helper; search/remark replacement clears the prior value, direct chat preserves a
  non-empty draft, and fixed common phrases remain option selections.
- Normal capture reuses the current search page. Boss forwarding mode and recipient appear together
  and only on Boss; they include the stable candidate ID and select exactly one colleague or fill
  the email recipient. Forward before parsing or seen marking; a pre-capture failure remains
  retryable.

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
