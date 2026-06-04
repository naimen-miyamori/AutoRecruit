import { collectCandidateList } from '../browser/candidate-list.js';
import { clear51jobViewedFilter, ensure51jobViewedFilterChecked, openSubscribeSearch } from '../browser/subscribe-search.js';
import {
  prepare51jobSearchConditionPage,
  prepare51jobSearchConditionPageWithOptions,
  read51jobSearchResultTotal,
  save51jobSearchCondition,
} from '../browser/51job-search-subscription.js';
import { openResumeDetail, parseResumeDetail } from '../browser/resume-detail.js';
import type { PlatformAdapter } from './types.js';
import { assertAuthenticatedPage } from '../browser/subscribe-search.js';
import { discoverSearchFiltersOnPage } from '../search/filter-discovery.js';
import {
  buildSearchFilterDiscoveryStats,
  type SearchFilterCatalog,
  type SearchFilterDefinition,
  type SearchFilterDiscoveryFailure,
  type SearchFilterDiscoveryRunOptions,
  type SearchFilterOption,
} from '../search/filter-catalog.js';
import { buildFilterKey } from '../search/filter-dom.js';
import { normalize51jobFilterDefinition } from './51job-filter-normalization.js';
import { clickPrimarySearchButton } from '../search/page-actions.js';
import type { Locator, Page } from 'playwright';
import type { SearchCondition, SearchConditionApplyResult } from '../types/job.js';

const expectedLocationOverlaySelector = '.talent_search_address.outer_search_address .up';
const textInputDialogSelector = '.el-dialog__wrapper';

interface FiftyOneJobDynamicTextInputTarget {
  id: string;
  label: string;
  triggerSelector: string;
  dialogMarkerText: string;
  inputPlaceholder?: string;
  preferCascade?: boolean;
}

interface FiftyOneJobCascadeTarget {
  id: string;
  label: string;
}

const fiftyOneJobDynamicTextInputTargets: FiftyOneJobDynamicTextInputTarget[] = [
  {
    id: 'expected-location',
    label: '期望工作地',
    triggerSelector: expectedLocationOverlaySelector,
    dialogMarkerText: '选择城市',
    inputPlaceholder: '期望工作地',
    preferCascade: true,
  },
  {
    id: 'living-area',
    label: '居住地',
    triggerSelector: 'div.search-row-content_item > div > div.candidateLivingAreaPicker-container.candidate-living-area-picker > button.base-select-button',
    dialogMarkerText: '选择现居地',
  },
  {
    id: 'expected-industry',
    label: '期望行业',
    triggerSelector: 'div.search-row-content_item > div > div.candidateExpectedIndustryPicker-container.candidate-expected-industry-picker > button.base-select-button',
    dialogMarkerText: '选择行业',
    inputPlaceholder: '请输入',
  },
  {
    id: 'expected-function',
    label: '期望职能',
    triggerSelector: 'div.search-row-content_item > div > div.candidateExpectedFunctionPicker-container.candidate-expected-function-picker > button.base-select-button',
    dialogMarkerText: '选择职能',
    inputPlaceholder: '请输入',
  },
  {
    id: 'engage-industry',
    label: '从事行业',
    triggerSelector: 'div.search-row-content > div.search-row-content_item > div.candidateEngageIndustryPicker-container.candidate-engage-industry-picker > button.base-select-button',
    dialogMarkerText: '选择行业',
    inputPlaceholder: '请输入',
  },
  {
    id: 'engage-function',
    label: '从事职能',
    triggerSelector: 'div.search-row-content > div.search-row-content_item > div.candidateExpectedFunctionPicker-container.candidate-engage-function-picker > button.base-select-button',
    dialogMarkerText: '选择职能',
    inputPlaceholder: '请输入',
  },
  {
    id: 'major',
    label: '专业',
    triggerSelector: 'div.search-row-content_item > div > div.candidateMajorSelectPicker-container.candidate-major-select-picker > button.base-select-button',
    dialogMarkerText: '选择专业',
    inputPlaceholder: '请输入',
  },
];

const fiftyOneJobDynamicTextInputSelectorSet = new Set(
  fiftyOneJobDynamicTextInputTargets.map((target) => target.triggerSelector),
);

const fiftyOneJobExpectedSalaryTarget: FiftyOneJobCascadeTarget = {
  id: 'expected-salary',
  label: '期望月薪',
};

const fiftyOneJobSingleSelectLabelByFieldId: Record<string, string> = {
  work_years: '工作年限',
  age: '年龄',
  gender: '性别',
  education: '学历要求',
  school_nature: '学校性质',
  job_status: '求职状态',
  recent_activity_time: '最近活跃时间',
  graduation_year: '毕业时间',
  language: '语言要求',
  work_type: '工作类型',
  company_nature: '公司性质',
  job_hopping_count: '跳槽次数',
};

function build51jobDynamicTextInputSelectorHints(
  target: FiftyOneJobDynamicTextInputTarget,
): SearchFilterDefinition['selectorHints'] {
  return [
    { kind: 'cssPath', value: target.triggerSelector },
    ...(target.inputPlaceholder ? [{ kind: 'placeholder' as const, value: target.inputPlaceholder }] : []),
    { kind: 'text', value: target.label },
    { kind: 'containerText', value: target.label },
  ];
}

function build51jobDynamicTextInputFailure(
  target: FiftyOneJobDynamicTextInputTarget,
  reason: string,
): SearchFilterDiscoveryFailure {
  return {
    key: buildFilterKey(target.label, `51job-dynamic-${target.id}`),
    label: target.label,
    stage: 'extract',
    reason,
    controlType: 'textInput',
    selectorHints: build51jobDynamicTextInputSelectorHints(target),
  };
}

function build51jobDynamicTextInputFilter(
  target: FiftyOneJobDynamicTextInputTarget,
  options: SearchFilterOption[],
  message?: string,
  status?: SearchFilterDefinition['status'],
): SearchFilterDefinition {
  return {
    key: buildFilterKey(target.label, `51job-dynamic-${target.id}`),
    label: target.label,
    controlType: 'textInput',
    valueShape: 'string',
    status: status ?? (options.length > 0 ? 'optionsExtracted' : 'inspected'),
    options: options.length > 0 ? options : undefined,
    selectorHints: build51jobDynamicTextInputSelectorHints(target),
    inputPlaceholder: target.inputPlaceholder,
    childrenLazy: options.some((option) => (option.depth ?? 0) > 0) || undefined,
    message,
  };
}

function has51jobDynamicTextInputSelectorHints(
  selectorHints: SearchFilterDefinition['selectorHints'] | SearchFilterDiscoveryFailure['selectorHints'] | undefined,
): boolean {
  return (selectorHints ?? []).some((hint) => hint.kind === 'cssPath' && fiftyOneJobDynamicTextInputSelectorSet.has(hint.value));
}

function build51jobCascadeSelectorHints(
  target: FiftyOneJobCascadeTarget,
): SearchFilterDefinition['selectorHints'] {
  return [
    { kind: 'cssPath', value: 'button.base-select-button' },
    { kind: 'text', value: target.label },
    { kind: 'containerText', value: target.label },
  ];
}

function build51jobCascadeFailure(
  target: FiftyOneJobCascadeTarget,
  reason: string,
): SearchFilterDiscoveryFailure {
  return {
    key: buildFilterKey(target.label, `51job-cascade-${target.id}`),
    label: target.label,
    stage: 'extract',
    reason,
    controlType: 'cascadeSelect',
    selectorHints: build51jobCascadeSelectorHints(target),
  };
}

function build51jobCascadeFilter(
  target: FiftyOneJobCascadeTarget,
  options: SearchFilterOption[],
  message?: string,
  status?: SearchFilterDefinition['status'],
): SearchFilterDefinition {
  return {
    key: buildFilterKey(target.label, `51job-cascade-${target.id}`),
    label: target.label,
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: status ?? (options.length > 0 ? 'optionsExtracted' : 'inspected'),
    options: options.length > 0 ? options : undefined,
    selectorHints: build51jobCascadeSelectorHints(target),
    childrenLazy: options.some((option) => (option.depth ?? 0) > 0) || undefined,
    message,
  };
}

