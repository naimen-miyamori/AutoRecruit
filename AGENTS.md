# AGENTS.md

Repository guidance for coding agents working on this project.

## Project Scope

This repository is a TypeScript CLI for recruitment automation. The supported production browser platforms are `51job`, `liepin`, and `zhilian`.

Keep the platform adapter boundary intact. Platform-specific behavior belongs under `src/platforms/`; shared orchestration belongs in `src/index.ts`, shared browser helpers under `src/browser/`, and storage behavior under `src/storage/`.

`--platform all` is part of the public CLI surface. It must run platforms sequentially in this exact order:

1. `51job`
2. `liepin`
3. `zhilian`

If one platform fails during an all-platform run, stop immediately and propagate that error.

## Do Not Break

- New job keys require JD input through `--jd` or `--jd-file`; reruns reuse the persisted `jd.json` and must not reparse JD text unnecessarily.
- `--jd-question` and `--rag-question` are aliases for candidate-facing JD/RAG question answering. They are standalone: do not open browsers, capture resumes, score candidates, export reports, or send email. With a stored `jobKey`, answer through the persisted RAG path and do not reparse JD text. With temporary `--jd` or `--jd-file`, answer from the provided JD only, do not create job records, do not write persistent RAG indexes, and do not append `answer-logs.jsonl`.
- RAG persisted facts live under `data/<platform>/jobs/<jobKey>/rag/`. Treat local JSONL files as the source of truth; Qdrant is a rebuildable index. Do not make Qdrant the only copy of JD, chunks, conversations, embeddings, or answer logs.
- Only verified recruiter facts may answer future candidate questions. For conversation ingestion, store full turns, but only `role: recruiter` with `verified: true` should become indexed factual chunks. Candidate turns and unverified recruiter turns are context/audit data, not answer facts.
- RAG retrieval must preserve platform and job isolation with metadata filtering. Hybrid retrieval is the default (`RAG_RETRIEVAL_MODE=hybrid`): dense Qdrant recall plus local BM25 keyword recall, fusion, and lightweight reranking. `dense` mode is only a diagnostic/override path.
- RAG answer failures or no-answer cases must not invent facts. If no trusted JD or verified conversation chunk meets the confidence threshold, return an explicit no-answer result instead of calling the model to speculate.
- RAG feedback, review, metrics, ops, eval, answer-eval, and regression commands are operational quality loops. Offline eval/regression paths must not append production `answer-logs.jsonl`.
- `rag:api` is an internal product HTTP interface for RAG. It may enforce `RAG_API_KEY`/`--api-key`, but it is not a full auth gateway: multi-tenancy, RBAC, rate limiting, centralized audit, monitoring alerts, and front-end management belong to upstream infrastructure or later product layers.
- Batch mode uses `--jobs-file` as the only source of job definitions. Do not allow it to combine with single-job `--keyword`, `--jd`, or `--jd-file`; normal run-level switches such as `--include-viewed`, `--email`, `--cc`, `--search-source`, `--application-filter-input-file`, and valid Liepin forwarding remain allowed. Jobs-file items may set `searchSource` and `applicationFilterInputFile`; job-level values override CLI-level defaults, and relative job-level filter paths resolve from the jobs file directory.
- With `--platform all --jobs-file`, the outer loop is jobs-file order and the inner loop is `51job`, `liepin`, `zhilian`.
- Search-subscription mode (`--search-subscription-file`) is standalone. It must not parse JD text, create job records, capture resumes, score candidates, export reports, or send email.
- `--search-source saved|direct` is only for normal resume-capture runs and defaults to `saved`. `saved` keeps the existing saved subscription/quick-search behavior. `direct` bypasses saved search tags, opens the platform search page, clears old filters/state, fills the raw keyword, applies application-filter input conditions, applies the platform viewed-filter state, then continues the normal candidate extraction, detail opening, forwarding, scoring, export, and email flow.
- `--application-filter-input-file` is only valid with `--search-source direct` in normal resume-capture runs. It uses the platform's `data/<platform>/filter-catalog/application-filter-options.latest.json` to build `applicationFilter` conditions. Any skipped or failed direct-mode search condition is a run error; do not continue to capture candidates from a partially applied direct filter set.
- `--include-viewed` defaults to `false`. It is only for normal resume-capture runs and must remain rejected in search-subscription mode.
- Explicit empty-result states are successful zero-candidate runs, not extraction failures. This includes 51job text such as `没有搜索到相关的人才` and stable empty result lists.
- Only successfully captured resumes are marked seen. Detail-open or extraction failures stay retryable.
- Mark successful captures as seen before scoring.
- Model scoring failures must persist `status: failed` score artifacts and must not undo seen state.
- Latest run-result files stay lightweight: store platform, counts, and candidate ID lists rather than full candidate card payloads.
- Exported markdown reports and email bodies must preserve a visible platform-source label.
- Zhilian scored-candidate emails must use copied colleague-forward resume share links. Missing or duplicated current-run Zhilian share links are delivery errors.
- In direct normal resume-capture mode, Zhilian must not click a saved quick-search tag. It should open `/app/search`, clear stale conditions when possible, fill the top keyword input, trigger search, confirm visible `关键词：<keyword>`, apply requested filters, then set `未看过` according to `--include-viewed` while preserving `未聊过`.
- Zhilian search extraction must run only after the saved quick-search condition is confirmed active, using visible text such as `关键词：<raw --keyword>`. If setting `未看过` for default runs or clearing it for `--include-viewed true` drops the quick-search condition, reselect the saved quick-search tag and set `未看过` to the requested state again before extraction. Do not clear `未聊过` for include-viewed reruns.
- Zhilian search-subscription mode must also prepare the page through the saved quick-search tag and confirm visible `关键词：<keyword>` state. In reusable-browser runs, re-click the saved quick-search tag even when `关键词：<keyword>` is already visible so stale application-filter state does not leak between runs; if the tag is not visible but the keyword state is already confirmed, fall back to that confirmed state. Do not replace the saved quick-search by filling the raw keyword search box. Explicit empty-result text such as `没有符合条件的人才` is a successful zero-result summary.
- Zhilian search-filter discovery must stay on `/app/search`, reuse the saved quick-search tag, confirm the visible search-condition panel, and expand the panel's `更多筛选` area before reading fields. Do not use broad `getByText(..., exact: false)` clicks for `筛选` or `使用高级搜索`; those can hit the top navigation or recommendation-page filters. The default Zhilian catalog captures the 19-field visible panel. With `--slow-click true`, discovery opens recognized simple dropdowns/salary popovers for `活跃日期`, `性别要求`, `求职状态`, `人才类型`, `人才照片`, `简历语言`, `跳槽频率`, and `期望月薪`; reads full Vue `.s-cascader` option trees for `现居住地`, `户口所在地`, `从事行业`, `期望行业`, `从事职位`, and `期望职位`; and reads the `语言能力` popover options. The exported application options currently include 19 Zhilian fields.
- Zhilian search-subscription `applicationFilter` replay supports the 19 exported fields: `education`, `work_years`, `school_nature`, `recent_activity_time`, `gender`, `job_status`, `language`, `talent_type`, `talent_photo`, `resume_language`, `job_hopping_count`, `living_location`, `hukou_location`, `engaged_industry`, `expected_industry`, `engaged_function`, `expected_function`, `age`, and `expected_salary`. `education` and `work_years` support preset strings or custom select ranges such as `{ "label": "自定义", "input": { "min": "大专", "max": "本科" } }` and `{ "label": "自定义", "input": { "min": "1年", "max": "3年" } }`. `age` accepts number ranges and uses a visible preset when possible, otherwise the custom dropdowns for non-preset ranges such as `{ "min": 24, "max": 31 }`. Salary uses monthly labels from the Zhilian salary popover, such as `{ "min": "2千", "max": "1万" }`. The salary popover's left/right option clicks must be immediate native locator clicks rather than delayed generic mouse-move clicks, and live validation should confirm the visible selected-condition text such as `期望月薪：3千-1万`. Cascader fields such as city, hukou, industry, and function should prefer `{ "value": "...", "pathLabels": [...] }` to avoid ambiguous duplicate labels. `expected_location` remains unsupported on Zhilian because the current catalog has no corresponding visible field.
- Zhilian current search cards may not expose usable detail links or IDs in anchors; DOM extraction must read candidate data from Vue props on card wrappers, such as `userMasterId` and `resumeNumber`, before falling back to candidate APIs.
- 51job candidate extraction defaults to running after `我已看` is checked. When `--include-viewed true` is provided, extraction must run after that filter is explicitly unchecked.
- 51job detail opening uses `div[id^="no_interested_"]` only as a candidate-card anchor. The `no_interested_<id>` element is near the `不感兴趣` action and is not the detail trigger. Prefer clicking the candidate name/detail line such as `.name`, `.detail`, or `.firstline`, then fall back to broader card regions. A single failed 51job click target must not consume the full resume-detail timeout; keep the overall popup/current-page navigation/content race under the shared detail deadline.
- Zhilian candidate extraction defaults to running after `未看过` is checked. When `--include-viewed true` is provided, extraction must run after `未看过` is explicitly unchecked while preserving `未聊过`.
- Liepin candidate extraction defaults to running after `隐藏已查看` is checked. When `--include-viewed true` is provided, extraction must run after that filter is explicitly unchecked. Stale `search-resumes` API responses from before the final viewed-filter state is applied must be discarded.
- Liepin search opening must reach the recruiter talent-search surface, clicking the top-nav `找人` entry when starting from the recruiter home before selecting the requested quick-search tag.
- Liepin search-filter discovery can capture the expanded visible filter catalog with `--slow-click true`; the current normalized catalog should include 25 recruiter-search filters and clean adjacent-row pollution before export. Liepin industry modal full-tree discovery is handled by `discover:liepin-industry-tree`; it overwrites the `当前行业` and `期望行业` catalog entries with path-based leaf options and writes application options.
- Liepin search-subscription `applicationFilter` replay supports `work_years`, `education`, `school_nature`, `recent_activity_time`, `gender`, `language`, `living_location`, `expected_location`, `expected_salary`, `current_salary`, `job_hopping_count`, `job_status`, `resume_language`, `overseas_work_experience`, `management_experience`, `age`, `engaged_industry`, `engaged_function`, `expected_industry`, `expected_function`, `company_name`, `school_name`, and `major`. Search-subscription preparation clears existing page filters before applying requested filters so reusable-browser state does not leak between runs, and closes stale blocking filter dialogs before applying filters. The expanded more-conditions area must be opened idempotently: click `展开更多条件` only when the page is not already showing `收起更多条件`. Salary input is annual salary in 万, using the page `wantSalaryLow`/`wantSalaryHigh` or `nowSalaryLow`/`nowSalaryHigh` inputs when available. Age input is a number range object such as `{ "min": 25, "max": 35 }` in years. Current/expected industry and function use the Liepin modal picker/search flow and must confirm the modal before triggering search readiness. Industry parent labels such as `AI/互联网/IT`, `消费品`, `生活服务`, and `交通/物流/贸易/零售` are path nodes, not direct replay values; industry leaf values should use `{ "value": "电子商务", "pathLabels": ["AI/互联网/IT", "电子商务"] }` when duplicate labels or explicit category selection matters. `company_name`, `school_name`, and `major` are free-text inputs with row-level confirmation. `overseas_work_experience` and `management_experience` are checkbox filters; successful replay and screenshots must verify the real checkbox state (`input.checked` or Ant checked class), not just visible text or selected-condition tags. `keyword_title` is not replayed as an `applicationFilter` because search-subscription already maps the plan keyword to the top keyword/title input. Each applied filter must trigger search readiness before reading the result total.
- `--liepin-forward-contact` is only valid for normal Liepin resume-capture runs, including single-job and batch runs with `--platform liepin` or `--platform all`; reject it for other platforms and search-subscription mode. Forwarding must happen after opening a new candidate detail and before parsing/seen marking. Forward failures keep the candidate retryable.
- Liepin interaction pacing defaults to randomized `2000-3000ms` waits for in-page actions and candidate-to-candidate transitions. Click helpers should move the mouse to the target before clicking when possible.

