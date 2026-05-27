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
- Liepin candidate extraction defaults to running after `隐藏已查看` is checked. When `--include-viewed true` is provided, extraction must run after that filter is explicitly unchecked. Stale `search-resumes` API responses from before the final viewed-filter state is applied must be discarded.

## Platform Rules

| Platform | Storage State | Search Entry | Candidate Extraction | Special Rules |
| --- | --- | --- | --- | --- |
| `51job` | `storage-state.json` | Subscription page at `https://ehire.51job.com/Revision/talent/subscribe` | DOM cards anchored around `div[id^="no_interested_"]` | Hover saved keyword card, click talent-search trigger, preserve selector fallbacks, treat filtered-empty text as success. `--include-viewed true` clears `我已看`. |
| `liepin` | `storage-state.liepin.json` | Recruiter quick-search tag | DOM-first; API fallback only when DOM has no candidates or needs safe detail URLs | Manual-login polling must avoid unrelated probes before recruiter cookies exist. Click requested quick-search tag, ensure `隐藏已查看` by default, or uncheck it for `--include-viewed true`, then reset/request-start barrier before extraction. |
| `zhilian` | `storage-state.zhilian.json` | `https://rd6.zhaopin.com/app/search` saved quick-search tag | DOM-first; API fallback only when DOM yields no candidates | Login starts at `https://passport.zhaopin.com/org/login`. Saved tag text must contain raw `--keyword`. `--include-viewed true` clears visible `未看过` only. Resume detail is a modal on `/app/search`; parse the modal subtree, copy `转给同事` -> `链接转发` share link, and persist it as `candidateShareUrl`. |

All adapters share one search wait contract: the main workflow creates a single search deadline before opening platform search entry and passes it through search opening and candidate extraction. Avoid adding fixed waits in series that exceed the shared deadline.

Detail opening should follow the same total-deadline style across platforms. For 51job and Liepin, race popup/current-page navigation/content readiness within the deadline. For Zhilian, use the modal readiness path without repeating a full detail wait.

## Runtime

- Use Node 24 LTS by default. `.nvmrc` is `24`, and `package.json` declares `>=24 <27`.
- Node 26 is supported through `scripts/node-ts-hooks.mjs`; runtime scripts do not rely on `tsx`.
- Environment variables are loaded by `dotenv` in `src/config.ts`.
- `OPENAI_API_KEY` is required for JD parsing and resume scoring. `OPENAI_BASE_URL`, `OPENAI_MODEL`, `JD_PARSING_MODEL`, and `SCORING_MODEL` can override model routing.
- Browser auth uses platform-scoped Playwright storage state. Leave `STORAGE_STATE_PATH` unset for normal multi-platform runs so each platform uses its own default file.
- If a saved session is missing or expired, headed runs may refresh through manual login and then verify the new session. Headless runs cannot refresh sessions and should error with instructions to rerun headed.
- Resume extraction can use the optional Crawl4AI runtime at `.venv/bin/python`; if unavailable, the built-in parser fallback should continue.
- SMTP delivery uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.

Key browser timing env vars:

- `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` default `20000`
- `PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS` default `2000`
- `PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS` default `3000`
- `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` default `20000`

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
- Batch mode: `rtk npm run dev -- --platform <platform|all> --jobs-file ./jobs.json`
- Search-subscription mode: `rtk npm run dev -- --platform <platform|all> --search-subscription-file ./search-subscription.json [--keyword "<keyword>"] [--search-subscription-name "<name>"] [--save-search-subscription true]`

Run compiled CLI:

- `rtk npm start -- --platform <platform|all> --keyword "<keyword>" --jd "<JD text>"`
- `rtk npm start -- --platform <platform|all> --jobs-file ./jobs.json`

Session and live diagnostics:

- `rtk npm run login:session -- --platform <51job|liepin|zhilian> [--keep-open]`
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
- `src/browser/session.ts` - Playwright session creation, manual refresh, and persisted auth verification.
- `src/browser/subscribe-search.ts` - 51job subscription-search entry flow.
- `src/browser/candidate-list.ts` - 51job candidate card extraction and empty-result readiness.
- `src/browser/resume-detail.ts` - 51job resume opening and heuristic resume parsing.
- `src/platforms/*.ts` - adapter contract and concrete 51job, Liepin, and Zhilian implementations.
- `src/search/search-subscription.ts` - standalone search-subscription orchestration.
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

## Resume Parsing Guidance

`src/browser/resume-detail.ts` is heuristic-heavy. Prefer validating parser changes against stored snapshots and offline reparsing before changing live browser flow.

Preserve original field text where possible. Use page-structure cues instead of rewriting resume content or splitting same-company multi-role histories into invented records.

The parser combines whole-page section slicing, DOM work-history snapshots, and Chinese-language heuristics for company names, titles, industries, durations, schools, and noisy UI text. Keep changes narrow and covered by focused tests or stored-snapshot validation when possible.
