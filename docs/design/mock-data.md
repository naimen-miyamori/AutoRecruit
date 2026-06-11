# Console Mock Data

The frontend keeps preview data in `frontend/src/mock-data.ts` for offline UI inspection when `/api` is not running.

Covered mock states:

- Running and succeeded task summaries.
- One task detail with logs.
- 51job and Liepin job summaries.
- Job detail with JD, normalized job, export path.
- Candidate summaries with successful and failed score artifacts.
- Candidate detail with structured resume and snapshot preview.
- Zhilian filter catalog stats.

The mock data is intentionally small and contains no secrets, no real Stitch key, and no direct writes to `data/`.
