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
- Batch mode uses `--jobs-file` only. Do not allow it to combine with single-job `--keyword`, `--jd`, or `--jd-file`.
- With `--platform all --jobs-file`, the outer loop is jobs-file order and the inner loop is `51job`, `liepin`, `zhilian`.
- Search-subscription mode (`--search-subscription-file`) is standalone. It must not parse JD text, create job records, capture resumes, score candidates, export reports, or send email.
- `--include-viewed` defaults to `false`. It is only for normal resume-capture runs and must remain rejected in search-subscription mode.
- Explicit empty-result states are successful zero-candidate runs, not extraction failures. This includes 51job text such as `没有搜索到相关的人才` and stable empty result lists.
- Only successfully captured resumes are marked seen. Detail-open or extraction failures stay retryable.
- Mark successful captures as seen before scoring.
- Model scoring failures must persist `status: failed` score artifacts and must not undo seen state.
- Latest run-result files stay lightweight: store platform, counts, and candidate ID lists rather than full candidate card payloads.
- Exported markdown reports and email bodies must preserve a visible platform-source label.
- Zhilian scored-candidate emails must use copied colleague-forward resume share links. Missing or duplicated current-run Zhilian share links are delivery errors.
- Zhilian search extraction must run only after the saved quick-search condition is confirmed active, using visible text such as `关键词：<raw --keyword>`. If clearing `未看过` for `--include-viewed true` drops the quick-search condition, reselect the saved quick-search tag and clear `未看过` again before extraction. Do not clear `未聊过` for include-viewed reruns.
- Zhilian search-subscription mode must also prepare the page through the saved quick-search tag and confirm visible `关键词：<keyword>` state. In reusable-browser runs, re-click the saved quick-search tag even when `关键词：<keyword>` is already visible so stale application-filter state does not leak between runs; if the tag is not visible but the keyword state is already confirmed, fall back to that confirmed state. Do not replace the saved quick-search by filling the raw keyword search box. Explicit empty-result text such as `没有符合条件的人才` is a successful zero-result summary.
- Zhilian search-filter discovery must stay on `/app/search`, reuse the saved quick-search tag, confirm the visible search-condition panel, and expand the panel's `更多筛选` area before reading fields. Do not use broad `getByText(..., exact: false)` clicks for `筛选` or `使用高级搜索`; those can hit the top navigation or recommendation-page filters. The default Zhilian catalog captures the 19-field visible panel. With `--slow-click true`, discovery opens recognized simple dropdowns/salary popovers for `活跃日期`, `性别要求`, `求职状态`, `人才类型`, `人才照片`, `简历语言`, `跳槽频率`, and `期望月薪`; reads full Vue `.s-cascader` option trees for `现居住地`, `户口所在地`, `从事行业`, `期望行业`, `从事职位`, and `期望职位`; and reads the `语言能力` popover options. The exported application options currently include 19 Zhilian fields.
- Zhilian search-subscription `applicationFilter` replay supports the 19 exported fields: `education`, `work_years`, `school_nature`, `recent_activity_time`, `gender`, `job_status`, `language`, `talent_type`, `talent_photo`, `resume_language`, `job_hopping_count`, `living_location`, `hukou_location`, `engaged_industry`, `expected_industry`, `engaged_function`, `expected_function`, `age`, and `expected_salary`. `education` and `work_years` support preset strings or custom select ranges such as `{ "label": "自定义", "input": { "min": "大专", "max": "本科" } }` and `{ "label": "自定义", "input": { "min": "1年", "max": "3年" } }`. `age` accepts number ranges and uses a visible preset when possible, otherwise the custom dropdowns for non-preset ranges such as `{ "min": 24, "max": 31 }`. Salary uses monthly labels from the Zhilian salary popover, such as `{ "min": "2千", "max": "1万" }`. The salary popover's left/right option clicks must be immediate native locator clicks rather than delayed generic mouse-move clicks, and live validation should confirm the visible selected-condition text such as `期望月薪：3千-1万`. Cascader fields such as city, hukou, industry, and function should prefer `{ "value": "...", "pathLabels": [...] }` to avoid ambiguous duplicate labels. `expected_location` remains unsupported on Zhilian because the current catalog has no corresponding visible field.
- Zhilian current search cards may not expose usable detail links or IDs in anchors; DOM extraction must read candidate data from Vue props on card wrappers, such as `userMasterId` and `resumeNumber`, before falling back to candidate APIs.
- Liepin candidate extraction defaults to running after `隐藏已查看` is checked. When `--include-viewed true` is provided, extraction must run after that filter is explicitly unchecked. Stale `search-resumes` API responses from before the final viewed-filter state is applied must be discarded.
- Liepin search opening must reach the recruiter talent-search surface, clicking the top-nav `找人` entry when starting from the recruiter home before selecting the requested quick-search tag.
- Liepin search-filter discovery can capture the expanded visible filter catalog with `--slow-click true`; the current normalized catalog should include 25 recruiter-search filters and clean adjacent-row pollution before export. Liepin industry modal full-tree discovery is handled by `discover:liepin-industry-tree`; it overwrites the `当前行业` and `期望行业` catalog entries with path-based leaf options and writes application options.
- Liepin search-subscription `applicationFilter` replay supports `work_years`, `education`, `school_nature`, `recent_activity_time`, `gender`, `language`, `living_location`, `expected_location`, `expected_salary`, `current_salary`, `job_hopping_count`, `job_status`, `resume_language`, `overseas_work_experience`, `management_experience`, `age`, `engaged_industry`, `engaged_function`, `expected_industry`, `expected_function`, `company_name`, `school_name`, and `major`. Search-subscription preparation clears existing page filters before applying requested filters so reusable-browser state does not leak between runs, and closes stale blocking filter dialogs before applying filters. The expanded more-conditions area must be opened idempotently: click `展开更多条件` only when the page is not already showing `收起更多条件`. Salary input is annual salary in 万, using the page `wantSalaryLow`/`wantSalaryHigh` or `nowSalaryLow`/`nowSalaryHigh` inputs when available. Age input is a number range object such as `{ "min": 25, "max": 35 }` in years. Current/expected industry and function use the Liepin modal picker/search flow and must confirm the modal before triggering search readiness. Industry parent labels such as `AI/互联网/IT`, `消费品`, `生活服务`, and `交通/物流/贸易/零售` are path nodes, not direct replay values; industry leaf values should use `{ "value": "电子商务", "pathLabels": ["AI/互联网/IT", "电子商务"] }` when duplicate labels or explicit category selection matters. `company_name`, `school_name`, and `major` are free-text inputs with row-level confirmation. `overseas_work_experience` and `management_experience` are checkbox filters; successful replay and screenshots must verify the real checkbox state (`input.checked` or Ant checked class), not just visible text or selected-condition tags. `keyword_title` is not replayed as an `applicationFilter` because search-subscription already maps the plan keyword to the top keyword/title input. Each applied filter must trigger search readiness before reading the result total.
- `--liepin-forward-contact` is only valid for normal Liepin resume-capture runs, including `--platform all`; reject it for other single platforms and search-subscription mode. Forwarding must happen after opening a new candidate detail and before parsing/seen marking. Forward failures keep the candidate retryable.
- Liepin interaction pacing defaults to randomized `2000-3000ms` waits for in-page actions and candidate-to-candidate transitions. Click helpers should move the mouse to the target before clicking when possible.

