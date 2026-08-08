import type { Page } from 'playwright';
import {
  clickPlatformLocator,
  reloadPlatformPage,
} from '../../../browser/pacing.js';
import {
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../../../search/page-actions.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  attachZhilianCandidateApiObserver,
  clearObservedZhilianCandidateApi,
} from './candidate-actions.js';
import {
  createZhilianSearchDeadline as createSearchDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import {
  isAbortNavigationError,
  isZhilianSearchUrl,
  openZhilianRecruiterHome,
  waitForZhilianRecruiterShell,
} from './navigation-actions.js';

const zhilianUnviewedFilterSelector = [
  '.km-checkbox:has-text("未看过")',
  '[class*="checkbox"]:has-text("未看过")',
  '[role="checkbox"]:has-text("未看过")',
  'label:has-text("未看过")',
].join(', ');
const zhilianViewedFilterSettleMs = 1000;
const zhilianViewedFilterPollMs = 100;
const zhilianViewedFilterMaxWaitMs = 8000;
const zhilianSearchStatePollMs = 100;
const zhilianPlatform = 'zhilian';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

async function reloadZhilianSearchPage(page: Page, deadline: number): Promise<void> {
  const reload = (page as Partial<Pick<Page, 'reload'>>).reload?.bind(page);
  if (!reload) {
    return;
  }

  clearObservedZhilianCandidateApi(page);
  try {
    await reloadPlatformPage(page, zhilianPlatform, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
  } catch (error) {
    if (!isAbortNavigationError(error) || !isZhilianSearchUrl(page.url())) {
      throw error;
    }
  }

  await waitForZhilianRecruiterShell(page, { deadline });
  clearObservedZhilianCandidateApi(page);
}

export async function listVisibleZhilianQuickSearchTags(page: Page): Promise<string[]> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const quickSearchSectionMatch = bodyText.match(/(?:快捷搜索|猜你想搜：?)([\s\S]{0,600})/);
  const quickSearchSection = normalizeText(quickSearchSectionMatch?.[1] ?? bodyText);
  return quickSearchSection
    .split(/\s{2,}|[,\n]/)
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => !/^(快捷搜索|猜你想搜：?|清空筛选|使用高级搜索|搜索|搜 索)$/.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordToLoosePattern(keyword: string): RegExp {
  const segments = keyword
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => escapeRegExp(segment));

  const pattern = segments.length > 0 ? segments.join('\\s*') : escapeRegExp(keyword);
  return new RegExp(pattern, 'i');
}


export function hasAppliedZhilianQuickSearchKeyword(bodyText: string, keyword: string): boolean {
  const normalizedText = normalizeText(bodyText);
  const keywordPattern = keywordToLoosePattern(keyword);
  const appliedKeywordMatch = normalizedText.match(/关键词[:：]\s*([^:：]*?)(?:\s+(?:学历要求|经验要求|年龄要求|期望月薪|活跃日期|期望职位|从事职业|从事行业|期望行业|现居住地|户口所在地|语言能力|性别要求|求职状态|人才类型|人才照片|简历语言|跳槽频率|保存为快捷搜索|今日搜索聊剩|综合排序|未看过|未聊过|近一段工作相关|其他过滤条件)|$)/);
  return keywordPattern.test(appliedKeywordMatch?.[1] ?? '');
}

export async function isZhilianQuickSearchApplied(page: Page, keyword: string): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return hasAppliedZhilianQuickSearchKeyword(bodyText, keyword);
}

async function waitForZhilianQuickSearchApplied(page: Page, keyword: string, deadline: number): Promise<boolean> {
  while (Date.now() <= deadline) {
    if (await isZhilianQuickSearchApplied(page, keyword)) {
      return true;
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  return false;
}

async function clickSavedZhilianQuickSearchTag(
  page: Page,
  keyword: string,
  deadline: number,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && await isZhilianQuickSearchApplied(page, keyword)) {
    return;
  }

  const keywordPattern = keywordToLoosePattern(keyword);
  const quickSearchTagSelectors = [
    '.search-quick-search-new__content-item',
    '.search-quick-search__content-item',
    '[class*="quick-search"][class*="content-item"]',
    '[class*="quick-search"][class*="item"]',
  ];
  let quickSearchTag: ReturnType<Page['locator']> | undefined;

  for (const selector of quickSearchTagSelectors) {
    const candidate = page.locator(selector).filter({ hasText: keywordPattern }).first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: Math.min(2000, remainingTime(deadline)) });
      quickSearchTag = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!quickSearchTag) {
    if (options.force && await isZhilianQuickSearchApplied(page, keyword)) {
      return;
    }

    const visibleTags = await listVisibleZhilianQuickSearchTags(page);
    throw new Error(`Could not find a saved Zhilian quick-search tag containing keyword "${keyword}". Visible tags: ${visibleTags.join(', ') || '(none)'}.`);
  }

  clearObservedZhilianCandidateApi(page);
  await clickPlatformLocator(quickSearchTag, page, zhilianPlatform, remainingTime(deadline));
  await waitForZhilianRecruiterShell(page, { deadline });
  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search tag containing keyword "${keyword}" was clicked, but its search conditions did not become active before timeout.`);
  }
}

async function ensureZhilianViewedFilterClearedForQuickSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await clearZhilianUnviewedFilter(page, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }

  if (!await isZhilianQuickSearchApplied(page, keyword)) {
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (await clearZhilianUnviewedFilter(page, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
  }

  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search conditions for keyword "${keyword}" were not active after clearing 未看过.`);
  }

  if (await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter remained checked after --include-viewed true.');
  }
}

