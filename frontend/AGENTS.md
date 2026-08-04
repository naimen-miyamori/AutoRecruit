# Frontend Instructions

## Scope and Inheritance

These instructions apply to the React operations console under frontend/. Apply the root AGENTS.md
first. Read src/server/AGENTS.md for every HTTP, task, assistant, or scheduler change and the
owning domain instructions for screens that expose platform, RAG, Boss, or Talent Mapping behavior.

## Ownership and Boundaries

- The frontend owns presentation, local form state, API-client calls, query cache state, navigation,
  loading/error/empty states, and explicit user confirmation affordances.
- The server owns validation, task normalization, queue insertion, scheduling, persistence, and all
  external browser actions. Do not build browser automation, local data-file writes, argv execution,
  alternative task runners, or client-only authorization in the frontend.
- Keep frontend API contracts synchronized with the server read models and task input types. A route
  or response change updates frontend/src/api/contracts.ts, the typed API client, query keys, and
  affected screen tests in the same work item.

## Task and Mutation Safety

- Submit execution through the documented task endpoints and display the resulting TaskQueue state;
  preview text is explanatory and cannot become an execution source of truth.
- Use SafetyDialog or an equally explicit confirmation interaction for contact, forwarding,
  matching, chat, review acceptance/revocation, detail opening, and any other externally meaningful
  or fact-changing mutation. The dialog must show the target identity and irreversible effect, and
  must collect required confirmation, reason, or reviewer fields.
- Read-only operations remain visibly distinguishable from quota-consuming or contact mutations.
  Client-side warnings complement, but never replace, server-side confirmed, identity, scheduling,
  and mode checks.
- Request-scoped model settings are only for assistant drafts and console RAG answers. Never persist,
  log, render in task history, or attach an API key to normal task input or mapping facts.

## Query and Domain Contracts

- Define shared cache keys in frontend/src/api/client.ts. After a successful mutation, invalidate or
  update every affected detail, list, task, and summary query; do not leave a fact view stale after
  review, task completion, or schedule change.
- Pass AbortSignal through read requests where the client supports it, and render explicit loading,
  empty, access/error, and retry states rather than treating a failed request as an empty result.
- Talent Mapping permits 51job, Liepin, Zhilian, or all only; Boss must not be offered. Detail
  opening requires the project's explicit confirmation contract. Classification generation is a
  queued task, and entity/classification acceptance or revocation remains a human-reviewed mutation.
- For normal capture/batch and search subscription, the `all` UI may offer a separate explicit
  `includeBoss` control. It must explain the fourth-stage order; capture/batch must additionally
  explain the detail-open side effect and possible saved-forwarding reuse. Search subscription
  must explain native “我的订阅” selection/save side effects and must not expose Boss independent
  modes as part of that control.
- Boss screening forms expose primary forwarding and the rejected-resume secondary email/CC only.
  The UI must state that `qualified/review` use Boss forwarding while `rejected` never uses Boss
  forwarding and receives one candidate-level email containing the reason and complete resume;
  legacy secondary-forward controls must not be rendered.
- Task details and dashboard health render candidate-level rejection-email counts, recipients/CC
  from the reviewed task input or immutable snapshot, and explicit `sending`/`uncertain`
  manual-verification warnings without
  rendering email body content or SMTP credentials.
- Boss task details render pending-score count and de-identified provider `kind@phase` counts.
  Pending candidates are not review candidates and the UI must state that they received neither
  Boss forwarding nor rejection email; never render their IDs merely to explain a model failure.
- Automation may offer a Talent Mapping schedule only as scan stage. The form must submit the
  card-only-compatible input shape and must not offer enrich or all as scheduled Mapping stages.
- Do not infer candidate identity, link entities, apply classifications, or turn a later absence
  into an employment conclusion in display logic. Render the server's evidence, review state, and
  completeness labels faithfully.

## Verification

- Frontend API contracts, mutation inputs, query invalidation, task forms, and safety dialogs:
  src/scripts/test-frontend-client.ts and npm run test:web.
- Run npm run web:typecheck and npm run web:build while iterating on frontend types or rendering.
- Run npm run typecheck, npm run test, and npm run build when changing shared API contracts,
  TaskQueue presentation, or cross-domain frontend behavior.
