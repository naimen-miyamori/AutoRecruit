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
import { clickPlatformLocator } from './pacing.js';
import type { SearchWaitOptions } from '../platforms/types.js';

const talentSearchPageUrl = 'https://ehire.51job.com/Revision/talent/search';
const subscribePageUrl = 'https://ehire.51job.com/Revision/talent/subscribe';
const platform = '51job';

export const openPageLevelSearchRef = {
  fn: openPageLevelSearch,
};

export async function openPageLevelSearch(page: Page): Promise<Page> {
  await page.goto(subscribePageUrl, { waitUntil: 'domcontentloaded', timeout: config.playwright.searchPageTimeoutMs });
  await page.goto(talentSearchPageUrl, { waitUntil: 'domcontentloaded', timeout: config.playwright.searchPageTimeoutMs });

  if (await isLoginPage(page)) {
    throw new Error('51job authenticated talent search page is not available because the session has fallen back to the login screen.');
  }

  return page;
}

async function isLoginPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText();
  return bodyText.includes('登录') || (bodyText.includes('账号') && bodyText.includes('密码'));
}

async function clear51jobSearchFilters(page: Page): Promise<void> {
  const clearButton = page.getByText('清空筛选', { exact: true }).first();
  const isVisible = await clearButton.isVisible({ timeout: 1500 }).catch(() => false);
  if (!isVisible) {
    return;
  }

  await clickPlatformLocator(clearButton, page, platform, 1500);
  await page.waitForTimeout(300);
}

export async function fill51jobSearchKeyword(page: Page, keyword: string): Promise<void> {
  const didFillKeyword = await fillFirstVisibleInput(page, keyword, [
    '.talent_search_keywords_input input.el-input__inner',
    '.talent_search_keywords_input .el-input__inner',
    'input[placeholder*="OR"]',
    'input[placeholder*="关键词"]',
    'input[type="search"]',
    'input[type="text"]',
  ], 5000, platform);

  if (!didFillKeyword) {
    throw new Error('Search subscription on 51job could not find the keyword input on the talent search page.');
  }

  const didTriggerSearch = await clickPrimarySearchButton(page, 3000, platform);
  if (!didTriggerSearch) {
    throw new Error('Search subscription on 51job could not trigger the keyword search on the talent search page.');
  }
}

export async function expand51jobAdvancedFilters(page: Page): Promise<void> {
  await clickFirstVisibleSelector(page, [
    '.more',
    '.expand',
    '.advanced-search',
    '.filter-more',
    '[class*="more"]',
    '[class*="expand"]',
    '[class*="advanced"]',
  ], 1000, platform).catch(() => false);
  await clickFirstVisibleText(page, ['更多', '展开', '高级搜索', '更多筛选'], 1000, platform).catch(() => false);
}

export async function prepare51jobSearchConditionPage(page: Page, keyword: string): Promise<Page> {
  const searchPage = await openPageLevelSearchRef.fn(page);
  await clear51jobSearchFilters(searchPage);
  await fill51jobSearchKeyword(searchPage, keyword);
  await expand51jobAdvancedFilters(searchPage);
  return searchPage;
}

export async function prepare51jobSearchConditionPageWithOptions(
  page: Page,
  keyword: string,
  _options?: SearchWaitOptions,
): Promise<Page> {
  return prepare51jobSearchConditionPage(page, keyword);
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
