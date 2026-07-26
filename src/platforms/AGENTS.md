# Platform Adapter Instructions

These instructions apply to platform adapters and Boss chat automation under `src/platforms/`.
Repository-wide mode, persistence, pacing, and verification contracts remain in the root
`AGENTS.md`.

## Adapter Boundary

- Keep platform-specific selectors, page behavior, filter replay, candidate extraction, detail
  parsing, and platform actions in this directory.
- Shared orchestration belongs in `src/index.ts`; shared browser primitives belong in
  `src/browser/`.
- Boss is single-platform only and must never enter the registry list used by `--platform all`.
- Search entry and extraction must use the shared search deadline passed by orchestration.
- Detail opening must use one total deadline. Race popup/current-page/content readiness for 51job
  and Liepin; use the modal path for Zhilian and Boss.
- A stable or explicitly identified empty result is a successful zero-candidate result.
- In direct capture, every requested condition must be applied and confirmed. A skipped or failed
  condition aborts the run before candidate extraction.

## Semantic Page Actions

- All four platform adapters are registration and compatibility facades. Keep user-visible page
  controls out of `51job-adapter.ts`, `liepin-adapter.ts`, `zhilian-adapter.ts`, and
  `boss-adapter.ts`; delegate them to the matching `src/platforms/<platform>/actions/` modules.
- Expose actions by business intent and domain, such as navigation, saved/direct search, filter
  replay, candidate extraction, resume detail, forwarding, or delivery. Do not expose arbitrary
  selectors, generic text clicks, or one public function per DOM node.
- Selectors, DOM/native compatibility paths, readiness checks, and action-specific fallbacks stay
  private to the platform action implementation. A private `internal-page-actions.ts` may retain a
  tightly coupled low-level compatibility fallback, but it must not remain the implementation owner
  for normal navigation, search, filter, candidate, resume, forwarding, or delivery actions.
- Adapters, workflows, scripts, and tests must not import a private page-action runtime directly.
  Import the typed domain action instead. A domain action file must own its public semantic action;
  do not satisfy this boundary with a file that only re-exports a multi-domain runtime.
- Pure resume text conversion belongs under `src/platforms/<platform>/parsing/` when the platform
  owns it. Parsers do not click, navigate, write local data, enter `TaskQueue`, or call models.
  The heuristic-heavy 51job parser remains owned by `src/browser/resume-detail.ts`.
- Page actions may validate page state and candidate identity, but must not write job records,
  mutation receipts, reports, or queue state. Confirmation, persistence, and workflow ordering stay
  in orchestration/workflow modules.
- The shared `src/browser/platform-action-context.ts` owns only selector-free page/deadline
  bookkeeping. Keep platform pacing, selectors, modal/popup differences, and post-action
  verification in platform code. Existing 51job heuristic text parsing may remain in
  `src/browser/resume-detail.ts`, but 51job navigation, search, candidate-card, and detail-control
  selectors are platform action concerns rather than shared browser primitives.
- Update `src/scripts/test-platform-action-boundaries.ts` whenever a platform facade or action
  directory changes. The boundary test must reject facade/private-runtime imports, platform page
  selectors outside their platform action ownership, and domain files that merely re-export a
  multi-domain runtime. Platform-specific behavior remains covered by direct domain-action tests as
  well as the matching adapter regressions.

## 51job

### Search and viewed state

- Saved mode starts at `https://ehire.51job.com/Revision/talent/subscribe`, clicks the matching saved
  keyword card, confirms the active subscription detail title matches the raw keyword, and clicks
  that panel's `去搜索` action.
- Confirm visible applied state such as `关键词：<keyword>` before extraction.
- Direct mode opens talent search, clears old filters, fills the raw keyword, applies requested
  conditions, and searches without using a saved subscription.
- Default capture explicitly checks `我已看`; `--include-viewed true` explicitly clears it before
  extraction.
- After talent search opens, close extra `我的订阅` tabs in the reusable context and keep the active
  session page on talent search.
- Preserve selector fallbacks and treat `没有搜索到相关的人才` as a successful empty result.

### Candidate detail

- Use `div[id^="no_interested_"]` only as a card anchor. The `no_interested_<id>` element is near
  `不感兴趣` and is not the detail trigger.
