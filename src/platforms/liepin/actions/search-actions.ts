import type { Locator, Page } from 'playwright';
import { parseSearchResultTotalFromText } from '../../../search/page-actions.js';
import type { SearchCondition } from '../../../types/job.js';
import type { CoreSavedSearchTarget, PlatformSavedSearchOpenEvidence } from '../../../types/job.js';
import { buildCoreSavedSearchTarget, buildSavedSearchOpenEvidence } from '../../../search/saved-search-target.js';
import type {
  CoreSavedSearchVerificationRequest,
  ExistingSavedSearchInspection,
  SearchWaitOptions,
} from '../../types.js';
import {
  attachLiepinSearchResumesApiObserver,
  clearObservedLiepinSearchResumesApiBeforeNextAction,
  resetObservedLiepinSearchResumesApi,
  waitForLiepinFinalSearchResumesOrEmptyResults,
  waitForLiepinQuickSearchResults,
} from './candidate-actions.js';
import { clickLiepinLocatorWithForceFallback } from './compatibility.js';
import {
  clickLiepinLocator,
  createLiepinSearchDeadline as createSearchDeadline,
  fillLiepinLocator,
  remainingLiepinActionMs as remainingTime,
  waitLiepinActionPace,
} from './context.js';
import { applyLiepinSearchCondition } from './filter-actions.js';
import {
  openLiepinRecruiterSearchPage,
} from './navigation-actions.js';
import { closeLiepinBlockingOverlays, hasVisibleLiepinBlockingOverlay } from './overlay-actions.js';
import { waitForLiepinPageReady } from './readiness.js';

export { isLiepinSearchUrl } from './navigation-actions.js';

