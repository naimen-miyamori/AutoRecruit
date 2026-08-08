import type { Locator, Page } from 'playwright';
import {
  moveMouseToLocatorCenter,
  pressPlatformKey,
  waitOnPageOrTimer,
} from '../../../browser/pacing.js';
import { discoverSearchFiltersOnPage } from '../../../search/filter-discovery.js';
import { buildSearchFilterDiscoveryStats, createEmptySearchFilterCatalog } from '../../../search/filter-catalog.js';
import {
  clickLiepinIndustryPath,
  openLiepinIndustryModalByLabel,
} from '../../liepin-industry-tree.js';
import { discoverLiepinStaticSearchFilters, mergeLiepinSearchFilterCatalog } from '../../liepin-filter-normalization.js';
import type {
  SearchCondition,
  SearchConditionApplyResult,
} from '../../../types/job.js';
import type { SearchFilterControlSnapshot, SearchFilterDiscoveryRunOptions } from '../../../search/filter-catalog.js';
import {
  clickLiepinLocator,
  createLiepinSearchDeadline as createSearchDeadline,
  fillLiepinLocator,
  waitLiepinActionPace,
} from './context.js';
import {
  clearObservedLiepinSearchResumesApiBeforeNextAction,
  waitForLiepinFinalSearchResumesOrEmptyResults,
} from './candidate-actions.js';
import { waitForLiepinPageReady } from './readiness.js';
import { clickLiepinLocatorWithForceFallback } from './compatibility.js';
import {
  closeLiepinBlockingOverlays,
  hasVisibleLiepinBlockingOverlay,
} from './overlay-actions.js';

const liepinPlatform = 'liepin';
const liepinApplicationFilterRowLabelsByFieldId: Record<string, string[]> = {
  work_years: ['工作年限', '工作经验'],
  education: ['教育经历', '学历'],
  school_nature: ['院校要求', '学校要求', '学校性质'],
  language: ['语言', '语 言', '语言能力', '语言要求'],
  recent_activity_time: ['活跃度', '最近活跃时间'],
  gender: ['性别', '性 别'],
  job_hopping_count: ['跳槽频率', '跳槽次数'],
  job_status: ['求职状态', '其他', '其 他'],
  resume_language: ['简历语言'],
  living_location: ['目前城市', '当前城市', '所在城市', '所在地区'],
  expected_location: ['期望城市', '意向城市'],
  company_name: ['公司名称'],
  school_name: ['毕业院校', '毕业学校', '学校名称'],
  major: ['专业名称', '专业'],
  age: ['年龄', '年 龄'],
};
const liepinApplicationFilterCheckboxLabelsByFieldId: Record<string, string> = {
  overseas_work_experience: '海外工作经验',
  management_experience: '管理经验',
};
const liepinApplicationFilterSelectSelectorsByFieldId: Record<string, string[]> = {
  job_status: [
    '.apply-job-status',
    '.search-item:has-text("求职状态") .ant-select:has-text("求职状态")',
  ],
};
const liepinSupportedApplicationFilterFieldIds = new Set([
  ...Object.keys(liepinApplicationFilterRowLabelsByFieldId),
  ...Object.keys(liepinApplicationFilterCheckboxLabelsByFieldId),
  'expected_salary',
  'current_salary',
  'engaged_industry',
  'engaged_function',
  'expected_industry',
  'expected_function',
  'company_name',
  'school_name',
  'major',
]);
const liepinSlowFilterDiscoveryTextPattern = /筛选|条件|职位名称|公司名称|目前城市|当前城市|所在城市|所在地区|期望城市|意向城市|工作经验|工作年限|教育经历|学历|统招|院校|期望薪资|期望月薪|期望年薪|目前薪资|当前薪资|行业|职能|职位|公司|学校|毕业院校|专业|语言|简历语言|年龄|性别|活跃度|跳槽|求职状态|海外工作经验|管理经验|更新时间|发布时间/;

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

function buildExactTextPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeApplicationFilterValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeLiepinApplicationFilterOptionLabel(value: string): string {
  return normalizeApplicationFilterValue(value).replace(/\s+/g, '');
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

function readLiepinApplicationFilterSingleValue(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  const normalizedValue = isRecord(condition.value)
    ? normalizeApplicationFilterValue(condition.value.label)
    : normalizeApplicationFilterValue(condition.value);
  const conditionValue = normalizedValue || normalizeApplicationFilterValue(condition.values?.[0]?.value);
  if (!conditionValue) {
    throw new Error(`Missing value for Liepin application filter: ${condition.fieldId}`);
  }

  return conditionValue;
}

function parseLiepinSalaryWan(value: unknown): string {
  const normalizedValue = normalizeApplicationFilterValue(value);
  if (!normalizedValue || normalizedValue === '不限') {
    return '';
  }

  const matched = normalizedValue.match(/^(\d+(?:\.\d+)?)(?:\s*万)?$/);
  if (!matched) {
    throw new Error(`Liepin salary filters only support annual salary values in 万: ${normalizedValue}`);
  }

  return matched[1] ?? '';
}

function parseLiepinNumberRangeBoundary(value: unknown, unitPattern = '[^\\d.]*'): string {
  const normalizedValue = normalizeApplicationFilterValue(value);
  if (!normalizedValue || normalizedValue === '不限') {
    return '';
  }

  const matched = normalizedValue.match(new RegExp(`^(\\d+(?:\\.\\d+)?)${unitPattern}$`));
  if (!matched) {
    throw new Error(`Liepin number range filters only support numeric boundaries: ${normalizedValue}`);
  }

  return matched[1] ?? '';
}

function readLiepinTextInputApplicationFilterValues(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string[] {
  const rawValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  const values = rawValues
    .map((value) => isRecord(value)
      ? normalizeApplicationFilterValue(value.value) || normalizeApplicationFilterValue(value.label)
      : normalizeApplicationFilterValue(value))
    .filter((value) => value && value !== '不限');

  if (values.length > 0) {
    return values;
  }

  return (condition.values ?? [])
    .map((value) => normalizeApplicationFilterValue(value.value))
    .filter((value) => value && value !== '不限');
}

interface LiepinTextInputApplicationFilterValueEntry {
  value: string;
  pathLabels?: string[];
}

function toLiepinTextInputApplicationFilterValueEntry(
  value: string,
  pathLabels?: string[],
): LiepinTextInputApplicationFilterValueEntry | undefined {
  if (!value || value === '不限') {
    return undefined;
  }

  const normalizedPathLabels = pathLabels?.filter(Boolean);
  return normalizedPathLabels && normalizedPathLabels.length > 0
    ? { value, pathLabels: normalizedPathLabels }
    : { value };
}

function readLiepinTextInputApplicationFilterValueEntries(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): LiepinTextInputApplicationFilterValueEntry[] {
  const rawValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  const entries = rawValues
    .map((value) => {
      const normalizedValue = isRecord(value)
        ? normalizeApplicationFilterValue(value.value) || normalizeApplicationFilterValue(value.label)
        : normalizeApplicationFilterValue(value);
      const pathLabels = isRecord(value) && Array.isArray(value.pathLabels)
        ? value.pathLabels.map((pathLabel) => normalizeApplicationFilterValue(pathLabel)).filter(Boolean)
        : undefined;
      return toLiepinTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is LiepinTextInputApplicationFilterValueEntry => Boolean(value));

  if (entries.length > 0) {
    return entries;
  }

  return (condition.values ?? [])
    .map((value) => {
      const normalizedValue = normalizeApplicationFilterValue(value.value);
      const pathLabels = value.pathLabels
        ?.map((pathLabel) => normalizeApplicationFilterValue(pathLabel))
        .filter(Boolean);
      return toLiepinTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is LiepinTextInputApplicationFilterValueEntry => Boolean(value));
}

function buildLiepinFilterRowLabelPattern(label: string): RegExp {
  return new RegExp(`${label}\\s*[:：]`);
}

async function findLiepinFilterRowsByLabels(page: Page, labels: readonly string[]): Promise<Locator[]> {
  const rows: Locator[] = [];
  const rowSelectors = [
    '.sfilter-other-condition .search-item.line-wrap',
    '.sfilter-other-condition .search-item',
    '.sfilter-other-condition .ant-select',
    '.search-item.line-wrap',
    '.search-item',
    '.sfilter-salary',
    '.filter-item',
    '[class*="search-item"]',
    '[class*="filter-item"]',
    '[class*="filter"]',
  ];

  for (const label of labels) {
    for (const rowSelector of rowSelectors) {
      rows.push(page.locator(rowSelector, { hasText: buildLiepinFilterRowLabelPattern(label) }).first());
      rows.push(page.locator(rowSelector, { hasText: label }).first());
    }
  }

  return rows;
}

async function clickLiepinFilterOptionCandidate(
  page: Page,
  candidate: Locator,
  value: string,
  normalizedTarget: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  const candidateText = normalizeLiepinApplicationFilterOptionLabel(
    await candidate.innerText({ timeout: timeoutMs }).catch(() => ''),
  );
  if (candidateText && candidateText !== normalizedTarget && !candidateText.includes(normalizedTarget)) {
    return false;
  }

  await clickLiepinLocator(candidate, page, timeoutMs);
  await waitLiepinActionPace(page);
  return true;
}

async function clickLiepinFilterOptionFromCandidateGroups(
  page: Page,
  candidateGroups: readonly Locator[],
  value: string,
  normalizedTarget: string,
  timeoutMs: number,
): Promise<boolean> {
  for (const candidateGroup of candidateGroups) {
    const count = await candidateGroup.count().catch(() => 0);
    for (let index = 0; index < Math.max(count, 1); index += 1) {
      const candidate = count > 0 ? candidateGroup.nth(index) : candidateGroup.first();
      if (await clickLiepinFilterOptionCandidate(page, candidate, value, normalizedTarget, timeoutMs)) {
        return true;
      }
    }
  }

  return false;
}

async function clickLiepinInlineFilterRowOption(
  page: Page,
  row: Locator,
  value: string,
  normalizedTarget: string,
  timeoutMs: number,
): Promise<boolean> {
  return clickLiepinFilterOptionFromCandidateGroups(page, [
    row.locator('.tag-item, .unlimited-btn, label, button, a, span').filter({ hasText: buildExactTextPattern(value) }),
    row.getByText(buildExactTextPattern(value), { exact: true }),
    row.locator('.tag-item, .unlimited-btn, label, button, a, span').filter({ hasText: value }),
    row.getByText(value, { exact: false }),
  ], value, normalizedTarget, timeoutMs);
}

async function clickLiepinOpenedDropdownOption(
  page: Page,
  value: string,
  normalizedTarget: string,
  timeoutMs: number,
): Promise<boolean> {
  const visibleAntSelectOptionSelector = [
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder-inner .ant-select-item-option',
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder-inner .ant-select-item-option-content',
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
  ].join(', ');
  const popupOptionSelector = [
    '[role="listbox"] [role="option"]',
    '[role="menu"] [role="menuitem"]',
    '.el-select-dropdown__item',
    '.ant-dropdown-menu-item',
    '.ant-cascader-menu-item',
    '.cascader_panel_item',
    '[class*="dropdown"] li',
    '[class*="dropdown"] [class*="item"]',
    '[class*="popover"] li',
    '[class*="popover"] [class*="item"]',
    '[class*="menu"] li',
    '[class*="menu"] [class*="item"]',
  ].join(', ');

  return clickLiepinFilterOptionFromCandidateGroups(page, [
    page.locator(visibleAntSelectOptionSelector).filter({ hasText: buildExactTextPattern(value) }),
    page.locator(visibleAntSelectOptionSelector).filter({ hasText: value }),
    page.locator(popupOptionSelector).filter({ hasText: buildExactTextPattern(value) }),
    page.locator(popupOptionSelector).filter({ hasText: value }),
    page.getByText(buildExactTextPattern(value), { exact: true }),
  ], value, normalizedTarget, timeoutMs);
}

async function openLiepinAntSelectWithDomEvents(
  page: Page,
  select: Locator,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await select.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  const evaluate = (select as Partial<Pick<Locator, 'evaluate'>>).evaluate?.bind(select);
  if (!evaluate) {
    return false;
  }

  const opened = await select.evaluate((element) => {
    const input = element.querySelector('input[role="combobox"]');
    const selector = element.querySelector('.ant-select-selector');
    const arrow = element.querySelector('.ant-select-arrow');
    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };
    const targets = [selector, input, arrow, element].filter((item): item is Element => Boolean(item));
    for (const target of targets) {
      target.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));
    }
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowDown',
        code: 'ArrowDown',
      }));
    }

    return Boolean(input?.getAttribute('aria-controls') || input?.getAttribute('aria-owns'));
  }).catch(() => false);

  if (!opened) {
    return false;
  }

  await waitLiepinActionPace(page);
  return true;
}

