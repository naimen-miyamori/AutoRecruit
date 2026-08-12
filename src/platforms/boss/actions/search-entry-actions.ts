import type { Page } from 'playwright';
import { config } from '../../../config.js';
import type { SearchCondition } from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import { waitBossActionPaceWithinDeadline } from './context.js';
import {
  applyBossDirectSearch,
  applyBossViewedCandidatePolicy,
  snapshotBossSearchFilterState,
} from './filter-actions.js';
import {
  assertBossSubmittableSearchKeyword,
  prepareBossSearchPage,
  submitBossPreparedSearch,
  type BossSearchSubmissionReceipt,
} from './search-actions.js';

const bossUnrestrictedJobName = '不限职位';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function throwIfBossSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Boss search condition application was cancelled.');
  }
}

async function assertBossSavedSearchState(
  page: Page,
  keyword: string,
  expectedRecentViewed: boolean | undefined,
  deadline: number,
  submission?: BossSearchSubmissionReceipt,
): Promise<void> {
  const state = await snapshotBossSearchFilterState(page, deadline);
  const expectedKeyword = normalizeText(keyword);
  const actualKeyword = submission?.keyword ?? state.keyword;
  if (actualKeyword !== expectedKeyword) {
    throw new Error(`Boss saved search keyword was not ready before submit: expected ${expectedKeyword}, observed ${actualKeyword || '(empty)'}.`);
  }
  if (state.jobScope !== bossUnrestrictedJobName) {
    throw new Error(`Boss saved search job scope was not ready before submit: expected ${bossUnrestrictedJobName}, observed ${state.jobScope || '(empty)'}.`);
  }
  if (expectedRecentViewed !== undefined && state.toggles.filter_recent_viewed !== expectedRecentViewed) {
    throw new Error(`Boss saved search viewed policy was not ready before submit: expected ${String(expectedRecentViewed)}, observed ${String(state.toggles.filter_recent_viewed)}.`);
  }
}

export async function openBossSubscribeSearch(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  assertBossSubmittableSearchKeyword(keyword);
  const deadline = createSearchDeadline(options);
  const searchPage = await prepareBossSearchPage(page, keyword, deadline);
  if (options?.includeViewedCandidates !== undefined) {
    await applyBossViewedCandidatePolicy(searchPage, options.includeViewedCandidates, deadline);
  }
  throwIfBossSearchAborted(options?.signal);
  await waitBossActionPaceWithinDeadline(searchPage, deadline);
  const expectedRecentViewed = options?.includeViewedCandidates === undefined
    ? undefined
    : !options.includeViewedCandidates;
  await assertBossSavedSearchState(searchPage, keyword, expectedRecentViewed, deadline);
  const submission = await submitBossPreparedSearch(searchPage, keyword, deadline, options?.signal);
  await assertBossSavedSearchState(searchPage, keyword, expectedRecentViewed, deadline, submission);
  return searchPage;
}

export async function openBossDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<Page> {
  return (await applyBossDirectSearch(page, keyword, conditions, options)).page;
}