## Platform Rules

| Platform | Storage State | Search Entry | Candidate Extraction | Special Rules |
| --- | --- | --- | --- | --- |
| `51job` | `storage-state.json` | Subscription page at `https://ehire.51job.com/Revision/talent/subscribe` | DOM cards anchored around `div[id^="no_interested_"]` | Hover saved keyword card, click talent-search trigger, preserve selector fallbacks, treat filtered-empty text as success. `--include-viewed true` clears `我已看`. After the talent-search page opens, close extra `我的订阅` tabs in the same reusable browser context and keep the active session page on the talent-search page. |
| `liepin` | `storage-state.liepin.json` | Recruiter talent search via `找人`, then quick-search tag | DOM-first; API fallback only when DOM has no candidates or needs safe detail URLs | Liepin is always headed. Manual-login polling must avoid unrelated probes before recruiter cookies exist. Click requested quick-search tag, ensure `隐藏已查看` by default, or uncheck it for `--include-viewed true`, then reset/request-start barrier before extraction. |
| `zhilian` | `storage-state.zhilian.json` | `https://rd6.zhaopin.com/app/search` saved quick-search tag | DOM-first, including Vue candidate props on current card wrappers; API fallback only when DOM yields no candidates | Login starts at `https://passport.zhaopin.com/org/login`. Saved tag text must contain raw `--keyword`, and applied state must show `关键词：<keyword>` before extraction. `--include-viewed true` clears visible `未看过` only and preserves `未聊过`. Resume detail is a modal on `/app/search`; parse the modal subtree, copy `转给同事` -> `链接转发` share link, and persist it as `candidateShareUrl`. |

