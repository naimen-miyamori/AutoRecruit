import type { Page } from 'playwright';
import {
  prepare51jobSearchConditionPageWithOptions,
  read51jobSearchResultTotal,
  save51jobSearchCondition,
} from '../../../browser/51job-search-subscription.js';
import { config } from '../../../config.js';
import type { SearchCondition } from '../../../types/job.js';
import type { PlatformAdapter } from '../../types.js';
import { apply51jobSearchCondition } from './filter-actions.js';
import {
  apply51jobViewedCandidatePolicy,
  resolve51jobSearchDeadline,
  submit51jobDirectSearch,
} from './result-actions.js';

type DirectSearchOptions = Parameters<NonNullable<PlatformAdapter['openDirectSearch']>>[3];

/**
 * Estimates one bounded 51job search deadline. Saved-search entry has several
 * paced interactions before the viewed-policy and candidate snapshot can each
 * prove a stable result. Keeping that time in the caller-owned budget avoids
 * making the later snapshot fail merely because the entry flow consumed the
 * generic 30-second default.
 */
export function estimate51jobSearchTimeoutMs(input: {
  source: 'saved' | 'direct';
  conditions: readonly SearchCondition[];
  includeViewedCandidates?: boolean;
}): number {
  const pacingUpperBound = Math.max(config.playwright.actionDelayMaxMsByPlatform['51job'], 1);
  const stableWindowMs = Math.max(config.playwright.emptyResultsStableMs, 0);
  const isDirectSearch = input.source === 'direct';

  // Saved search: enter subscription, select the exact card, enter talent
  // search, and allow one possible viewed-filter transition. Direct search
  // additionally navigates, fills/submits the keyword, expands filters, and
  // performs the final verified submit. Each replayed condition may require
  // multiple paced controls, so reserve three action units per condition.
  const pacedActionUnits = isDirectSearch
    ? 8 + input.conditions.length * 3
    : 4;
  const stableResultWindows = isDirectSearch ? 3 : 2;
  const readinessBudgetMs = 24_000 + stableResultWindows * stableWindowMs;
  const estimatedMs = readinessBudgetMs + pacedActionUnits * pacingUpperBound;

  return Math.min(120_000, Math.max(config.playwright.searchPageTimeoutMs, estimatedMs));
}

export async function open51jobSubscribeSearch(
  ...args: Parameters<NonNullable<PlatformAdapter['openSubscribeSearch']>>
): Promise<Page> {
  const { openSubscribeSearch } = await import('../../../browser/subscribe-search.js');
  return openSubscribeSearch(...args);
}

export async function prepare51jobSearchCondition(
  ...args: Parameters<NonNullable<PlatformAdapter['prepareSearchConditionPage']>>
): Promise<Page> {
  return prepare51jobSearchConditionPageWithOptions(...args);
}

export async function read51jobSearchConditionResultTotal(
  ...args: Parameters<NonNullable<PlatformAdapter['readSearchConditionResultTotal']>>
): Promise<Awaited<ReturnType<NonNullable<PlatformAdapter['readSearchConditionResultTotal']>>>> {
  return read51jobSearchResultTotal(args[0]);
}

export async function savePrepared51jobSearchCondition(
  ...args: Parameters<NonNullable<PlatformAdapter['saveSearchCondition']>>
): Promise<void> {
  await save51jobSearchCondition(args[0], args[1]);
}

export async function open51jobDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: DirectSearchOptions,
): Promise<Page> {
  const deadline = resolve51jobSearchDeadline(options);
  // The direct-search preparation (navigation, keyword entry, and filter
  // setup) is part of the same search transaction as the viewed-policy and
  // final submit. Do not let an omitted caller deadline create a fresh budget
  // for that first phase.
  const searchOptions = { ...options, deadline };
  const searchPage = await prepare51jobSearchConditionPageWithOptions(page, keyword, searchOptions);
  for (const condition of conditions) {
    const result = await apply51jobSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      throw new Error(`51job direct search condition ${condition.kind} failed: ${result.message ?? result.status}`);
    }
  }

  await apply51jobViewedCandidatePolicy(searchPage, {
    includeViewedCandidates: searchOptions.includeViewedCandidates,
    deadline,
    signal: searchOptions.signal,
  });
  await submit51jobDirectSearch(searchPage, {
    includeViewedCandidates: searchOptions.includeViewedCandidates,
    deadline,
    signal: searchOptions.signal,
  });
  return searchPage;
}