async function clickLiepinVisibleAntSelectOption(
  page: Page,
  value: string,
  timeoutMs: number,
): Promise<boolean> {
  const option = page.locator(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    { hasText: buildExactTextPattern(value) },
  ).first();
  if (!(await option.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  await clickLiepinLocatorWithForceFallback(option, page, timeoutMs);
  await waitLiepinActionPace(page);
  return true;
}

async function clickLiepinJobStatusSelectOption(
  page: Page,
  value: string,
  timeoutMs = 3000,
): Promise<boolean> {
  await closeLiepinBlockingOverlays(page, 2000);
  const select = page.locator('.apply-job-status').first();
  if (!(await select.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  if (await openLiepinAntSelectWithDomEvents(page, select, timeoutMs)
    && await clickLiepinVisibleAntSelectOption(page, value, timeoutMs)) {
    return true;
  }

  await closeLiepinBlockingOverlays(page, 2000);
  return false;
}

async function openLiepinFilterRowDropdown(page: Page, row: Locator, timeoutMs: number): Promise<boolean> {
  await closeLiepinBlockingOverlays(page, 2000);

  const triggers = [
    row.locator('.ant-select-selector').last(),
    row.locator('input[role="combobox"]').last(),
    row.locator('.ant-select-arrow').last(),
    row.locator('.ant-select').last(),
    row.locator([
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      '[class*="select"]',
      '[class*="dropdown"]',
      '[class*="cascader"]',
      '[class*="arrow"]',
      '[class*="down"]',
      'input',
      'button',
      'a',
      'span',
    ].join(', ')).last(),
    row,
  ];

  for (const trigger of triggers) {
    if (!(await trigger.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    const clicked = await clickLiepinLocatorWithForceFallback(trigger, page, timeoutMs).catch(() => false);
    if (!clicked) {
      continue;
    }
    await waitLiepinActionPace(page);
    if (await hasVisibleLiepinBlockingOverlay(page)) {
      await closeLiepinBlockingOverlays(page, 2000);
      continue;
    }
    return true;
  }

  return false;
}

async function clickLiepinFilterRowOption(
  page: Page,
  rowLabels: readonly string[],
  value: string,
  timeoutMs = 2000,
): Promise<void> {
  const normalizedTarget = normalizeLiepinApplicationFilterOptionLabel(value);
  const rows = await findLiepinFilterRowsByLabels(page, rowLabels);

  for (const row of rows) {
    await closeLiepinBlockingOverlays(page, 2000);
    if (!(await row.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    if (await clickLiepinInlineFilterRowOption(page, row, value, normalizedTarget, timeoutMs)) {
      return;
    }

    if (await openLiepinFilterRowDropdown(page, row, timeoutMs)
      && await clickLiepinOpenedDropdownOption(page, value, normalizedTarget, timeoutMs)) {
      return;
    }

    const rowSelect = row.locator('.ant-select, [role="combobox"], input[role="combobox"]').first();
    if (await rowSelect.isVisible({ timeout: 800 }).catch(() => false)) {
      await clickLiepinLocator(rowSelect, page, timeoutMs).catch(() => undefined);
      await waitLiepinActionPace(page);
      if (await clickLiepinOpenedDropdownOption(page, value, normalizedTarget, timeoutMs)) {
        return;
      }
    }
  }

  throw new Error(`Unable to select Liepin filter option ${value} in ${rowLabels.join('/')}`);
}

async function readLiepinCheckboxFilterChecked(page: Page, label: string): Promise<boolean | undefined> {
  return page.evaluate((targetLabel) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
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
    const labels = Array.from(document.querySelectorAll<HTMLElement>('label, [role="checkbox"], .ant-checkbox-wrapper, .semi-checkbox, [class*="checkbox"]'))
      .filter((element) => isVisible(element) && normalize(element.textContent).includes(targetLabel));

    for (const element of labels) {
      const control = element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
        ?? element.querySelector('[role="checkbox"], [role="switch"], .ant-checkbox, .semi-checkbox')
        ?? element;
      return isChecked(control);
    }

    return undefined;
  }, label).catch(() => undefined);
}

async function clickLiepinCheckboxFilterWithDomEvents(page: Page, label: string): Promise<boolean> {
  const wrappers = page.locator('label, [role="checkbox"], .ant-checkbox-wrapper, .semi-checkbox, [class*="checkbox"]');
  const wrapperIndex = await wrappers.evaluateAll((elements, targetLabel) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    return elements.findIndex((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && normalize(element.textContent).includes(targetLabel);
    });
  }, label);
  if (wrapperIndex < 0) return false;

  const wrapper = wrappers.nth(wrapperIndex);
  await waitLiepinActionPace(page);
  await moveMouseToLocatorCenter(wrapper, page, 3000).catch(() => false);
  const clicked = await wrapper.evaluate((element) => {
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
    if (!(element instanceof HTMLElement)) return false;

    const input = element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
    const control = input
      ?? element.querySelector<HTMLElement>('[role="checkbox"], [role="switch"], .ant-checkbox, .semi-checkbox')
      ?? element;
    if (input?.disabled) {
      return false;
    }

    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };
    for (const target of [control, input, element].filter((item): item is HTMLElement => Boolean(item))) {
      target.dispatchEvent(new MouseEvent('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
    }

    if (input) {
      input.click();
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } else if (control instanceof HTMLElement) {
      control.click();
    } else {
      element.click();
    }

    for (const target of [control, input, element].filter((item): item is HTMLElement => Boolean(item))) {
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
    }

    const effectiveControl = input ?? control;
    return isChecked(effectiveControl);
  }).catch(() => false);

  if (clicked) {
    await waitOnPageOrTimer(page, 100);
  }

  return clicked;
}

async function clickLiepinCheckboxFilterByLabel(page: Page, label: string, timeoutMs = 3000): Promise<void> {
  if (await clickLiepinCheckboxFilterWithDomEvents(page, label)) {
    return;
  }

  const locators = [
    page.locator('label.ant-checkbox-wrapper, label, [role="checkbox"], .ant-checkbox-wrapper', { hasText: buildExactTextPattern(label) }).first(),
    page.locator('label.ant-checkbox-wrapper, label, [role="checkbox"], .ant-checkbox-wrapper', { hasText: label }).first(),
    page.getByText(buildExactTextPattern(label), { exact: true }).first(),
  ];

  for (const locator of locators) {
    if (!(await locator.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    await clickLiepinLocatorWithForceFallback(locator, page, timeoutMs);
    await waitLiepinActionPace(page);
    if (await clickLiepinCheckboxFilterWithDomEvents(page, label)) {
      return;
    }
    return;
  }

  throw new Error(`Unable to find Liepin checkbox filter ${label}.`);
}

async function clickLiepinFieldSelectOption(
  page: Page,
  selectors: readonly string[],
  value: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const normalizedTarget = normalizeLiepinApplicationFilterOptionLabel(value);
  await closeLiepinBlockingOverlays(page, 2000);

  for (const selector of selectors) {
    const select = page.locator(selector).first();
    if (!(await select.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    if (await openLiepinFilterRowDropdown(page, select, timeoutMs)
      && await clickLiepinOpenedDropdownOption(page, value, normalizedTarget, timeoutMs)) {
      return true;
    }
  }

  return false;
}

async function fillLiepinAgeApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!isRecord(condition.value)) {
    throw new Error(`Liepin ${condition.fieldId} application filter requires { min, max } value.`);
  }

  const min = parseLiepinNumberRangeBoundary(condition.value.min);
  const max = parseLiepinNumberRangeBoundary(condition.value.max);
  const ageRow = page.locator('.search-item.age-box, .search-item', {
    hasText: /年\s*龄|年龄/,
  }).first();
  await ageRow.waitFor({ state: 'visible', timeout: 3000 });
  await ageRow.hover({ timeout: 2000 }).catch(() => undefined);

  const minInput = page.locator('#ageLow').first();
  const maxInput = page.locator('#ageHigh').first();
  const rowMinInput = ageRow.locator('input').nth(0);
  const rowMaxInput = ageRow.locator('input').nth(1);
  const effectiveMinInput = await minInput.isVisible({ timeout: 500 }).catch(() => false) ? minInput : rowMinInput;
  const effectiveMaxInput = await maxInput.isVisible({ timeout: 500 }).catch(() => false) ? maxInput : rowMaxInput;

  await effectiveMinInput.waitFor({ state: 'visible', timeout: 3000 });
  await effectiveMaxInput.waitFor({ state: 'visible', timeout: 3000 });
  await fillLiepinLocator(effectiveMinInput, page, min, 2000);
  await fillLiepinLocator(effectiveMaxInput, page, max, 2000);
  await ageRow.hover({ timeout: 2000 }).catch(() => undefined);
  const confirm = ageRow.locator('button.shadow-box-submit-btn, button', { hasText: /确\s*定/ }).first();
  await clickLiepinLocator(confirm, page, 3000);
  await waitLiepinActionPace(page);
}

async function fillLiepinSalaryApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!isRecord(condition.value)) {
    throw new Error(`Liepin ${condition.fieldId} application filter requires { min, max } value.`);
  }

  const min = parseLiepinSalaryWan(condition.value.min);
  const max = parseLiepinSalaryWan(condition.value.max);
  const isCurrentSalary = condition.fieldId === 'current_salary';
  const salaryRow = page.locator('.sfilter-salary, .search-item', {
    hasText: isCurrentSalary ? /目前年薪|目前薪资|当前年薪|当前薪资/ : /期望年薪|期望薪资|期望月薪/,
  }).first();
  await salaryRow.waitFor({ state: 'visible', timeout: 3000 });

  const minInput = page.locator(isCurrentSalary ? '#nowSalaryLow' : '#wantSalaryLow').first();
  const maxInput = page.locator(isCurrentSalary ? '#nowSalaryHigh' : '#wantSalaryHigh').first();
  const rowMinInput = salaryRow.locator('input').nth(0);
  const rowMaxInput = salaryRow.locator('input').nth(1);
  const effectiveMinInput = await minInput.isVisible({ timeout: 500 }).catch(() => false) ? minInput : rowMinInput;
  const effectiveMaxInput = await maxInput.isVisible({ timeout: 500 }).catch(() => false) ? maxInput : rowMaxInput;

  await effectiveMinInput.waitFor({ state: 'visible', timeout: 3000 });
  await effectiveMaxInput.waitFor({ state: 'visible', timeout: 3000 });
  await fillLiepinLocator(effectiveMinInput, page, min, 2000);
  await fillLiepinLocator(effectiveMaxInput, page, max, 2000);
}

async function fillLiepinTextBoxApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const value = readLiepinApplicationFilterSingleValue(condition);
  const rowLabels = liepinApplicationFilterRowLabelsByFieldId[condition.fieldId];
  if (!rowLabels) {
    throw new Error(`Unsupported Liepin text input application filter: ${condition.fieldId}`);
  }

  const rows = await findLiepinFilterRowsByLabels(page, rowLabels);
  for (const row of rows) {
    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      continue;
    }

    await row.hover({ timeout: 2000 }).catch(() => undefined);
    const input = row.locator('input:not([readonly]), textarea').first();
    if (!(await input.isVisible({ timeout: 1000 }).catch(() => false))) {
      continue;
    }

    await fillLiepinLocator(input, page, value, 3000);
    await waitLiepinActionPace(page);
    await row.hover({ timeout: 2000 }).catch(() => undefined);
    const confirm = row.locator('button.shadow-box-submit-btn, button', { hasText: /确\s*定/ }).first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await clickLiepinLocator(confirm, page, 3000);
      await waitLiepinActionPace(page);
    }
    return;
  }

  throw new Error(`Unable to fill Liepin text input filter ${condition.fieldId}.`);
}

async function clickLiepinCheckboxApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const checkboxLabel = liepinApplicationFilterCheckboxLabelsByFieldId[condition.fieldId];
  if (!checkboxLabel) {
    throw new Error(`Unsupported Liepin application filter: ${condition.fieldId}`);
  }

  const value = readLiepinApplicationFilterSingleValue(condition);
  if (value.includes('不限')) {
    return;
  }

  await closeLiepinBlockingOverlays(page, 2000);
  await ensureLiepinMoreConditionsExpanded(page);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checked = await readLiepinCheckboxFilterChecked(page, checkboxLabel);
    if (checked === true) {
      return;
    }

    await clickLiepinCheckboxFilterByLabel(page, checkboxLabel);
  }

  const checked = await readLiepinCheckboxFilterChecked(page, checkboxLabel);
  if (checked !== true) {
    throw new Error(`Liepin checkbox filter ${checkboxLabel} was not checked after clicking.`);
  }
}

function buildLiepinTextSearchPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

async function getVisibleLiepinModal(page: Page, textPattern: RegExp, timeoutMs = 3000): Promise<Locator> {
  const modal = page.locator('.ant-modal-wrap, .ant-modal, [role="dialog"]', { hasText: textPattern }).filter({ hasText: textPattern }).first();
  await modal.waitFor({ state: 'visible', timeout: timeoutMs });
  return modal;
}

async function clickLiepinExactTextInScope(
  scope: Locator,
  page: Page,
  value: string,
  timeoutMs = 3000,
  selector = 'span, div, li, label, a, button',
): Promise<boolean> {
  const pattern = buildLiepinTextSearchPattern(value);
  const candidates = [
    scope.locator(selector).filter({ hasText: pattern }),
    scope.getByText(pattern, { exact: true }),
  ];

  for (const group of candidates) {
    const count = await group.count().catch(() => 0);
    for (let index = 0; index < Math.max(count, 1); index += 1) {
      const candidate = count > 0 ? group.nth(index) : group.first();
      if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
        continue;
      }

      const candidateText = normalizeLiepinApplicationFilterOptionLabel(
        await candidate.innerText({ timeout: timeoutMs }).catch(() => ''),
      );
      if (candidateText && candidateText !== normalizeLiepinApplicationFilterOptionLabel(value)) {
        continue;
      }

      await clickLiepinLocator(candidate, page, timeoutMs);
      await waitLiepinActionPace(page);
      return true;
    }
  }

  return false;
}

async function clickFirstVisibleLiepinLocatorInGroup(
  group: Locator,
  page: Page,
  timeoutMs = 3000,
): Promise<boolean> {
  const count = await group.count().catch(() => 0);
  for (let index = 0; index < Math.max(count, 1); index += 1) {
    const candidate = count > 0 ? group.nth(index) : group.first();
    if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    await clickLiepinLocator(candidate, page, timeoutMs);
    await waitLiepinActionPace(page);
    return true;
  }

  return false;
}

async function clickLiepinModalConfirm(modal: Locator, page: Page, timeoutMs = 3000): Promise<void> {
  const confirmCandidates = [
    modal.locator('button:not([disabled]), [role="button"]:not([aria-disabled="true"]), .ant-btn:not([disabled])', { hasText: /^确认$/ }).last(),
    modal.locator('button:not([disabled]), [role="button"]:not([aria-disabled="true"]), .ant-btn:not([disabled])', { hasText: /确认/ }).last(),
  ];

  for (const confirm of confirmCandidates) {
    if (!(await confirm.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    await clickLiepinLocator(confirm, page, timeoutMs);
    await waitLiepinActionPace(page);
    return;
  }

  throw new Error('Unable to confirm Liepin modal selection.');
}

async function clickFirstVisibleLiepinScopedLocator(
  scope: Locator,
  page: Page,
  selectors: string[],
  timeoutMs = 3000,
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) {
      continue;
    }

    await clickLiepinLocator(locator, page, timeoutMs);
    return true;
  }

  return false;
}

async function clickLiepinIndustryOption(modal: Locator, page: Page, value: string): Promise<void> {
  if (await clickLiepinExactTextInScope(modal, page, value, 3000, '.ant-tag, .ant-menu-item, span, div, li')) {
    return;
  }

  const input = modal.locator('input[placeholder*="行业"], input.ant-input').first();
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await fillLiepinLocator(input, page, value, 3000);
    await waitLiepinActionPace(page);
    if (await clickLiepinExactTextInScope(modal, page, value, 3000, '.ant-tag, .ant-menu-item, span, div, li')) {
      return;
    }
  }

  throw new Error(`Unable to select Liepin industry option ${value}.`);
}