- Prefer candidate name/detail lines such as `.name`, `.detail`, or `.firstline`, then broader card
  regions.
- A failed click target must not consume the whole detail deadline; keep the popup/current-page
  navigation/content race inside the shared deadline.

## Liepin

### Session, search, and pacing

- Liepin is always headed. Manual-login polling must avoid unrelated probes before recruiter
  cookies exist.
- Reach recruiter talent search by clicking the top navigation `找人` when starting from recruiter
  home.
- Saved mode clicks the requested quick-search tag. Direct mode clears old filters, fills the raw
  keyword, triggers search, and applies requested conditions.
- Default capture explicitly checks `隐藏已查看`; `--include-viewed true` explicitly clears it.
  Discard stale `search-resumes` responses from before the final viewed-filter state.
- In-page actions, post-open resume dwell, successful resume-detail closing, and candidate transitions use
  the shared weighted `2000-4000ms` pacing. Every pointer click follows the shared continuous mouse trajectory; DOM or
  forced-click fallbacks must first move that same pointer to the target.
- After a successful parse and save, wait one Liepin action interval before closing the detail page
  and returning to search. On forwarding, detail-open, or extraction failure, stop the flow and
  leave the detail page open for inspection.

### Forwarding

- `--liepin-forward-contact` is valid only in normal Liepin capture, including Liepin jobs inside
  `--platform all` and batch runs. Reject it on other platforms and in search-subscription mode.
- Forward after opening a new detail and before parsing or seen marking. A forwarding failure keeps
  the candidate retryable.

### Filter discovery and replay

- `--slow-click true` discovery captures the expanded recruiter catalog. Normalize the current
  catalog to 25 filters and remove adjacent-row pollution.
- `discover:liepin-industry-tree` owns full current/expected industry trees. It overwrites those
  catalog entries with path-based leaves and writes application options.
- Search-subscription replay supports `work_years`, `education`, `school_nature`,
  `recent_activity_time`, `gender`, `language`, `living_location`, `expected_location`,
  `expected_salary`, `current_salary`, `job_hopping_count`, `job_status`, `resume_language`,
  `overseas_work_experience`, `management_experience`, `age`, `engaged_industry`,
  `engaged_function`, `expected_industry`, `expected_function`, `company_name`, `school_name`, and
  `major`.
- Clear existing filters before replay and close stale blocking dialogs. Open more conditions
  idempotently: click `展开更多条件` only when `收起更多条件` is not already visible.
- Salary is annual 万 and should use `wantSalaryLow`/`wantSalaryHigh` or
  `nowSalaryLow`/`nowSalaryHigh` when available. Age is a numeric year range.
- Industry/function conditions use the modal search/picker and must confirm before search readiness.
  Parent labels such as `AI/互联网/IT`, `消费品`, `生活服务`, and `交通/物流/贸易/零售` are path
  nodes, not replayable leaves. Prefer objects such as
  `{ "value": "电子商务", "pathLabels": ["AI/互联网/IT", "电子商务"] }`.
- `company_name`, `school_name`, and `major` are row-confirmed free text.
- Verify checkbox filters from real checked state (`input.checked` or Ant checked class), not only
  text or selected tags.
- Do not replay `keyword_title` as applicationFilter; search subscription maps the plan keyword to
  the top keyword/title input. Every applied filter must reach search readiness before reading total.

## Zhilian

### Search and result boundaries

- Login starts at `https://passport.zhaopin.com/org/login`; talent search is `/app/search`.
- Saved mode re-clicks the matching quick-search tag in reusable runs so stale filters cannot leak.
  Confirm visible `关键词：<raw keyword>`. If the tag is unavailable but the keyword state is already
  confirmed, use that confirmed state.
- Direct normal capture must not click a saved tag. Open `/app/search`, clear stale conditions when
  possible, fill the top keyword input, trigger search, confirm `关键词：<keyword>`, apply requested
  filters, then set viewed state.
- Default capture explicitly checks visible `未看过`; `--include-viewed true` clears only `未看过`
  and preserves `未聊过`.
- If changing `未看过` drops the saved keyword condition, reselect the tag and set the viewed state
  again before extraction.
- Extract only real search cards before the `更多相关人才` boundary. Recommendation cards must not
  be opened, scored, exported, emailed, or marked seen.
