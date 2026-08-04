# AGENTS.md

Repository-wide guidance for coding agents working on Auto Recruit.

## Scope, Inheritance, and Routing

This repository is a TypeScript CLI and local operations console for recruitment automation. The core
production browser platforms are 51job, Liepin, and Zhilian. Boss is a single-platform extension
for search/capture, talent discovery, configured forwarding, atomic chat operations, unread-chat
review, and position/JD synchronization.

Apply this root document to every change. A scoped AGENTS.md on the changed path adds and clarifies
constraints; it must not silently weaken a root safety or public-product contract. Cross-domain
changes read every affected scoped document. If two rules genuinely conflict, stop and resolve the
exception in their closest common parent before implementation; do not choose one by omission.

Keep ownership boundaries intact:

- Platform-specific behavior belongs under src/platforms/.
- Shared orchestration belongs in src/index.ts.
- Shared browser/session helpers belong in src/browser/.
- Ordinary job persistence belongs in src/storage/. A domain with an independent lifecycle and
  authoritative fact model may own its local store, such as Talent Mapping or RAG.
- RAG behavior belongs in src/rag/.
- HTTP, assistant, queue, and scheduler behavior belongs in src/server/.
- React console presentation belongs in frontend/.

More specific instructions are routed as follows:

| Scope | Instructions |
| --- | --- |
| Cross-platform adapters and semantic actions | src/platforms/AGENTS.md |
| 51job-specific actions | src/platforms/51job/AGENTS.md |
| Liepin-specific actions, forwarding, and filters | src/platforms/liepin/AGENTS.md |
| Zhilian-specific actions, delivery, and filters | src/platforms/zhilian/AGENTS.md |
| Boss search, chat, talent, and job sync | src/platforms/boss/AGENTS.md |
| Browser sessions, deadlines, pacing, pointer, and parser primitives | src/browser/AGENTS.md |
| Talent Mapping plans, runs, reviews, changes, and exports | src/talent-mapping/AGENTS.md |
| RAG facts, retrieval, answers, and quality loops | src/rag/AGENTS.md |
| Console assistant, HTTP routes, queue, and scheduler | src/server/AGENTS.md |
| React operations console | frontend/AGENTS.md |

Changes in src/index.ts, src/config.ts, src/search/, src/scripts/, src/scoring/, src/reporting/, or
tests that alter a domain must also consult that domain's scoped instructions.

README.md and 项目说明文档.md are the user-facing usage and architecture references. Avoid
duplicating volatile command catalogs, selector inventories, filter field counts, or persistence
listings in them or in AGENTS.md; code, schemas, fixtures, and regression tests are the facts for
those details.

## Long-Term Project Memory

项目说明文档.md is the durable current-state memory for product, architecture, data semantics,
design rationale, operational boundaries, and known limitations. Code, schemas, and tests remain
the behavioral source of truth; Git history records how the project changed.

Any change that alters a public mode, platform boundary, workflow, API, queue/scheduling behavior,
persistence contract, failure semantics, runtime requirement, major frontend entry, or core module
ownership updates 项目说明文档.md in the same work item. User-facing setup or command changes also
update README.md. Hard coding constraints belong in this root document or the relevant scoped
AGENTS.md.

Keep long-term memory current rather than diary-like. Replace stale statements and paths; record
important reasons and boundaries; omit secrets, candidate data, transient task status, debugging
logs, selector inventories, and unimplemented plans. Before finishing a qualifying change,
reconcile documentation with implementation, schemas, package.json, .env.example, and regression
tests.

## Planning Document Placement

All new implementation, design, remediation, and rollout plans belong in the local docs/plan/
archive. Do not create plan documents in the repository root, src/, or another documentation
directory. Create a new plan with:

    rtk npm run plan:new -- --topic <kebab-case-topic> --title <title>

Validate local placement and metadata with rtk npm run plan:check.

- New files use YYYY-MM-DD-<kebab-case-topic>-plan.md and state status, last-updated date, and Git
  submission policy at the top.
- docs/plan/README.md is the local index; the creation command adds each new plan to it.
- docs/ remains ignored by Git, so plans, the local index, and the local template are not staged or
  committed by default. If that policy changes, redesign .gitignore and this section together;
  never mix tracked and untracked plan conventions ad hoc.
- A completed plan records decisions and acceptance evidence only. Update README.md and
  项目说明文档.md with stable current behavior; neither document is a plan archive.
- Existing historical names in docs/plan/ are grandfathered. Every new plan passes the current
  naming and metadata checks.

## Semantic Action Module Design Standard

Semantic action modules are the repository-wide standard for browser automation and future external
interactive integrations. The reusable unit is one complete business intent, such as selecting a
saved search, applying a verified filter, opening an exact candidate, forwarding a resume, or
sending a confirmed message.

- Adapters/workflows choose actions, order them, enforce confirmation/identity rules, and own
  persistence; they do not implement user-visible controls.
- A platform action owns selectors, compatibility fallbacks, pacing, readiness, and postcondition
  for one business intent. Callers pass typed business inputs, never DOM mechanics.