## Platform Rules

| Platform | Storage State | Search Entry | Candidate Extraction | Special Rules |
| --- | --- | --- | --- | --- |
| `51job` | `storage-state.json` | Saved mode: subscription page at `https://ehire.51job.com/Revision/talent/subscribe`; direct mode: talent search page | DOM cards anchored around `div[id^="no_interested_"]` | Saved mode clicks the saved keyword card, confirms the active subscription detail panel title matches the raw keyword, then clicks that panel's `去搜索` trigger. Direct mode opens talent search, clears old filters, fills the keyword, applies requested filters, then searches. Before extraction confirm visible text such as `关键词：<keyword>` when using saved mode. Preserve selector fallbacks and treat filtered-empty text as success. Default runs explicitly check `我已看`; `--include-viewed true` clears it. After the talent-search page opens, close extra `我的订阅` tabs in the same reusable browser context and keep the active session page on the talent-search page. |
| `liepin` | `storage-state.liepin.json` | Saved mode: recruiter talent search via `找人`, then quick-search tag; direct mode: recruiter talent search keyword input | DOM-first; API fallback only when DOM has no candidates or needs safe detail URLs | Liepin is always headed. Manual-login polling must avoid unrelated probes before recruiter cookies exist. Saved mode clicks the requested quick-search tag. Direct mode clears existing filters, fills the keyword, triggers search, and applies requested filters. Both modes ensure `隐藏已查看` by default, or uncheck it for `--include-viewed true`, then reset/request-start barrier before extraction. |
| `zhilian` | `storage-state.zhilian.json` | Saved mode: `/app/search` saved quick-search tag; direct mode: `/app/search` keyword input | DOM-first, including Vue candidate props on current card wrappers; API fallback only when DOM yields no candidates | Login starts at `https://passport.zhaopin.com/org/login`. Saved mode tag text must contain raw `--keyword`, and applied state must show `关键词：<keyword>` before extraction. Direct mode must not click the saved tag; it clears stale conditions, fills the keyword input, triggers search, and confirms `关键词：<keyword>`. Default runs explicitly check visible `未看过`; `--include-viewed true` clears visible `未看过` only and preserves `未聊过`. Resume detail is a modal on `/app/search`; parse the modal subtree, copy `转给同事` -> `链接转发` share link, and persist it as `candidateShareUrl`. |

