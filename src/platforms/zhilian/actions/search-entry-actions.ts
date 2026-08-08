import type { Page } from 'playwright';
import {
  clickPlatformLocator,
  pressPlatformKey,
} from '../../../browser/pacing.js';
import {
  clickPrimarySearchButton,
  fillFirstVisibleInput,
} from '../../../search/page-actions.js';
import type { SearchCondition } from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import { clearObservedZhilianCandidateApi } from './candidate-actions.js';
import {
  createZhilianSearchDeadline as createSearchDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import {
  applyZhilianSearchCondition,
  closeZhilianVisibleFilterPopups,
  ensureZhilianSearchConditionPanelOpen,
} from './filter-actions.js';
import { waitForZhilianRecruiterShell } from './navigation-actions.js';
import {
  applyZhilianViewedFilterForExtraction,
  isZhilianQuickSearchApplied,
  prepareZhilianSavedQuickSearchPage,
  prepareZhilianSearchSurface,
} from './search-actions.js';

const zhilianPlatform = 'zhilian';
const zhilianSearchStatePollMs = 100;

export async function prepareZhilianSearchConditionPage(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  await prepareZhilianSavedQuickSearchPage(page, keyword, { ...options, deadline });
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true });
  return page;
}

async function clearZhilianSearchConditionFilters(page: Page, deadline: number): Promise<void> {
  await closeZhilianVisibleFilterPopups(page, deadline).catch(() => undefined);
  const clearControls = [
    page.locator('.search-condition-panel-new').getByText('清空筛选', { exact: true }).first(),
    page.getByText('清空筛选', { exact: true }).first(),
    page.locator('button:has-text("清空筛选")').first(),
    page.locator('[role="button"]:has-text("清空筛选")').first(),
  ];

  for (const control of clearControls) {
    try {
      await control.waitFor({ state: 'visible', timeout: Math.min(1000, remainingTime(deadline)) });
      clearObservedZhilianCandidateApi(page);
      await clickPlatformLocator(control, page, zhilianPlatform, Math.min(1000, remainingTime(deadline)));
      await waitForZhilianRecruiterShell(page, { deadline });
      await page.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
      return;
    } catch {
      continue;
    }
  }
}

async function fillZhilianDirectKeywordSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  const didFill = await fillFirstVisibleInput(page, keyword, [
    'input[placeholder*="搜公司、职位、专业、学校、行业、技能"]',
    'input[placeholder*="搜公司"]',
    'input[placeholder*="职位"]',
    'input[placeholder*="关键词"]',
    '.search-input input',
    '[class*="search"] input[type="text"]',
    'input[type="search"]',
    'input[type="text"]',
  ], Math.min(5000, remainingTime(deadline)), zhilianPlatform);

  if (!didFill) {
    throw new Error('Direct Zhilian search could not find the keyword input on the recruiter search page.');
  }

  clearObservedZhilianCandidateApi(page);
  const didTriggerSearch = await clickPrimarySearchButton(
    page,
    Math.min(3000, remainingTime(deadline)),
    zhilianPlatform,
  );
  if (!didTriggerSearch) {
    await pressPlatformKey(page, zhilianPlatform, 'Enter').catch(() => undefined);
  }

  await waitForZhilianRecruiterShell(page, { deadline });
  while (Date.now() <= deadline) {
    if (await isZhilianQuickSearchApplied(page, keyword)) {
      return;
    }
    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error(`Direct Zhilian search did not confirm visible keyword "${keyword}" before timeout.`);
}

export async function prepareZhilianDirectSearchConditionPage(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  await prepareZhilianSearchSurface(page, { ...options, deadline });
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true }).catch(() => undefined);
  await clearZhilianSearchConditionFilters(page, deadline);
  await fillZhilianDirectKeywordSearch(page, keyword, deadline);
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true });
  return page;
}

export async function openZhilianDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  const searchPage = await prepareZhilianDirectSearchConditionPage(page, keyword, { ...options, deadline });
  for (const condition of conditions) {
    const result = await applyZhilianSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      throw new Error(`Zhilian direct search condition ${condition.kind} failed: ${result.message ?? result.status}`);
    }
  }

  await applyZhilianViewedFilterForExtraction(searchPage, deadline, options?.includeViewedCandidates);
  return searchPage;
}