async function clickLocatorWithMouse(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 3000 });
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }).catch(() => undefined);
  await page.waitForTimeout(80);
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Target element is not clickable because its bounding box is unavailable.');
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function clickLocatorWithDomEvents(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 3000 });
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    for (const eventName of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }
  });
}

async function waitFor51jobTransientOverlaysToSettle(page: Page, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const hasBlockingOverlay = await page.evaluate(() => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };

      return Array.from(document.querySelectorAll(
        '.el-dialog__wrapper[class*="leave-active"], .el-dialog__wrapper[class*="leave-to"], .el-dialog__wrapper, .base-select-popper',
      )).some(isVisible);
    });

    if (!hasBlockingOverlay) {
      return;
    }

    await page.waitForTimeout(50);
  }
}

async function waitFor51jobVisibleBaseSelectPopover(
  page: Page,
  predicate: (element: Element) => boolean,
  description: string,
  popoverId?: string,
): Promise<Locator> {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const visibleIndex = await page.evaluate(({ predicateSource, targetPopoverId }) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const matches = new Function('element', `return (${predicateSource})(element);`) as (element: Element) => boolean;

      const poppers = Array.from(document.querySelectorAll('.base-select-popper'));
      if (targetPopoverId) {
        const targetIndex = poppers.findIndex((popper) => popper.id === targetPopoverId);
        const target = targetIndex >= 0 ? poppers[targetIndex] : undefined;
        return target && isVisible(target) && matches(target) ? targetIndex : -1;
      }

      for (let index = poppers.length - 1; index >= 0; index -= 1) {
        const popper = poppers[index];
        if (!isVisible(popper)) {
          continue;
        }
        if (matches(popper)) {
          return index;
        }
      }

      return -1;
    }, { predicateSource: predicate.toString(), targetPopoverId: popoverId });

    if (visibleIndex >= 0) {
      const popper = page.locator('.base-select-popper').nth(visibleIndex);
      await popper.waitFor({ state: 'visible', timeout: 500 });
      return popper;
    }

    await page.waitForTimeout(50);
  }

  throw new Error(`Timed out waiting for the visible 51job ${description} popover.`);
}

async function waitFor51jobVisibleDialog(page: Page, markerText: string, timeoutMs = 3000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const visibleIndex = await page.evaluate(({ selector, marker }) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
      const dialogs = Array.from(document.querySelectorAll(selector));
      for (let index = dialogs.length - 1; index >= 0; index -= 1) {
        const dialog = dialogs[index];
        if (isVisible(dialog) && normalize(dialog.textContent).includes(marker)) {
          return index;
        }
      }

      return -1;
    }, { selector: textInputDialogSelector, marker: markerText });

    if (visibleIndex >= 0) {
      const dialog = page.locator(textInputDialogSelector).nth(visibleIndex);
      await dialog.waitFor({ state: 'visible', timeout: 500 });
      return dialog;
    }

    await page.waitForTimeout(50);
  }

  throw new Error(`Timed out waiting for the visible 51job dialog: ${markerText}`);
}

async function waitFor51jobVisibleElementSelectDropdown(page: Page, value: string, timeoutMs = 3000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const visibleIndex = await page.evaluate(({ selector, targetValue }) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const normalize = (item: string | null | undefined): string => String(item ?? '').replace(/\s+/g, ' ').trim();
      const dropdowns = Array.from(document.querySelectorAll(selector));
      for (let index = dropdowns.length - 1; index >= 0; index -= 1) {
        const dropdown = dropdowns[index];
        if (!isVisible(dropdown)) {
          continue;
        }

        const optionTexts = Array.from(dropdown.querySelectorAll('.el-select-dropdown__item, li[role="option"], li'))
          .filter(isVisible)
          .map((option) => normalize(option.textContent));
        if (optionTexts.some((optionText) => optionText === targetValue || optionText.includes(targetValue))) {
          return index;
        }
      }

      return -1;
    }, { selector: '.el-select-dropdown.el-popper', targetValue: value });

    if (visibleIndex >= 0) {
      const dropdown = page.locator('.el-select-dropdown.el-popper').nth(visibleIndex);
      await dropdown.waitFor({ state: 'visible', timeout: 500 });
      return dropdown;
    }

    await page.waitForTimeout(50);
  }

  throw new Error(`Timed out waiting for the visible 51job element-select dropdown: ${value}`);
}

async function waitFor51jobExpectedSalaryPopover(page: Page, popoverId?: string): Promise<Locator> {
  return waitFor51jobVisibleBaseSelectPopover(
    page,
    (element) => Boolean(element.querySelector('.content-wrapper .list-container')),
    'expected-salary',
    popoverId,
  );
}

async function waitFor51jobSingleSelectPopover(page: Page, label: string, popoverId?: string): Promise<Locator> {
  return waitFor51jobVisibleBaseSelectPopover(
    page,
    (element) => Boolean(element.querySelector('.option-list .option-item-wrapper, .popover-custom-range')),
    `single-select ${label}`,
    popoverId,
  );
}