async function fillFirstVisibleLiepinInput(
  page: Page,
  value: string,
  selectors: string[],
  timeoutMs = 1000,
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await fillLiepinLocator(locator, page, value, timeoutMs);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function fillLiepinInputNearText(
  page: Page,
  value: string,
  rowHints: Array<string | RegExp>,
  rowSelectors: string[],
  inputSelectors: string[],
  timeoutMs = 1000,
): Promise<boolean> {
  for (const rowHint of rowHints) {
    for (const rowSelector of rowSelectors) {
      const row = page.locator(rowSelector, { hasText: rowHint }).first();
      if (typeof (row as Partial<Locator>).locator !== 'function') {
        continue;
      }

      for (const inputSelector of inputSelectors) {
        const locator = row.locator(inputSelector).first();
        try {
          await locator.waitFor({ state: 'visible', timeout: timeoutMs });
          await fillLiepinLocator(locator, page, value, timeoutMs);
          return true;
        } catch {
          continue;
        }
      }
    }
  }

  return false;
}

async function clickFirstVisibleLiepinText(
  page: Page,
  labels: Array<string | RegExp>,
  timeoutMs = 1000,
): Promise<boolean> {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: false }).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await clickLiepinLocator(locator, page, timeoutMs);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function ensureLiepinMoreConditionsExpanded(page: Page, timeoutMs = 2000): Promise<void> {
  const bodyText = await page.locator('body').innerText({ timeout: timeoutMs }).catch(() => '');
  if (bodyText.includes('收起更多条件')) {
    return;
  }

  const locators = [
    page.getByText(/展开更多条件/).first(),
    page.getByText(/^展开$/).first(),
    page.getByText(/^更多筛选$/).first(),
    page.getByText(/^更多$/).first(),
    page.getByText(/高级搜索/).first(),
  ];
  for (const locator of locators) {
    if (!(await locator.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    await clickLiepinLocatorWithForceFallback(locator, page, timeoutMs);
    await waitLiepinActionPace(page);
    return;
  }
}

async function clickLiepinPrimarySearchButton(page: Page, timeoutMs = 1000): Promise<boolean> {
  const candidates: Locator[] = [];
  const roleLookup = (page as Partial<Pick<Page, 'getByRole'>>).getByRole?.bind(page);

  if (roleLookup) {
    candidates.push(roleLookup('button', { name: /^搜索$/ }).first());
    candidates.push(roleLookup('button', { name: /搜\s*索/ }).first());
  }

  const buttonLocator = page.locator('button');
  if (typeof (buttonLocator as Partial<Locator>).filter === 'function') {
    candidates.push(buttonLocator.filter({ hasText: /^搜索$/ }).first());
    candidates.push(buttonLocator.filter({ hasText: /搜\s*索/ }).first());
  }

  candidates.push(page.locator('.search-btn, .btn-search, .search_button, button.search_button, [class*="search-btn"], [class*="btn-search"]').first());

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await clickLiepinLocator(locator, page, timeoutMs);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function uniqueVisibleLiepinLocator(locator: Locator, label: string): Promise<Locator> {
  const visibleIndexes: number[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visibleIndexes.push(index);
  }
  if (visibleIndexes.length !== 1) {
    throw new Error(`Liepin ${label} requires one visible control; found ${visibleIndexes.length}.`);
  }
  return locator.nth(visibleIndexes[0]!);
}

async function saveLiepinSearchCondition(page: Page, savedSearchName: string, deadline: number): Promise<void> {
  const openSave = await uniqueVisibleLiepinLocator(
    page.getByText(/^(?:订阅|保存搜索条件|保存条件|保存搜索|保存)$/u),
    'save-search action',
  );
  await clickLiepinLocator(openSave, page, remainingTime(deadline));

  const dialog = await uniqueVisibleLiepinLocator(
    page.locator('.ant-modal-wrap').filter({ hasText: /保存新的搜索条件|搜索条件命名/u }),
    'save-search dialog',
  );
  let nameInputs = dialog.locator('input.ant-input.input-text-v3[type="text"]');
  const primaryVisibleCount = await nameInputs.count().then(async (count) => {
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await nameInputs.nth(index).isVisible().catch(() => false)) visible += 1;
    }
    return visible;
  });
  if (primaryVisibleCount === 0) nameInputs = dialog.locator('input[type="text"]');
  const nameInput = await uniqueVisibleLiepinLocator(nameInputs, 'save-search name input');
  await fillLiepinLocator(nameInput, page, savedSearchName, remainingTime(deadline));
  const observedName = (await nameInput.inputValue({
    timeout: Math.min(1000, remainingTime(deadline)),
  })).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const expectedName = savedSearchName.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (observedName !== expectedName) {
    throw new Error(`Liepin save-search name postcondition mismatch: expected "${expectedName}", observed "${observedName || '(empty)'}".`);
  }

  const confirm = await uniqueVisibleLiepinLocator(
    dialog.getByRole('button', { name: /^\s*确\s*定\s*$/u }),
    'save-search confirmation',
  );
  await clickLiepinLocator(confirm, page, remainingTime(deadline));
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
}


async function fillLiepinKeywordSearchInput(page: Page, value: string): Promise<boolean> {
  if (await fillLiepinInputNearText(
    page,
    value,
    ['职位名称', '包含任意关键词', '包含全部关键词'],
    ['.search-item', '.filter-item', '.form-item', '[class*="search"]', '[class*="filter"]'],
    [
      'input.ant-select-selection-search-input[type="search"]',
      'input.search-component-input',
      'input.ant-input',
      'input[type="search"]',
      'input[type="text"]',
    ],
  )) {
    return true;
  }

  return fillFirstVisibleLiepinInput(page, value, [
    'input.ant-select-selection-search-input[type="search"]',
    'input.search-component-input',
    'input.ant-input',
    'input[type="search"]',
    'input[type="text"]',
  ]);
}

async function clearLiepinSearchConditionFilters(page: Page, deadline: number): Promise<boolean> {
  await closeLiepinBlockingOverlays(page);
  const cleared = await clickFirstVisibleLiepinText(page, ['清空筛选条件'], 2000);
  if (!cleared) {
    return false;
  }

  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  return true;
}

export async function prepareLiepinSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  resetObservedLiepinSearchResumesApi(page);
  attachLiepinSearchResumesApiObserver(page);

  await openLiepinRecruiterSearchPage(page, deadline);

  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  await clearLiepinSearchConditionFilters(page, deadline);
  const didFillKeyword = await fillLiepinKeywordSearchInput(page, keyword);
  if (!didFillKeyword) {
    throw new Error('Search subscription on liepin could not fill the keyword input on the recruiter search page.');
  }

  const didTriggerSearch = await clickLiepinPrimarySearchButton(page)
    || await clickFirstVisibleLiepinText(page, ['搜索', '搜 索']);
  if (!didTriggerSearch) {
    throw new Error('Search subscription on liepin could not trigger the keyword search on the recruiter search page.');
  }

  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  await ensureLiepinMoreConditionsExpanded(page).catch(() => undefined);
  return page;
}

