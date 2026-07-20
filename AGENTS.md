# AGENTS.md

Repository guidance for coding agents working on this project.

## Project Scope

This repository is a TypeScript CLI for recruitment automation. The three core production browser platforms are `51job`, `liepin`, and `zhilian`. Boss (`boss`) is a supported single-platform extension for search/capture, configured resume forwarding, and unread-chat review, but it is deliberately excluded from multi-platform `all` runs.

Keep the platform adapter boundary intact. Platform-specific behavior belongs under `src/platforms/`; shared orchestration belongs in `src/index.ts`, shared browser helpers under `src/browser/`, and storage behavior under `src/storage/`.

`--platform all` is part of the public CLI surface. It must run platforms sequentially in this exact order:

1. `51job`
2. `liepin`
3. `zhilian`

If one platform fails during an all-platform run, stop immediately and propagate that error.

Boss must run only through `--platform boss`. Do not add it to `listSupportedPlatforms()`, `--platform all`, or the inner loop of `--platform all --jobs-file` unless the public all-platform contract is explicitly redesigned.

## Do Not Break

- New job keys require JD input through `--jd` or `--jd-file`; reruns reuse the persisted `jd.json` and must not reparse JD text unnecessarily.
- Job-scoped reusable inputs live in the same `data/<platform>/jobs/<jobKey>/jd.json`: JD, report delivery, search source, normalized direct-search conditions, original application-filter input, and Boss forwarding settings. Explicit CLI values replace the saved value; omitted values reuse it. Persist canonical single values rather than appending duplicate history entries, and do not rewrite an unchanged job record.
- `--jd-question` and `--rag-question` are aliases for candidate-facing JD/RAG question answering. They are standalone: do not open browsers, capture resumes, score candidates, export reports, or send email. With a stored `jobKey`, answer through the persisted RAG path and do not reparse JD text. With temporary `--jd` or `--jd-file`, answer from the provided JD only, do not create job records, do not write persistent RAG indexes, and do not append `answer-logs.jsonl`.
- RAG persisted facts live under `data/<platform>/jobs/<jobKey>/rag/`. Treat local JSONL files as the source of truth; Qdrant is a rebuildable index. Do not make Qdrant the only copy of JD, chunks, conversations, embeddings, or answer logs.
- Only verified recruiter facts may answer future candidate questions. For conversation ingestion, store full turns, but only `role: recruiter` with `verified: true` should become indexed factual chunks. Candidate turns and unverified recruiter turns are context/audit data, not answer facts.
- RAG retrieval must preserve platform and job isolation with metadata filtering. Hybrid retrieval is the default (`RAG_RETRIEVAL_MODE=hybrid`): dense Qdrant recall plus local BM25 keyword recall, fusion, and lightweight reranking. `dense` mode is only a diagnostic/override path.
- RAG answer failures or no-answer cases must not invent facts. If no trusted JD or verified conversation chunk meets the confidence threshold, return an explicit no-answer result instead of calling the model to speculate.
- RAG feedback, review, metrics, ops, eval, answer-eval, and regression commands are operational quality loops. Offline eval/regression paths must not append production `answer-logs.jsonl`.
- `rag:api` is an internal product HTTP interface for RAG. It may enforce `RAG_API_KEY`/`--api-key`, but it is not a full auth gateway: multi-tenancy, RBAC, rate limiting, centralized audit, monitoring alerts, and front-end management belong to upstream infrastructure or later product layers.
- The console assistant is only a structured draft layer. `src/server/cli-assistant.ts` may call a model to produce an `AssistantDraft`, but it must reject arbitrary shell/script/file-write requests and must not execute or persist model-suggested commands.
- Console model settings from the web UI (`baseUrl`, `model`, `apiKey`) are request-scoped overrides for assistant draft generation and console RAG question answering only. Do not store the API key in task records, assistant drafts, persisted config files, logs, answer logs, or model input text, and do not let it alter confirmed task execution.
- `/api/assistant/confirm` must finalize the draft, then reuse `src/server/task-normalizers.ts` and the existing `TaskQueue`. Do not bypass normalizers, do not treat preview argv as an execution source of truth, and do not add a separate assistant-specific task runner.
- Assistant `rag-answer` is a standalone answer path. It must not create tasks, open browsers, capture resumes, score candidates, export reports, or send email. Stored-job and temporary-JD behavior must follow the same rules as `--jd-question`/`--rag-question`.
- Assistant drafts for normal capture, batch, search-subscription, login-refresh, Boss auto-chat, and RAG ops must preserve the same mode isolation and platform constraints as the CLI/API paths. Unsupported or unsafe draft fields should be dropped or warned about before confirmation, and confirmation must still fail through the shared normalizers when the request is invalid.
- Batch mode uses `--jobs-file` as the only source of job definitions. Do not allow it to combine with single-job `--keyword`, `--jd`, or `--jd-file`; normal run-level switches such as `--include-viewed`, `--email`, `--cc`, `--search-source`, `--application-filter-input-file`, and valid Liepin forwarding remain allowed. Jobs-file items may set `searchSource` and `applicationFilterInputFile`; job-level values override CLI-level defaults, and relative job-level filter paths resolve from the jobs file directory.
- With `--platform all --jobs-file`, the outer loop is jobs-file order and the inner loop is `51job`, `liepin`, `zhilian`.
- Search-subscription mode (`--search-subscription-file`) is standalone. It must not parse JD text, create job records, capture resumes, score candidates, export reports, or send email.
- `--search-source saved|direct` is only for normal resume-capture runs and defaults to `saved` for a new job. On a rerun, omitting it reuses the job's persisted source and conditions; providing it explicitly replaces the persisted search settings. `saved` keeps the existing saved subscription/quick-search behavior. `direct` bypasses saved search tags, opens the platform search page, clears old filters/state, fills the raw keyword, applies application-filter input conditions, applies the platform viewed-filter state, then continues the normal candidate extraction, detail opening, forwarding, scoring, export, and email flow.
- `--application-filter-input-file` is only valid with explicit `--search-source direct` in normal resume-capture runs. It uses the platform's `data/<platform>/filter-catalog/application-filter-options.latest.json` to build and persist `applicationFilter` conditions. Later reruns may omit both arguments and replay the persisted conditions without rereading the input or catalog file. Any skipped or failed direct-mode search condition is a run error; do not continue to capture candidates from a partially applied direct filter set.
- `--include-viewed` defaults to `false`. It is only for normal resume-capture runs and must remain rejected in search-subscription mode.
- Explicit empty-result states are successful zero-candidate runs, not extraction failures. This includes 51job text such as `没有搜索到相关的人才` and stable empty result lists.
- Only successfully captured resumes are marked seen. Detail-open or extraction failures stay retryable.
- Mark successful captures as seen before scoring.
- Model scoring failures must persist `status: failed` score artifacts and must not undo seen state.
- Latest run-result files stay lightweight: store platform, counts, and candidate ID lists rather than full candidate card payloads.
- Exported markdown reports and email bodies must preserve a visible platform-source label.
- Boss work must reuse the platform-scoped headed browser and the existing Boss tab whenever possible. Search and chat automation must not repeatedly open the Boss login URL, create extra Boss tabs, or replace the current authenticated search/chat page; the reusable Boss CDP port defaults to `19331`.
- Boss forwarding options `--boss-forward-mode colleague|email` and `--boss-forward-recipient` must be provided together and are valid only for Boss. Both modes put the candidate ID in the forwarding message. Colleague mode must select one exact dropdown match; email mode fills the recipient address. A forward failure before successful capture keeps the candidate retryable.
- Boss auto-chat (`--boss-auto-chat true`) is standalone and requires `--platform boss`. Explicit forwarding mode/recipient and summary delivery are saved under `data/boss/chat-review/automation-settings.json`; later runs may omit them and reuse job-scoped forwarding first, then the Boss platform default. It must not combine with normal capture, batch, search-subscription, report-email, or JD/RAG question flags. Summary delivery uses `--boss-chat-summary-email` and optional `--boss-chat-summary-cc` and is separate from normal job-report delivery. Replying to unmatched candidates is run-scoped and defaults off; only `--boss-chat-reply-unqualified true` may send the fixed rejection phrase.
- Boss auto-chat must snapshot red-dot conversations before opening any of them. Open each red-dot conversation first, wait for the current conversation, candidate summary, and message list to hydrate, then branch on prior-chat state. Previously chatted conversations do not require a stored JD or forwarding configuration; first-contact conversations read the conversation job, reuse the stored Boss JD, and process only supported jobs. A first-contact conversation with missing JD or forwarding configuration is a retryable failure after opening and must not be added to reviewed IDs.
- After opening each red-dot Boss conversation, record whether the candidate was previously chatted with. Prefer Boss `bothTalked` state, then visible recruiter-authored history, then visible message count greater than the unread count captured before opening. If previously chatted, extract the last `unreadCount` candidate-authored messages in chronological order, persist them as `newCandidateReplies`, set `status: follow_up_reply`, and stop: do not open the resume, read or evaluate JD, score, forward, send a phrase, or request phone exchange. Normalize text whitespace; use explicit typed placeholders for images, resumes, attachments, voice, video, and other non-text messages. If extraction is unreliable, record a retryable failure instead of an empty reply.
- Boss chat deduplication is event-aware. A conversation with a current red-dot snapshot must be processed even when its conversation ID is already in `reviewedConversationIds`; the ID only suppresses repeated recovery of a failed item that has no new red dot. A successfully persisted follow-up event may add the ID again, and a future red dot for the same ID remains processable.
- Boss strict matching with `--boss-chat-require-all true` is currently configured for `物业电工`: age must be strictly below 47, both high-voltage and low-voltage certificates need explicit evidence, property-industry electrician experience needs explicit evidence, at least one company tenure must reach 24 months, and the resume must explicitly establish that the candidate is from Shanghai. Expected/current location `上海` is not native-place evidence. Missing evidence is a rejection, not permission to infer, except for the controlled Shanghai-origin clarification below.
- Boss Shanghai-origin clarification applies only when the other five property-electrician requirements are all met, the resume does not explicitly establish a Shanghai or non-Shanghai native place, and an education entry provides a Shanghai-school clue. In that case close the resume, type the exact text `是上海人吗？` into `#boss-chat-editor-input[contenteditable="true"]`, click the main send button, record `status: awaiting_clarification`, and do not forward, reject, or request phone exchange. Do not overwrite a non-empty editor containing other text. Do not add the conversation to reviewed IDs; wait for a later red-dot reply. Shanghai schooling is only a reason to ask, never evidence that the candidate is from Shanghai.
- Qualified and enabled unqualified Boss chat messages must be selected from the page's common-phrase panel opened through `.toolbar-icon.changyongyu`; do not fill the editor directly for those messages. For a matched candidate, keep the resume dialog open and forward first, record `forwarded: true`, close the resume, select `方便发一份你的简历过来吗？`, send it, then request phone exchange through `换电话` -> `确定`. For an unmatched candidate, close the resume and mark the review complete without replying by default. Only when `--boss-chat-reply-unqualified true` is explicit, select the page's `对不起，看了你的简历以后觉得不太合适，希望你早日找到满意的工作机会` and send it; never forward or request phone exchange for an unmatched candidate. The Shanghai-origin clarification is the only direct-editor exception. Message and phone actions must remain idempotent.
- A Boss contact failure after successful forwarding must preserve `forwarded: true`, record `status: failed`, and render `已转发，但联系动作未完成`. Do not automatically forward that resume again. Failures before forwarding remain retryable even if opening the conversation removed its red dot; recover the latest unforwarded failed item from prior chat-review runs when it is still visible.
- On the current Boss chat page, open `.resume-btn-online` with Playwright's native locator click. A DOM `element.click()` can create a hidden iframe without opening the dialog. Wait for both the target conversation ID and hydrated `.base-info-single-container` data, including `ageDesc`, before reading the snapshot. Resume details may arrive through iframe `IFRAME_DONE` WASM data; do not persist the raw decrypted payload.
- Zhilian scored-candidate emails must use copied colleague-forward resume share links. Missing or duplicated current-run Zhilian share links are delivery errors.
- In direct normal resume-capture mode, Zhilian must not click a saved quick-search tag. It should open `/app/search`, clear stale conditions when possible, fill the top keyword input, trigger search, confirm visible `关键词：<keyword>`, apply requested filters, then set `未看过` according to `--include-viewed` while preserving `未聊过`.
- Zhilian search extraction must run only after the saved quick-search condition is confirmed active, using visible text such as `关键词：<raw --keyword>`. If setting `未看过` for default runs or clearing it for `--include-viewed true` drops the quick-search condition, reselect the saved quick-search tag and set `未看过` to the requested state again before extraction. Do not clear `未聊过` for include-viewed reruns.
- Zhilian candidate extraction must only process real search-result cards. Cards after a `更多相关人才` boundary are recommendation results and must not be opened, scored, exported, emailed, or marked seen. `--include-viewed true` means explicitly clearing `未看过`; do not reinterpret it as clearing unrelated filters.
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
| `boss` | `storage-state.boss.json` | Reuse the current Boss search page for normal capture/direct filters; reuse `/web/chat/index` for auto-chat | Search cards plus Boss resume modal/API/WASM data; chat conversations use Vue state and red-dot snapshots | Boss is single-platform only and never part of `all`. Keep the current authenticated page/tab open. Configured resume forwarding supports colleague or email with candidate ID as the message. Auto-chat selects `未读`, evaluates against the conversation job's stored JD, forwards matched resumes before chat/phone actions, persists review runs, and sends an optional SMTP summary. |

