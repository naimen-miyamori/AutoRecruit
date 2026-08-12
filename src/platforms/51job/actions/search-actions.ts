import type { Locator, Page } from 'playwright';
import {
  clickFirstVisibleSelector,
  clickFirstVisibleText,
  clickPrimarySearchButton,
  fillFirstVisibleInput,
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../../../search/page-actions.js';
import { clickPlatformLocator, gotoPlatformPage } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { SearchCondition } from '../../../types/job.js';
import type { PlatformAdapter, SearchWaitOptions } from '../../types.js';
import { buildCoreSavedSearchTarget } from '../../../search/saved-search-target.js';
import { apply51jobSearchCondition } from './filter-actions.js';
import {
  apply51jobViewedCandidatePolicy,
  resolve51jobSearchDeadline,
  submit51jobDirectSearch,
} from './result-actions.js';

type DirectSearchOptions = Parameters<NonNullable<PlatformAdapter['openDirectSearch']>>[3];
const talentSearchPageUrl = 'https://ehire.51job.com/Revision/talent/search';
const subscribePageUrl = 'https://ehire.51job.com/Revision/talent/subscribe';
const platform = '51job';
const appliedKeywordInputSelectors = [
  '.talent_search_keywords_input input.el-input__inner',
  '.talent_search_keywords_input .el-input__inner',
];
const keywordInputSelectors = [
  ...appliedKeywordInputSelectors,
  'input[placeholder*="OR"]',
  'input[placeholder*="关键词"]',
];

export const openPageLevelSearchRef = { fn: openPageLevelSearch };

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

function normalizeObservedKeyword(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function parse51jobAppliedSearchKeywordText(pageText: string): string | undefined {
  const normalizedText = normalizeObservedKeyword(pageText);
  const match = normalizedText.match(
    /(?:^|\s)关键词[:：]\s*(.*?)(?=\s+(?:\d{6,}\s+)?(?:从事职能|学历|工作年限|经验|年龄|薪资|现居住地|户口所在地|行业|公司|在线简历|工作经历|教育经历|清空筛选|隐藏已查看|搜索)(?:[:：]|\s|$)|$)/u,
  );
  return normalizeObservedKeyword(match?.[1]) || undefined;
}

export async function read51jobAppliedSearchKeyword(page: Page, deadline: number): Promise<string | undefined> {
  for (const selector of appliedKeywordInputSelectors) {
    const input = page.locator(selector).first();
    const readInputValue = (input as Partial<Pick<Locator, 'inputValue'>>).inputValue?.bind(input);
    if (!readInputValue) continue;
    const value = await readInputValue({
      timeout: Math.min(1000, getRemainingTimeout(deadline)),
    }).catch(() => '');
    const normalized = normalizeObservedKeyword(value);
    if (normalized) return normalized;
  }

  const body = page.locator('body').first();
  const readable = body as Partial<Pick<Locator, 'innerText' | 'textContent'>>;
  const timeout = Math.min(1000, getRemainingTimeout(deadline));
  const [innerText, textContent] = await Promise.all([
    readable.innerText?.({ timeout }).catch(() => '') ?? Promise.resolve(''),
    readable.textContent?.({ timeout }).catch(() => '') ?? Promise.resolve(''),
  ]);
  return parse51jobAppliedSearchKeywordText(innerText)
    ?? parse51jobAppliedSearchKeywordText(textContent ?? '');
}

function assertSearchNotAborted(options: SearchWaitOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error('51job direct search was cancelled before the next page action.');
  }
}

async function isLoginPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText();
  return bodyText.includes('登录') || (bodyText.includes('账号') && bodyText.includes('密码'));
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

async function clear51jobSearchFilters(page: Page, deadline: number, options?: SearchWaitOptions): Promise<void> {
  assertSearchNotAborted(options);
  const clearButton = page.getByText('清空筛选', { exact: true }).first();
  const isVisible = await clearButton.isVisible({ timeout: Math.min(1500, getRemainingTimeout(deadline)) }).catch(() => false);
  if (!isVisible) return;
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
    ...keywordInputSelectors,
    'input[type="search"]',
    'input[type="text"]',
  ], Math.min(5000, getRemainingTimeout(deadline)), platform);
  if (!didFillKeyword) {
    throw new Error('Search subscription on 51job could not find the keyword input on the talent search page.');
  }
  assertSearchNotAborted(options);
  if (!await clickPrimarySearchButton(page, Math.min(3000, getRemainingTimeout(deadline)), platform)) {
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

export async function prepare51jobSearchConditionPageWithOptions(
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

export async function read51jobSearchResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const bodyText = await page.locator('body').innerText();
  const resultTotal = parseSearchResultTotalFromText(bodyText);
  if (bodyText.includes('没有搜索到相关的人才')) return { resultTotal: 0, resultTotalSource: 'page' };
  if (resultTotal === undefined) throw new Error('Search subscription on 51job could not read the page result total.');
  return { resultTotal, resultTotalSource: 'page' };
}

export async function save51jobSearchCondition(page: Page, savedSearchName: string): Promise<void> {
  await saveSearchConditionByCommonDialog(page, savedSearchName, { platformLabel: '51job', platform });
}

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

export async function openBound51jobSavedSearch(
  ...args: Parameters<NonNullable<PlatformAdapter['openBoundSavedSearch']>>
): Promise<Awaited<ReturnType<NonNullable<PlatformAdapter['openBoundSavedSearch']>>>> {
  const { openBound51jobSavedSearch: openBound } = await import('../../../browser/subscribe-search.js');
  if (!('targetKind' in args[1]) || args[1].targetKind !== 'core-exact-name-keyword') {
    throw new Error('51job requires a core exact-name saved-search target.');
  }
  return openBound(args[0], args[1], args[2]);
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
): Promise<Awaited<ReturnType<NonNullable<PlatformAdapter['saveSearchCondition']>>>> {
  await save51jobSearchCondition(args[0], args[1]);
  const context = args[2]?.subscriptionMutationContext;
  if (!context) return undefined;
  const target = buildCoreSavedSearchTarget({
    platform,
    boundJobKey: `subscription-management:${context.conditionFingerprint}`,
    bindingRevision: 1,
    name: args[1],
    expectedKeyword: context.expectedKeyword,
  });
  const opened = await openBound51jobSavedSearch(args[0], target, {
    ...args[2],
    boundJobKey: target.boundJobKey,
  });
  return { outcome: 'saved', openEvidence: opened.evidence, workPage: opened.page };
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
