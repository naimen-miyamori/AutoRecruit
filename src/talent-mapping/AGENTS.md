# Talent Mapping Instructions

## Scope and Inheritance

These instructions apply to the isolated market-research domain under
src/talent-mapping/. Apply the root AGENTS.md first. Also read the platform scoped document when
changing a platform action, src/server/AGENTS.md when changing routes, queueing, scheduling, or
model-task execution, and frontend/AGENTS.md when changing the console.

## Ownership and Boundaries

- Talent Mapping supports only 51job, Liepin, and Zhilian. Boss is permanently outside this domain:
  do not add it to project plans, platform selection, runs, schedules, exports, read models, or UI.
- Mapping is independent from normal resume capture. It must not write ordinary job records,
  seen IDs, scores, reports, email delivery, forwarding, contact actions, or RAG facts.
- Platform adapters own browser interaction. Mapping owns project plans, bounded scan/enrichment
  orchestration, mapping-local persistence, deterministic aggregation, quality review, changes, and
  exports. It must never bypass semantic platform actions or expose selectors.
- Mapping-local JSON and JSONL files under data/talent-mapping/<mappingKey>/ are authoritative.
  Rebuildable views, indexes, reports, and exports must not become the only copy of observations,
  profiles, runs, reviews, or evidence.

## Project and Run Contracts

- Validate the versioned project plan before a run. Keep mappingKey, slice identity, platform
  selection, coverage bounds, enrichment mode, and immutable scan contract stable for each run.
- A card-only scan is a Talent Landscape or Mapping preliminary scan, never a complete Mapping.
  It reads cards only and preserves platform identity, slice, batch, rank, observation time, and
  source evidence.
- targeted-detail and full-detail open candidate detail only inside their configured caps and only
  after explicit confirmation for that run. A detail failure preserves the card observation and
  remains retryable; it must not silently become a completed profile.
- Preserve terminal evidence for every requested scan batch/slice. A successful run distinguishes
  explicit end, configured cap, empty result, failure, and cancellation; it never claims coverage
  from an unobserved or ambiguous terminal state.
- Results remain platform-isolated. A platform candidate ID is not a person identity, and no
  cross-platform match may merge observations automatically.

## Quality, Changes, and Model Assistance

- Possible cross-platform links are conservative review leads only. Confirmation requires a human
  reviewer, stated basis, source identities, audit record, and an explicit entity ID; revocation
  records its reason and rebuilds derived views. Only confirmed links affect the manual entity view.
- Compare only compatible successful scan/all runs. Report new observations, evidenced field
  changes, not-observed-again profiles, and unchanged profiles separately. Absence in a later scan
  is not evidence of resignation, job change, or withdrawal.
- Model classification is advisory. Send only the minimal approved inputs, validate output against
  the plan taxonomy, store a suggestion with source evidence, and apply it only after human review.
  An acceptance may fill a still-empty field, never overwrite stronger observed fact; rejected,
  stale, superseded, or revoked suggestions remain auditable and cannot enter the fact view.
- Review/accept/revoke flows must revalidate source observation ownership, freshness, evidence
  identity, remaining blank fields, and immutable snapshot/scan-contract compatibility before
  mutating a derived view.

## Scheduling, APIs, and Exports

- Only scan-stage projects whose enrichment mode is card-only are schedulable. Reject enrich, all,
  targeted-detail, and full-detail plans before queueing; a UI or API must not weaken this server
  normalizer.
- HTTP and classification work enter the shared TaskQueue through server normalizers. Mapping code
  does not create an alternate runner or trust preview arguments.
- Read models and exports make scope and completeness visible. CSV values that could be interpreted
  as formulas must be neutralized, and export summaries must distinguish observations, manually
  confirmed entities, review state, changes, and scan completeness.

## Verification

- Project plan, store, aggregation, export, quality, workflow, CLI, and server behavior:
  src/scripts/test-talent-mapping-*.ts and npm run test:talent-mapping.
- Scheduler restrictions and TaskQueue integration: src/scripts/test-task-scheduler.ts and
  src/scripts/test-server-api.ts.
- Console workflow, review UI, and task presentation: src/scripts/test-frontend-client.ts and
  npm run test:web.
- Run npm run typecheck after contract changes; run npm run test and npm run build when a shared
  type, route, scheduling, persistence, or frontend contract changes.
