# Liepin Platform Instructions

## Scope and Inheritance

These instructions apply to Liepin actions, parsing, adapter behavior, filters, and tests under
src/platforms/liepin/. Apply the root AGENTS.md, src/platforms/AGENTS.md, and
src/browser/AGENTS.md first.

## Ownership and Boundaries

- Liepin action modules own all recruiter-page controls, network/DOM compatibility, visible-state
  checks, selector fallbacks, and platform pacing. The adapter and workflow remain semantic facades.
- Keep discovery and replay behavior compatible with the persisted application-filter catalog.
  Catalog field inventories, selectors, and fixture values live in the implementation and focused
  filter tests, not in this document.

## Session, Search, and Detail Contracts

- Liepin is always headed. Before recruiter cookies exist, manual-login polling must not probe
  unrelated pages. From recruiter home, enter talent search through the recruiter find-people flow.
- Saved search selects the requested quick-search tag. Direct search clears stale filters, supplies
  the raw keyword, searches, and applies requested conditions.
- Default capture explicitly enables hidden-viewed state; include-viewed explicitly clears it.
  Discard stale search responses produced before the final viewed-filter state.
- All user actions, post-open dwell, successful detail closing, and candidate transitions use the
  shared platform pacing and continuous pointer path. After successful parse/save, wait the required
  action interval before closing detail and returning to search. On forwarding, detail-open, or
  extraction failure, stop and leave detail open for inspection.

## Forwarding and Filter Replay

- liepin-forward-contact is valid only for normal Liepin capture, including Liepin items inside
  all-platform and batch runs. Reject it for other platforms and search subscription.
- Forward a new detail before parsing or seen marking. A forwarding failure leaves the candidate
  retryable.
- Discovery expands the recruiter catalog without adjacent-row pollution. Industry-tree discovery
  owns the full current/expected industry trees and writes path-based application options.
- Clear existing filters and blocking dialogs before replay. More conditions open idempotently;
  every requested condition must be confirmed before totals or candidates are read.
- Preserve domain units and data shapes: salary is annual wan, age is numeric years, industry and
  function values use confirmed leaf paths, and row text values require row-level confirmation.
  Verify checkboxes through actual checked state, not labels or selected-tag text.
- The search-plan keyword maps to the top keyword/title input, never to an application-filter
  replay field. The supported filter schema is defined by the current catalog and its validation
  tests; unsupported values fail before extraction rather than being silently skipped.

## Verification

- Adapter/search/filter behavior: src/scripts/test-liepin-adapter.ts and
  src/scripts/test-liepin-filter-normalization.ts.
- Catalog discovery, export, validation, and industry-tree behavior: the matching
  src/scripts/test-*-filter-*.ts and src/scripts/test-liepin-industry-tree.ts tests.
- Cross-platform action boundaries and run semantics: src/scripts/test-platform-action-boundaries.ts
  and src/scripts/test-scoring-run-semantics.ts.