export async function readLiepinSearchConditionResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const resultTotal = parseSearchResultTotalFromText(await page.locator('body').innerText());
  if (resultTotal === undefined) {
    throw new Error('Search subscription on liepin could not read the page result total.');
  }

  return {
    resultTotal,
    resultTotalSource: 'page',
  };
}

const liepinQuickSearchRegionSelector = [
  '.quick-search-box',
  '[data-testid*="quick-search"]',
  '[data-test-id*="quick-search"]',
].join(', ');

function locateExactLiepinQuickSearchTags(page: Page, name: string): Locator | undefined {
  const quickSearchRegions = page.locator(liepinQuickSearchRegionSelector);
  const getByText = (quickSearchRegions as Partial<Pick<Locator, 'getByText'>>)
    .getByText?.bind(quickSearchRegions);
  return getByText?.(name, { exact: true });
}


async function clickLiepinQuickSearchTag(
  page: Page,
  keyword: string,
  deadline: number,
  options: { requireUniqueExact?: boolean } = {},
): Promise<string | undefined> {
  const getByText = (page as Partial<Pick<Page, 'getByText'>>).getByText?.bind(page);
  if (!getByText) {
    return undefined;
  }

  // Candidate cards and other search-page content can repeat the saved-search
  // name. Identity and the subsequent click must therefore share the same
  // quick-search-region scope rather than counting exact text across the page.
  const tags = locateExactLiepinQuickSearchTags(page, keyword)
    ?? (options.requireUniqueExact ? undefined : getByText(keyword, { exact: true }));
  if (!tags) return undefined;
  if (options.requireUniqueExact) {
    const visibleIndexes: number[] = [];
    const count = await tags.count();
    for (let index = 0; index < count; index += 1) {
      if (await tags.nth(index).isVisible().catch(() => false)) visibleIndexes.push(index);
    }
    if (visibleIndexes.length !== 1) {
      throw new Error(`Liepin saved search "${keyword}" requires one visible exact match; found ${visibleIndexes.length}.`);
    }
    const exactTag = tags.nth(visibleIndexes[0]!);
    const observedName = (await exactTag.innerText({
      timeout: Math.min(1000, remainingTime(deadline)),
    })).normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const normalizedExpected = keyword.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (observedName !== normalizedExpected) {
      throw new Error(`Liepin saved-search tag changed before opening. Expected "${normalizedExpected}", observed "${observedName || '(missing)'}".`);
    }
    await clickLiepinLocator(exactTag, page, remainingTime(deadline));
    return observedName;
  }
  const tag = tags.first();
  await tag.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  await clickLiepinLocator(tag, page, remainingTime(deadline));
  return undefined;
}

type LiepinHideViewedState = {
  found: boolean;
  checked: boolean;
  clickSelector?: string;
  searchButtonSelector?: string;
  bodyText?: string;
};

function getLiepinHideViewedControlState(): LiepinHideViewedState {
  const normalizeNodeText = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (element: Element | null | undefined): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const selectorForElement = (element: Element): string | undefined => {
    const escapeCssString = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (element.id) {
      return `[id="${escapeCssString(element.id)}"]`;
    }

    const className = typeof element.className === 'string' ? element.className : '';
    if (/\bhide-view-checkbox\b/.test(className)) {
      return 'label.hide-view-checkbox';
    }
    if (element.tagName.toLowerCase() === 'button' && /\bsearch-btn\b/.test(className)) {
      return 'button.search-btn';
    }

    const dataAttributes = [
      'data-testid',
      'data-test-id',
      'data-tlg-elem-id',
      'name',
    ];
    for (const attributeName of dataAttributes) {
      const value = element.getAttribute(attributeName);
      if (value) {
        return `${element.tagName.toLowerCase()}[${attributeName}="${escapeCssString(value)}"]`;
      }
    }

    return undefined;
  };
  const isChecked = (element: Element): boolean => {
    if (element instanceof HTMLInputElement) {
      return element.checked;
    }

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }
    if (ariaChecked === 'false') {
      return false;
    }

    const className = typeof element.className === 'string' ? element.className : '';
    return /\b(?:checked|selected|active|is-checked|is-active|ant-checkbox-checked|ant-switch-checked|semi-checkbox-checked|semi-switch-checked)\b/i.test(className);
  };
  const bodyText = normalizeNodeText(document.body?.innerText);
  const searchButton = Array.from(document.querySelectorAll<HTMLElement>('button.search-btn, button'))
    .find((element) => isVisible(element) && /搜\s*索|搜索/.test(normalizeNodeText(element.innerText ?? element.textContent)));
  const searchButtonSelector = searchButton ? selectorForElement(searchButton) : undefined;
  const textNodes = Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter((element) => normalizeNodeText(element.textContent).includes('隐藏已查看'))
    .filter((element) => !Array.from(element.children).some((child) => normalizeNodeText(child.textContent).includes('隐藏已查看')));

  for (const textNode of textNodes) {
    if (!isVisible(textNode)) {
      continue;
    }

    const containers = [
      textNode.closest('label'),
      textNode.closest('[role="checkbox"], [role="switch"]'),
      textNode.closest('li, div, section, span'),
      textNode.parentElement,
    ].filter((element): element is Element => Boolean(element));

    for (const container of containers) {
      const input = container.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"], input');
      const ariaControl = container.matches('[role="checkbox"], [role="switch"]')
        ? container
        : container.querySelector('[role="checkbox"], [role="switch"]');
      const classControl = container.querySelector('[class*="checkbox"], [class*="switch"]');
      const control = input ?? ariaControl ?? classControl ?? container;
      const clickTarget = [
        input,
        ariaControl,
        classControl,
        container,
        textNode,
      ].find(isVisible);
      const checked = input ? input.checked : isChecked(control);
      const clickSelector = clickTarget ? (selectorForElement(clickTarget) ?? selectorForElement(container)) : selectorForElement(container);

      return {
        found: true,
        checked,
        clickSelector,
        searchButtonSelector,
        bodyText,
      };
    }
  }

  return {
    found: false,
    checked: false,
    searchButtonSelector,
    bodyText,
  };
}