async function fillLiepinIndustryApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const values = readLiepinTextInputApplicationFilterValueEntries(condition);
  if (values.length === 0) {
    return;
  }

  const label = condition.fieldId === 'expected_industry' ? '期望行业' : '当前行业';
  await closeLiepinBlockingOverlays(page, 2000);
  const modal = await openLiepinIndustryModalByLabel(page, label);
  for (const entry of values.slice(0, 3)) {
    if (entry.pathLabels && entry.pathLabels.length > 0) {
      await clickLiepinIndustryPath(modal, page, entry.pathLabels, entry.value);
    } else {
      await clickLiepinIndustryOption(modal, page, entry.value);
    }
  }
  await clickLiepinModalConfirm(modal, page);
}

async function openLiepinJobFunctionModal(page: Page, fieldId: string): Promise<Locator> {
  const rowText = fieldId === 'expected_function' ? /期望职位/ : /当前职位/;
  const row = page.locator('.search-item.sfilter-job, .search-item', { hasText: rowText }).first();
  await row.waitFor({ state: 'visible', timeout: 3000 });
  await row.hover({ timeout: 2000 }).catch(() => undefined);
  const clicked = await clickFirstVisibleLiepinScopedLocator(row, page, [
    '.search-component-drop-icon-wrapper',
    '.search-component-input',
    '.jobs-wrap',
  ], 3000);
  if (!clicked) {
    throw new Error(`Unable to open Liepin job function modal for ${fieldId}.`);
  }
  await waitLiepinActionPace(page);
  return getVisibleLiepinModal(page, /请选择职位类别/);
}

