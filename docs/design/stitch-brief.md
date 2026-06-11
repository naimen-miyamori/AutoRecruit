# Stitch Brief: Autorecruit Ops Console

Generate a dense internal operations console for a TypeScript recruitment automation CLI. The UI is a working application, not a landing page.

Audience:

- Recruitment operators running browser automation jobs.
- Engineers diagnosing platform adapters, RAG quality, filters, and task failures.

Screens:

- Dashboard with recent tasks, platform status, latest run results, success/failure/zero-candidate metrics.
- Run Job form with platform, keyword, JD text/file, includeViewed, searchSource, applicationFilterInputFile, email/cc, Liepin forward contact.
- Tasks list and detail with logs, inputs, outputs, errors.
- Jobs list and job detail with JD, normalized job, runs, candidates.
- Candidate detail with resume structure, score artifact, failure artifact, Zhilian share link, snapshot preview.
- RAG answer screen with confidence, sources, and no-answer state.
- Ops screen with RAG doctor/review/metrics and filter catalog diagnostics.

Design requirements:

- Chinese-friendly, table-first, high density.
- Clear state colors and compact controls.
- No marketing hero, no decorative gradient background.
- Use familiar icons for nav/actions.
- Cards only for repeated tiles or framed tools.

Implementation note:

Google Stitch output may be used as visual reference or React draft only. It must not be a production runtime dependency.