async function open51jobSingleSelectPopover(page: Page, trigger: Locator, label: string): Promise<Locator> {
  let lastError: unknown;
  const popoverId = await trigger.evaluate((element) =>
    element.closest('[aria-describedby]')?.getAttribute('aria-describedby')
      ?? element.getAttribute('aria-describedby')
      ?? undefined,
  ).catch(() => undefined);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt === 0) {
        await clickLocatorWithMouse(page, trigger);
      } else {
        await clickLocatorWithDomEvents(trigger);
      }
      await page.waitForTimeout(150);
      return await waitFor51jobSingleSelectPopover(page, label, popoverId);
    } catch (error) {
      lastError = error;
      await page.keyboard.press('Escape').catch(() => undefined);
      await waitFor51jobTransientOverlaysToSettle(page, 1500).catch(() => undefined);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to open 51job single-select popover: ${label}`);
}

async function open51jobExpectedSalaryPopover(page: Page, trigger: Locator): Promise<Locator> {
  let lastError: unknown;
  const popoverId = await trigger.evaluate((element) =>
    element.closest('[aria-describedby]')?.getAttribute('aria-describedby')
      ?? element.getAttribute('aria-describedby')
      ?? undefined,
  ).catch(() => undefined);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt === 0) {
        await clickLocatorWithMouse(page, trigger);
      } else {
        await clickLocatorWithDomEvents(trigger);
      }
      return await waitFor51jobExpectedSalaryPopover(page, popoverId);
    } catch (error) {
      lastError = error;
      await page.keyboard.press('Escape').catch(() => undefined);
      await waitFor51jobTransientOverlaysToSettle(page, 1500).catch(() => undefined);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to open 51job expected-salary popover.');
}

async function close51jobBaseSelectPopover(
  page: Page,
  popper: Locator,
  trigger?: Locator,
): Promise<void> {
  const waitUntilHidden = async (): Promise<boolean> => {
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const visible = await popper.isVisible().catch(() => false);
      if (!visible) {
        return true;
      }

      await page.waitForTimeout(50);
    }

    return !(await popper.isVisible().catch(() => false));
  };

  await page.keyboard.press('Escape').catch(() => undefined);
  if (await waitUntilHidden()) {
    return;
  }

  if (trigger) {
    await clickLocatorWithMouse(page, trigger).catch(() => undefined);
    if (await waitUntilHidden()) {
      return;
    }
  }

  if (await clickPrimarySearchButton(page, 1500).catch(() => false)) {
    if (await waitUntilHidden()) {
      return;
    }
  }

  throw new Error('Unable to close the visible 51job base-select popover.');
}

async function findFirstUncovered51jobLocator(
  page: Page,
  selector: string,
  predicate: string,
): Promise<Locator | undefined> {
  const index = await page.evaluate(({ selectorValue, predicateSource }) => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const isSelfOrDescendant = (candidate: Element, hit: Element | null): boolean => Boolean(hit)
      && (hit === candidate || candidate.contains(hit));
    const matches = new Function('element', `return ${predicateSource};`) as (element: Element) => boolean;
    const candidates = Array.from(document.querySelectorAll(selectorValue));

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!isVisible(candidate) || !matches(candidate)) {
        continue;
      }

      candidate.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = candidate.getBoundingClientRect();
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + Math.min(12, rect.width / 2), rect.top + rect.height / 2],
        [rect.right - Math.min(12, rect.width / 2), rect.top + rect.height / 2],
      ];
      if (points.some(([x, y]) => isSelfOrDescendant(candidate, document.elementFromPoint(x, y)))) {
        return index;
      }
    }

    return -1;
  }, { selectorValue: selector, predicateSource: predicate.toString() });

  return index >= 0 ? page.locator(selector).nth(index) : undefined;
}

async function findFirstUncovered51jobLocatorBySelectors(
  page: Page,
  selectors: string[],
  predicate: string,
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = await findFirstUncovered51jobLocator(page, selector, predicate);
    if (locator) {
      return locator;
    }
  }

  return undefined;
}

async function findFirstVisible51jobLocator(
  page: Page,
  selector: string,
  predicate: string,
): Promise<Locator | undefined> {
  const index = await page.evaluate(({ selectorValue, predicateSource }) => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const matches = new Function('element', `return ${predicateSource};`) as (element: Element) => boolean;
    const candidates = Array.from(document.querySelectorAll(selectorValue));
    return candidates.findIndex((candidate) => isVisible(candidate) && matches(candidate));
  }, { selectorValue: selector, predicateSource: predicate });

  return index >= 0 ? page.locator(selector).nth(index) : undefined;
}

async function findFirstVisible51jobLocatorBySelectors(
  page: Page,
  selectors: string[],
  predicate: string,
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = await findFirstVisible51jobLocator(page, selector, predicate);
    if (locator) {
      return locator;
    }
  }

  return undefined;
}

async function findPreferred51jobLocator(
  page: Page,
  selector: string,
  predicate: string,
): Promise<Locator | undefined> {
  return await findFirstUncovered51jobLocator(page, selector, predicate)
    ?? await findFirstVisible51jobLocator(page, selector, predicate);
}

async function findPreferred51jobLocatorBySelectors(
  page: Page,
  selectors: string[],
  predicate: string,
): Promise<Locator | undefined> {
  return await findFirstUncovered51jobLocatorBySelectors(page, selectors, predicate)
    ?? await findFirstVisible51jobLocatorBySelectors(page, selectors, predicate);
}

function build51jobTextContentIncludesPredicate(text: string): string {
  return `String(element.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)})`;
}

function build51jobInputPlaceholderPredicate(placeholder: string): string {
  return `element instanceof HTMLInputElement && element.placeholder === ${JSON.stringify(placeholder)}`;
}

async function read51jobExpectedSalaryPopoverState(
  popper: Locator,
  maxOptionsPerLevel: number,
): Promise<{
  leftLabels: string[];
  rightLabels: string[];
  activeLeftLabel: string;
  rightSignature: string;
}> {
  return popper.evaluate((root, optionLimitPerLevel: number) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readLabel = (element: Element | null | undefined): string => normalize(element?.textContent);
    const listContainers = Array.from(root.querySelectorAll('.content-wrapper .list-container'))
      .filter(isVisible) as HTMLElement[];
    const readColumnLabels = (columnIndex: number): string[] => {
      const container = listContainers[columnIndex];
      if (!container) {
        return [];
      }

      return Array.from(container.querySelectorAll('.option-item-wrapper'))
        .filter(isVisible)
        .slice(0, optionLimitPerLevel)
        .map((element) => readLabel(element))
        .filter(Boolean);
    };
    const leftContainer = listContainers[0];
    const activeLeftLabel = leftContainer
      ? readLabel(Array.from(leftContainer.querySelectorAll('.option-item-wrapper'))
        .find((element) => {
          const icon = element.querySelector('.active-item_icon');
          return isVisible(icon);
        }))
      : '';
    const rightLabels = readColumnLabels(1);

    return {
      leftLabels: readColumnLabels(0),
      rightLabels,
      activeLeftLabel,
      rightSignature: rightLabels.join('\u001f'),
    };
  }, maxOptionsPerLevel);
}

async function get51jobExpectedSalaryOptionBox(
  popper: Locator,
  label: string,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  const box = await popper.evaluate((root, targetLabel: string) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const leftContainer = Array.from(root.querySelectorAll('.content-wrapper .list-container'))
      .filter(isVisible)
      .at(0);
    if (!(leftContainer instanceof HTMLElement)) {
      return null;
    }

    const target = Array.from(leftContainer.querySelectorAll('.option-item-wrapper'))
      .filter(isVisible)
      .find((element) => normalize(element.textContent) === targetLabel);
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, label);

  return box ?? undefined;
}

async function click51jobExpectedSalaryOption(
  page: Page,
  popper: Locator,
  label: string,
): Promise<void> {
  const box = await get51jobExpectedSalaryOptionBox(popper, label);
  if (!box) {
    throw new Error(`Unable to locate expected salary option: ${label}`);
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function extract51jobExpectedSalaryOptions(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterOption[]> {
  const trigger = await findPreferred51jobLocator(
    page,
    'button.base-select-button',
    build51jobTextContentIncludesPredicate('期望月薪'),
  ) ?? page.locator('button.base-select-button')
    .filter({ hasText: fiftyOneJobExpectedSalaryTarget.label })
    .first();
  await clickLocatorWithMouse(page, trigger);

  const popper = await waitFor51jobExpectedSalaryPopover(page);
  const maxOptionsPerLevel = Math.max(1, options.maxOptionsPerLevel ?? 80);
  const initialState = await read51jobExpectedSalaryPopoverState(popper, maxOptionsPerLevel);
  const collectedOptions = new Map<string, SearchFilterOption>();
  const upsertOption = (option: SearchFilterOption): void => {
    const key = `${option.depth ?? 0}|${option.pathLabels?.join('\u0000') ?? option.label}`;
    if (!collectedOptions.has(key)) {
      collectedOptions.set(key, option);
    }
  };

  for (const leftLabel of initialState.leftLabels.slice(0, maxOptionsPerLevel)) {
    upsertOption({
      label: leftLabel,
      value: leftLabel,
      depth: 0,
      disabled: false,
      selected: false,
      pathLabels: [leftLabel],
    });
  }

  const terminalRootLabels = new Set(
    initialState.leftLabels.filter((label) => label === '不限' || label.endsWith('及以下') || label.endsWith('及以上')),
  );

  for (const leftLabel of initialState.leftLabels.slice(0, maxOptionsPerLevel)) {
    if (terminalRootLabels.has(leftLabel)) {
      continue;
    }

    const beforeState = await read51jobExpectedSalaryPopoverState(popper, maxOptionsPerLevel);
    await click51jobExpectedSalaryOption(page, popper, leftLabel);

    const waitUntil = Date.now() + 800;
    let currentState = beforeState;
    while (Date.now() < waitUntil) {
      currentState = await read51jobExpectedSalaryPopoverState(popper, maxOptionsPerLevel);
      const rightColumnChanged = currentState.rightSignature !== beforeState.rightSignature;
      const activeMatched = !currentState.activeLeftLabel || currentState.activeLeftLabel === leftLabel;
      if (rightColumnChanged && activeMatched) {
        break;
      }
      await page.waitForTimeout(50);
    }

    for (const rightLabel of currentState.rightLabels) {
      upsertOption({
        label: rightLabel,
        value: rightLabel,
        depth: 1,
        disabled: false,
        selected: false,
        parentPathLabels: [leftLabel],
        pathLabels: [leftLabel, rightLabel],
      });
    }
  }

  return Array.from(collectedOptions.values());
}

async function extract51jobDynamicTextInputOptions(
  page: Page,
  target: FiftyOneJobDynamicTextInputTarget,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterOption[]> {
  const trigger = await findPreferred51jobLocatorBySelectors(
    page,
    [target.triggerSelector],
    'true',
  ) ?? page.locator(target.triggerSelector).first();
  await trigger.waitFor({ state: 'visible', timeout: 3000 });
  await clickLocatorWithMouse(page, trigger);

  const dialogLocator = page.locator(textInputDialogSelector)
    .filter({ hasText: target.dialogMarkerText })
    .last();
  await dialogLocator.waitFor({ state: 'visible', timeout: 3000 });

  const maxDepth = Math.max(1, options.maxDepth ?? 3);
  const maxOptionsPerLevel = Math.max(1, options.maxOptionsPerLevel ?? 50);

  return dialogLocator.evaluate(async (dialog, {
    optionDepthLimit,
    optionLimitPerLevel,
  }) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const getVisibleMenus = (root: ParentNode): HTMLElement[] => Array.from(root.querySelectorAll('ul.cascader_panel_menu'))
      .filter(isVisible);
    const getVisibleItems = (menu: ParentNode): HTMLElement[] => Array.from(menu.children)
      .filter(isVisible)
      .filter((child) => /(^|\s)cascader_panel_item(\s|$)/.test(child.className) || child.tagName === 'LI') as HTMLElement[];
    const readOptionLabel = (element: Element | null | undefined): string => normalize(
      element instanceof HTMLElement
        ? element.querySelector('.cascader_item_label')?.textContent ?? element.textContent
        : '',
    );
    const readMenuSignature = (root: ParentNode, depth: number): string => {
      const menu = getVisibleMenus(root)[depth];
      if (!menu) {
        return '';
      }
      return getVisibleItems(menu).map((item) => readOptionLabel(item)).join('\u001f');
    };
    const readActiveLabel = (root: ParentNode, depth: number): string => {
      const menu = getVisibleMenus(root)[depth];
      if (!menu) {
        return '';
      }
      const active = getVisibleItems(menu).find((item) => /\bactive\b/i.test(item.className));
      return readOptionLabel(active);
    };
    const buildOption = (element: HTMLElement, depth: number, parentPathLabels: string[] = []): SearchFilterOption => {
      const label = readOptionLabel(element);
      const normalizedParentPathLabels = parentPathLabels.map((value) => normalize(value)).filter(Boolean);
      const pathLabels = label
        ? [...normalizedParentPathLabels, label]
        : [...normalizedParentPathLabels];
      return {
        label,
        value: normalize(element.getAttribute('data-value'))
          || ('value' in element ? normalize((element as HTMLInputElement).value) : '')
          || label,
        depth,
        disabled: normalize(element.getAttribute('aria-disabled')).toLowerCase() === 'true'
          || /\bdisabled\b/i.test(element.className),
        selected: /\b(active|selected|checked)\b/i.test(element.className),
        parentPathLabels: normalizedParentPathLabels.length > 0 ? normalizedParentPathLabels : undefined,
        pathLabels: pathLabels.length > 0 ? pathLabels : undefined,
      };
    };
    const clickItem = async (root: ParentNode, depth: number, targetOption: SearchFilterOption): Promise<boolean> => {
      const menu = getVisibleMenus(root)[depth];
      if (!menu) {
        return false;
      }

      const match = getVisibleItems(menu).find((item) => readOptionLabel(item) === targetOption.label);
      if (!match) {
        return false;
      }

      const previousActiveLabel = readActiveLabel(root, depth);
      const previousNextMenuSignature = readMenuSignature(root, depth + 1);
      match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      match.click();
      match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));

      const waitUntil = Date.now() + 1200;
      while (Date.now() < waitUntil) {
        const activeLabel = readActiveLabel(root, depth);
        const nextMenuSignature = readMenuSignature(root, depth + 1);
        const becameActive = activeLabel === targetOption.label;
        const nextMenuChanged = depth + 1 >= optionDepthLimit
          || nextMenuSignature !== previousNextMenuSignature
          || nextMenuSignature.length === 0;
        if (becameActive && nextMenuChanged) {
          return true;
        }
        if (becameActive && previousActiveLabel === targetOption.label) {
          return true;
        }
        await delay(50);
      }

      return true;
    };

    const levels = Array.from(
      { length: optionDepthLimit },
      () => new Map<string, SearchFilterOption>(),
    );
    const upsert = (option: SearchFilterOption) => {
      const key = `${option.depth ?? 0}|${option.pathLabels?.join('\u0000') ?? option.label}`;
      if (!levels[option.depth ?? 0]?.has(key)) {
        levels[option.depth ?? 0]?.set(key, option);
      }
    };
    const visitDepth = async (depth: number, parentPathLabels: string[] = []): Promise<void> => {
      if (depth >= optionDepthLimit) {
        return;
      }

      const menu = getVisibleMenus(dialog)[depth];
      if (!menu) {
        return;
      }

      const items = getVisibleItems(menu)
        .slice(0, optionLimitPerLevel)
        .map((item) => buildOption(item, depth, parentPathLabels))
        .filter((item) => item.label);
      for (const item of items) {
        upsert(item);
      }

      if (depth + 1 >= optionDepthLimit) {
        return;
      }

      for (const item of items) {
        if (item.disabled) {
          continue;
        }

        const clicked = await clickItem(dialog, depth, item);
        if (!clicked) {
          continue;
        }

        const nextMenu = getVisibleMenus(dialog)[depth + 1];
        if (!nextMenu) {
          continue;
        }

        const nextItems = getVisibleItems(nextMenu)
          .slice(0, optionLimitPerLevel)
          .map((nextItem) => buildOption(nextItem, depth + 1, item.pathLabels ?? [...parentPathLabels, item.label]))
          .filter((nextItem) => nextItem.label);
        for (const nextItem of nextItems) {
          upsert(nextItem);
        }

        const hasDeeperChildren = getVisibleItems(nextMenu).some((nextItem) => !/\bleaf\b/i.test(nextItem.className));
        if (hasDeeperChildren) {
          await visitDepth(depth + 1, item.pathLabels ?? [...parentPathLabels, item.label]);
        }
      }
    };

    await visitDepth(0, []);

    return levels.flatMap((level) => Array.from(level.values()));
  }, {
    optionDepthLimit: maxDepth,
    optionLimitPerLevel: maxOptionsPerLevel,
  });
}

function normalizeApplicationFilterValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeApplicationFilterInputValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return normalizeApplicationFilterValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isApplicationFilterCondition(condition: SearchCondition): condition is Extract<SearchCondition, { kind: 'applicationFilter' }> {
  return condition.kind === 'applicationFilter'
    && typeof condition.fieldId === 'string'
    && typeof condition.label === 'string'
    && typeof condition.fieldKind === 'string';
}

async function clickVisibleOptionByLabel(root: Locator, label: string, timeoutMs = 1500): Promise<boolean> {
  const candidates = [
    root.getByText(label, { exact: true }).first(),
    root.getByText(label, { exact: false }).first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: timeoutMs });
      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      await candidate.click({ timeout: timeoutMs });
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function click51jobOptionItemWrapperByLabel(
  page: Page,
  root: Locator,
  label: string,
  timeoutMs = 2000,
  columnIndex?: number,
): Promise<boolean> {
  const clicked = await root.evaluate(async (container, { targetLabel, waitMs, targetColumnIndex }) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readOptionText = (element: Element): string => normalize(
      element.querySelector('.option-item-label, .cascader_item_label')?.textContent
        || element.textContent,
    );
    const getScopedContainers = (): HTMLElement[] => {
      const columnContainers = Array.from(container.querySelectorAll(
        '.content-wrapper .list-container, ul.cascader_panel_menu, .el-select-dropdown__list',
      )).filter(isVisible) as HTMLElement[];
      if (columnContainers.length > 0) {
        return columnContainers;
      }

      const scopedContainers = Array.from(container.querySelectorAll(
        '.option-list, .popover-custom-range',
      )).filter(isVisible) as HTMLElement[];

      return scopedContainers.length > 0 ? scopedContainers : [container as HTMLElement];
    };
    const findMatch = (): HTMLElement | undefined => {
      const scopedContainers = getScopedContainers();
      const searchContainers = typeof targetColumnIndex === 'number'
        ? scopedContainers.slice(targetColumnIndex, targetColumnIndex + 1)
        : scopedContainers;
      const candidates = searchContainers.flatMap((searchContainer) => Array.from(searchContainer.querySelectorAll(
        '.option-item-wrapper, .cascader_panel_item, .el-select-dropdown__item, li[role="option"]',
      )).filter(isVisible) as HTMLElement[]);

      return candidates.find((element) => readOptionText(element) === targetLabel)
        ?? candidates.find((element) => readOptionText(element).includes(targetLabel));
    };
    const dispatchPointerClick = (element: HTMLElement): void => {
      const clickTarget = (
        element.querySelector('.option-item, .option-item-label, .cascader_item_label, span')
        ?? element
      ) as HTMLElement;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const target of [clickTarget, element]) {
        for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window,
          }));
        }
      }
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    };
    const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      const match = findMatch();
      if (match) {
        dispatchPointerClick(match);
        return true;
      }

      await delay(50);
    }

    return false;
  }, { targetLabel: label, waitMs: timeoutMs, targetColumnIndex: columnIndex });

  if (!clicked) {
    return false;
  }

  await page.waitForTimeout(150);
  return true;
}

async function click51jobOptionItemWrapperByLabelWithMouse(
  page: Page,
  root: Locator,
  label: string,
  timeoutMs = 2000,
  columnIndex?: number,
): Promise<boolean> {
  const box = await root.evaluate(async (container, { targetLabel, waitMs, targetColumnIndex }) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readOptionText = (element: Element): string => normalize(
      element.querySelector('.option-item-label, .cascader_item_label')?.textContent
        || element.textContent,
    );
    const getScopedContainers = (): HTMLElement[] => {
      const columnContainers = Array.from(container.querySelectorAll(
        '.content-wrapper .list-container, ul.cascader_panel_menu, .el-select-dropdown__list',
      )).filter(isVisible) as HTMLElement[];
      if (columnContainers.length > 0) {
        return columnContainers;
      }

      const scopedContainers = Array.from(container.querySelectorAll(
        '.option-list, .popover-custom-range',
      )).filter(isVisible) as HTMLElement[];

      return scopedContainers.length > 0 ? scopedContainers : [container as HTMLElement];
    };
    const findMatch = (): HTMLElement | undefined => {
      const scopedContainers = getScopedContainers();
      const searchContainers = typeof targetColumnIndex === 'number'
        ? scopedContainers.slice(targetColumnIndex, targetColumnIndex + 1)
        : scopedContainers;
      const candidates = searchContainers.flatMap((searchContainer) => Array.from(searchContainer.querySelectorAll(
        '.option-item-wrapper, .cascader_panel_item, .el-select-dropdown__item, li[role="option"]',
      )).filter(isVisible) as HTMLElement[]);

      return candidates.find((element) => readOptionText(element) === targetLabel)
        ?? candidates.find((element) => readOptionText(element).includes(targetLabel));
    };
    const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      const match = findMatch();
      if (match) {
        match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = match.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }
      }

      await delay(50);
    }

    return null;
  }, { targetLabel: label, waitMs: timeoutMs, targetColumnIndex: columnIndex });

  if (!box) {
    return false;
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  return true;
}

async function click51jobDialogConfirmButton(page: Page, dialog: Locator, timeoutMs = 1500): Promise<boolean> {
  const candidates = [
    dialog.locator('button.confirm_button').first(),
    dialog.locator('button').filter({ hasText: '确 定' }).first(),
    dialog.locator('button').filter({ hasText: '确定' }).first(),
    dialog.locator('button').filter({ hasText: '确认' }).first(),
    dialog.getByText('确 定', { exact: true }).first(),
    dialog.getByText('确定', { exact: true }).first(),
    dialog.getByText('确认', { exact: true }).first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: timeoutMs });
      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      await clickLocatorWithMouse(page, candidate).catch(async () => candidate.click({ timeout: timeoutMs }));
      return true;
    } catch {
      continue;
    }
  }

  const clickedInDialog = await dialog.evaluate((root) => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(root.querySelectorAll('button'));
    const button = buttons.find((element) =>
      isVisible(element)
      && !element.hasAttribute('disabled')
      && (
        element.classList.contains('confirm_button')
        || ['确 定', '确定', '确认'].includes(normalize(element.textContent))
      ),
    );
    if (!button) {
      return false;
    }

    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    for (const eventName of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      button.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }
    return true;
  }).catch(() => false);

  if (clickedInDialog) {
    return true;
  }

  const clickedInVisiblePageDialog = await page.evaluate(() => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const dialogs = Array.from(document.querySelectorAll('.el-dialog__wrapper')).filter(isVisible);
    for (let index = dialogs.length - 1; index >= 0; index -= 1) {
      const dialogRoot = dialogs[index];
      const buttons = Array.from(dialogRoot.querySelectorAll('button'));
      const button = buttons.find((element) =>
        isVisible(element)
        && !element.hasAttribute('disabled')
        && (
          element.classList.contains('confirm_button')
          || ['确 定', '确定', '确认'].includes(normalize(element.textContent))
        ),
      );
      if (!button) {
        continue;
      }

      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        button.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
      return true;
    }

    return false;
  }).catch(() => false);

  if (clickedInVisiblePageDialog) {
    await page.waitForTimeout(150);
  }

  return clickedInVisiblePageDialog;
}

async function read51jobDynamicTextInputDialogSelection(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((root) => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const selectedRoots = Array.from(root.querySelectorAll(
      '.selected_list_wrapper, .selected-list-wrapper, .selected-list, .selected_list, .el-tag',
    )).filter(isVisible);
    const values = selectedRoots.flatMap((selectedRoot) => {
      const tagValues = Array.from(selectedRoot.querySelectorAll('.el-tag, [title], .tag, li, span'))
        .filter(isVisible)
        .map((element) => normalize(element.getAttribute('title') || element.textContent))
        .filter((value) => value && !/^已选/.test(value) && !/^\d+$/.test(value));
      if (tagValues.length > 0) {
        return tagValues;
      }

      const text = normalize(selectedRoot.textContent);
      return text && !/^已选/.test(text) ? [text] : [];
    });

    const activeValues = Array.from(root.querySelectorAll(
      '.cascader_panel_item.active, .cascader_panel_item.selected, .cascader_panel_item.checked, .cascader_panel_item[class*="active"], .cascader_panel_item[class*="selected"], .cascader_panel_item[class*="checked"]',
    ))
      .filter(isVisible)
      .map((element) => normalize(element.querySelector('.cascader_item_label')?.textContent || element.textContent))
      .filter(Boolean);

    return Array.from(new Set([...values, ...activeValues]));
  });
}

async function clear51jobDynamicTextInputDialogSelection(page: Page, dialog: Locator): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const closedCount = await dialog.evaluate((root) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };

      const selectedRoots = Array.from(root.querySelectorAll(
        '.dialog_footer_content_tag, .selected_list_wrapper, .selected-list-wrapper, .selected-list, .selected_list',
      )).filter(isVisible);
      const closeButtons = selectedRoots.flatMap((selectedRoot) =>
        Array.from(selectedRoot.querySelectorAll('.el-tag__close, .el-icon-close'))
          .filter(isVisible) as HTMLElement[],
      );

      for (const button of closeButtons) {
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
          button.dispatchEvent(new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window,
          }));
        }
      }

      return closeButtons.length;
    }).catch(() => 0);

    if (closedCount === 0) {
      return;
    }

    await page.waitForTimeout(150);
  }
}

function textIncludes51jobSelectedValue(haystack: string, value: string): boolean {
  const normalizedHaystack = haystack.replace(/\s+/g, '');
  const normalizedValue = value.replace(/\s+/g, '');
  return Boolean(normalizedValue) && normalizedHaystack.includes(normalizedValue);
}

function build51jobPersistedValueCandidates(value: string): string[] {
  const normalizedValue = normalizeApplicationFilterValue(value);
  const values = [
    normalizedValue,
    normalizeApplicationFilterValue(normalizedValue.replace(/^全部\s+/, '')),
  ].filter(Boolean);

  return Array.from(new Set(values));
}

function build51jobCustomRangePersistedValueCandidates(input: Record<string, unknown>): string[] {
  const min = normalizeApplicationFilterInputValue(input.min);
  const max = normalizeApplicationFilterInputValue(input.max);
  const values: string[] = [];

  if (min && max) {
    values.push(`${min}-${max}年`);
    values.push(`${min} - ${max}年`);
    values.push(`${min}~${max}年`);
  }

  if (min && !max) {
    values.push(`${min}年及以上`);
    values.push(`${min}年以上`);
  }

  if (!min && max) {
    values.push(`${max}年及以下`);
    values.push(`${max}年以下`);
  }

  return Array.from(new Set(values));
}

function build51jobSalaryRangePersistedValueCandidates(min: string, max: string): string[] {
  const values = [
    `${min}-${max}`,
    `${min} - ${max}`,
    `${min}~${max}`,
  ];
  const minMatch = min.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(千|万)$/);
  const maxMatch = max.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(千|万)$/);

  if (minMatch && maxMatch && minMatch[2] === maxMatch[2]) {
    values.push(`${minMatch[1]}-${maxMatch[1]}${minMatch[2]}`);
    values.push(`${minMatch[1]} - ${maxMatch[1]}${minMatch[2]}`);
    values.push(`${minMatch[1]}~${maxMatch[1]}${minMatch[2]}`);
  }

  return Array.from(new Set(values.map(normalizeApplicationFilterValue).filter(Boolean)));
}

async function waitFor51jobDynamicTextInputDialogSelection(
  page: Page,
  dialog: Locator,
  value: string,
  timeoutMs = 1500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const selectedValues = await read51jobDynamicTextInputDialogSelection(dialog).catch(() => []);
    const valueCandidates = build51jobPersistedValueCandidates(value);
    if (selectedValues.some((selectedValue) => valueCandidates.some((candidate) => textIncludes51jobSelectedValue(selectedValue, candidate)))) {
      return true;
    }

    await page.waitForTimeout(50);
  }

  return false;
}

async function get51jobDynamicTextInputSearchBox(
  dialog: Locator,
  target: FiftyOneJobDynamicTextInputTarget,
): Promise<Locator | undefined> {
  const candidates = [
    ...(target.inputPlaceholder ? [dialog.locator(`input.el-input__inner[placeholder="${target.inputPlaceholder}"]`).first()] : []),
    dialog.locator('input.el-input__inner[placeholder="请输入"]').first(),
    dialog.locator('input[placeholder="请输入"]').first(),
    dialog.locator('input.el-input__inner:visible').first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.count() === 0) {
      continue;
    }

    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return undefined;
}

async function click51jobDynamicTextInputSearchResult(
  page: Page,
  value: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const clicked = await page.evaluate(async ({ targetValue, waitMs }) => {
    const normalize = (input: string | null | undefined): string => String(input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalize(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readPrimaryText = (element: Element): string => {
      const primary = element.querySelector('.key-name_words, .key-name, [class*="key-name"], [title]');
      return normalize(primary?.textContent || element.getAttribute('title') || element.textContent);
    };
    const findMatch = (): HTMLElement | undefined => {
      const targetCompact = compact(targetValue);
      const candidates = Array.from(document.querySelectorAll(
        'li[role="option"], .el-autocomplete-suggestion li, [id^="el-autocomplete-"][role="option"]',
      )).filter(isVisible) as HTMLElement[];

      return candidates.find((element) => compact(readPrimaryText(element)) === targetCompact)
        ?? candidates.find((element) => compact(element.textContent).includes(targetCompact));
    };
    const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      const match = findMatch();
      if (match) {
        match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        match.click();
        return true;
      }

      await delay(50);
    }

    return false;
  }, { targetValue: value, waitMs: timeoutMs });

  if (clicked) {
    await page.waitForTimeout(150);
  }

  return clicked;
}

async function apply51jobDynamicTextInputBySearch(
  page: Page,
  dialog: Locator,
  target: FiftyOneJobDynamicTextInputTarget,
  value: string,
): Promise<boolean> {
  const input = await get51jobDynamicTextInputSearchBox(dialog, target);
  if (!input) {
    return false;
  }

  await input.fill(value, { timeout: 2000 });
  const clicked = await click51jobDynamicTextInputSearchResult(page, value);
  if (!clicked) {
    await input.fill('', { timeout: 1000 }).catch(() => undefined);
    return false;
  }

  const selected = await waitFor51jobDynamicTextInputDialogSelection(page, dialog, value, 2000);
  if (!selected) {
    await input.fill('', { timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }

  return selected;
}

async function apply51jobDynamicTextInputByCascade(
  page: Page,
  dialog: Locator,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  value: string,
  pathLabels?: string[],
): Promise<void> {
  const labels = pathLabels?.length ? pathLabels : [value];
  for (let index = 0; index < labels.length; index += 1) {
    const pathLabel = labels[index]!;
    const clicked = await click51jobOptionItemWrapperByLabelWithMouse(page, dialog, pathLabel, 2000, labels.length > 1 ? index : undefined)
      || await clickVisibleOptionByLabel(dialog, pathLabel);
    if (!clicked) {
      throw new Error(`Unable to select ${condition.label}: ${labels.join(' / ')}`);
    }
    await page.waitForTimeout(150);
  }

  if (!(await is51jobDynamicTextInputSelected(page, dialog, value))) {
    throw new Error(`Unable to verify ${condition.label} selected value before confirm: ${value}`);
  }
}

async function read51jobAppliedFilterText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const values = Array.from(document.querySelectorAll('input.el-input__inner, button.base-select-button, .filter-tag, .tag-item, .search-condition-tag'))
      .map((element) => {
        if (element instanceof HTMLInputElement) {
          return [element.placeholder, element.value, element.title].map(normalize).filter(Boolean).join(':');
        }

        return [
          normalize(element.textContent),
          normalize(element.getAttribute('title')),
        ].filter(Boolean).join(':');
      })
      .filter(Boolean);

    return Array.from(new Set(values)).join(' ');
  });
}

async function assert51jobDynamicTextInputApplied(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  values: Array<{ value: string }>,
): Promise<void> {
  const appliedText = await read51jobAppliedFilterText(page);
  const missingValues = values
    .map((item) => item.value)
    .filter((value) => !build51jobPersistedValueCandidates(value).some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate)));

  if (missingValues.length > 0) {
    throw new Error(`51job text input filter ${condition.label} did not persist selected values: ${missingValues.join(', ')}`);
  }
}

async function is51jobDynamicTextInputSelected(
  page: Page,
  dialog: Locator,
  value: string,
): Promise<boolean> {
  if (await waitFor51jobDynamicTextInputDialogSelection(page, dialog, value, 2000)) {
    return true;
  }

  const appliedText = await read51jobAppliedFilterText(page).catch(() => '');
  return build51jobPersistedValueCandidates(value)
    .some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate));
}

async function assert51jobSingleSelectApplied(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  value: string,
  customInput?: Record<string, unknown>,
): Promise<void> {
  if (value === '不限') {
    return;
  }

  const appliedText = await read51jobAppliedFilterText(page);
  const customCandidates = customInput
    ? build51jobCustomRangePersistedValueCandidates(customInput)
    : [];
  const candidates = customCandidates.length > 0 ? customCandidates : [value];

  if (!candidates.some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate))) {
    throw new Error(`51job single-select filter ${condition.label} did not persist selected value: ${value}`);
  }
}

async function assert51jobExpectedSalaryApplied(page: Page, min: string, max: string): Promise<void> {
  if (min === '不限') {
    return;
  }

  const appliedText = await read51jobAppliedFilterText(page);
  const rangeApplied = build51jobSalaryRangePersistedValueCandidates(min, max)
    .some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate));
  const minApplied = build51jobPersistedValueCandidates(min)
    .some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate));
  const maxApplied = build51jobPersistedValueCandidates(max)
    .some((candidate) => textIncludes51jobSelectedValue(appliedText, candidate));

  if (!rangeApplied && (!minApplied || !maxApplied)) {
    throw new Error(`51job expected salary filter did not persist selected range: ${min}-${max}`);
  }
}

function extractCustomInputObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value.input) ? value.input : undefined;
}

function read51jobSingleSelectPathLabels(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  value: string,
): string[] | undefined {
  const matchedValue = condition.values?.find((item) =>
    normalizeApplicationFilterValue(item.value) === value
    && (item.pathLabels?.length ?? 0) > 0,
  );
  const pathLabels = matchedValue?.pathLabels
    ?.map((item) => normalizeApplicationFilterValue(item))
    .filter(Boolean);

  return pathLabels && pathLabels.length > 0 ? pathLabels : undefined;
}

async function fill51jobSingleSelectCustomInput(
  page: Page,
  popover: Locator,
  input: Record<string, unknown>,
  label: string,
): Promise<void> {
  const orderedEntries = [
    ...['min', 'max']
      .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
      .map((key) => [key, input[key]] as const),
    ...Object.entries(input).filter(([key]) => key !== 'min' && key !== 'max'),
  ];
  const inputValues = orderedEntries
    .map(([key, value]) => ({ key, value: normalizeApplicationFilterInputValue(value) }))
    .filter((entry) => entry.value);
  if (inputValues.length === 0) {
    throw new Error(`Missing custom input values for 51job single-select filter: ${label}`);
  }

  const textInputs = popover.locator('input.el-input__inner:visible');
  const inputCount = await textInputs.count();
  if (inputCount < inputValues.length) {
    throw new Error(`Unable to fill custom input for ${label}: expected ${inputValues.length} inputs, found ${inputCount}`);
  }

  for (let index = 0; index < inputValues.length; index += 1) {
    await textInputs.nth(index).fill(inputValues[index]!.value, { timeout: 2000 });
  }

  const button = popover.locator('button').filter({ hasText: '确定' }).first();
  await button.waitFor({ state: 'visible', timeout: 2000 });
  const confirmDeadline = Date.now() + 2000;
  while (Date.now() < confirmDeadline) {
    if (await button.isEnabled().catch(() => false)) {
      await clickLocatorWithMouse(page, button);
      return;
    }

    await page.waitForTimeout(50);
  }

  throw new Error(`Unable to confirm custom input for ${label}: confirm button stayed disabled`);
}

async function apply51jobElementSelectApplicationFilter(
  page: Page,
  label: string,
  value: string,
): Promise<boolean> {
  const triggerInput = await findPreferred51jobLocator(
    page,
    'input.el-input__inner',
    build51jobInputPlaceholderPredicate(label),
  );
  if (!triggerInput) {
    return false;
  }

  await triggerInput.waitFor({ state: 'visible', timeout: 3000 });
  await clickLocatorWithMouse(page, triggerInput).catch(async () => clickLocatorWithDomEvents(triggerInput));

  const dropdown = await waitFor51jobVisibleElementSelectDropdown(page, value);

  const clicked = await click51jobOptionItemWrapperByLabel(page, dropdown, value, 2000)
    || await clickVisibleOptionByLabel(dropdown, value, 2000);
  if (!clicked) {
    throw new Error(`Unable to select ${label}: ${value}`);
  }

  return true;
}

async function find51jobRecentActivityTimeTrigger(page: Page): Promise<Locator | undefined> {
  const triggerIndex = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const activityOptions = ['近1周', '近2周', '近1个月', '近2个月', '近6个月', '近1年', '1年及以上'];
    const popovers = Array.from(document.querySelectorAll('.base-select-popper'));
    const buttons = Array.from(document.querySelectorAll('button.base-select-button'));

    for (const popover of popovers) {
      const optionText = normalize(popover.textContent);
      if (!activityOptions.every((option) => optionText.includes(option))) {
        continue;
      }

      const id = popover.getAttribute('id');
      if (!id) {
        continue;
      }

      const trigger = document.querySelector(`[aria-describedby="${id}"] button.base-select-button`);
      if (!trigger) {
        continue;
      }

      return buttons.indexOf(trigger);
    }

    for (let index = 0; index < buttons.length; index += 1) {
      const buttonText = normalize(buttons[index]?.textContent);
      if (activityOptions.includes(buttonText)) {
        return index;
      }
    }

    return -1;
  });

  if (triggerIndex < 0) {
    return undefined;
  }

  return page.locator('button.base-select-button').nth(triggerIndex);
}

async function find51jobSingleSelectTrigger(
  page: Page,
  fieldId: string,
  label: string,
): Promise<Locator | undefined> {
  const trigger = await findPreferred51jobLocator(
    page,
    'button.base-select-button',
    build51jobTextContentIncludesPredicate(label),
  );
  if (trigger) {
    return trigger;
  }

  if (fieldId === 'recent_activity_time') {
    return find51jobRecentActivityTimeTrigger(page);
  }

  return undefined;
}

async function apply51jobDynamicTextInputApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  await waitFor51jobTransientOverlaysToSettle(page);
  const target = fiftyOneJobDynamicTextInputTargets.find((item) => item.label === condition.label);
  if (!target) {
    throw new Error(`Unsupported 51job text input filter: ${condition.fieldId}`);
  }

  const values = condition.values ?? [];
  if (values.length === 0) {
    throw new Error(`Missing values for 51job text input filter: ${condition.fieldId}`);
  }

  const trigger = await findPreferred51jobLocatorBySelectors(page, [target.triggerSelector], 'true')
    ?? page.locator(target.triggerSelector).first();
  await trigger.waitFor({ state: 'visible', timeout: 3000 });
  await clickLocatorWithMouse(page, trigger).catch(async () => clickLocatorWithDomEvents(trigger));

  const dialog = await waitFor51jobVisibleDialog(page, target.dialogMarkerText);

  const normalizedValues = values
    .map((item) => ({
      value: normalizeApplicationFilterValue(item.value),
      pathLabels: item.pathLabels,
    }))
    .filter((item) => item.value);
  if (normalizedValues.length === 0) {
    throw new Error(`Missing non-empty values for 51job text input filter: ${condition.fieldId}`);
  }

  await clear51jobDynamicTextInputDialogSelection(page, dialog);

  for (const item of normalizedValues) {
    const didApplyBySearch = target.preferCascade
      ? false
      : await apply51jobDynamicTextInputBySearch(page, dialog, target, item.value);
    if (!didApplyBySearch) {
      await apply51jobDynamicTextInputByCascade(page, dialog, condition, item.value, item.pathLabels);
    }
  }

  const didConfirm = await click51jobDialogConfirmButton(page, dialog, 1500);
  if (!didConfirm && !(await is51jobDynamicTextInputSelected(page, dialog, normalizedValues[normalizedValues.length - 1]!.value))) {
    throw new Error(`Unable to confirm ${condition.label} selection.`);
  }
  await waitFor51jobTransientOverlaysToSettle(page);
  await assert51jobDynamicTextInputApplied(page, condition, normalizedValues);
}

async function apply51jobExpectedSalaryApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  await waitFor51jobTransientOverlaysToSettle(page);
  if (!isRecord(condition.value)) {
    throw new Error('Expected salary application filter requires { min, max } value.');
  }

  const min = normalizeApplicationFilterValue(condition.value.min);
  const max = normalizeApplicationFilterValue(condition.value.max);
  if (!min || !max) {
    throw new Error('Expected salary application filter requires non-empty min and max values.');
  }

  const trigger = await findPreferred51jobLocator(
    page,
    'button.base-select-button',
    build51jobTextContentIncludesPredicate(fiftyOneJobExpectedSalaryTarget.label),
  ) ?? page.locator('button.base-select-button')
    .filter({ hasText: fiftyOneJobExpectedSalaryTarget.label })
    .first();
  const popper = await open51jobExpectedSalaryPopover(page, trigger);
  await click51jobExpectedSalaryOption(page, popper, min);
  await page.waitForTimeout(250);

  const clickedMax = await popper.getByText(max, { exact: true }).last().click({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!clickedMax) {
    throw new Error(`Unable to select expected salary max option: ${max}`);
  }
  await close51jobBaseSelectPopover(page, popper, trigger);
  await waitFor51jobTransientOverlaysToSettle(page);
  await assert51jobExpectedSalaryApplied(page, min, max);
}

async function apply51jobSingleSelectApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  await waitFor51jobTransientOverlaysToSettle(page);
  const label = fiftyOneJobSingleSelectLabelByFieldId[condition.fieldId] ?? condition.label;
  const value = isRecord(condition.value)
    ? normalizeApplicationFilterValue(condition.value.label)
    : normalizeApplicationFilterValue(condition.value);

  if (!value) {
    throw new Error(`Missing value for 51job single-select filter: ${condition.fieldId}`);
  }

  const trigger = await find51jobSingleSelectTrigger(page, condition.fieldId, label);
  if (!trigger) {
    const didApplyElementSelect = await apply51jobElementSelectApplicationFilter(page, label, value);
    if (didApplyElementSelect) {
      await waitFor51jobTransientOverlaysToSettle(page);
      await assert51jobSingleSelectApplied(page, condition, value);
      return;
    }
  }

  if (!trigger) {
    throw new Error(`Unable to locate 51job single-select trigger: ${label}`);
  }

  const popover = await open51jobSingleSelectPopover(page, trigger, label);
  const labelsToClick = read51jobSingleSelectPathLabels(condition, value) ?? [value];
  for (let index = 0; index < labelsToClick.length; index += 1) {
    const pathLabel = labelsToClick[index]!;
    const clicked = await click51jobOptionItemWrapperByLabel(
      page,
      popover,
      pathLabel,
      2000,
      labelsToClick.length > 1 ? index : undefined,
    )
      || await clickVisibleOptionByLabel(popover, pathLabel, 2000);
    if (!clicked) {
      throw new Error(`Unable to select ${label}: ${labelsToClick.join(' / ')}`);
    }
    await page.waitForTimeout(150);
  }

  const customInput = extractCustomInputObject(condition.value);
  if (customInput) {
    await fill51jobSingleSelectCustomInput(page, popover, customInput, label);
  }
  await waitFor51jobTransientOverlaysToSettle(page);
  await assert51jobSingleSelectApplied(page, condition, value, customInput);
}

async function apply51jobApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<SearchConditionApplyResult> {
  try {
    if (condition.fieldKind === 'textInput') {
      await apply51jobDynamicTextInputApplicationFilter(page, condition);
    } else if (condition.fieldKind === 'salaryRange') {
      await apply51jobExpectedSalaryApplicationFilter(page, condition);
    } else {
      await apply51jobSingleSelectApplicationFilter(page, condition);
    }

    return {
      platform: '51job',
      condition,
      status: 'applied',
    };
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await waitFor51jobTransientOverlaysToSettle(page, 1500).catch(() => undefined);
    return {
      platform: '51job',
      condition,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function apply51jobSearchCondition(
  page: Page,
  condition: SearchCondition,
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: '51job',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for 51job yet.`,
    };
  }

  return apply51jobApplicationFilter(page, condition);
}

