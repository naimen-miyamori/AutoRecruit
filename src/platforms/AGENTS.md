# Platform Adapter Instructions

## Scope and Inheritance

These instructions apply to all platform adapters and semantic page actions under src/platforms/.
Apply the root AGENTS.md first, then the matching platform document:

| Platform scope | Instructions |
| --- | --- |
| 51job actions and adapter behavior | src/platforms/51job/AGENTS.md |
| Liepin actions, forwarding, and filters | src/platforms/liepin/AGENTS.md |
| Zhilian actions, delivery, and filters | src/platforms/zhilian/AGENTS.md |
| Boss search, chat, talent, and job sync | src/platforms/boss/AGENTS.md |

Read src/browser/AGENTS.md whenever changing shared session, deadline, pacing, pointer, or parser
primitives. Platform documents add constraints; they do not relax root safety or public-platform
contracts.

## Ownership and Boundaries

- Platform code owns platform selectors, page behavior, filter replay, candidate extraction, detail
  parsing integration, compatibility fallbacks, pacing, readiness, and semantic actions.
- Public dispatch and shared cross-platform selection belong in src/index.ts, stable business-mode
  orchestration in src/mode-runners/, platform-neutral browser primitives in src/browser/, and
  persistence, confirmation, queueing, and mode selection in their owning workflows/domains.
- Boss keeps one platform key and adapter. Normal capture/batch and search subscription may opt into
  it as the fourth stage only through their explicit `all + includeBoss` selection; plain `all`
  registries, questions, filter discovery, and Talent Mapping remain three-platform.
- Search entry and extraction consume the caller's shared search deadline. Detail opening uses a
  bounded action segment: popup/current-page/content races are platform-owned, and modal platforms
  use modal readiness without resetting that segment. Boss enabled screening may keep the verified
  detail open during a non-browser model wait, then use one fresh bounded continuation on that same
  detail; the normal path must not open it a second time.
- A stable or explicit empty result is a successful zero-candidate result. In direct capture, every
  requested condition must be applied and confirmed; skipped or failed conditions abort before
  candidate extraction.

## Semantic Page Actions

- The four adapters are registration and compatibility facades. Keep user-visible page controls out
  of 51job-adapter.ts, liepin-adapter.ts, zhilian-adapter.ts, and boss-adapter.ts; delegate to the
  matching platform actions directory.
- Expose actions by typed business intent: navigation, saved/direct search, filters, candidates,
  resume detail, forwarding/delivery, conversations, talent, or jobs. Do not expose arbitrary
  selectors, generic text clicks, raw handles, caller callbacks, or one public action per DOM node.
- Selectors, DOM/native compatibility, readiness checks, pacing, pointer movement, and
  action-specific fallbacks remain private to their concrete platform action. A private compatibility
  runtime may be narrow and low-level; it cannot be the normal owner of multiple public domains.
- Adapters, workflows, scripts, and tests import typed domain actions, never a private page-action
  runtime. A domain action file implements its public action rather than only re-exporting a
  multi-domain runtime.
- Platform-owned pure resume conversion belongs in its platform parsing directory and stays
  deterministic: no clicks, navigation, local writes, TaskQueue access, or model calls. The
  heuristic 51job text parser is the documented browser exception.
- Page actions validate page state and candidate identity but do not write job records, receipts,
  reports, or queue state. Workflows compose actions, enforce mode/confirmation rules, and persist
  results. Read actions do not import mutation/forwarding/delivery actions.
- The shared platform-action context contains selector-free page/deadline bookkeeping only. Do not
  move platform controls, modal/popup differences, post-action verification, or platform pacing
  into shared browser modules.

## Required Action Contract

Every public page action must:

1. use a verb phrase that states the business result, not a UI mechanism;
2. accept typed business values and stable target identity, never arbitrary DOM inputs;
3. revalidate page, target identity, uniqueness, and preconditions immediately before acting;
4. consume the caller's existing bounded deadline without unbounded retries or deadline resets;
5. perform required platform pacing, typing, and continuous-pointer behavior, including
   native/forced/DOM compatibility paths;
6. verify a business postcondition and represent already-satisfied idempotent state explicitly;
7. return only the typed business result required for composition, with retry-preserving failures.

## Composition and Completion

- Group actions by business domain, not DOM controls or whole workflows. Keep selectors and
  compatibility paths in one owning domain implementation.
- Workflows may combine actions, request confirmation, persist results, and enter TaskQueue; page
  actions may operate and validate the page but do not take those responsibilities.
- A workflow may start a new bounded page-action segment after an explicitly non-browser wait only
  where the root contract authorizes it. Boss enabled screening uses this to retain the same verified
  detail during model work, then revalidates it inside one bounded continuation; an action itself
  never extends or resets its caller-provided deadline.
- A migration completes only when facade/private-runtime imports and selector leakage fail the
  boundary tests; direct actions cover success, missing/ambiguous/stale identity, idempotency,
  deadline exhaustion, postcondition failure, and compatibility pointer behavior where relevant;
  and the resulting architecture is reflected in 项目说明文档.md.

## Verification

- Cross-platform facade/action ownership: src/scripts/test-platform-action-boundaries.ts and the
  matching direct action tests.
- Registry/defaults and capture semantics: src/scripts/test-platform-registry.ts and
  src/scripts/test-scoring-run-semantics.ts.
- Use the matching platform document for focused adapter, filter, Boss, delivery, or action tests.
- After shared action contracts change, run npm run typecheck, npm run test, npm run build, and
  git diff --check.