async function readLiepinHideViewedState(page: Page): Promise<LiepinHideViewedState> {
  return page.evaluate(getLiepinHideViewedControlState);
}

async function waitForLiepinHideViewedState(page: Page, deadline: number): Promise<LiepinHideViewedState> {
  const state = await readLiepinHideViewedState(page);
  if (state.found) {
    return state;
  }

  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (waitForFunction) {
    await waitForFunction(
      () => (document.body?.innerText ?? '').includes('隐藏已查看'),
      undefined,
      { timeout: remainingTime(deadline), polling: 250 },
    ).catch(() => undefined);
  }

  return readLiepinHideViewedState(page);
}

async function clickLiepinSearchButtonIfHideViewedMissing(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await readLiepinHideViewedState(page);
  if (state.found || !state.searchButtonSelector) {
    return false;
  }

  const searchButton = page.locator(state.searchButtonSelector).first();
  await searchButton.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await clickLiepinLocator(searchButton, page, remainingTime(deadline));
  return true;
}

async function ensureLiepinHideViewedChecked(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await waitForLiepinHideViewedState(page, deadline);
  if (!state.found) {
    throw new Error(`Could not find Liepin "隐藏已查看" filter. Page text: ${(state.bodyText ?? '').slice(0, 500)}`);
  }

  if (state.checked) {
    return false;
  }

  const verifyChecked = async () => {
    const nextState = await waitForLiepinHideViewedState(page, deadline);
    if (!nextState.checked) {
      throw new Error(`Liepin "隐藏已查看" filter was clicked but did not become checked. Page text: ${(nextState.bodyText ?? '').slice(0, 500)}`);
    }
  };

  if (state.clickSelector) {
    const control = page.locator(state.clickSelector).first();
    await control.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
    options.beforeClick?.();
    await clickLiepinLocator(control, page, remainingTime(deadline));
    await verifyChecked();
    return true;
  }

  const filterText = page.getByText('隐藏已查看', { exact: false }).first();
  await filterText.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await clickLiepinLocator(filterText, page, remainingTime(deadline));
  await verifyChecked();
  return true;
}

async function ensureLiepinHideViewedUnchecked(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await waitForLiepinHideViewedState(page, deadline);
  if (!state.found || !state.checked) {
    return false;
  }

  const verifyUnchecked = async () => {
    const nextState = await waitForLiepinHideViewedState(page, deadline);
    if (nextState.checked) {
      throw new Error(`Liepin "隐藏已查看" filter was clicked but did not become unchecked. Page text: ${(nextState.bodyText ?? '').slice(0, 500)}`);
    }
  };

  if (state.clickSelector) {
    const control = page.locator(state.clickSelector).first();
    await control.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
    options.beforeClick?.();
    await clickLiepinLocator(control, page, remainingTime(deadline));
    await verifyUnchecked();
    return true;
  }

  const filterText = page.getByText('隐藏已查看', { exact: false }).first();
  await filterText.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await clickLiepinLocator(filterText, page, remainingTime(deadline));
  await verifyUnchecked();
  return true;
}