async function open51jobDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: Parameters<NonNullable<PlatformAdapter['openDirectSearch']>>[3],
): Promise<Page> {
  const searchPage = await prepare51jobSearchConditionPageWithOptions(page, keyword, options);
  for (const condition of conditions) {
    const result = await apply51jobSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      throw new Error(`51job direct search condition ${condition.kind} failed: ${result.message ?? result.status}`);
    }
  }

  if (options?.includeViewedCandidates) {
    await clear51jobViewedFilter(searchPage, options);
  } else {
    await ensure51jobViewedFilterChecked(searchPage, options);
  }

  await clickPrimarySearchButton(searchPage, 1500, '51job').catch(() => false);
  return searchPage;
}

async function discover51jobDynamicTextInputFilter(
  page: Page,
  target: FiftyOneJobDynamicTextInputTarget,
  options: SearchFilterDiscoveryRunOptions,
): Promise<{ filter: SearchFilterDefinition; failures: SearchFilterDiscoveryFailure[] }> {
  try {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    const extractedOptions = await extract51jobDynamicTextInputOptions(page, target, options);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250);

    return {
      filter: build51jobDynamicTextInputFilter(
        target,
        extractedOptions,
        'Opened text-entry dialog. Visible menu options were recorded as a constrained input pool.',
      ),
      failures: [],
    };
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250);
    const reason = error instanceof Error ? error.message : String(error);
    return {
      filter: build51jobDynamicTextInputFilter(target, [], reason, 'failed'),
      failures: [build51jobDynamicTextInputFailure(target, reason)],
    };
  }
}