All adapters share one search wait contract: the main workflow creates a single search deadline before opening platform search entry and passes it through search opening and candidate extraction. Avoid adding fixed waits in series that exceed the shared deadline.

Detail opening should follow the same total-deadline style across platforms. For 51job and Liepin, race popup/current-page navigation/content readiness within the deadline. For Zhilian and Boss, use the modal readiness path without repeating a full detail wait.

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
- Reusable browser mode is implemented for all browser platforms with platform-scoped CDP ports and browser profiles. 51job, Liepin, Zhilian, and Boss default to reusable headed mode. Liepin still forces headed mode even when `PLAYWRIGHT_HEADLESS=true`.
- Resume extraction can use the optional Crawl4AI runtime at `.venv/bin/python`; if unavailable, the built-in parser fallback should continue.
- SMTP delivery uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.

Key browser timing env vars:

- `BROWSER_ENGINE=cloakbrowser|playwright`
- `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` default `20000`
- `PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS` default `2000`
- `PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS` default `3000`
- `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` default `20000`
- `PLAYWRIGHT_ACTION_DELAY_MIN_MS` / `PLAYWRIGHT_ACTION_DELAY_MAX_MS` default `0-0` outside Liepin and Boss; Boss defaults to `1000-2000ms`
- `PLAYWRIGHT_CANDIDATE_DELAY_MIN_MS` / `PLAYWRIGHT_CANDIDATE_DELAY_MAX_MS` default `0-0` outside Liepin
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN|BOSS>_ACTION_DELAY_MIN_MS` / `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN|BOSS>_ACTION_DELAY_MAX_MS`
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN|BOSS>_CANDIDATE_DELAY_MIN_MS` / `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN|BOSS>_CANDIDATE_DELAY_MAX_MS`
- `PLAYWRIGHT_REUSE_BROWSER` default `false` outside platforms with their own defaults
- `PLAYWRIGHT_<51JOB|LIEPIN|ZHILIAN|BOSS>_REUSE_BROWSER`; 51job, Liepin, Zhilian, and Boss default enabled unless set to `false`
- `PLAYWRIGHT_51JOB_REUSE_CDP_PORT` default `19325`
- `PLAYWRIGHT_LIEPIN_REUSE_CDP_PORT` default `19327`
- `PLAYWRIGHT_ZHILIAN_REUSE_CDP_PORT` default `19329`
- `PLAYWRIGHT_BOSS_REUSE_CDP_PORT` default `19331`
- Existing `PLAYWRIGHT_LIEPIN_*ACTION_DELAY*`, `PLAYWRIGHT_LIEPIN_*CANDIDATE_DELAY*`, and `PLAYWRIGHT_LIEPIN_REUSE_*` names remain supported as the Liepin platform overrides.

