# Zhilian Platform Instructions

## Scope and Inheritance

These instructions apply to Zhilian actions, parsing, adapter behavior, filters, delivery, and tests
under src/platforms/zhilian/. Apply the root AGENTS.md, src/platforms/AGENTS.md, and
src/browser/AGENTS.md first.

## Ownership and Boundaries

- Zhilian action modules own selectors, Vue-state compatibility, modal readiness, page controls,
  and platform-specific postconditions. The adapter is a registration/compatibility facade, not a
  place for UI interaction.
- Catalog field inventories, selectors, and filter values are maintained in action code, fixtures,
  and focused tests. Keep this document to behavioral constraints that survive those details.

## Search and Result Boundaries

- Login begins at the recruiter login flow and talent search uses the recruiter search page.
  Strict saved search reads exactly one trusted quick-search component, requires component and
  visible-card order/cardinality to agree, and reselects by stable native condition ID only after
  the complete canonical condition fingerprint matches. It then confirms the exact visible raw
  keyword. The user-provided subscription label is local metadata because this page does not expose
  a remote name; summary text, prefix matching, DOM order alone, and an already-active keyword never
  substitute for native identity.
- Direct normal capture never invokes a saved tag. It clears stale conditions when possible,
  supplies the keyword, confirms visible keyword state, applies requested filters, then establishes
  viewed state.
- Default capture explicitly enables not-viewed state. include-viewed clears only that state and
  preserves the unrelated not-chatted state. If changing it drops the saved keyword, restore the
  saved search and re-establish viewed state before extraction.
- Extract only true search cards before the recommendation boundary. Recommendation cards must not
  be opened, scored, exported, emailed, or marked seen. Prefer verified card state for stable
  identity before any candidate-API fallback.

## Detail, Delivery, and Filters

- Resume detail is a search-page modal. Parse only its intended subtree, wait an action interval
  after readiness before forwarding/parsing, then wait another interval and close the modal before
  the next candidate.
- Normal delivery obtains the current-run colleague-share link through the platform's forwarding
  flow and persists it as candidateShareUrl. A scored-candidate email requires exactly one unique
  current-run link per candidate; missing or duplicated links are delivery errors.
- The forwarding-link action shares one caller-owned detail deadline, preserves cleanup reserve,
  installs clipboard observation before any forwarding click, and revalidates the exact resume
  modal before and after delivery. Close only the unique forwarding-dialog close control and prove
  the underlying resume modal remains ready; Escape is unsafe because it also closes the resume.
  Resolve identity at the highest-priority canonical resume wrapper: nested wrapper/content matches
  from that same modal are one detail, while multiple matching canonical wrappers remain ambiguous.
  Missing link evidence is a `forward` failure, while parsing waits on the remaining lifecycle
  deadline rather than a fixed one-second window.
- Subscription mode uses the verified saved quick-search state rather than replacing it with a raw
  box search. Existing native conditions with the requested keyword are never reported absent merely
  because their remote name is unavailable, so save cannot create a duplicate. An explicit no-result
  state is successful.
- Filter discovery stays in the verified search condition panel and opens the platform's additional
  controls precisely; it must not use broad text actions that can target navigation or
  recommendations. Replay supports only the persisted catalog schema and confirms every requested
  value before candidates are read.
- Preserve visible domain semantics for custom ranges, monthly salary labels, cascade paths, and
  unsupported fields. When a salary boundary requires native clicking, perform it immediately
  inside the semantic action after continuous pointer positioning; do not route it through a delayed
  generic click helper.

## Verification

- Adapter/search/filter behavior: src/scripts/test-zhilian-adapter.ts.
- Filter discovery, catalog export, and application input behavior: matching
  src/scripts/test-*-filter-*.ts tests.
- Cross-platform action boundaries, run semantics, and delivery behavior:
  src/scripts/test-platform-action-boundaries.ts, src/scripts/test-scoring-run-semantics.ts, and
  the relevant export tests.
