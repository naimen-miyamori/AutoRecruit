# Browser Instructions

These instructions apply to shared browser sessions, page readiness, pacing, and 51job-oriented
resume parsing under `src/browser/`.

## Session and Authentication

- Use platform-scoped storage state:
  - 51job: `storage-state.json`
  - Liepin: `storage-state.liepin.json`
  - Zhilian: `storage-state.zhilian.json`
  - Boss: `storage-state.boss.json`
- Leave `STORAGE_STATE_PATH` unset for normal multi-platform runs. Reject unsafe shared or
  cross-platform overrides.
- If a saved session is missing or expired, headed runs may refresh it through manual login and then
  verify the persisted state. Headless runs cannot refresh and must fail with a useful rerun message.
- Liepin is always headed. Manual-login polling must not probe unrelated pages before recruiter
  cookies exist.
- Zhilian login starts at `https://passport.zhaopin.com/org/login`.
- Reuse the current authenticated page and browser context rather than opening repeated login tabs.

## Reusable Browser Contract

- 51job, Liepin, Zhilian, and Boss default to reusable headed mode unless their platform override is
  `false`.
- Default CDP ports are `19325`, `19327`, `19329`, and `19331` respectively.
- Browser engine defaults to CloakBrowser. `BROWSER_ENGINE=playwright` is the supported fallback.
- A reusable run should leave the browser on the useful authenticated search/chat page. Close only
  detail pages or stale tabs that the platform contract says to close.
- Boss search, recommendation/deep-search, chat, and job-management flows share the Boss-scoped
  browser/profile and should reuse the current useful Boss tab.

## Deadlines and Readiness

- Orchestration creates one search deadline before opening search entry and passes it through search
  opening and candidate extraction.
- Avoid sequential full-timeout waits. Use remaining-time calculations and race all valid readiness
  paths inside the shared deadline.
- Detail opening follows the same total-deadline principle:
  - 51job and Liepin race popup/current-page navigation/content readiness.
  - Zhilian and Boss use modal readiness without repeating a full detail wait.
- A stable empty visible list or explicit platform empty text is successful readiness, not failure.
- Keep API fallback short and subordinate to DOM readiness.
- Pacing and readiness are different concerns. Pacing must happen before the relevant user action,
  while readiness waits for the resulting page state. Multi-action flows must budget both without
  silently exhausting the deadline.

Default timing configuration:

| Setting | Default |
| --- | --- |
| `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` | `20000` |
| `PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS` | `2000` |
| `PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS` | `3000` |
| `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` | `20000` |

## Pacing

- Use helpers in `src/browser/pacing.ts` for platform user actions and candidate transitions.
- Liepin action, successful detail closing, and candidate pacing defaults to uniform
  `2000-3000ms`.
- Boss action and candidate pacing defaults to `2000-4000ms`, weighted about 80% in
  `2000-3000ms` and 20% in `3001-4000ms`.
- Boss navigation, clicks, inputs, key presses, forwarding, talent matching/greet, job-detail sync,
  chat/contact actions, and candidate transitions must not bypass the shared pacing helper.
- Boss search keywords, direct chat text, and remarks must use the shared sequential typing helper.
  Its default randomized character delay is `80-180ms`, with an additional punctuation pause;
  `PLAYWRIGHT_BOSS_TYPING_DELAY_MIN_MS/MAX_MS` override the base range. Do not silently fall back to
  whole-value `fill()` when simulated typing fails.
- Platform-specific overrides use
  `PLAYWRIGHT_<PLATFORM>_{ACTION|CANDIDATE}_DELAY_{MIN|MAX}_MS`.
- Existing `PLAYWRIGHT_LIEPIN_*ACTION_DELAY*`, `PLAYWRIGHT_LIEPIN_*CANDIDATE_DELAY*`, and
  `PLAYWRIGHT_LIEPIN_REUSE_*` names remain supported as Liepin platform overrides.
- Pointer-driven actions use the context-scoped continuous trajectory in `src/browser/pacing.ts`.
  Every next click starts from the prior operation's recorded endpoint, including popup/current-page
  transitions. Native locator and DOM-event exceptions such as Boss chat resume opening and Zhilian
  salary boundaries must move the shared pointer to the target before clicking; no direct mouse move
  or coordinate click may bypass the shared tracker.
- DOM reads, parsing, model calls, local writes, and SMTP do not need artificial browser pacing.

## Candidate and Detail Semantics

- A detail-open or extraction failure remains retryable; only successfully captured resumes become
  seen.
- Liepin success waits one action interval before closing the detail page and foregrounding search.
  Liepin failures leave the detail open for inspection and stop the flow.
- A single failed 51job click selector must not consume the whole detail deadline.
- Modal platforms should parse the intended modal subtree rather than unrelated page chrome.

## Resume Parsing

`src/browser/resume-detail.ts` is heuristic-heavy and primarily owns 51job extraction fallbacks.

- Validate parser changes against stored snapshots and offline reparsing before changing live flow.
- Preserve original field text when possible.
- Use page-structure evidence; do not invent records by splitting same-company multi-role histories.
- Keep whole-page section slicing, DOM work-history snapshots, and Chinese-language heuristics narrow
  and covered by focused tests or stored-snapshot validation.
- Crawl4AI is optional. If `.venv/bin/python` or Crawl4AI is unavailable, the built-in parser must
  continue.

Useful offline checks:

- `rtk npm run reparse:resumes -- <platform> <jobKey>`
- `rtk npm run validate:resumes`
- `rtk npm run capture:resume-dom -- --platform <platform> <jobKey> <searchKeyword> <candidateId>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-lines.ts <platform> <jobKey> <candidateId>`
- `rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-boundaries.ts <platform> <jobKey> <candidateId>`