async function applyLiepinViewedFilterForExtraction(
  page: Page,
  deadline: number,
  includeViewedCandidates?: boolean,
): Promise<void> {
  if (includeViewedCandidates) {
    const clickedSearchButton = await clickLiepinSearchButtonIfHideViewedMissing(page, deadline, {
      beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
    });
    if (clickedSearchButton) {
      await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
    }

    await ensureLiepinHideViewedUnchecked(page, deadline, {
      beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
    });
    await waitForLiepinFinalSearchResumesOrEmptyResults(page, deadline);
    if ((await waitForLiepinHideViewedState(page, deadline)).checked) {
      await ensureLiepinHideViewedUnchecked(page, deadline, {
        beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
      });
      await waitForLiepinFinalSearchResumesOrEmptyResults(page, deadline);
    }
    await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
    return;
  }

  if (await clickLiepinSearchButtonIfHideViewedMissing(page, deadline, {
    beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
  })) {
    await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  }
  await ensureLiepinHideViewedChecked(page, deadline, {
    beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
  });
  await waitForLiepinFinalSearchResumesOrEmptyResults(page, deadline);
  if (!(await waitForLiepinHideViewedState(page, deadline)).checked) {
    await ensureLiepinHideViewedChecked(page, deadline, {
      beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
    });
    await waitForLiepinFinalSearchResumesOrEmptyResults(page, deadline);
  }
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
}

export async function openLiepinDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  const searchPage = await prepareLiepinSearchConditionPage(page, keyword, { ...options, deadline });
  for (const condition of conditions) {
    const result = await applyLiepinSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      throw new Error(`Liepin direct search condition ${condition.kind} failed: ${result.message ?? result.status}`);
    }
  }

  await applyLiepinViewedFilterForExtraction(searchPage, deadline, options?.includeViewedCandidates);
  return searchPage;
}

export async function openLiepinSubscribeSearch(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  resetObservedLiepinSearchResumesApi(page);
  attachLiepinSearchResumesApiObserver(page);
  await openLiepinRecruiterSearchPage(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  clearObservedLiepinSearchResumesApiBeforeNextAction(page);
  await clickLiepinQuickSearchTag(page, keyword, deadline);
  await waitForLiepinQuickSearchResults(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  await applyLiepinViewedFilterForExtraction(page, deadline, options?.includeViewedCandidates);
  return page;
}

export function parseLiepinAppliedSearchKeyword(bodyText: string): string | undefined {
  const normalizedBody = bodyText.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = normalizedBody.match(/关键词[:：]\s*(.*?)(?=\s+(?:学历|经验|年龄|薪资|城市|行业|公司|更多|清空|隐藏已查看|搜索)|$)/u);
  return (match?.[1] ?? '').trim() || undefined;
}

export async function readLiepinAppliedSearchKeyword(page: Page): Promise<string | undefined> {
  const scopedInputs = await page.locator([
    '.search-area .search-auto-complete-box input.ant-select-selection-search-input',
    '.search-top-bar .search-auto-complete-box input.ant-select-selection-search-input',
  ].join(', ')).evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLInputElement)) return [];
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return [];
    return [element.value.normalize('NFKC').replace(/\s+/gu, ' ').trim()];
  }));
  const populatedInputs = scopedInputs.filter(Boolean);
  if (populatedInputs.length > 1) {
    throw new Error(`Liepin keyword evidence is ambiguous: found ${populatedInputs.length} populated scoped inputs.`);
  }
  if (populatedInputs.length === 1) return populatedInputs[0];
  if (scopedInputs.length > 0) return '';
  return parseLiepinAppliedSearchKeyword(await page.locator('body').innerText().catch(() => ''));
}