- Every mutation validates target and preconditions immediately before acting, preserves the
  caller's bounded deadline, follows pacing/continuous-pointer rules, and verifies result state.
  Idempotent state is explicit rather than blindly retried.
- Read actions, mutation actions, and pure parsers remain distinct. Page actions do not write job
  records, queue state, receipts, reports, or call models; workflows do not bypass actions.
- Shared browser helpers are selector-free and platform-neutral. Promote only after two platforms
  prove equivalent inputs, outputs, and failure semantics.
- A domain file that only re-exports a multi-domain runtime is not a completed boundary. Private
  compatibility runtimes are narrow low-level fallbacks, never normal owners of multiple domains.
- Changed UI automation includes direct action and architecture-boundary tests in addition to
  workflow regression. Do not expand documented migration debt or claim full compliance before it
  is actually removed.

Detailed action contracts and platform ownership live in src/platforms/AGENTS.md.

## Public Platform Contract

Plain `platform all` is public CLI behavior. It runs sequentially in this exact order:

1. 51job
2. Liepin
3. Zhilian

If one platform fails, stop immediately and propagate the error. Normal capture and batch may opt
into Boss/直猎邦 as a fourth stage only with `--platform all --include-boss true`; its order is:

1. 51job
2. Liepin
3. Zhilian
4. Boss

`listSupportedPlatforms()` remains the core three-platform list for modes whose `all` contract has
not expanded. Use purpose-specific platform selection for normal capture/batch and search
subscription; both require explicit `includeBoss=true` to add Boss. Do not implicitly add Boss to
JD/RAG questions, filter discovery, Talent Mapping, or Boss independent modes.

For an all-platform jobs-file run, jobs-file order is the outer loop and the selected platform order
above is the inner loop. Existing schedules and tasks without `includeBoss` remain core-only.

## CLI and Mode Isolation

### Job Input and Reuse

- A new job key requires jd or jd-file. A rerun reuses persisted jd.json and does not reparse
  unchanged JD text.
- Job-scoped reusable inputs share data/<platform>/jobs/<jobKey>/jd.json: JD, report delivery,
  search source, normalized direct-search conditions, original application-filter input, and Boss
  forwarding settings.
- Explicit CLI values replace saved canonical values; omitted values reuse them. Do not append
  duplicate history or rewrite an unchanged job record.

### Standalone Modes

- User-facing terminology is stable: ordinary capture with `search-source saved` is “订阅搜索”,
  ordinary capture with `search-source direct` is “直接搜索”, and the standalone
  `search-subscription` mode is “订阅管理”. Keep internal enum values, CLI flags, schemas, and
  persisted `saved|direct` values unchanged.
- jd-question and rag-question are aliases and standalone. They do not open a browser, capture or
  score resumes, export reports, or send email.
- A stored-job question uses persisted RAG without JD reparsing. A temporary JD question uses only
  that JD and creates no job record, persistent RAG index, or production answer log.
- Search subscription is standalone. It does not parse JD, create jobs, capture/score resumes,
  export, send email, or alter seen state. Plain `platform all` remains core-only; explicit
  `platform all + includeBoss=true` adds Boss native subscription selection/save as the fourth
  stage without authorizing any other Boss mode.
- Boss auto-chat, talent discovery, greet, atomic chat operations, and position/JD sync are
  standalone Boss-only modes. Reads default to read-only; match, greet, chat, and contact mutations
  require explicit confirmation. Only position/JD sync is schedulable.
- Talent Mapping is isolated market research, not normal capture: it supports only 51job, Liepin,
  and Zhilian; it does not write ordinary job/seen/score/report/email/RAG state. See
  src/talent-mapping/AGENTS.md for run and review contracts.

### Batch and Normal Capture

- Batch mode uses jobs-file as its only job-definition source. Reject combinations with single-job
  keyword, jd, or jd-file.
- Run-level include-viewed, report delivery, search source, filter-input file, and valid
  Liepin-forwarding remain allowed. Job-level search/filter values override CLI defaults; relative
  filter paths resolve from the jobs-file directory.
- search-source saved|direct is only for normal capture. New jobs default to saved; omitted rerun
  values reuse persisted settings.
- include-boss is valid for normal capture, batch, or search subscription with platform all. It
  defaults false; when true for capture, Boss uses the ordinary capture chain and may reuse the
  Boss job's saved forwarding setting. When true for search subscription, Boss is limited to
  native subscription search/save. It never authorizes Boss talent matching, greetings, chat
  operations, forwarding, candidate capture, or position sync.
- application-filter-input-file requires explicit direct search in normal capture. Build conditions
  from the saved application-filter catalog, persist normalized conditions and original input, and
  fail the run if any requested condition is skipped or fails.
- include-viewed defaults false, is normal-capture-only, and is invalid in search subscription.

## Persistence and Run Semantics

- Local job data is platform-scoped under data/<platform>/jobs/<jobKey>/; never reuse a job record
  across platforms solely because a keyword matches.
- Explicit empty results are successful zero-candidate runs, not extraction failures.
- Only successfully captured resumes become seen. Detail-open, forwarding, or extraction failures
  stay retryable. Mark successful captures seen before scoring.
