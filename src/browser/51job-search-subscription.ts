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

const talentSearchPageUrl = 'https://ehire.51job.com/Revision/talent/search';
const subscribePageUrl = 'https://ehire.51job.com/Revision/talent/subscribe';

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

export async function fill51jobSearchKeyword(page: Page, keyword: string): Promise<void> {
  const didFillKeyword = await fillFirstVisibleInput(page, keyword, [
    '.talent_search_keywords_input input.el-input__inner',
    '.talent_search_keywords_input .el-input__inner',
    'input[placeholder*="OR"]',
    'input[placeholder*="关键词"]',
    'input[type="search"]',
    'input[type="text"]',
  ]);

  if (!didFillKeyword) {
    throw new Error('Search subscription on 51job could not find the keyword input on the talent search page.');
  }

  const didTriggerSearch = await clickPrimarySearchButton(page);
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
  ]).catch(() => false);
  await clickFirstVisibleText(page, ['更多', '展开', '高级搜索', '更多筛选']).catch(() => false);
}

export async function prepare51jobSearchConditionPage(page: Page, keyword: string): Promise<Page> {
  const searchPage = await openPageLevelSearchRef.fn(page);
  await fill51jobSearchKeyword(searchPage, keyword);
  await expand51jobAdvancedFilters(searchPage);
  return searchPage;
}

export async function read51jobSearchResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const resultTotal = parseSearchResultTotalFromText(await page.locator('body').innerText());
  if (resultTotal === undefined) {
    throw new Error('Search subscription on 51job could not read the page result total.');
  }

  return {
    resultTotal,
    resultTotalSource: 'page',
  };
}

export async function save51jobSearchCondition(page: Page, savedSearchName: string): Promise<void> {
  await saveSearchConditionByCommonDialog(page, savedSearchName, { platformLabel: '51job' });
}
