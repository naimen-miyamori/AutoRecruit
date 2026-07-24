# AGENTS.md

Repository-wide guidance for coding agents working on Auto Recruit.

## Scope and Routing

This repository is a TypeScript CLI and local operations console for recruitment automation.
The core production browser platforms are `51job`, `liepin`, and `zhilian`. Boss (`boss`) is a
single-platform extension for search/capture, talent discovery, configured forwarding, atomic chat
operations, unread-chat review, and position/JD synchronization.

Keep ownership boundaries intact:

- Platform-specific behavior belongs under `src/platforms/`.
- Shared orchestration belongs in `src/index.ts`.
- Shared browser/session helpers belong under `src/browser/`.
- Storage behavior belongs under `src/storage/`.
- RAG behavior belongs under `src/rag/`.
- HTTP, assistant, queue, and scheduler behavior belongs under `src/server/`.

More specific instructions exist in these directories:

| Scope | Instructions |
| --- | --- |
| Platform adapters and Boss chat | `src/platforms/AGENTS.md` |
| Browser sessions, pacing, deadlines, and resume parsing | `src/browser/AGENTS.md` |
| RAG storage, retrieval, answers, and quality loops | `src/rag/AGENTS.md` |
| Console assistant, HTTP routes, queue, and scheduler | `src/server/AGENTS.md` |

Changes in `src/index.ts`, `src/config.ts`, `src/search/`, `src/scripts/`, `src/scoring/`,
`src/reporting/`, tests, or the frontend that alter one of those domains must also consult the
corresponding scoped instructions.

`README.md` and `项目说明文档.md` are the user-facing usage and architecture references. Avoid
duplicating volatile command catalogs, selector inventories, or persistence listings here.

## Public Platform Contract

`--platform all` is public CLI behavior. It must run sequentially in this exact order:

1. `51job`
2. `liepin`
3. `zhilian`

If one platform fails, stop immediately and propagate the error. Boss must run only through
`--platform boss`; do not add it to `listSupportedPlatforms()`, `--platform all`, or the inner loop
of `--platform all --jobs-file` unless that public contract is explicitly redesigned.

For `--platform all --jobs-file`, jobs-file order is the outer loop and the platform order above is
the inner loop.

## CLI and Mode Isolation

### Job input and reuse

- A new job key requires `--jd` or `--jd-file`. A rerun reuses persisted `jd.json` and must not
  reparse JD text unnecessarily.
- Job-scoped reusable inputs share `data/<platform>/jobs/<jobKey>/jd.json`: JD, report delivery,
  search source, normalized direct-search conditions, original application-filter input, and Boss
  forwarding settings.
- Explicit CLI values replace saved canonical values; omitted values reuse them. Do not append
  duplicate history or rewrite an unchanged job record.

### Standalone modes

- `--jd-question` and `--rag-question` are aliases and standalone. They must not open a browser,
  capture or score resumes, export reports, or send email.
- A stored-job question uses persisted RAG without reparsing JD. A temporary `--jd` or `--jd-file`
  question uses only that JD and must not create job records, persistent RAG indexes, or production
  `answer-logs.jsonl` entries.
- Search-subscription mode (`--search-subscription-file`) is standalone. It must not parse JD,
  create job records, capture or score resumes, export reports, send email, or alter seen state.
- Boss auto-chat is standalone and must preserve the platform and flag isolation defined in
  `src/platforms/AGENTS.md`.
- Boss talent discovery, single-candidate greet, atomic chat operations, and position/JD sync are
  standalone and require `--platform boss`. Recommendation and deep-search reads default to
  read-only; immediate match, greet, and chat mutations require explicit confirmation.
- Of the new Boss modes, only position/JD sync is schedulable. Do not schedule quota-consuming
  matching, candidate contact, or arbitrary chat mutations.

### Batch and normal capture

- Batch mode uses `--jobs-file` as its only job-definition source. Reject combinations with
  single-job `--keyword`, `--jd`, or `--jd-file`.