- Read Vue card props such as `userMasterId` and `resumeNumber` before candidate-API fallback when
  anchors do not expose usable IDs or URLs.

### Detail and delivery

- Resume detail is a modal on `/app/search`; parse only the modal subtree.
- After the modal becomes ready, wait one action interval before forwarding or parsing. After candidate
  processing, wait another action interval and close the modal before continuing.
- Copy `转给同事` -> `链接转发` and persist the current-run link as `candidateShareUrl`.
- Scored-candidate email requires one unique current-run share link per candidate. Missing or
  duplicated links are delivery errors.

### Search subscription and filter replay

- Subscription mode prepares search through the saved quick-search tag and confirms visible keyword
  state. Do not replace the saved search by filling the raw search box.
- Treat `没有符合条件的人才` as a successful zero-result summary.
- Filter discovery stays on `/app/search`, reuses the saved tag, confirms the visible condition
  panel, and expands that panel's `更多筛选`. Do not use broad non-exact `筛选` or `使用高级搜索`
  text clicks that may hit navigation or recommendation controls.
- The current catalog exports 19 fields. With `--slow-click true`, open recognized simple controls
  for `活跃日期`, `性别要求`, `求职状态`, `人才类型`, `人才照片`, `简历语言`, `跳槽频率`, and
  `期望月薪`; read full Vue `.s-cascader` trees for `现居住地`, `户口所在地`, `从事行业`,
  `期望行业`, `从事职位`, and `期望职位`; and read the `语言能力` popover.
- Replay supports `education`, `work_years`, `school_nature`, `recent_activity_time`, `gender`,
  `job_status`, `language`, `talent_type`, `talent_photo`, `resume_language`, `job_hopping_count`,
  `living_location`, `hukou_location`, `engaged_industry`, `expected_industry`, `engaged_function`,
  `expected_function`, `age`, and `expected_salary`.
- Education/work-years accept presets or custom select ranges. Age uses a visible preset when
  possible, otherwise numeric custom dropdowns. Salary uses monthly labels such as `2千` and `1万`.
- Salary boundary clicks must be immediate native locator clicks, not delayed generic mouse-move
  clicks. Confirm visible selected-condition text such as `期望月薪：3千-1万`.
- Cascader fields should prefer `{ "value": "...", "pathLabels": [...] }` to disambiguate labels.
  `expected_location` remains unsupported because the current catalog has no visible field.

## Boss

### Shared session and pacing

- Boss runs only as `--platform boss`. Reuse the platform-scoped headed browser, profile, CDP port
  `19331`, and current authenticated search/chat/talent/job-management tab whenever possible.
- Do not repeatedly open the login URL, create extra Boss tabs, or replace the current authenticated
  page.
- All navigation, click, input, key, forwarding, chat, phone, and candidate-transition actions use
  shared Boss pacing: default `2000-4000ms`, weighted about 80% in `2000-3000ms` and 20% in
  `3001-4000ms`.
- Boss pointer clicks also use the shared context-scoped trajectory. Locator-native and DOM-event
  compatibility paths must continuously move from the prior endpoint before executing the click.
- Boss talent-search keywords, direct chat messages, and remarks type sequentially through the
  shared browser helper. Search and remark replacement clears the prior value first; direct chat
  must preserve the non-empty draft guard. Common phrases remain option clicks and must not be
  converted to sequential typing.
- Account for pacing in multi-action deadlines. Do not make a valid forward/contact sequence
  impossible under the default timeout merely because its required paced actions consume the budget.

### Semantic page actions

- Boss page controls live under `src/platforms/boss/actions/` and are grouped by domain. Export
  semantic operations with typed identity and results; do not expose arbitrary selectors, generic
  text clicks, or one-file-per-DOM-control helpers.
- `boss-adapter.ts`, `boss-chat.ts`, `boss-operations.ts`, `boss-talent.ts`, and `boss-jobs.ts` are
  adapter/workflow/compatibility facades. They must not directly click, fill, press, navigate, or
  copy page selectors.
- Page actions may validate readiness and identity, but must not enter `TaskQueue`, write mutation
  receipts or job records, call models, or decide mode-level confirmation. Read action modules must
  not import mutation action modules.