async function selectLiepinJobFunctionValue(modal: Locator, page: Page, value: string): Promise<void> {
  const searchValue = value.includes('/') ? value.split('/')[0] ?? value : value;
  const input = modal.locator('input[placeholder*="职位名称"], input.ant-input').first();
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await fillLiepinLocator(input, page, searchValue, 3000);
    await waitLiepinActionPace(page);
  }

  const valueSuggestion = modal.locator('.suggest-list li', { hasText: value });
  if (await clickFirstVisibleLiepinLocatorInGroup(valueSuggestion, page, 3000)) {
    return;
  }

  const exactSuggestion = modal.locator('.suggest-list li').filter({ hasText: buildLiepinTextSearchPattern(searchValue) });
  if (await clickFirstVisibleLiepinLocatorInGroup(exactSuggestion, page, 3000)) {
    return;
  }

  if (await clickLiepinExactTextInScope(modal, page, value, 3000, '.ant-tag, .drop-box-item, .ant-menu-item, span, div, li')) {
    return;
  }

  throw new Error(`Unable to select Liepin job function option ${value}.`);
}

async function fillLiepinJobFunctionApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const values = readLiepinTextInputApplicationFilterValues(condition);
  if (values.length === 0) {
    return;
  }

  const modal = await openLiepinJobFunctionModal(page, condition.fieldId);
  for (const value of values.slice(0, 3)) {
    await selectLiepinJobFunctionValue(modal, page, value);
  }
  await clickLiepinModalConfirm(modal, page);
}

