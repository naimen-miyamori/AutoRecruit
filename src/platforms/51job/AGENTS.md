# 51job Platform Instructions

## Scope and Inheritance

These instructions apply to 51job actions, parsing integration, adapter behavior, and tests under
src/platforms/51job/. Apply the root AGENTS.md, src/platforms/AGENTS.md, and
src/browser/AGENTS.md first.

## Ownership and Boundaries

- 51job actions own 51job selectors, compatibility fallbacks, search-state verification, candidate
  identity, detail readiness, and postconditions. The adapter remains a registration/compatibility
  facade and must not directly operate user-visible controls.
- Keep page actions semantic and typed. Workflows own confirmation, persistence, seen state, scoring,
  and report delivery; the heuristic resume-text parser remains the documented browser exception.

## Search and Candidate Contracts

- Saved search starts from the recruiter subscription area, selects the exact saved keyword,
  verifies the active subscription title and visible keyword state, then enters that subscription's
  talent search. Do not extract from an unverified saved-search state.
- Direct search opens talent search, clears stale filters, supplies the raw keyword, applies every
  requested condition, and searches without invoking a saved subscription.
- Default capture explicitly enables the viewed-candidate filter; include-viewed explicitly clears
  it. After entering talent search, close stale subscription tabs and preserve the useful reusable
  search page. A popup search page is registered and returned before any
  subscription-page cleanup; the runtime handoff commits it and owns cleanup of the prior page.
- An explicit no-result state is a successful zero-candidate result. Preserve compatible selector
  fallbacks in the owning action and update direct action tests when the platform changes.
- Candidate actions must use a verified detail trigger, not decorative or rejection controls inside
  a card. A failed target attempt consumes only its remaining bounded detail budget; popup,
  current-page, and content readiness still race inside the caller's one detail deadline.

## Verification

- 51job semantic actions and fragile detail targeting: src/scripts/test-51job-actions.ts.
- Cross-platform facade/action ownership: src/scripts/test-platform-action-boundaries.ts.
- Registry, capture, and persistence semantics: src/scripts/test-platform-registry.ts and
  src/scripts/test-scoring-run-semantics.ts.