- Keep selectors private to their domain action. Native and DOM compatibility clicks remain inside
  the concrete semantic action and continue to move the shared pointer before clicking.

### Normal capture and forwarding

- Reuse the current Boss search page for saved/direct normal capture and conditions.
- `--boss-forward-mode colleague|email` and `--boss-forward-recipient` must appear together and only
  on Boss.
- Both modes put the candidate ID in the forwarding message. Colleague mode selects exactly one
  dropdown match; email mode fills the recipient address.
- Forward after opening a new detail and before parsing or seen marking. A failure before successful
  capture keeps the candidate retryable.

### Talent discovery, deep search, and greet

- Recommendation and native deep-search modes are standalone and read-only by default. They must
  not enter normal capture, batch, search subscription, auto-chat, or `--platform all`.
- Candidate results must expose a stable Boss candidate ID. Visible card order is diagnostic only;
  never use a name or list index as the execution identifier.
- Deep-search requirements are separated into core and bonus groups. Synchronize them exactly and
  verify the resulting form before any match. Matching requires at least one core requirement,
  positive remaining quota, an enabled match control, and explicit confirmation.
- A match result returns at most the latest 20 candidates. Reading the current form or cards must
  never consume match quota.
- Single-candidate greet requires exact candidate ID plus expected candidate name and job name.
  Revalidate them immediately before the click, include Boss job ID when available, and treat an
  existing continue-chat state as already contacted rather than greeting again.

### Atomic chat operations

- Keep read-only conversation listing/opening/message-history/resume-preview distinct from chat
  mutations. All operations target an exact conversation ID and revalidate hydrated candidate/job
  identity when expectations are supplied.
- A mutation requires `confirmed: true` and a non-empty intent ID. Persist a successful receipt and
  return it on retry; an intent ID already bound to another operation or conversation is an error.
- Generic text sending must fail when the editor contains any existing draft. Never clear or
  overwrite user-authored text.
- Remark, not-fit, attachment-resume, phone, and WeChat actions must locate one unambiguous visible
  control, apply Boss pacing, and confirm dialogs where the platform requires confirmation.
- Atomic chat mutations are never schedulable. Do not weaken the fixed-common-phrase behavior of
  auto-chat when implementing generic atomic operations.

### Position/JD synchronization

- Read Boss position management as a source of open, pending, and closed positions. Closed positions
  stay included by default because existing unread conversations may reference them.
- Position identity is the stable Boss job ID. Build a distinct job key for each ID; same-name jobs
  must not merge, and detail hydration must match both expected ID and name before persistence.
- Hash normalized raw JD text before parsing. If the hash matches the stored position metadata,
  skip model parsing and do not rewrite `jd.json`.
- Parse a changed JD before saving. A parsing/detail failure records a failed sync item and must not
  overwrite the last valid job record. Preserve prior creation time, forwarding, delivery, and
  search settings on a successful update.
- Persist a latest position snapshot and timestamped sync run, while the normal Boss job record
  remains the authoritative JD copy.
- Auto-chat resolves a conversation by Boss job ID first. Name fallback is allowed only when the
  normalized job name maps to exactly one stored record; ambiguity is a retryable failure. Optional
  pre-review sync defaults off and aborts review when any requested position fails to sync.

### Auto-chat isolation and settings

- `--boss-auto-chat true` is standalone and requires Boss. Do not combine it with normal capture,
  batch, search subscription, normal report email, JD/RAG questions, or unrelated capture flags.
- Explicit forwarding and chat-summary delivery settings persist under
  `data/boss/chat-review/automation-settings.json`. Later runs reuse job-scoped forwarding first,
  then the Boss platform default.
- Summary delivery uses `--boss-chat-summary-email` and optional `--boss-chat-summary-cc`; it is
  separate from normal job-report delivery.
- Replying to unmatched candidates is run-scoped and defaults off. Only explicit
  `--boss-chat-reply-unqualified true` enables the fixed rejection phrase.

### Conversation snapshot and follow-up branch

- Snapshot all red-dot conversations before opening any. Open each red-dot conversation first and
  wait for current conversation, candidate summary, and message list hydration before branching.
- Previously chatted conversations require neither stored JD nor forwarding. First-contact
  conversations read the conversation job and stored Boss JD; unsupported jobs are not processed.