- A scoring failure persists a failed score artifact and does not undo seen state. Latest results
  remain lightweight: platform, counts, and candidate IDs rather than full card payloads.
- Exported markdown and email visibly identify source platform. Platform delivery, Boss chat
  persistence, mapping-local persistence, and review artifacts have additional scoped rules.
- Boss position records use stable ID as well as name. Unchanged JD hash never reparses/rewrites;
  a parse failure never replaces the last valid JD. Boss chat mutations use intent IDs and durable
  receipts so retry returns existing result instead of repeating external action.
- Local JSON/JSONL is the source of truth for persisted product data. Rebuildable external indexes
  never become the sole copy.

## Browser, Pacing, and Deadline Contracts

- Use platform-scoped Playwright storage state. Headed runs may refresh expired sessions through
  manual login; headless runs fail with actionable instructions.
- Reuse the platform-scoped headed browser and authenticated tab where supported; avoid repeated
  login tabs and replacing a usable current page.
- A search has one deadline from entry through extraction. Detail opens have one bounded deadline
  and race valid platform readiness paths inside it. Pacing is intentional user-like delay, not an
  unbudgeted wait that consumes readiness time.
- Action and candidate pacing defaults to 2000–4000ms with a weighted 2000–3000ms majority.
  Navigation, clicks, input, keys, forwarding, and candidate transitions use shared pacing;
  detailed platform typing and post-detail dwell rules live in scoped platform documents.
- Pointer-driven actions preserve one continuous path across operations and pages. Compatibility
  locator/DOM clicks move the shared pointer first; never teleport or reset it.

See src/browser/AGENTS.md and the matching platform document before changing these flows.

## RAG and Console Safety

- RAG local JSONL facts are authoritative; Qdrant is rebuildable. Retrieval preserves
  platform/job isolation and only verified recruiter facts become answer facts.
- No trusted source or insufficient confidence produces explicit no-answer, not model speculation.
  Offline eval/regression does not append production answer logs.
- rag:api is internal, not a complete auth gateway.
- The console assistant produces structured drafts only. It rejects arbitrary shell, script, and
  file-write requests and never executes model-suggested commands.
- Request-scoped console model settings affect assistant drafts and console RAG answers only.
  Never persist/log API keys, include them in model input, or let them alter confirmed execution.
- assistant confirmation reuses normalizers and TaskQueue; preview argv is not execution authority.
  HTTP and assistant-confirmed Boss work enters TaskQueue; risk acceptance does not replace
  mode-specific confirmation and identity checks.

See src/rag/AGENTS.md and src/server/AGENTS.md before changing those flows.

## Runtime

- Use Node 24 LTS by default. .nvmrc is 24 and package.json supports >=24 <27.
- Node 26 support uses scripts/node-ts-hooks.mjs; runtime scripts do not rely on tsx.
- Prefix repository shell commands with rtk.
- Environment variables load through dotenv in src/config.ts. Operational environment references,
  commands, and deployment setup belong in README.md and 项目说明文档.md.

## Verification Matrix

Run verification in proportion to the change. The critical mappings are:

| Contract | Primary tests |
| --- | --- |
| CLI modes, persistence, seen/scoring semantics | src/scripts/test-scoring-run-semantics.ts |
| Platform registry, default pacing, reuse defaults | src/scripts/test-platform-registry.ts |
| Semantic page-action ownership and facade boundaries | src/scripts/test-platform-action-boundaries.ts and matching direct action tests |
| Boss normal capture/search, chat, talent, operations, and position sync | src/scripts/test-boss-search-actions.ts and matching src/scripts/test-boss-*.ts tests |
| Liepin/Zhilian adapter and filter behavior | src/scripts/test-liepin-adapter.ts and src/scripts/test-zhilian-adapter.ts |
| Search subscription | src/scripts/test-search-subscription.ts |
| Talent Mapping workflow, quality, and server behavior | src/scripts/test-talent-mapping-*.ts |
| RAG behavior | matching src/scripts/test-rag-*.ts tests |
| HTTP, assistant, and scheduler behavior | src/scripts/test-server-api.ts and src/scripts/test-task-scheduler.ts |
| Frontend contracts and safety UI | src/scripts/test-frontend-client.ts |
| AGENTS routing and structure | src/scripts/test-agent-instructions.ts and npm run agents:check |

Baseline commands:

- rtk npm run typecheck
- rtk npm run test
- rtk npm run build

Use focused Node tests during iteration, then expand verification according to risk.

## Data and Reporting Safety

- Do not commit .env, browser storage-state files, candidate data, generated reports, or data/.
- Migration never overwrites an existing platform target job directory.
- DOCX export is offline maintenance, not normal capture/scoring/email orchestration.
- Candidate photos come only from that candidate's confirmed detail-page avatar evidence. Never use
  default avatars, logos, school images, SVG assets, similar-candidate photos, or template samples.
  Omit the photo when identity is uncertain.
- Preserve original resume text where possible. Do not invent records by splitting same-company
  multi-role histories without page evidence.