async function ensureZhilianUnviewedFilterCheckedForQuickSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }

  if (!await isZhilianQuickSearchApplied(page, keyword)) {
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
  }

  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search conditions for keyword "${keyword}" were not active after checking 未看过.`);
  }

  if (!await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter was not checked before extraction.');
  }
}

async function isZhilianCheckboxFilterChecked(page: Page, selector: string): Promise<boolean> {
  const filter = page.locator(selector).filter({ visible: true }).first();
  const evaluate = (filter as Partial<Pick<typeof filter, 'evaluate'>>).evaluate?.bind(filter);
  if (!evaluate) {
    return false;
  }

  return evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const control = element.closest('[class*="checkbox"], label, [role="checkbox"]') ?? element;
    const checkbox = control.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const ariaChecked = control.getAttribute('aria-checked');
    return checkbox?.checked === true
      || ariaChecked === 'true'
      || /\b(km-checkbox--checked|ant-checkbox-checked|is-checked|checked)\b/.test(String(control.className ?? ''));
  }).catch(() => false);
}

async function isZhilianUnviewedFilterChecked(page: Page): Promise<boolean> {
  return isZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector);
}

export async function clearZhilianUnviewedFilter(page: Page, options?: SearchWaitOptions): Promise<boolean> {
  return setZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector, isZhilianUnviewedFilterChecked, false, options);
}

async function setZhilianUnviewedFilterChecked(page: Page, checked: boolean, options?: SearchWaitOptions): Promise<boolean> {
  return setZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector, isZhilianUnviewedFilterChecked, checked, options);
}

async function setZhilianCheckboxFilterChecked(
  page: Page,
  selector: string,
  isChecked: (page: Page) => Promise<boolean>,
  checked: boolean,
  options?: SearchWaitOptions,
): Promise<boolean> {
  const deadline = createSearchDeadline(options);
  const waitUntil = Math.min(deadline, Date.now() + zhilianViewedFilterMaxWaitMs);
  const filter = page.locator(selector).filter({ visible: true }).first();

  try {
    await filter.waitFor({ state: 'visible', timeout: Math.max(1, waitUntil - Date.now()) });
  } catch {
    return false;
  }

  let clicked = false;
  let stableSince: number | undefined;

  while (Date.now() < waitUntil) {
    const currentChecked = await isChecked(page);
    if (currentChecked !== checked) {
      stableSince = undefined;
      clearObservedZhilianCandidateApi(page);
      try {
        await clickPlatformLocator(
          filter,
          page,
          zhilianPlatform,
          Math.min(1000, Math.max(1, waitUntil - Date.now())),
        );
        clicked = true;
      } catch {
        // The search page renders hidden duplicates; retry until a visible control is stable.
      }
    } else {
      if (!clicked) {
        return false;
      }

      const now = Date.now();
      stableSince ??= now;
      if (now - stableSince >= zhilianViewedFilterSettleMs) {
        return clicked;
      }
    }

    await page.waitForTimeout(Math.min(zhilianViewedFilterPollMs, Math.max(1, waitUntil - Date.now()))).catch(() => undefined);
  }

  return clicked;
}


export async function prepareZhilianSearchSurface(
  page: Page,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  return page;
}

export async function prepareZhilianSavedQuickSearchPage(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  await prepareZhilianSearchSurface(page, { ...options, deadline });
  await clickSavedZhilianQuickSearchTag(page, keyword, deadline, { force: true });
  return page;
}

export async function applyZhilianViewedFilterForExtraction(
  page: Page,
  deadline: number,
  includeViewedCandidates?: boolean,
): Promise<void> {
  if (includeViewedCandidates) {
    if (await clearZhilianUnviewedFilter(page, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
    if (await isZhilianUnviewedFilterChecked(page)) {
      throw new Error('Zhilian 未看过 filter remained checked after --include-viewed true.');
    }
    return;
  }

  if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }
  if (!await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter was not checked before extraction.');
  }
}

export async function readZhilianSearchConditionResultTotal(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const deadline = createSearchDeadline(options);

  while (Date.now() <= deadline) {
    const bodyText = await page.locator('body').innerText();
    const resultTotal = parseSearchResultTotalFromText(bodyText);
    if (resultTotal !== undefined) {
      return {
        resultTotal,
        resultTotalSource: 'page',
      };
    }

    if (/没有符合条件的人才|没有搜索到相关的人才|暂无符合条件|暂无数据|未搜索到相关/.test(bodyText)) {
      return {
        resultTotal: 0,
        resultTotalSource: 'page',
      };
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  throw new Error('Search subscription on zhilian could not read the page result total.');
}


export async function openZhilianSubscribeSearch(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await reloadZhilianSearchPage(page, deadline);
  await clickSavedZhilianQuickSearchTag(page, keyword, deadline, { force: true });
  if (options?.includeViewedCandidates) {
    await ensureZhilianViewedFilterClearedForQuickSearch(page, keyword, deadline);
  } else {
    await ensureZhilianUnviewedFilterCheckedForQuickSearch(page, keyword, deadline);
  }
  return page;
}

export async function savePreparedZhilianSearchCondition(
  page: Page,
  savedSearchName: string,
): Promise<void> {
  await saveSearchConditionByCommonDialog(page, savedSearchName, {
    platformLabel: 'zhilian',
    platform: zhilianPlatform,
  });
  await waitForZhilianRecruiterShell(page);
}