All adapters share one search wait contract: the main workflow creates a single search deadline before opening platform search entry and passes it through search opening and candidate extraction. Avoid adding fixed waits in series that exceed the shared deadline.

Detail opening should follow the same total-deadline style across platforms. For 51job and Liepin, race popup/current-page navigation/content readiness within the deadline. For Zhilian, use the modal readiness path without repeating a full detail wait.

## Runtime

- Use Node 24 LTS by default. `.nvmrc` is `24`, and `package.json` declares `>=24 <27`.
- Node 26 is supported through `scripts/node-ts-hooks.mjs`; runtime scripts do not rely on `tsx`.
- Environment variables are loaded by `dotenv` in `src/config.ts`.
- `OPENAI_API_KEY` is required for JD parsing and resume scoring. `OPENAI_BASE_URL`, `OPENAI_MODEL`, `JD_PARSING_MODEL`, and `SCORING_MODEL` can override model routing.
- RAG answer generation uses `RAG_MODEL` only as an optional override; when it is unset, use `OPENAI_MODEL`. The current local setup should normally configure only `OPENAI_MODEL` for model routing.
- Persisted RAG uses Qdrant plus local embeddings by default. `QDRANT_URL` points to Qdrant, `RAG_VECTOR_COLLECTION` defaults to `autorecruit_rag_chunks`, `RAG_EMBEDDING_PROVIDER` defaults to `local-http`, `RAG_EMBEDDING_LOCAL_URL` defaults to `http://127.0.0.1:8011`, and `RAG_EMBEDDING_MODEL` defaults to `BAAI/bge-small-zh-v1.5`. Set `RAG_EMBEDDING_PROVIDER=openai` only when intentionally switching embedding back to OpenAI.
- The local embedding HTTP service can be run from source with `rtk npm run rag:embedding:local`. On this machine the long-running LaunchAgent setup uses `com.autorecruit.embedding`, runtime files under `~/.local/share/autorecruit/embedding/`, and logs under `~/.local/var/log/autorecruit/`. This runtime path intentionally avoids `~/Documents` because macOS background services may not reliably access Documents without extra privacy permissions.
- For local RAG health checks, use `rtk launchctl list | rtk rg 'com\\.autorecruit\\.(qdrant|embedding)'`, `rtk curl -sSf http://127.0.0.1:6333/collections`, and `rtk curl -sSf http://127.0.0.1:8011/health`.
- Browser auth uses platform-scoped Playwright storage state. Leave `STORAGE_STATE_PATH` unset for normal multi-platform runs so each platform uses its own default file.
- If a saved session is missing or expired, headed runs may refresh through manual login and then verify the new session. Headless runs cannot refresh sessions and should error with instructions to rerun headed.
- Browser launch engine defaults to CloakBrowser through `BROWSER_ENGINE=cloakbrowser`; set `BROWSER_ENGINE=playwright` to fall back to Playwright's bundled Chromium.
- Reusable browser mode is implemented for all production platforms with platform-scoped CDP ports and browser profiles. 51job, Liepin, and Zhilian default to reusable headed mode. Liepin still forces headed mode even when `PLAYWRIGHT_HEADLESS=true`.
- Resume extraction can use the optional Crawl4AI runtime at `.venv/bin/python`; if unavailable, the built-in parser fallback should continue.
- SMTP delivery uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.