## Common Commands

Prefix shell commands with `rtk`.

Install and verify:

- `rtk npm install`
- `rtk npm run typecheck`
- `rtk npm run test`
- `rtk npm run build`

Run from source:

- First run with inline JD: `rtk npm run dev -- --platform <51job|liepin|zhilian|boss|all> --keyword "<keyword>" --jd "<JD text>" [--email user@example.com] [--cc a@example.com,b@example.com]`; `all` still excludes Boss.
- First run with JD file: `rtk npm run dev -- --platform <platform> --keyword "<keyword>" --jd-file ./fixtures/jd.txt`
- Rerun existing job key: `rtk npm run dev -- --platform <platform> --keyword "<keyword>"`
- Include already-viewed candidates: `rtk npm run dev -- --platform <platform|all> --keyword "<keyword>" --include-viewed true`
- Liepin forward contact: `rtk npm run dev -- --platform <liepin|all> --keyword "<keyword>" --liepin-forward-contact "<contact name>"`
- Boss email forwarding during a first normal capture: `rtk npm run dev -- --platform boss --keyword "<keyword>" --jd "<JD text>" --boss-forward-mode email --boss-forward-recipient "recipient@example.com"`; an existing Boss job key may omit `--jd`.
- Boss strict unread-chat review, first configuration: `PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --boss-auto-chat true --boss-chat-require-all true --boss-forward-mode email --boss-forward-recipient "resume@example.com" --boss-chat-summary-email "summary@example.com" [--boss-chat-summary-cc "audit@example.com"] [--boss-chat-reply-unqualified true]`; later runs may omit the forwarding and summary delivery arguments, while unmatched replies remain off unless explicitly enabled for that run.
- Direct normal capture with filter input: `rtk npm run dev -- --platform <platform|all> --keyword "<keyword>" --jd-file ./fixtures/jd.txt --search-source direct --application-filter-input-file ./filter-input.json [--include-viewed true] [--liepin-forward-contact "<contact name>"]`
- Batch mode: `rtk npm run dev -- --platform <platform|all> --jobs-file ./jobs.json [--search-source direct] [--application-filter-input-file ./filter-input.json] [--include-viewed true] [--liepin-forward-contact "<contact name>"]`
- Search-subscription mode: `rtk npm run dev -- --platform <platform|all> --search-subscription-file ./search-subscription.json [--keyword "<keyword>"] [--search-subscription-name "<name>"] [--save-search-subscription true]`
- Search-filter discovery: `rtk npm run discover:filters -- --platform <51job|liepin|zhilian|boss|all> --keyword "<keyword>" [--max-depth 3] [--max-options-per-level 50] [--include-remote-probes true] [--slow-click true]`; `all` still excludes Boss.
- Liepin industry tree discovery: `rtk npm run discover:liepin-industry-tree -- --keyword "<keyword>" [--field engaged_industry,expected_industry]`
- Liepin option verification dry-run: `rtk npm run verify:liepin-filter-options -- --keyword "<keyword>" [--limit 10] [--field work_years,education]`; industry fields use tree leaf paths when the industry catalog has been collected.
- Liepin option verification live run: `rtk npm run verify:liepin-filter-options -- --keyword "<keyword>" --run true --limit 10`; for industry-only checks use `--field engaged_industry,expected_industry`.