- Run-level switches such as `--include-viewed`, report delivery, search source, filter-input file,
  and valid Liepin forwarding remain allowed. Job-level search/filter values override CLI defaults;
  relative filter paths resolve from the jobs-file directory.
- `--search-source saved|direct` is only for normal capture. A new job defaults to `saved`; an
  omitted value on rerun reuses persisted settings.
- `--application-filter-input-file` is valid only with explicit `--search-source direct` in normal
  capture. Build conditions from
  `data/<platform>/filter-catalog/application-filter-options.latest.json`, then persist normalized
  conditions and original input. A skipped or failed requested condition is a run error; never
  capture from a partially applied direct-filter set.
- `--include-viewed` defaults to `false`, is only for normal capture, and remains invalid in
  search-subscription mode.

## Persistence and Run Semantics

- Local job data is platform-scoped under `data/<platform>/jobs/<jobKey>/`; never reuse a job
  record across platforms solely because the keyword matches.
- Explicit empty-result states are successful zero-candidate runs, not extraction failures.
- Only successfully captured resumes are marked seen. Detail-open, forwarding, or extraction
  failures remain retryable.
- Mark successful captures as seen before scoring.
- A scoring failure persists a `status: failed` score artifact and must not undo seen state.
- Latest run results stay lightweight: platform, counts, and candidate-ID lists rather than full
  card payloads.
- Exported markdown and email bodies must visibly identify the source platform.
- Zhilian delivery and Boss chat-review persistence have additional platform rules in
  `src/platforms/AGENTS.md`.
- Boss-synced job records are keyed by stable Boss position ID as well as name. Same-name positions
  with different IDs must never merge. An unchanged JD hash must not trigger reparsing or a job
  record rewrite, and a parse failure must not replace the last valid JD.
- Boss chat mutations use an explicit intent ID and persist a receipt. Retrying the same intent must
  return the existing result rather than repeat the external action.
- Local JSON/JSONL files are the source of truth for persisted product data. Rebuildable external
  indexes must never become the only copy.

## Browser, Pacing, and Deadline Contracts

- Use platform-scoped Playwright storage state. Leave `STORAGE_STATE_PATH` unset for normal
  multi-platform runs.
- Headed runs may refresh an expired session through manual login; headless runs must fail with
  actionable instructions.
- Reuse the platform-scoped headed browser and existing authenticated tab whenever supported.
  Do not create repeated login tabs or replace a usable current page.
- A normal search uses one deadline from search entry through candidate extraction. A detail open
  uses one bounded detail deadline and races popup/current-page/modal readiness within it.
- Pacing waits are intentional user-like action delays. Do not add unbudgeted waits that silently
  exhaust a shared readiness deadline. Multi-action flows must give pacing and page readiness a
  realistic bounded budget, or use bounded per-phase deadlines.
- Liepin action, successful detail-close, and candidate-transition pacing defaults to randomized
  `2000-3000ms`.
- Boss action and candidate pacing defaults to `2000-4000ms`, weighted approximately 80% in
  `2000-3000ms` and 20% in `3001-4000ms`. Navigation, clicks, inputs, key presses, forwarding, and
  candidate transitions must use shared pacing helpers; do not introduce an unpaced Boss action.
- Boss search keywords, direct chat text, and remarks use shared grapheme-by-grapheme typing with
  randomized `80-180ms` character delays and punctuation pauses. Keep common phrases on their
  existing option-click path, and never replace an existing chat draft.
- Pointer-driven actions must preserve one continuous mouse path across consecutive operations and
  pages in the same browser context. Direct locator or DOM clicks that are required for compatibility
  must first move the shared pointer continuously to the target; do not reset or teleport it.

Detailed session, parsing, and platform interaction requirements live in the browser and platform
scoped instructions.

## RAG and Console Safety

- RAG local JSONL facts are authoritative; Qdrant is a rebuildable index.
- Preserve platform/job isolation in retrieval. Only verified recruiter facts may become answer
  facts; candidate turns and unverified recruiter turns remain audit/context data.
