import type { Page } from 'playwright';
import { config } from '../config.js';
import {
  clickFirstVisibleSelector,
  clickFirstVisibleText,
  clickPrimarySearchButton,
  fillFirstVisibleInput,
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../search/page-actions.js';
import { clickPlatformLocator, gotoPlatformPage } from './pacing.js';
import type { SearchWaitOptions } from '../platforms/types.js';

const talentSearchPageUrl = 'https://ehire.51job.com/Revision/talent/search';
const subscribePageUrl = 'https://ehire.51job.com/Revision/talent/subscribe';
const platform = '51job';

export const openPageLevelSearchRef = {
  fn: openPageLevelSearch,
};

function resolveSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + config.playwright.searchPageTimeoutMs;
}

function getRemainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('51job direct search exceeded the shared search deadline before the next page action.');
  }
  return remaining;
}

function assertSearchNotAborted(options: SearchWaitOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error('51job direct search was cancelled before the next page action.');
  }
}

export async function openPageLevelSearch(page: Page, options?: SearchWaitOptions): Promise<Page> {
  const deadline = resolveSearchDeadline(options);
  assertSearchNotAborted(options);
  await gotoPlatformPage(page, platform, subscribePageUrl, { waitUntil: 'domcontentloaded', timeout: getRemainingTimeout(deadline) });
  assertSearchNotAborted(options);
  await gotoPlatformPage(page, platform, talentSearchPageUrl, { waitUntil: 'domcontentloaded', timeout: getRemainingTimeout(deadline) });

  if (await isLoginPage(page)) {
    throw new Error('51job authenticated talent search page is not available because the session has fallen back to the login screen.');
  }

  return page;
}

async function isLoginPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText();
  return bodyText.includes('登录') || (bodyText.includes('账号') && bodyText.includes('密码'));
}

async function clear51jobSearchFilters(page: Page, deadline: number, options?: SearchWaitOptions): Promise<void> {
  assertSearchNotAborted(options);
  const clearButton = page.getByText('清空筛选', { exact: true }).first();
  const isVisible = await clearButton.isVisible({ timeout: Math.min(1500, getRemainingTimeout(deadline)) }).catch(() => false);
  if (!isVisible) {
    return;
  }

  await clickPlatformLocator(clearButton, page, platform, getRemainingTimeout(deadline));
  await page.waitForTimeout(Math.min(300, getRemainingTimeout(deadline)));
}

export async function fill51jobSearchKeyword(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  assertSearchNotAborted(options);
  const didFillKeyword = await fillFirstVisibleInput(page, keyword, [
    '.talent_search_keywords_input input.el-input__inner',
    '.talent_search_keywords_input .el-input__inner',
    'input[placeholder*="OR"]',
    'input[placeholder*="关键词"]',
    'input[type="search"]',
    'input[type="text"]',
  ], Math.min(5000, getRemainingTimeout(deadline)), platform);

  if (!didFillKeyword) {
    throw new Error('Search subscription on 51job could not find the keyword input on the talent search page.');
  }

  assertSearchNotAborted(options);
  const didTriggerSearch = await clickPrimarySearchButton(page, Math.min(3000, getRemainingTimeout(deadline)), platform);
  if (!didTriggerSearch) {
    throw new Error('Search subscription on 51job could not trigger the keyword search on the talent search page.');
  }
}

export async function expand51jobAdvancedFilters(page: Page, options?: SearchWaitOptions): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  assertSearchNotAborted(options);
  await clickFirstVisibleSelector(page, [
    '.more',
    '.expand',
    '.advanced-search',
    '.filter-more',
    '[class*="more"]',
    '[class*="expand"]',
    '[class*="advanced"]',
  ], Math.min(1000, getRemainingTimeout(deadline)), platform).catch(() => false);
  assertSearchNotAborted(options);
  await clickFirstVisibleText(page, ['更多', '展开', '高级搜索', '更多筛选'], Math.min(1000, getRemainingTimeout(deadline)), platform).catch(() => false);
}

export async function prepare51jobSearchConditionPage(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = resolveSearchDeadline(options);
  const searchPage = await openPageLevelSearchRef.fn(page, { ...options, deadline });
  await clear51jobSearchFilters(searchPage, deadline, options);
  await fill51jobSearchKeyword(searchPage, keyword, { ...options, deadline });
  await expand51jobAdvancedFilters(searchPage, { ...options, deadline });
  return searchPage;
}

export async function prepare51jobSearchConditionPageWithOptions(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  return prepare51jobSearchConditionPage(page, keyword, options);
}

export async function read51jobSearchResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const bodyText = await page.locator('body').innerText();
  const resultTotal = parseSearchResultTotalFromText(bodyText);
  if (bodyText.includes('没有搜索到相关的人才')) {
    return {
      resultTotal: 0,
      resultTotalSource: 'page',
    };
  }

  if (resultTotal === undefined) {
    throw new Error('Search subscription on 51job could not read the page result total.');
  }

  return {
    resultTotal,
    resultTotalSource: 'page',
  };
}

export async function save51jobSearchCondition(page: Page, savedSearchName: string): Promise<void> {
  await saveSearchConditionByCommonDialog(page, savedSearchName, { platformLabel: '51job', platform });
}