async function discover51jobExpectedSalaryFilter(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<{ filter: SearchFilterDefinition; failures: SearchFilterDiscoveryFailure[] }> {
  try {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    const extractedOptions = await extract51jobExpectedSalaryOptions(page, options);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250);

    return {
      filter: build51jobCascadeFilter(
        fiftyOneJobExpectedSalaryTarget,
        extractedOptions,
        'Opened the 51job expected-salary menu and recorded each minimum-salary option with its matching maximum-salary options.',
      ),
      failures: [],
    };
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(250);
    const reason = error instanceof Error ? error.message : String(error);
    return {
      filter: build51jobCascadeFilter(fiftyOneJobExpectedSalaryTarget, [], reason, 'failed'),
      failures: [build51jobCascadeFailure(fiftyOneJobExpectedSalaryTarget, reason)],
    };
  }
}

async function discover51jobDynamicTextInputFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<{ filters: SearchFilterDefinition[]; failures: SearchFilterDiscoveryFailure[] }> {
  const filters: SearchFilterDefinition[] = [];
  const failures: SearchFilterDiscoveryFailure[] = [];

  for (const target of fiftyOneJobDynamicTextInputTargets) {
    const result = await discover51jobDynamicTextInputFilter(page, target, options);
    filters.push(result.filter);
    failures.push(...result.failures);
  }

  return { filters, failures };
}

