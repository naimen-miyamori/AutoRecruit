# AGENTS.md

This file provides repository guidance for coding agents working in this project.

## Overview

This repository is a TypeScript CLI for a recruitment automation workflow. The production-ready browser paths currently cover 51job, Liepin, and Zhilian. The platform adapter boundary remains in place, and these three platforms are part of the formal CLI support surface.

Liepin and Zhilian are connected to the same full CLI path as 51job and are maintained as supported platform implementations. Their platform-specific regression command names still keep the `test:experimental:*` prefix for compatibility with existing scripts.

The CLI also supports `--platform all`, which expands to the stable supported platform order `51job`, `liepin`, then `zhilian`. All-platform runs execute the same single-platform workflow once per platform, sequentially, with a separate browser session and platform-scoped storage for each platform. If one platform fails, the all-platform run stops and propagates that error.

The current implemented path is:

1. Parse a freeform JD text block, either inline or from `--jd-file`, into a normalized JSON record only when the keyword-derived `jobKey` is new; reruns reuse the persisted JD payload.
2. Launch Playwright with a saved and still-valid login session for the selected platform; in headed mode, an expired session can be refreshed through a manual login window, then saved and verified before the run continues. In `--platform all` mode this happens independently for each platform in order.
3. Open the adapter-specific search entry. For 51job this means opening the subscription page, hovering the saved keyword card, resolving the talent-search trigger, and clicking it as soon as the click helper confirms it is ready.
4. Wait for the talent-search page to reach a known ready state, then collect candidate IDs from the result cards. Explicit empty-result text, including 51job filtered-empty pages such as `没有搜索到相关的人才`, or a stable empty result list is treated as a successful zero-candidate run rather than an extraction failure.
5. Deduplicate candidates per job key using local JSON state.
6. Open only new resumes, parse structured fields from the page text/DOM, and persist snapshots plus parsed JSON.
7. Mark successfully captured candidates as seen before scoring; candidates that fail detail opening or extraction remain retryable on later runs.
8. Score captured resumes afterward from stored resume JSON. Model scoring failures persist `status: failed` score artifacts and do not undo the seen state.
9. Export a markdown report and optionally email the latest run summary, including the existing no-new-candidates email path when zero new candidates are found.

The repository currently implements resume scoring, markdown export, and SMTP email delivery in `src/`, alongside the browser capture flow.

## Commands