async function waitForExactLiepinKeyword(page: Page, expectedKeyword: string, deadline: number): Promise<string> {
  const normalizedExpected = expectedKeyword.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  let latestObserved: string | undefined;
  while (Date.now() <= deadline) {
    latestObserved = await readLiepinAppliedSearchKeyword(page);
    if (latestObserved === normalizedExpected) return latestObserved;
    await page.waitForTimeout(Math.min(100, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error(`Liepin saved search did not prove exact page keyword "${expectedKeyword}". Observed: "${latestObserved ?? '(missing)'}".`);
}

async function countVisibleExactLiepinQuickSearchTags(page: Page, name: string): Promise<number> {
  const tags = locateExactLiepinQuickSearchTags(page, name);
  if (!tags) return 0;
  let visible = 0;
  for (let index = 0; index < await tags.count(); index += 1) {
    if (await tags.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

export async function inspectExistingLiepinSavedSearch(
  page: Page,
  request: CoreSavedSearchVerificationRequest,
  options: SearchWaitOptions & { boundJobKey: string },
): Promise<ExistingSavedSearchInspection> {
  if (request.platform !== 'liepin' || request.boundJobKey !== options.boundJobKey) {
    throw new Error('Liepin saved-search inspection target does not belong to this platform and job.');
  }
  const target = buildCoreSavedSearchTarget({
    platform: 'liepin',
    boundJobKey: request.boundJobKey,
    bindingRevision: request.bindingRevision,
    name: request.name,
    expectedKeyword: request.expectedKeyword,
  });
  const deadline = createSearchDeadline(options);
  if (await hasVisibleLiepinBlockingOverlay(page)) {
    await closeLiepinBlockingOverlays(page, Math.min(3000, remainingTime(deadline)));
    if (await hasVisibleLiepinBlockingOverlay(page)) {
      throw new Error('Liepin saved-search inspection could not clear the existing blocking overlay.');
    }
  }
  await openLiepinRecruiterSearchPage(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  const exactCount = await countVisibleExactLiepinQuickSearchTags(page, target.name);
  if (exactCount === 0) return { status: 'absent', page };
  if (exactCount !== 1) {
    throw new Error(`Liepin saved search "${target.name}" requires one visible exact match; found ${exactCount}.`);
  }
  const opened = await openBoundLiepinSavedSearch(page, target, { ...options, deadline });
  return { status: 'matched', page: opened.page, target, evidence: opened.evidence };
}

export async function openBoundLiepinSavedSearch(
  page: Page,
  rawTarget: CoreSavedSearchTarget,
  options: SearchWaitOptions & { boundJobKey: string },
): Promise<{ page: Page; evidence: PlatformSavedSearchOpenEvidence }> {
  const target = rawTarget;
  if (target.platform !== 'liepin' || target.boundJobKey !== options.boundJobKey) {
    throw new Error('Liepin saved-search target does not belong to this platform and job.');
  }
  const deadline = createSearchDeadline(options);
  resetObservedLiepinSearchResumesApi(page);
  attachLiepinSearchResumesApiObserver(page);
  await openLiepinRecruiterSearchPage(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  clearObservedLiepinSearchResumesApiBeforeNextAction(page);
  const observedName = await clickLiepinQuickSearchTag(page, target.name, deadline, { requireUniqueExact: true });
  if (!observedName) throw new Error(`Liepin saved search "${target.name}" did not yield an observed exact tag name.`);
  await waitForLiepinQuickSearchResults(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  await waitForExactLiepinKeyword(page, target.expectedKeyword, deadline);
  await applyLiepinViewedFilterForExtraction(page, deadline, options.includeViewedCandidates);
  const observedKeyword = await waitForExactLiepinKeyword(page, target.expectedKeyword, deadline);
  return {
    page,
    evidence: buildSavedSearchOpenEvidence(target, {
      boundJobKey: options.boundJobKey,
      observedName,
      observedKeyword,
    }),
  };
}

export async function savePreparedLiepinSearchCondition(
  page: Page,
  savedSearchName: string,
  options?: SearchWaitOptions,
): Promise<Awaited<ReturnType<NonNullable<import('../../types.js').PlatformAdapter['saveSearchCondition']>>>> {
  const deadline = createSearchDeadline(options);
  await saveLiepinSearchCondition(page, savedSearchName, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
  const context = options?.subscriptionMutationContext;
  if (!context) return undefined;
  const target = buildCoreSavedSearchTarget({
    platform: 'liepin',
    boundJobKey: `subscription-management:${context.conditionFingerprint}`,
    bindingRevision: 1,
    name: savedSearchName,
    expectedKeyword: context.expectedKeyword,
  });
  const opened = await openBoundLiepinSavedSearch(page, target, {
    ...options, deadline,
    boundJobKey: target.boundJobKey,
  });
  return { outcome: 'saved', openEvidence: opened.evidence, workPage: opened.page };
}