- Missing JD or forwarding on first contact is a retryable failure after opening and is not added to
  reviewed IDs.
- Record previous-chat evidence in this priority: Boss `bothTalked`, visible recruiter-authored
  history, then visible message count greater than the pre-open unread count.
- For a previous chat, extract the last `unreadCount` candidate-authored messages chronologically,
  persist them as `newCandidateReplies`, set `follow_up_reply`, and stop. Do not open the resume,
  read/evaluate JD, score, forward, send a phrase, or request phone exchange.
- Normalize whitespace and use typed placeholders for image, resume, attachment, voice, video, and
  other non-text messages. Unreliable extraction is a retryable failure, not an empty reply.
- Deduplication is event-aware: a current red dot is always processable even when its conversation ID
  was reviewed before. Reviewed IDs only suppress recovery of a failed item with no new red dot.

### Property-electrician strict matching

- `--boss-chat-require-all true` is configured for `物业电工` only.
- Require explicit evidence that age is below 47, both high- and low-voltage certificates exist,
  property-industry electrician experience exists, one company tenure reaches 24 months, and the
  candidate is from Shanghai.
- Current/expected location `上海` is not native-place evidence. Missing evidence is rejection, not
  permission to infer.
- Shanghai-origin clarification is allowed only when the other five requirements are met, native
  place is neither established as Shanghai nor elsewhere, and education provides a Shanghai-school
  clue. Close the resume, type exactly `是上海人吗？` into
  `#boss-chat-editor-input[contenteditable="true"]`, send, set `awaiting_clarification`, and do not
  forward, reject, request phone, or mark reviewed. Never overwrite a non-empty editor. Shanghai
  schooling is a reason to ask, never proof of origin.

### Resume, forwarding, contact, and failure order

- On chat, open `.resume-btn-online` with Playwright native locator click. DOM `element.click()` may
  create a hidden iframe without opening the dialog.
- Wait for the target conversation ID and hydrated `.base-info-single-container`, including
  `ageDesc`, before reading. Resume detail may use iframe `IFRAME_DONE` WASM data; never persist the
  raw decrypted payload.
- Qualified and enabled-unqualified messages must come from the common-phrase panel opened by
  `.toolbar-icon.changyongyu`; do not type those messages directly into the editor.
- Matched order is fixed: keep resume open, forward, persist `forwarded: true`, close resume, choose
  `方便发一份你的简历过来吗？`, send, then `换电话` -> `确定`.
- Unmatched order: close resume and complete review without reply by default. If explicit unmatched
  reply is enabled, choose exactly
  `对不起，看了你的简历以后觉得不太合适，希望你早日找到满意的工作机会` and send. Never
  forward or request phone for unmatched candidates.
- Shanghai clarification is the only direct-editor exception. Message and phone actions must remain
  idempotent.
- A contact failure after forwarding preserves `forwarded: true`, sets `failed`, and renders
  `已转发，但联系动作未完成`. Never auto-forward that resume again.
- Failures before forwarding remain retryable even when opening removed the red dot. Recover the
  latest visible unforwarded failed item from prior review runs.

## Focused Verification

- Boss action context and architecture boundaries: `src/scripts/test-boss-action-context.ts`,
  `src/scripts/test-boss-action-boundaries.ts`
- Boss conversation read/mutation actions: `src/scripts/test-boss-conversation-actions.ts`
- Platform registry/defaults: `src/scripts/test-platform-registry.ts`
- Shared capture/run semantics: `src/scripts/test-scoring-run-semantics.ts`
- Boss chat and strict matching: `src/scripts/test-boss-chat.ts`
- Boss talent discovery and guarded CLI modes: `src/scripts/test-boss-talent.ts`,
  `src/scripts/test-boss-cli-modes.ts`
- Boss atomic chat operations: `src/scripts/test-boss-chat-operations.ts`
- Boss position/JD sync: `src/scripts/test-boss-job-sync.ts`
- Liepin adapter/filter behavior: `src/scripts/test-liepin-adapter.ts`
- Zhilian adapter/filter behavior: `src/scripts/test-zhilian-adapter.ts`
- Filter option export: `src/scripts/test-export-application-filter-options.ts`