async function applyLiepinSupportedApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!liepinSupportedApplicationFilterFieldIds.has(condition.fieldId)) {
    throw new Error(`Unsupported Liepin application filter: ${condition.fieldId}`);
  }

  if (condition.fieldKind === 'numberRange' || condition.fieldId === 'age') {
    await fillLiepinAgeApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldKind === 'salaryRange' || condition.fieldId === 'expected_salary' || condition.fieldId === 'current_salary') {
    await fillLiepinSalaryApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId === 'company_name' || condition.fieldId === 'school_name' || condition.fieldId === 'major') {
    await fillLiepinTextBoxApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId === 'engaged_industry' || condition.fieldId === 'expected_industry') {
    await fillLiepinIndustryApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId === 'engaged_function' || condition.fieldId === 'expected_function') {
    await fillLiepinJobFunctionApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId in liepinApplicationFilterCheckboxLabelsByFieldId) {
    await clickLiepinCheckboxApplicationFilter(page, condition);
    return;
  }

  const fieldSelectSelectors = liepinApplicationFilterSelectSelectorsByFieldId[condition.fieldId];
  if (condition.fieldId === 'job_status'
    && await clickLiepinJobStatusSelectOption(page, readLiepinApplicationFilterSingleValue(condition))) {
    return;
  }

  if (fieldSelectSelectors
    && await clickLiepinFieldSelectOption(page, fieldSelectSelectors, readLiepinApplicationFilterSingleValue(condition))) {
    return;
  }

  const rowLabels = liepinApplicationFilterRowLabelsByFieldId[condition.fieldId];
  if (!rowLabels) {
    throw new Error(`Unsupported Liepin application filter: ${condition.fieldId}`);
  }

  await clickLiepinFilterRowOption(page, rowLabels, readLiepinApplicationFilterSingleValue(condition));
}