All adapters share one search wait contract: the main workflow creates a single search deadline before opening platform search entry and passes it through search opening and candidate extraction. Avoid adding fixed waits in series that exceed the shared deadline.

Detail opening should follow the same total-deadline style across platforms. For 51job and Liepin, race popup/current-page navigation/content readiness within the deadline. For Zhilian, use the modal readiness path without repeating a full detail wait.

## Runtime

- Use Node 24 LTS by default. `.nvmrc` is `24`, and `package.json` declares `>=24 <27`.
- Node 26 is supported through `scripts/node-ts-hooks.mjs`; runtime scripts do not rely on `tsx`.
- Environment variables are loaded by `dotenv` in `src/config.ts`.
- `OPENAI_API_KEY` is required for JD parsing and resume scoring. `OPENAI_BASE_URL`, `OPENAI_MODEL`, `JD_PARSING_MODEL`, and `SCORING_MODEL` can override model routing.
- Browser auth uses platform-scoped Playwright storage state. Leave `STORAGE_STATE_PATH` unset for normal multi-platform runs so each platform uses its own default file.
- If a saved session is missing or expired, headed runs may refresh through manual login and then verify the new session. Headless runs cannot refresh sessions and should error with instructions to rerun headed.
- Browser launch engine defaults to CloakBrowser through `BROWSER_ENGINE=cloakbrowser`; set `BROWSER_ENGINE=playwright` to fall back to Playwright's bundled Chromium.
- Reusable browser mode is implemented for all production platforms with platform-scoped CDP ports and browser profiles. Liepin defaults to reusable headed mode; 51job and Zhilian are opt-in. Liepin still forces headed mode even when `PLAYWRIGHT_HEADLESS=true`.
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
- `PLAYWRIGHT_REUSE_BROWSER` default `false` outside Liepin
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN>_REUSE_BROWSER`; Liepin default enabled unless set to `false`
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
- Include already-viewed candidates: `rtk npm run dev -- --platform <platform> --keyword "<keyword>" --include-viewed true`
- Liepin forward contact: `rtk npm run dev -- --platform liepin --keyword "<keyword>" --liepin-forward-contact "<contact name>"`
- Batch mode: `rtk npm run dev -- --platform <platform|all> --jobs-file ./jobs.json`
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
- `rtk npm run migrate:platform-storage`
- `rtk npm run validate:resumes`
- `rtk npm run capture:resume-dom -- --platform <platform> <jobKey> <searchKeyword> <candidateId>`
- `rtk npm run capture:resume-dom -- --platform <platform> <jobKey> <candidateId> <resumeUrl>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-lines.ts <platform> <jobKey> <candidateId>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-boundaries.ts <platform> <jobKey> <candidateId>`

Platform-specific regression command names keep `experimental` for compatibility:

- `rtk npm run test:experimental:liepin`
- `rtk npm run test:experimental:zhilian`

## Architecture Map

- `src/index.ts` - CLI parsing and orchestration for single jobs, all-platform jobs, batch mode, and search-subscription mode.
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

Legacy top-level `data/jobs/` content may exist. `rtk npm run migrate:platform-storage` moves legacy jobs into `data/51job/jobs/`, backfills missing platform fields, and must not overwrite existing target job directories.

Search-filter discovery outputs live outside job directories:

- `data/<platform>/filter-catalog/latest.json`
- `data/<platform>/filter-catalog/<timestamp>.json`

## Resume Parsing Guidance

`src/browser/resume-detail.ts` is heuristic-heavy. Prefer validating parser changes against stored snapshots and offline reparsing before changing live browser flow.

Preserve original field text where possible. Use page-structure cues instead of rewriting resume content or splitting same-company multi-role histories into invented records.

The parser combines whole-page section slicing, DOM work-history snapshots, and Chinese-language heuristics for company names, titles, industries, durations, schools, and noisy UI text. Keep changes narrow and covered by focused tests or stored-snapshot validation when possible.