- `npm install` — install dependencies. Recommended runtime is Node 24 LTS (`.nvmrc` is pinned to `24`), but Node 26 is also supported through the repository's custom Node hooks runtime.
- `npm run dev -- --platform 51job --keyword "东南亚 销售" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the full CLI from source with inline JD text for a first-time job key.
- `npm run dev -- --platform 51job --keyword "东南亚 销售" --jd-file ./fixtures/jd.txt [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the full CLI from source with a JD file for a first-time job key.
- `npm run dev -- --platform 51job --keyword "东南亚 销售" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — rerun an existing keyword-derived job key by reusing the stored `jd.json` without JD parsing.
- `npm run dev -- --platform liepin --keyword "东南亚 销售" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the Liepin full CLI from source with inline JD text for a first-time job key.
- `npm run dev -- --platform liepin --keyword "东南亚 销售" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — rerun an existing Liepin keyword-derived job key by reusing the stored `jd.json`.
- `npm run dev -- --platform zhilian --keyword "优衣库" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the Zhilian full CLI from source with inline JD text for a first-time job key. Zhilian requires a saved quick-search tag whose text contains the raw `--keyword`.
- `npm run dev -- --platform zhilian --keyword "优衣库" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — rerun an existing Zhilian keyword-derived job key by reusing the stored `jd.json`.
- `npm run dev -- --platform all --keyword "东南亚 销售" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run 51job, Liepin, then Zhilian sequentially from source. The same JD input seeds platforms without an existing `jd.json`; platforms that already have the keyword-derived job key reuse their own stored JD payload.
- `npm run dev -- --platform all --keyword "东南亚 销售" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — rerun all supported platforms only when every platform already has the keyword-derived `jd.json`; otherwise the first missing platform fails with the normal missing-JD error.
- `npm run build` — compile TypeScript into `dist/`.
- `npm start -- --platform 51job --keyword "东南亚 销售" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the compiled CLI with inline JD text for a first-time job key.
- `npm start -- --platform 51job --keyword "东南亚 销售" --jd-file ./fixtures/jd.txt [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the compiled CLI with a JD file for a first-time job key.
- `npm start -- --platform 51job --keyword "东南亚 销售" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — rerun an existing keyword-derived job key by reusing the stored `jd.json` without JD parsing.
- `npm start -- --platform all --keyword "东南亚 销售" --jd "<JD text>" [--email "user@example.com"] [--cc "cc1@example.com,cc2@example.com"]` — run the compiled CLI across all supported platforms in the same sequential order.
- `npm run reparse:resumes -- <platform> <jobKey>` — rebuild parsed resume JSON from stored snapshots for one job.
- `npm run score:stored -- <platform> <jobKey>` — rescore locally stored resumes for one job.
- `npm run export:results -- <platform> <jobKey>` — export the latest run’s markdown report for one job.
- `npm run migrate:platform-storage` — backfill missing `platform` fields in legacy `jd.json` and `results/*.json` files under the current data directory.
- `npm run validate:resumes` — validate stored resume extraction quality.
- `npm run capture:resume-dom -- --platform <platform> <jobKey> <searchKeyword> <candidateId>` or `npm run capture:resume-dom -- --platform <platform> <jobKey> <candidateId> <resumeUrl>` — capture or refresh one stored DOM snapshot.
- `npm run login:session -- --platform 51job [--keep-open]` — log in manually, save the 51job Playwright session, verify it can be reused from a fresh browser session, and optionally keep the browser open after verification.
- `npm run login:session -- --platform liepin [--keep-open]` — log in manually, save the Liepin Playwright session, and verify it from a separate fresh browser session.
- `npm run login:session -- --platform zhilian [--keep-open]` — log in manually at `https://passport.zhaopin.com/org/login`, save the Zhilian Playwright session, and verify it from a separate fresh browser session against the recruiter search shell.
- `npm run typecheck` — run the repository TypeScript type-check.
- `npm run test` — run the current stable test suite.
- `npm run test:scoring` — run scoring and orchestration semantic tests.
- `npm run test:export` — run export/report aggregation tests.
- `npm run test:maintenance` — run maintenance and report-delivery regression tests.
- `npm run test:experimental:liepin` — run Liepin platform diagnostics and regressions; the command name keeps the `experimental` prefix for script compatibility.
- `npm run test:experimental:zhilian` — run Zhilian platform diagnostics and regressions; the command name keeps the `experimental` prefix for script compatibility.
- `npm run debug:zhilian -- --keyword "优衣库"` — inspect the authenticated Zhilian recruiter search page, quick-search tags, and candidate-related responses for a raw keyword.
- `npm run smoke:liepin -- --keyword "<keyword>" [--parse-first]` — run the Liepin live smoke flow for auth, search, list extraction, and optional first-resume parsing.
- `npm run smoke:zhilian -- --keyword "优衣库" [--parse-first]` — run the Zhilian live smoke flow for auth, saved-tag search entry, list extraction, and optional first-resume parsing.
- `node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-lines.ts <platform> <jobKey> <candidateId>` — inspect extracted work-history lines for one stored resume snapshot.
- `node --import ./scripts/node-ts-hooks.mjs src/scripts/debug-work-boundaries.ts <platform> <jobKey> <candidateId>` — inspect work-history block boundary heuristics for one stored resume snapshot.

## Runtime requirements

- Recommended runtime is Node 24 LTS. This repository pins `.nvmrc` to `24` and declares `engines.node` as `>=24 <27`.
- Node 26 is also supported. Runtime scripts no longer use `tsx`; they preload `scripts/node-ts-hooks.mjs`, which uses `module.registerHooks()` plus TypeScript transpilation for source execution, avoiding the `DEP0205` warning caused by `tsx` calling deprecated `module.register()`.
- Supported platforms use separate default storage-state files: 51job uses `storage-state.json`, Liepin uses `storage-state.liepin.json`, and Zhilian uses `storage-state.zhilian.json`. `src/browser/session.ts` verifies persisted auth by opening the adapter’s authenticated home page. `npm run login:session -- --platform <platform>` saves the storage state from one browser context and then re-verifies it in a separate fresh browser session.
- If a saved login state is missing, expired, or otherwise invalid during a normal headed CLI run, `ensureAuthenticatedBrowserSession()` opens the platform login page, waits for manual login, persists the refreshed state, verifies it in a fresh headless session, then recreates the authenticated browser session and continues the current run. In headless mode this refresh is impossible, so the CLI errors and tells the operator to rerun with `PLAYWRIGHT_HEADLESS=false`.
- `--platform all` relies on the same per-platform storage-state defaults and should normally be run with `STORAGE_STATE_PATH` unset so each platform can load its own session file.
- JD parsing and resume scoring both require usable model API credentials via `OPENAI_API_KEY`.
- Resume extraction's Crawl4AI-enhanced path expects the repository Python runtime at `.venv/bin/python` and the `crawl4ai` package installed there.
- If that Crawl4AI adapter runtime is unavailable, the CLI and offline resume reparse flow automatically fall back to the built-in parser and continue running.
- Environment variables are loaded through `dotenv` in `src/config.ts`.
- Key supported env vars:
  - `DATA_DIR` to relocate persisted job data.
  - `PLAYWRIGHT_HEADLESS=true` to run headless; default is headed.
  - `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` to control the total search-entry plus candidate-list readiness budget; default is `20000`.
  - `PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS` to require a stable empty 51job result container before treating it as zero candidates; default is `2000`.
  - `PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS` to cap short API fallback waits when DOM candidates need URL enrichment or DOM has no candidates; default is `3000`.
  - `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` to control the total resume-detail open/readiness budget; default is `20000`.
  - `STORAGE_STATE_PATH` to override the storage state file path for the current invocation. Leave it unset for normal multi-platform use so each platform keeps its own default file. If you set it, point it at a platform-specific filename for that invocation only; shared paths like `storage-state.json` are intentionally rejected for non-51job platforms.
  - `OPENAI_BASE_URL` to point JD parsing and scoring at a compatible third-party model endpoint.
  - `OPENAI_MODEL` to provide the default model for both JD parsing and scoring.
  - `JD_PARSING_MODEL` to override the JD extraction model.
  - `SCORING_MODEL` to override the scoring model.
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` configure the SMTP delivery path used by report emailing.

## Architecture

### Entry flow

`src/index.ts` is the orchestration layer. It parses `--platform`, `--keyword`, optional `--email` / `--cc`, and JD input that is required only for first-time job keys. It derives a keyword-first `jobKey`, reuses the persisted `jd.json` without JD parsing when that key already exists, persists the job record, runs the browser workflow through the resolved platform adapter, captures and saves all new resumes first, updates `seen-ids.json` for successful captures, then scores the captured resumes from local JSON before writing a lightweight run summary. `--platform all` is handled at this layer by expanding to `listSupportedPlatforms()` and invoking the same concrete-platform flow serially for each supported platform.

### JD normalization

`src/parsers/jd-parser.ts` converts the raw JD text into `NormalizedJob` from `src/types/job.ts` through model-based JSON extraction:

- calls a model through the OpenAI SDK against an OpenAI-compatible Responses endpoint,
- asks the model to return one JSON object in plain text,
- validates the returned JSON with Zod,
- sanitizes optional fields and arrays before persistence,
- derives `jobKey` from the search keyword first and falls back to the parsed title when needed.

On reruns where the keyword-derived `jobKey` already exists, `src/index.ts` skips JD parsing entirely and reuses the persisted `rawText` plus `normalizedJob` from `jd.json`. First-time runs still require `--jd` or `--jd-file` so a new normalized record can be created.

### Scoring behavior

`src/scoring/score-resume.ts` also calls the model through the OpenAI SDK. Like JD parsing, it expects plain JSON text in the response, validates that payload with Zod, and then converts it into `CandidateScore`.

### Browser automation

The browser layer lives under `src/browser/` and is intentionally split by page responsibility:

- `session.ts` creates a Chromium context from the saved storage state when present, and `npm run login:session -- --platform <platform>` uses a fresh context for manual login before re-verifying the persisted state in a separate fresh browser session.
- `subscribe-search.ts` opens `https://ehire.51job.com/Revision/talent/subscribe`, checks for an obvious login page, hovers the requested keyword entry, resolves the talent-search trigger through several selector/text fallbacks, and lets the click helper own readiness checks before opening the search page. It uses the shared search deadline created by the main workflow.
- `candidate-list.ts` scrapes result cards by anchoring on `div[id^="no_interested_"]`, then extracts `candidateId` from IDs/HTML/text using several fallback regexes. It also derives lightweight card metadata like name, current company, and current title heuristically. Its readiness checks now require candidate cards, explicit empty-result text such as 51job's `没有搜索到相关的人才`, or a stable empty `.virtual_list` window before treating zero candidates as ready, and include deadline diagnostics when the list never renders.
- `resume-detail.ts` opens an individual 51job resume from the list card and parses the resume page. Detail opening uses one total deadline and races popup, current-page navigation, and current-page content readiness.
- `src/platforms/*.ts` holds the platform adapter contract plus concrete supported 51job, Liepin, and Zhilian implementations; auth/session entrypoints, search opening, list extraction, and resume-detail parsing now flow through these adapters.

All supported platform adapters accept the same search wait contract: the main workflow creates one deadline before opening the platform search entry and passes it to both `openSubscribeSearch()` and `extractCandidateList()`. DOM candidates are returned as soon as they are complete. 51job has no API fallback and uses DOM cards, explicit empty text such as `没有搜索到相关的人才`, or the stable empty-list window. Liepin and Zhilian are DOM-first; their API fallbacks are used only when DOM has no candidates or, for Liepin, when DOM candidates need safe detail URLs.

Zhilian-specific behavior lives in `src/platforms/zhilian-adapter.ts`:

- login opens `https://passport.zhaopin.com/org/login`
- authenticated search entry opens `https://rd6.zhaopin.com/app/search`, not `https://rd6.zhaopin.com/desktop`
- search entry must click a saved recruiter quick-search tag whose text contains the original raw `--keyword`
- resume detail stays on the same `/app/search` page as a modal overlay after the URL changes, so the parser must read the modal subtree instead of the underlying search list text
- candidate extraction is DOM-first and only waits for the candidate API fallback when DOM extraction yields no candidates; modal parsing uses a short readiness confirmation instead of repeating a full detail wait

Liepin manual-login polling is intentionally constrained:

- before authenticated recruiter cookies exist, it must not probe unrelated pages or other login pages in the same context
- once authenticated cookies exist, it may probe non-login recruiter pages and a dedicated fresh probe page to confirm recruiter-search readiness

Liepin search entry must click the requested quick-search tag and then ensure the `隐藏已查看` filter is checked before candidate ID extraction. On the live page this filter may only appear after clicking the results-page search button, so preserve the existing fallback that clicks the search button when the filter is missing but a visible search button exists. When the filter is clicked, stale `search-resumes` responses from before that click must not be reused: keep the cache reset/request-start barrier so late pre-filter API responses cannot populate the candidate list after hide-viewed is applied. Local `seen-ids.json` dedupe remains the final guard and should not be replaced by Liepin's platform-side viewed filter.

Liepin detail opening uses the same total detail deadline style as 51job. Its search-page readiness now shares the main search deadline across initial-data, shell, quick-search tag, hide-viewed filtering, DOM extraction, and `search-resumes` API fallback waits; it should not add multiple fixed 15s waits in series.

When changing selectors, preserve the current strategy of using several DOM fallbacks rather than assuming one stable 51job structure.

### Resume parsing strategy

`src/browser/resume-detail.ts` is the most heuristic-heavy module. Its parser combines:

- whole-page text section slicing (`工作经历`, `项目经验`, `教育经历`, `技能/语言`, `证书`),
- DOM-based work-history snapshots when available,
- many Chinese-language heuristics for distinguishing company names, titles, industries, durations, schools, and noisy UI text.

Important behavior:

- raw body text is saved to `snapshots/<candidateId>.txt`,
- parsed resume JSON is saved to `resumes/<candidateId>.json`,
- DOM work-history snapshots are saved separately under `snapshots-dom/`,
- reparsing is expected; `src/scripts/reparse-resumes.ts` rebuilds resume JSON from stored snapshots without hitting the website again.

Because this area is heuristic, prefer validating changes against stored snapshot files and reparsing before changing the live browser flow.

Also preserve the existing resume parsing constraint from project memory: keep original field text where possible and rely on page-structure cues instead of rewriting or splitting same-company multi-role histories into invented sub-records.

### Persistence model

`src/storage/job-store.ts` is the file-backed persistence layer. For each job key it creates:

- `data/<platform>/jobs/<jobKey>/jd.json` — saved `JobRecord` including persisted platform, recipient email, and CC emails.
- `data/<platform>/jobs/<jobKey>/seen-ids.json` — dedupe state for processed candidates.
- `data/<platform>/jobs/<jobKey>/resumes/<candidateId>.json` — parsed structured resume.
- `data/<platform>/jobs/<jobKey>/snapshots/<candidateId>.txt` — raw page text snapshot.
- `data/<platform>/jobs/<jobKey>/snapshots-dom/<candidateId>.json` — DOM-derived work-history snapshot.
- `data/<platform>/jobs/<jobKey>/scores/<candidateId>.json` — persisted score artifact for the candidate.
- `data/<platform>/jobs/<jobKey>/results/<timestamp>.json` — one lightweight run summary containing platform, counts, and candidate ID lists, not full candidate card payloads.
- `data/<platform>/jobs/<jobKey>/exports/latest.md` — latest exported markdown report.

Legacy persisted files created before platform-aware storage can be rewritten once with `npm run migrate:platform-storage`, which moves legacy top-level `data/jobs/` entries into `data/51job/jobs/`, backfills missing `platform` fields as `51job`, and refuses to overwrite an existing target job directory.

The repository already contains real captured data under `data/<platform>/jobs/` and may still include legacy `data/jobs/` directories before migration, so changes to types or parsers should consider migration/reparse impact on existing snapshots.

## Source map

- `src/index.ts` — CLI orchestration.
- `src/config.ts` — env loading and runtime configuration for browser automation, JD parsing, scoring, and SMTP.
- `src/types/job.ts` — shared contracts for JD records, candidate list items, resumes, and run results.
- `src/parsers/jd-parser.ts` — model-based JD normalization with plain-text JSON extraction, local parsing, and schema validation.
- `src/browser/*.ts` — Playwright navigation, subscription search opening, candidate extraction, and resume parsing.
- `src/platforms/*.ts` — platform adapter contracts plus concrete adapter implementations.
- `src/storage/job-store.ts` — local JSON persistence.
- `src/scripts/*.ts` — offline debug, export, email, reparse, login, and migration utilities.
- `项目说明文档.md` — current high-level project overview for usage, architecture, and operational notes.

## Notes from project docs

- The project is intentionally CLI-first and single-job-per-run for the MVP.
- `--platform all` is still a single job-key run; it repeats that job-key workflow across all supported platforms in registry order and returns an array of per-platform summaries.
- Local JSON storage is the chosen persistence layer for the current implementation.
- Resume scoring, markdown export, and report emailing are already implemented in `src/`.
- Report delivery persists both recipient email and CC email lists per `jobKey` unless explicitly overridden on a later run.
- Exported markdown reports and no-new-candidates email bodies should preserve a visible platform-source label so multi-platform runs remain distinguishable.
- The latest run-result files intentionally stay lightweight and are meant to support export/email filtering via candidate IDs rather than storing full candidate card snapshots.
- The 51job browser automation is still built around the subscription-search interaction: hover a saved subscription keyword, click the search trigger after a single centralized readiness check, then harvest candidate IDs from the “不感兴趣” area/card markup.
- Explicit empty-result text, including 51job filtered-empty pages like `没有搜索到相关的人才`, or a stable visible empty candidate list is a successful run outcome, not an extraction error; that path should still write a run result, export the latest markdown when possible, and send the no-new-candidates email when a recipient is configured.
- Successfully captured resumes are marked seen before scoring; extraction/open failures stay retryable.
- Model scoring failures persist failed score artifacts and remain visible to export/email without reverting the candidate's seen state.
- Platform-aware auth/session handling now lives on `PlatformAdapter`; 51job, Liepin, and Zhilian are the current supported runtime paths, with platform-specific diagnostics kept in separate commands.
- Liepin candidate extraction must happen after `隐藏已查看` is checked; stale `search-resumes` API responses captured before that filter is applied must be discarded before DOM/API candidate extraction proceeds.