Key browser timing env vars:

- `BROWSER_ENGINE=cloakbrowser|playwright`
- `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` default `20000`
- `PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS` default `2000`
- `PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS` default `3000`
- `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` default `20000`
- `PLAYWRIGHT_ACTION_DELAY_MIN_MS` / `PLAYWRIGHT_ACTION_DELAY_MAX_MS` default `0-0` outside Liepin
- `PLAYWRIGHT_CANDIDATE_DELAY_MIN_MS` / `PLAYWRIGHT_CANDIDATE_DELAY_MAX_MS` default `0-0` outside Liepin
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_ACTION_DELAY_MIN_MS` / `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_ACTION_DELAY_MAX_MS`
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_CANDIDATE_DELAY_MIN_MS` / `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_CANDIDATE_DELAY_MAX_MS`
- `PLAYWRIGHT_REUSE_BROWSER` default `false` outside platforms with their own defaults
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_REUSE_BROWSER`; 51job, Liepin, and Zhilian default enabled unless set to `false`
- `PLAYWRIGHT_51JOB_REUSE_CDP_PORT` default `19325`
- `PLAYWRIGHT_LIEPIN_REUSE_CDP_PORT` default `19327`
- `PLAYWRIGHT_ZHILIAN_REUSE_CDP_PORT` default `19329`
- Existing `PLAYWRIGHT_LIEPIN_*ACTION_DELAY*`, `PLAYWRIGHT_LIEPIN_*CANDIDATE_DELAY*`, and `PLAYWRIGHT_LIEPIN_REUSE_*` names remain supported as the Liepin platform overrides.

## Common Commands

Prefix shell commands with `rtk`.

Install and verify:

- `rtk npm install`
- `rtk npm run typecheck`
- `rtk npm run test`
- `rtk npm run build`

Run from source:

- First run with inline JD: `rtk npm run dev -- --platform <51job|liepin|zhilian|all> --keyword "<keyword>" --jd "<JD text>" [--email user@example.com] [--cc a@example.com,b@example.com]`
- First run with JD file: `rtk npm run dev -- --platform <platform> --keyword "<keyword>" --jd-file ./fixtures/jd.txt`
- Rerun existing job key: `rtk npm run dev -- --platform <platform> --keyword "<keyword>"`
- Include already-viewed candidates: `rtk npm run dev -- --platform <platform|all> --keyword "<keyword>" --include-viewed true`
- Liepin forward contact: `rtk npm run dev -- --platform <liepin|all> --keyword "<keyword>" --liepin-forward-contact "<contact name>"`
- Direct normal capture with filter input: `rtk npm run dev -- --platform <platform|all> --keyword "<keyword>" --jd-file ./fixtures/jd.txt --search-source direct --application-filter-input-file ./filter-input.json [--include-viewed true] [--liepin-forward-contact "<contact name>"]`
- Batch mode: `rtk npm run dev -- --platform <platform|all> --jobs-file ./jobs.json [--search-source direct] [--application-filter-input-file ./filter-input.json] [--include-viewed true] [--liepin-forward-contact "<contact name>"]`
- Search-subscription mode: `rtk npm run dev -- --platform <platform|all> --search-subscription-file ./search-subscription.json [--keyword "<keyword>"] [--search-subscription-name "<name>"] [--save-search-subscription true]`
- Search-filter discovery: `rtk npm run discover:filters -- --platform <51job|liepin|zhilian|all> --keyword "<keyword>" [--max-depth 3] [--max-options-per-level 50] [--include-remote-probes true] [--slow-click true]`
- Liepin industry tree discovery: `rtk npm run discover:liepin-industry-tree -- --keyword "<keyword>" [--field engaged_industry,expected_industry]`
- Liepin option verification dry-run: `rtk npm run verify:liepin-filter-options -- --keyword "<keyword>" [--limit 10] [--field work_years,education]`; industry fields use tree leaf paths when the industry catalog has been collected.
- Liepin option verification live run: `rtk npm run verify:liepin-filter-options -- --keyword "<keyword>" --run true --limit 10`; for industry-only checks use `--field engaged_industry,expected_industry`.

Run compiled CLI:

- `rtk npm start -- --platform <platform|all> --keyword "<keyword>" --jd "<JD text>"`
- `rtk npm start -- --platform <platform|all> --jobs-file ./jobs.json`

Session and live diagnostics:

- `rtk npm run login:session -- --platform <51job|liepin|zhilian> [--keep-open]`
- `rtk npm run debug:liepin-forward`
- `rtk npm run debug:zhilian -- --keyword "<keyword>"`
- `rtk npm run smoke:liepin -- --keyword "<keyword>" [--parse-first]`
- `rtk npm run smoke:zhilian -- --keyword "<keyword>" [--parse-first]`

Offline maintenance:

- `rtk npm run reparse:resumes -- <platform> <jobKey>`
- `rtk npm run score:stored -- <platform> <jobKey>`
- `rtk npm run export:results -- <platform> <jobKey>`
- `rtk npm run export:resume-docx -- --platform <platform> <jobKey> <candidateId> [--template /path/to/template.docx] [--output /path/to/resume.docx]`
- `rtk npm run export:resume-docx -- --resume-file ./resume.json [--snapshot-file ./snapshot.txt] [--template /path/to/template.docx] [--output /path/to/resume.docx]`
- `rtk npm run migrate:platform-storage`
- `rtk npm run validate:resumes`

RAG maintenance and diagnostics:

- `rtk npm run rag:index -- --platform <platform> --keyword "<keyword>"`
- `rtk npm run rag:ask -- --platform <platform> --keyword "<keyword>" --question "<question>"`
- `rtk npm run rag:api -- --host 127.0.0.1 --port 3978`
- `rtk npm run rag:ingest-conversation -- --platform <platform> --keyword "<keyword>" --conversation-id <id> --conversation-file ./conversation.jsonl`
- `rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl [--dry-run true] [--doctor true]`
- `rtk npm run rag:inspect -- --platform <platform> --keyword "<keyword>" [--question "<question>"]`
- `rtk npm run rag:doctor -- --platform <platform> --keyword "<keyword>" [--question "<question>"]`
- `rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json [--fail-on-issue true]`
- `rtk npm run rag:eval -- --platform <platform> --keyword "<keyword>" --eval-file ./rag-eval.json`
- `rtk npm run rag:answer-eval -- --platform <platform> --keyword "<keyword>" --eval-file ./rag-answer-eval.json`
- `rtk npm run rag:regression -- --suite-file ./fixtures/rag/regression.json`
- `rtk npm run test:rag:offline`
- `rtk npm run rag:review -- --platform <platform> --keyword "<keyword>" [--output ./rag-review.md]`
- `rtk npm run rag:metrics -- --file ./rag-review-jobs.json [--output ./rag-metrics.json]`
- `rtk npm run rag:ops -- --file ./rag-review-jobs.json [--policy ./rag-metrics-policy.json] [--fail-on-issue true]`
- `rtk npm run rag:rebuild -- --platform <platform> --keyword "<keyword>"`

Resume/debug maintenance:

- `rtk npm run capture:resume-dom -- --platform <platform> <jobKey> <searchKeyword> <candidateId>`
- `rtk npm run capture:resume-dom -- --platform <platform> <jobKey> <candidateId> <resumeUrl>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-lines.ts <platform> <jobKey> <candidateId>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-boundaries.ts <platform> <jobKey> <candidateId>`

Platform-specific regression command names keep `experimental` for compatibility:

- `rtk npm run test:experimental:liepin`
- `rtk npm run test:experimental:zhilian`

## Architecture Map

- `src/index.ts` - CLI parsing and orchestration for single jobs, all-platform jobs, batch mode, saved/direct normal capture, and search-subscription mode.
- `src/config.ts` - environment loading and runtime configuration.
- `src/types/job.ts` - shared contracts for jobs, candidates, resumes, scores, and run results.
- `src/parsers/jd-parser.ts` - model-based JD normalization with Zod validation and keyword-first `jobKey` derivation.
- `src/scoring/score-resume.ts` - model-based resume scoring with Zod validation.
- `src/browser/session.ts` - browser-engine session creation, manual refresh, reusable Liepin browser wiring, and persisted auth verification.
- `src/browser/subscribe-search.ts` - 51job subscription-search entry flow.
- `src/browser/candidate-list.ts` - 51job candidate card extraction and empty-result readiness.
- `src/browser/resume-detail.ts` - 51job resume opening and heuristic resume parsing.
- `src/platforms/*.ts` - adapter contract and concrete 51job, Liepin, and Zhilian implementations.
- `src/search/search-subscription.ts` - standalone search-subscription orchestration.
- `src/search/filter-catalog.ts` - shared search-filter catalog types and discovery result schema.
- `src/search/filter-dom.ts` - pure DOM scanning helpers for search-filter discovery.
- `src/search/filter-discovery.ts` - standalone Playwright-based search-filter discovery runner.
- `src/rag/*.ts` - RAG fact storage, chunking, embeddings, Qdrant vector store, hybrid retrieval, answer generation, diagnostics, eval, review, metrics, ops, baseline, and regression logic.
- `src/reporting/resume-docx.ts` - DOCX resume rendering from `/Users/Admin/Downloads/简历模板.docx`, including template photo-slot handling.
- `src/storage/job-store.ts` - JSON-backed persistence.
- `src/scripts/*.ts` - offline debug, export, email, reparse, login, migration, and smoke utilities.
- `项目说明文档.md` - higher-level usage, architecture, and operational notes.

## Persistence Layout

Each job lives under `data/<platform>/jobs/<jobKey>/`:

- `jd.json` - persisted `JobRecord`, including platform and report recipients.
- `seen-ids.json` - candidates successfully processed for dedupe.
- `resumes/<candidateId>.json` - parsed structured resume.
- `snapshots/<candidateId>.txt` - raw page text snapshot.
- `snapshots-dom/<candidateId>.json` - DOM-derived work-history snapshot.
- `scores/<candidateId>.json` - score artifact, including failed scoring artifacts.
- `results/<timestamp>.json` - lightweight run summary.
- `exports/latest.md` - latest markdown report.
- `exports/resumes/<candidateId>-<name>.docx` - optional DOCX resume rendered from the local template by `export:resume-docx`.
- `rag/sources.jsonl` - RAG fact source records, including JD and verified conversation sources.
- `rag/chunks.jsonl` - RAG chunk records. Qdrant is a rebuildable index over these chunks.
- `rag/embeddings.jsonl` - local embedding cache keyed by provider, model, and content hash.
- `rag/conversations/<conversationId>.jsonl` - imported conversation turns, deduplicated by stable turn id.
- `rag/index-manifest.json` - latest RAG index build summary, including embedding provider/model, vector store, and counts.
- `rag/answer-logs.jsonl` - persisted candidate-facing RAG answers, confidence, sources, no-answer reasons, and human feedback. Temporary JD answers and offline eval/regression paths must not append this file.

Legacy top-level `data/jobs/` content may exist. `rtk npm run migrate:platform-storage` moves legacy jobs into `data/51job/jobs/`, backfills missing platform fields, and must not overwrite existing target job directories.

Search-filter discovery outputs live outside job directories:

- `data/<platform>/filter-catalog/latest.json`
- `data/<platform>/filter-catalog/<timestamp>.json`

## Resume Parsing Guidance

`src/browser/resume-detail.ts` is heuristic-heavy. Prefer validating parser changes against stored snapshots and offline reparsing before changing live browser flow.

Preserve original field text where possible. Use page-structure cues instead of rewriting resume content or splitting same-company multi-role histories into invented records.

The parser combines whole-page section slicing, DOM work-history snapshots, and Chinese-language heuristics for company names, titles, industries, durations, schools, and noisy UI text. Keep changes narrow and covered by focused tests or stored-snapshot validation when possible.

DOCX resume export is an offline maintenance path, not part of normal capture/scoring/email orchestration. The default template is `/Users/Admin/Downloads/简历模板.docx`; stored-resume exports write under `data/<platform>/jobs/<jobKey>/exports/resumes/` unless `--output` or `--output-dir` is provided. Candidate photos may be embedded only from the candidate's own detail-page avatar evidence. Do not use platform default avatars, school images, logos/icons, SVG assets, or similar-candidate photos; if the real avatar cannot be confidently identified or downloaded, omit the photo rather than inserting the template sample or another person's image.