async function triggerLiepinApplicationFilterSearch(page: Page): Promise<void> {
  const deadline = createSearchDeadline();
  clearObservedLiepinSearchResumesApiBeforeNextAction(page);
  const clicked = await clickLiepinPrimarySearchButton(page, 2000)
    || await clickFirstVisibleLiepinText(page, ['搜索', '搜 索'], 2000);
  if (!clicked) {
    throw new Error('Unable to trigger Liepin search after applying application filter.');
  }

  await waitForLiepinFinalSearchResumesOrEmptyResults(page, deadline);
  await waitForLiepinPageReady(page, { deadline, requireSearchPage: true });
}

async function applyLiepinApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<SearchConditionApplyResult> {
  try {
    await waitForLiepinPageReady(page, { requireSearchPage: true });
    await closeLiepinBlockingOverlays(page);
    await ensureLiepinMoreConditionsExpanded(page).catch(() => undefined);
    await applyLiepinSupportedApplicationFilter(page, condition);
    await triggerLiepinApplicationFilterSearch(page);
    return {
      platform: 'liepin',
      condition,
      status: 'applied',
    };
  } catch (error) {
    await pressPlatformKey(page, liepinPlatform, 'Escape').catch(() => undefined);
    return {
      platform: 'liepin',
      condition,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyLiepinSearchCondition(
  page: Page,
  condition: SearchCondition,
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: 'liepin',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for liepin yet.`,
    };
  }

  return applyLiepinApplicationFilter(page, condition);
}

function shouldInspectLiepinSlowDiscoveryControl(control: SearchFilterControlSnapshot): boolean {
  const haystack = normalizeText([
    control.label,
    control.text,
    control.placeholder,
    control.containerText,
    control.role,
    control.cssPath,
  ].join(' '));

  if (!haystack || control.disabled || control.width <= 0 || control.height <= 0) {
    return false;
  }

  if (/搜索|搜\s*索|保存|订阅|批量|查看|沟通|下载|导出|分享|刷新|排序|下一页|上一页|登录|注册|帮助|举报/.test(haystack)) {
    return false;
  }

  return liepinSlowFilterDiscoveryTextPattern.test(haystack);
}

export async function discoverLiepinSearchFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
) {
  const staticResult = await discoverLiepinStaticSearchFilters(page, options);
  if (!options.slowClick) {
    const catalog = createEmptySearchFilterCatalog('liepin', options.keyword, page.url());
    const filters = staticResult.filters;
    return {
      ...catalog,
      filters,
      failures: staticResult.failures,
      stats: buildSearchFilterDiscoveryStats(filters),
    };
  }

  const genericCatalog = await discoverSearchFiltersOnPage('liepin', page, {
    ...options,
    slowClick: true,
    controlTimeoutMs: options.controlTimeoutMs ?? 5000,
    stabilityWaitMs: options.stabilityWaitMs ?? 2500,
    maxControls: options.maxControls ?? 80,
    maxDepth: options.maxDepth ?? 3,
    maxOptionsPerLevel: options.maxOptionsPerLevel ?? 80,
  }, {
    beforeScan: async (scanPage) => {
      await ensureLiepinMoreConditionsExpanded(scanPage).catch(() => undefined);
    },
    shouldIncludeControl: shouldInspectLiepinSlowDiscoveryControl,
    shouldIgnoreControl: (control) => !shouldInspectLiepinSlowDiscoveryControl(control),
    ignoreTextPatterns: [
      /搜索结果/,
      /批量查看/,
      /保存条件/,
      /订阅/,
      /隐藏已查看/,
    ],
    filterContainerTextPatterns: [
      liepinSlowFilterDiscoveryTextPattern,
    ],
  });
  const expandedStaticResult = await discoverLiepinStaticSearchFilters(page, options);

  return mergeLiepinSearchFilterCatalog(genericCatalog, expandedStaticResult.filters, [
    ...staticResult.failures,
    ...expandedStaticResult.failures,
  ]);
}