Run compiled CLI:

- `rtk npm start -- --platform <platform|all> --keyword "<keyword>" --jd "<JD text>"`
- `rtk npm start -- --platform <platform|all> --jobs-file ./jobs.json`

Session and live diagnostics:

- `rtk npm run login:session -- --platform <51job|liepin|zhilian|boss> [--keep-open]`
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

- `src/index.ts` - CLI parsing and orchestration for single jobs, all-platform jobs, batch mode, saved/direct normal capture, search-subscription mode, and standalone Boss auto-chat.
- `src/config.ts` - environment loading and runtime configuration.
- `src/types/job.ts` - shared contracts for jobs, candidates, resumes, scores, and run results.
- `src/parsers/jd-parser.ts` - model-based JD normalization with Zod validation and keyword-first `jobKey` derivation.
- `src/scoring/score-resume.ts` - model-based resume scoring with Zod validation.
- `src/browser/session.ts` - browser-engine session creation, manual refresh, reusable Liepin browser wiring, and persisted auth verification.
- `src/browser/subscribe-search.ts` - 51job subscription-search entry flow.
- `src/browser/candidate-list.ts` - 51job candidate card extraction and empty-result readiness.
- `src/browser/resume-detail.ts` - 51job resume opening and heuristic resume parsing.
- `src/platforms/*.ts` - adapter contract and concrete 51job, Liepin, Zhilian, and Boss implementations; `boss-chat.ts` owns Boss conversation/resume/contact actions.
- `src/search/search-subscription.ts` - standalone search-subscription orchestration.
- `src/search/filter-catalog.ts` - shared search-filter catalog types and discovery result schema.
- `src/search/filter-dom.ts` - pure DOM scanning helpers for search-filter discovery.
- `src/search/filter-discovery.ts` - standalone Playwright-based search-filter discovery runner.
- `src/rag/*.ts` - RAG fact storage, chunking, embeddings, Qdrant vector store, hybrid retrieval, answer generation, diagnostics, eval, review, metrics, ops, baseline, and regression logic.
- `src/server/routes.ts` - internal product HTTP routes for tasks, RAG, filter inputs, and assistant endpoints.
- `src/server/task-normalizers.ts` - shared HTTP and assistant request normalization, CLI argv previews, and mode-isolation validation.
- `src/server/cli-assistant.ts` - model-backed console assistant that produces structured drafts, warnings, missing-field prompts, and confirmable previews only.
- `src/server/task-queue.ts` - single in-process task queue used by HTTP and assistant-confirmed task runs.
- `src/server/task-scheduler.ts` - persistent, completion-driven scheduler for ordered search and Boss auto-chat task groups; it shares `TaskQueue` and supports stop-after-current-task control.
- `src/server/schedule-store.ts` / `src/server/schedule-normalizers.ts` - JSON-backed schedule/round persistence and shared schedule request validation.
- `frontend/src/App.tsx` - web console UI, including the `智能助手` page and draft confirmation flow.
- `src/reporting/resume-docx.ts` - DOCX resume rendering from `/Users/Admin/Downloads/简历模板.docx`, including template photo-slot handling.
- `src/reporting/boss-chat-summary.ts` - Boss chat-review summary rendering and SMTP delivery.
- `src/scoring/boss-chat-hard-requirements.ts` - explicit-evidence hard-requirement evaluation for the configured Boss property-electrician flow.
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