async function discover51jobSearchFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterCatalog> {
  const genericCatalog = await discoverSearchFiltersOnPage('51job', page, options, {
    ignoreTextPatterns: [
      /订阅当前搜索条件/,
      /第一时间获取匹配的人才/,
      /订阅全部搜索器/,
      /搜索器.*升级.*我的订阅/,
    ],
    shouldIgnoreControl: (control) => {
      if (control.placeholder === '期望工作地') {
        return true;
      }

      if (control.placeholder === options.keyword || control.value === options.keyword) {
        return true;
      }

      if (control.text === fiftyOneJobExpectedSalaryTarget.label && /base-select-button/.test(control.cssPath)) {
        return true;
      }

      if (fiftyOneJobDynamicTextInputSelectorSet.has(control.cssPath)) {
        return true;
      }

      return control.tagName === 'button'
        && control.text === '搜索'
        && /search_button/.test(control.cssPath);
    },
    filterContainerTextPatterns: [
      /筛选|条件|城市|地区|行业|职能|学历|经验|薪资|学校|专业|语言|工作类型|公司性质|跳槽次数|毕业时间/,
    ],
  });

  const expectedSalary = await discover51jobExpectedSalaryFilter(page, options);
  const dynamicTextInputs = await discover51jobDynamicTextInputFilters(page, options);
  const genericFilters = genericCatalog.filters.filter((filter) => !has51jobDynamicTextInputSelectorHints(filter.selectorHints));
  const genericFailures = genericCatalog.failures.filter((failure) => !has51jobDynamicTextInputSelectorHints(failure.selectorHints));
  const filters = [
    ...genericFilters,
    expectedSalary.filter,
    ...dynamicTextInputs.filters,
  ].map(normalize51jobFilterDefinition);
  const failures = [
    ...genericFailures,
    ...expectedSalary.failures,
    ...dynamicTextInputs.failures,
  ];

  return {
    ...genericCatalog,
    filters,
    failures,
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}

export const fiftyOneJobAdapter: PlatformAdapter = {
  platform: '51job',
  displayName: '51job',
  subscribeSearchUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
  loginUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
  storageStateFileName: 'storage-state.json',
  openLoginPage: async (page) => {
    await page.goto('https://ehire.51job.com/Revision/talent/subscribe', { waitUntil: 'domcontentloaded' });
  },
  openAuthenticatedHome: async (page) => {
    await page.goto('https://ehire.51job.com/Revision/talent/subscribe', { waitUntil: 'domcontentloaded' });
    await assertAuthenticatedPage(page);
    return page;
  },
  assertAuthenticated: assertAuthenticatedPage,
  openSubscribeSearch,
  openDirectSearch: open51jobDirectSearch,
  prepareSearchConditionPage: prepare51jobSearchConditionPageWithOptions,
  discoverSearchFilters: discover51jobSearchFilters,
  applySearchCondition: apply51jobSearchCondition,
  readSearchConditionResultTotal: read51jobSearchResultTotal,
  saveSearchCondition: save51jobSearchCondition,
  extractCandidateList: async (page, options) => ({ candidates: await collectCandidateList(page, options) }),
  openResumeDetail,
  parseResumeDetail: async (page, candidate) => (await parseResumeDetail(page, candidate)).resume,
};