- No trusted source or insufficient confidence must produce an explicit no-answer result, not a
  speculative model call.
- Offline eval and regression paths must not append production answer logs.
- `rag:api` is an internal interface, not a complete auth gateway.
- The console assistant produces structured drafts only. It must reject arbitrary shell, script,
  and file-write requests and must never execute model-suggested commands.
- Request-scoped console model settings may affect assistant drafts and console RAG answers only.
  Never persist or log the API key, include it in model input, or let it alter confirmed execution.
- `/api/assistant/confirm` must reuse shared normalizers and the existing `TaskQueue`; preview argv
  is not an execution source of truth.
- HTTP and assistant-confirmed Boss browser operations must execute through `TaskQueue`. Read-only
  operations must remain distinguishable from quota-consuming/contact mutations, and risk
  acceptance does not replace the mode-specific `confirmed` and identity checks.

See `src/rag/AGENTS.md` and `src/server/AGENTS.md` before changing those flows.

## Runtime

- Use Node 24 LTS by default. `.nvmrc` is `24`; `package.json` supports `>=24 <27`.
- Node 26 support uses `scripts/node-ts-hooks.mjs`; runtime scripts do not rely on `tsx`.
- Prefix repository shell commands with `rtk`.
- Environment variables load through `dotenv` in `src/config.ts`.
- `OPENAI_API_KEY` is required for JD parsing and scoring. Model routing may use
  `OPENAI_BASE_URL`, `OPENAI_MODEL`, `JD_PARSING_MODEL`, `SCORING_MODEL`, and optional `RAG_MODEL`.
- Persisted RAG defaults to Qdrant plus the local embedding HTTP service; set
  `RAG_EMBEDDING_PROVIDER=openai` only intentionally.
- Browser engine defaults to CloakBrowser; `BROWSER_ENGINE=playwright` uses bundled Chromium.
- SMTP delivery uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.

Operational setup, full environment-variable reference, and command examples belong in
`README.md` and `项目说明文档.md`.

## Verification Matrix

Run verification in proportion to the change. The critical mappings are:

| Contract | Primary tests |
| --- | --- |
| CLI modes, persistence, seen/scoring semantics | `src/scripts/test-scoring-run-semantics.ts` |
| Platform registry, default pacing, reuse defaults | `src/scripts/test-platform-registry.ts` |
| Boss chat and property-electrician rules | `src/scripts/test-boss-chat.ts` |
| Boss talent discovery, deep search, and greet | `src/scripts/test-boss-talent.ts`, `src/scripts/test-boss-cli-modes.ts` |
| Boss atomic chat operations and receipts | `src/scripts/test-boss-chat-operations.ts` |
| Boss position/JD sync and ID mapping | `src/scripts/test-boss-job-sync.ts` |
| Liepin adapter/search/filter behavior | `src/scripts/test-liepin-adapter.ts` |
| Zhilian adapter/search/filter behavior | `src/scripts/test-zhilian-adapter.ts` |
| Search subscription | `src/scripts/test-search-subscription.ts` |
| RAG behavior | matching `src/scripts/test-rag-*.ts` tests |
| HTTP, assistant, and scheduler behavior | `src/scripts/test-server-api.ts`, `src/scripts/test-task-scheduler.ts` |

Baseline commands:

- `rtk npm run typecheck`
- `rtk npm run test`
- `rtk npm run build`

Use focused Node test commands during iteration, then expand verification according to risk.

## Data and Reporting Safety

- Do not commit `.env`, browser storage-state files, candidate data, generated reports, or `data/`.
- Migration must not overwrite an existing platform target job directory.
- DOCX export is offline maintenance, not part of normal capture/scoring/email orchestration.
- Candidate photos may come only from that candidate's confirmed detail-page avatar evidence. Never
  use default avatars, logos, school images, SVG assets, similar-candidate photos, or the template
  sample. If identity is uncertain, omit the photo.
- Preserve original resume text where possible. Do not invent records by splitting same-company
  multi-role histories without page evidence.