Boss chat-review state is separate from per-job run results:

- `data/boss/chat-review/reviewed-conversation-ids.json` - conversations whose processing is complete or whose resume was already forwarded.
- `data/boss/chat-review/runs/<timestamp>.json` - per-run conversation decisions, evidence, action states, and errors. The latest unforwarded failed item is the retry source when its red dot has already disappeared.

## Resume Parsing Guidance

`src/browser/resume-detail.ts` is heuristic-heavy. Prefer validating parser changes against stored snapshots and offline reparsing before changing live browser flow.

Preserve original field text where possible. Use page-structure cues instead of rewriting resume content or splitting same-company multi-role histories into invented records.

The parser combines whole-page section slicing, DOM work-history snapshots, and Chinese-language heuristics for company names, titles, industries, durations, schools, and noisy UI text. Keep changes narrow and covered by focused tests or stored-snapshot validation when possible.

DOCX resume export is an offline maintenance path, not part of normal capture/scoring/email orchestration. The default template is `/Users/Admin/Downloads/简历模板.docx`; stored-resume exports write under `data/<platform>/jobs/<jobKey>/exports/resumes/` unless `--output` or `--output-dir` is provided. Candidate photos may be embedded only from the candidate's own detail-page avatar evidence. Do not use platform default avatars, school images, logos/icons, SVG assets, or similar-candidate photos; if the real avatar cannot be confidently identified or downloaded, omit the photo rather than inserting the template sample or another person's image.
