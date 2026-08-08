import type { Page } from 'playwright';
import { config } from '../../../config.js';
import {
  clickPlatformLocator,
  moveMouseToLocatorCenter,
  pressPlatformKey,
  waitPlatformActionPace,
} from '../../../browser/pacing.js';
import {
  buildSearchFilterDiscoveryStats,
  createEmptySearchFilterCatalog,
  type SearchFilterCatalog,
  type SearchFilterControlSnapshot,
  type SearchFilterDefinition,
  type SearchFilterDiscoveryRunOptions,
  type SearchFilterOption,
  type SearchFilterOptionInputSpec,
} from '../../../search/filter-catalog.js';
import type {
  SearchCondition,
  SearchConditionApplyResult,
} from '../../../types/job.js';
import {
  createZhilianActionDeadline as createDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import { clearObservedZhilianCandidateApi } from './candidate-actions.js';
import {
  prepareZhilianSavedQuickSearchPage,
} from './search-actions.js';
import {
  isAbortNavigationError,
} from './navigation-actions.js';

const zhilianSearchStatePollMs = 100;
const zhilianPlatform = 'zhilian';
const zhilianOtherFilterLabels = [
  '活跃日期',
  '性别要求',
  '求职状态',
  '现居住地',
  '期望月薪',
  '期望职位',
  '从事职位',
  '从事行业',
  '期望行业',
  '户口所在地',
  '语言能力',
  '人才类型',
  '人才照片',
  '简历语言',
  '跳槽频率',
];
const zhilianOtherFilterIndexByLabel = new Map(zhilianOtherFilterLabels.map((label, index) => [label, index]));
const zhilianSimpleDropdownFilterLabels = new Set([
  '活跃日期',
  '性别要求',
  '求职状态',
  '人才类型',
  '人才照片',
  '简历语言',
  '跳槽频率',
]);
const zhilianComplexCascaderFilterLabels = [
  '现居住地',
  '户口所在地',
  '从事行业',
  '期望行业',
  '从事职位',
  '期望职位',
] as const;
const zhilianApplicationFilterBasicLabelsByFieldId: Record<string, string[]> = {
  education: ['学历要求'],
  work_years: ['经验要求'],
  school_nature: ['院校要求'],
  age: ['年龄要求'],
};
const zhilianBasicCustomSelectRangeInputSpecByLabel: Record<string, SearchFilterOptionInputSpec> = {
  学历要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低学历' },
      { key: 'max', valueType: 'string', label: '最高学历' },
    ],
  },
  经验要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低经验' },
      { key: 'max', valueType: 'string', label: '最高经验' },
    ],
  },
};
const zhilianAgePresetLabels = new Set(['20-25', '25-30', '30-35', '35-40', '40以上']);
const zhilianApplicationFilterDropdownLabelsByFieldId: Record<string, string> = {
  recent_activity_time: '活跃日期',
  gender: '性别要求',
  job_status: '求职状态',
  talent_type: '人才类型',
  talent_photo: '人才照片',
  resume_language: '简历语言',
  job_hopping_count: '跳槽频率',
};
const zhilianApplicationFilterCascaderLabelsByFieldId: Record<string, string> = {
  living_location: '现居住地',
  hukou_location: '户口所在地',
  engaged_industry: '从事行业',
  expected_industry: '期望行业',
  engaged_function: '从事职位',
  expected_function: '期望职位',
};
const zhilianAppliedConditionLabelsByFieldId: Record<string, string[]> = {
  education: ['学历要求'],
  work_years: ['经验要求'],
  age: ['年龄要求'],
  language: ['语言能力'],
  living_location: ['现居住地'],
  hukou_location: ['户口所在地'],
  engaged_industry: ['从事行业'],
  expected_industry: ['期望行业'],
  engaged_function: ['从事职业', '从事职位'],
  expected_function: ['期望职位'],
};
const zhilianSupportedApplicationFilterFieldIds = new Set([
  ...Object.keys(zhilianApplicationFilterBasicLabelsByFieldId),
  ...Object.keys(zhilianApplicationFilterDropdownLabelsByFieldId),
  ...Object.keys(zhilianApplicationFilterCascaderLabelsByFieldId),
  'language',
  'expected_salary',
]);

type ZhilianDynamicFilterOptions = {
  options: SearchFilterOption[];
  controlType?: SearchFilterDefinition['controlType'];
  valueShape?: SearchFilterDefinition['valueShape'];
  childrenLazy?: boolean;
  inputPlaceholder?: string;
  message?: string;
};

type ZhilianTextInputApplicationFilterValueEntry = {
  value: string;
  pathLabels?: string[];
};

type ZhilianCustomSelectRangeInput = {
  min: string;
  max: string;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeApplicationFilterValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' ? normalizeText(value) : '';
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

function compactZhilianFilterText(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function formatZhilianSalaryRange(min: string, max: string): string {
  return `${compactZhilianFilterText(min)}-${compactZhilianFilterText(max)}`;
}

function matchesZhilianSalaryRange(text: string, min: string, max: string): boolean {
  const compactText = compactZhilianFilterText(text);
  const expected = formatZhilianSalaryRange(min, max);
  return compactText === expected
    || compactText.includes(`期望月薪：${expected}`)
    || compactText.includes(`期望月薪:${expected}`);
}

async function readZhilianExpectedSalarySelectionTexts(page: Page): Promise<string[]> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBodyText = normalizeText(bodyText);
  const texts = Array.from(normalizedBodyText.matchAll(/期望月薪[:：]\s*([^\s]+)/g))
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);

  const salaryControlTexts = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };

    return Array.from(document.querySelectorAll('.search-salary'))
      .filter(isVisible)
      .map((element) => normalize(element.textContent))
      .filter(Boolean);
  }).catch(() => []);

  if (Array.isArray(salaryControlTexts)) {
    texts.push(...salaryControlTexts);
  }

  return [...new Set(texts.map(normalizeText).filter(Boolean))];
}

function buildZhilianAppliedFilterValueCandidates(value: string): string[] {
  const compactValue = compactZhilianFilterText(value);
  const candidates = [value];

  if (compactValue.startsWith('全') && compactValue.length > 1) {
    candidates.push(compactValue.slice(1));
  }

  return [...new Set(candidates.map(normalizeText).filter(Boolean))];
}

function buildZhilianAppliedFilterValueCandidatesForEntry(
  entry: ZhilianTextInputApplicationFilterValueEntry,
): string[] {
  const values = [entry.value];
  const lastPathLabel = entry.pathLabels?.at(-1);
  if (lastPathLabel) {
    values.push(lastPathLabel);
  }

  return [...new Set(values.flatMap(buildZhilianAppliedFilterValueCandidates))];
}

function matchesZhilianAppliedConditionValue(bodyText: string, labels: string[], valueCandidates: string[]): boolean {
  const compactBodyText = compactZhilianFilterText(bodyText);
  return labels.some((label) => {
    const compactLabel = compactZhilianFilterText(label);
    return valueCandidates.some((value) => {
      const compactValue = compactZhilianFilterText(value);
      return compactBodyText.includes(`${compactLabel}：${compactValue}`)
        || compactBodyText.includes(`${compactLabel}:${compactValue}`);
    });
  });
}

function readZhilianAppliedConditionObservations(bodyText: string, labels: string[]): string[] {
  const normalizedBodyText = normalizeText(bodyText);
  const observations = labels.flatMap((label) => {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*([^\\s]+)`, 'g');
    return Array.from(normalizedBodyText.matchAll(pattern))
      .map((match) => `${label}：${normalizeText(match[1])}`)
      .filter(Boolean);
  });

  return [...new Set(observations)];
}

async function assertZhilianAppliedConditionValues(
  page: Page,
  fieldId: string,
  valueCandidateGroups: string[][],
): Promise<void> {
  const labels = zhilianAppliedConditionLabelsByFieldId[fieldId];
  const candidateGroups = valueCandidateGroups
    .map((group) => [...new Set(group.map(normalizeText).filter(Boolean))])
    .filter((group) => group.length > 0 && !group.some((value) => value === '不限'));
  if (!labels || candidateGroups.length === 0) {
    return;
  }

  let lastBodyText = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastBodyText = await page.locator('body').innerText().catch(() => '');
    if (candidateGroups.every((group) => matchesZhilianAppliedConditionValue(lastBodyText, labels, group))) {
      return;
    }

    await page.waitForTimeout(zhilianSearchStatePollMs).catch(() => undefined);
  }

  const observed = readZhilianAppliedConditionObservations(lastBodyText, labels);
  const expected = candidateGroups.map((group) => group.join('/')).join(', ');
  throw new Error(`Zhilian ${labels[0]} did not apply ${expected}. Observed: ${observed.join(', ') || '(none)'}.`);
}

async function isZhilianAppliedConditionValues(
  page: Page,
  fieldId: string,
  valueCandidateGroups: string[][],
): Promise<boolean> {
  const labels = zhilianAppliedConditionLabelsByFieldId[fieldId];
  if (!labels) {
    return false;
  }

  const candidateGroups = valueCandidateGroups
    .map((group) => [...new Set(group.map(normalizeText).filter(Boolean))])
    .filter((group) => group.length > 0 && !group.some((value) => value === '不限'));
  if (candidateGroups.length === 0) {
    return true;
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  return candidateGroups.every((group) => matchesZhilianAppliedConditionValue(bodyText, labels, group));
}

async function isZhilianExpectedSalaryApplied(page: Page, min: string, max: string): Promise<boolean> {
  const texts = await readZhilianExpectedSalarySelectionTexts(page);
  return texts.some((text) => matchesZhilianSalaryRange(text, min, max));
}

async function assertZhilianExpectedSalaryApplied(page: Page, min: string, max: string): Promise<void> {
  const texts = await readZhilianExpectedSalarySelectionTexts(page);
  if (texts.some((text) => matchesZhilianSalaryRange(text, min, max))) {
    return;
  }

  throw new Error(`Zhilian expected salary did not apply ${formatZhilianSalaryRange(min, max)}. Observed: ${texts.join(', ') || '(none)'}.`);
}

export async function ensureZhilianSearchConditionPanelOpen(
  page: Page,
  deadline: number,
  options: { expandMore?: boolean } = {},
): Promise<void> {
  const panel = page.locator('.search-condition-panel-new').first();
  const hasVisiblePanel = await panel.waitFor({
    state: 'visible',
    timeout: Math.min(1000, remainingTime(deadline)),
  }).then(() => true).catch(() => false);

  if (!hasVisiblePanel) {
    const advancedTriggers = [
      page.locator('button:has-text("使用高级搜索")').first(),
      page.locator('[role="button"]:has-text("使用高级搜索")').first(),
      page.locator('[class*="advanced"]:has-text("使用高级搜索")').first(),
      page.getByText('使用高级搜索', { exact: true }).first(),
    ];

    let clicked = false;
    for (const trigger of advancedTriggers) {
      try {
        await trigger.waitFor({ state: 'visible', timeout: Math.min(1000, remainingTime(deadline)) });
        await clickPlatformLocator(trigger, page, zhilianPlatform, Math.min(1000, remainingTime(deadline)));
        clicked = true;
        break;
      } catch {
        continue;
      }
    }

    if (!clicked) {
      throw new Error('Could not find the Zhilian advanced-search trigger.');
    }

    await panel.waitFor({ state: 'visible', timeout: Math.min(2000, remainingTime(deadline)) });
  }

  if (!options.expandMore) {
    return;
  }

  const panelText = await panel.innerText({ timeout: Math.min(1000, remainingTime(deadline)) }).catch(() => '');
  if (/户口所在地|语言能力|人才类型|人才照片|简历语言|跳槽频率/.test(panelText)) {
    return;
  }

  const moreTriggers = [
    panel.locator('.filter-other-trigger.filter-other__item').first(),
    panel.locator('[class*="filter-other-trigger"]:has-text("更多筛选")').first(),
    panel.locator('.filter-other__item:has-text("更多筛选")').first(),
    panel.getByText('更多筛选', { exact: true }).first(),
  ];

  for (const trigger of moreTriggers) {
    try {
      await trigger.waitFor({ state: 'visible', timeout: Math.min(1000, remainingTime(deadline)) });
      await clickPlatformLocator(trigger, page, zhilianPlatform, Math.min(1000, remainingTime(deadline)));
      await page.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
      return;
    } catch {
      continue;
    }
  }
}

async function closeBlockingZhilianFilterDiscoveryDialogs(page: Page): Promise<void> {
  const blockingDialog = page.locator([
    '.km-modal__wrapper.required-hide-age-modal',
    '.km-modal__wrapper:has-text("隐藏年龄")',
    '.km-modal__wrapper:has-text("年龄")',
  ].join(', ')).filter({ visible: true }).first();

  if (await blockingDialog.count().catch(() => 0) === 0) {
    return;
  }

  const closeControl = blockingDialog.locator([
    '.km-modal__close',
    '[aria-label="关闭"]',
    '[class*="close"]',
    'button:has-text("取消")',
    'button:has-text("知道了")',
    'button:has-text("确定")',
  ].join(', ')).filter({ visible: true }).first();

  try {
    await clickPlatformLocator(closeControl, page, zhilianPlatform, 1000);
  } catch {
    await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
  }
}

function buildZhilianFilterDiscoveryHaystack(control: SearchFilterControlSnapshot): string {
  return normalizeText([
    control.label,
    control.text,
    control.placeholder,
    control.containerText,
    control.cssPath,
  ].join(' '));
}

export function shouldIncludeZhilianFilterDiscoveryControl(control: SearchFilterControlSnapshot): boolean {
  return /学历要求|年龄要求|经验要求|院校要求|其他筛选|性别要求|求职状态|现居住地|期望月薪|期望职位|从事职位|从事行业|期望行业|更多筛选|户口所在地|语言能力|人才类型|人才照片|简历语言|跳槽频率/.test(
    buildZhilianFilterDiscoveryHaystack(control),
  );
}

export function shouldIgnoreZhilianFilterDiscoveryControl(control: SearchFilterControlSnapshot): boolean {
  const haystack = buildZhilianFilterDiscoveryHaystack(control);
  if (/快捷搜索|猜你想搜|搜公司、职位、专业、学校、行业、技能等|搜索$|清空筛选/.test(haystack)) {
    return true;
  }
  return /推荐|职位管理|简历管理|聊天|个人中心|打电话|打招呼|候选人|简历列表|第\d+页|共\d+条/.test(haystack);
}

function buildZhilianFilterKey(label: string, index: number): string {
  const normalizedLabel = normalizeText(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `zhilian-${normalizedLabel || 'filter'}-${index + 1}`;
}

function uniqueZhilianFilterOptions(values: string[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const value of values.map((item) => normalizeText(item)).filter(Boolean)) {
    const normalized = value.replace(/·\d+$/g, '').replace(/\s+/g, '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    options.push(value);
  }

  return options;
}

function uniqueZhilianFilterOptionObjects(options: SearchFilterOption[]): SearchFilterOption[] {
  const seen = new Set<string>();
  const uniqueOptions: SearchFilterOption[] = [];

  for (const option of options) {
    const label = normalizeText(option.label);
    const value = normalizeText(option.value) || label;
    if (!label && !value) {
      continue;
    }

    const pathLabels = (option.pathLabels ?? []).map(normalizeText).filter(Boolean);
    const parentPathLabels = (option.parentPathLabels ?? []).map(normalizeText).filter(Boolean);
    const dedupeKey = [
      option.depth ?? 0,
      value,
      pathLabels.length > 0 ? pathLabels.join('\u0000') : label,
    ].join('\u0001');
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    uniqueOptions.push({
      label: label || value,
      value,
      depth: option.depth,
      disabled: option.disabled,
      selected: option.selected,
      parentPathLabels: parentPathLabels.length > 0 ? parentPathLabels : undefined,
      pathLabels: pathLabels.length > 0 ? pathLabels : undefined,
      message: option.message,
      inputSpec: option.inputSpec,
    });
  }

  return uniqueOptions;
}

function buildZhilianStringFilterOptions(values: string[]): SearchFilterOption[] {
  return uniqueZhilianFilterOptions(values).map((option) => ({
    label: option,
    value: option,
    selected: /\b(active|selected|checked)\b/i.test(option) || undefined,
  }));
}

function withZhilianBasicCustomInputSpecs(label: string, options: SearchFilterOption[]): SearchFilterOption[] {
  const inputSpec = zhilianBasicCustomSelectRangeInputSpecByLabel[label];
  if (!inputSpec) {
    return options;
  }

  return options.map((option) => (
    compactZhilianFilterText(option.label) === '自定义'
      ? { ...option, inputSpec }
      : option
  ));
}

function buildZhilianStaticFilterDefinition(
  row: { label: string; options: string[]; selectorHint?: string },
  index: number,
  dynamicOptions?: ZhilianDynamicFilterOptions,
): SearchFilterDefinition {
  const staticOptions = buildZhilianStringFilterOptions(row.options).filter((option) => option.label !== row.label);
  const options = uniqueZhilianFilterOptionObjects(
    withZhilianBasicCustomInputSpecs(row.label, dynamicOptions?.options ?? staticOptions),
  );
  const isRange = /年龄|薪/.test(row.label);
  const controlType = dynamicOptions?.controlType ?? (isRange ? 'rangeInput' : options.length > 0 ? 'singleSelect' : 'unknown');
  const valueShape = dynamicOptions?.valueShape ?? (isRange ? 'range' : options.length > 0 ? 'string' : 'string');

  return {
    key: buildZhilianFilterKey(row.label, index),
    label: row.label,
    controlType,
    valueShape,
    status: options.length > 0 ? 'optionsExtracted' : 'inspected',
    options: options.length > 0 ? options : undefined,
    selectorHints: [
      { kind: 'text', value: row.label },
      ...(row.selectorHint ? [{ kind: 'cssPath' as const, value: row.selectorHint }] : []),
    ],
    inputPlaceholder: dynamicOptions?.inputPlaceholder,
    childrenLazy: dynamicOptions?.childrenLazy,
    message: dynamicOptions?.message ?? 'Captured from the visible Zhilian search-condition panel.',
  };
}

async function collectZhilianOtherFilterPopupOptions(
  page: Page,
  label: string,
  kind: 'select' | 'salary',
  deadline: number,
): Promise<string[]> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    return [];
  }

  const options = await page.evaluate(async ({ targetIndex, targetLabel, targetKind }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readOtherLabel = (element: Element): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim();
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const unique = (values: string[]): string[] => {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const value of values.map(normalizeText).filter(Boolean)) {
        const dedupeKey = value.replace(/\s+/g, '');
        if (!dedupeKey || seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        result.push(value);
      }
      return result;
    };

    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const item = otherItems[targetIndex] ?? otherItems.find((candidate) => readOtherLabel(candidate) === targetLabel);
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return [];
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 350));

    const popupSelectors = [
      '.km-popover',
      '.km-popper',
      '.km-select__dropdown-wrapper',
      '.search-salary-popover',
      '[role="listbox"]',
    ];
    const popups = Array.from(document.querySelectorAll(popupSelectors.join(', '))).filter(isVisible);
    const optionSelector = targetKind === 'salary'
      ? '.search-salary_list-item span'
      : '.km-option__label';
    const values = popups.flatMap((popup) => Array.from(popup.querySelectorAll(optionSelector))
      .filter(isVisible)
      .map((node) => normalizeText(node.textContent)));

    return unique(values);
  }, { targetIndex, targetLabel: label, targetKind: kind }).catch(() => []);

  await closeZhilianVisibleFilterPopups(page, deadline);
  return options;
}

export async function closeZhilianVisibleFilterPopups(page: Page, deadline: number): Promise<void> {
  await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
  await page.evaluate(async () => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const dialogs = Array.from(document.querySelectorAll('.s-dialog, .km-modal, [role="dialog"]'))
      .filter(isVisible)
      .reverse();
    for (const dialog of dialogs) {
      const controls = Array.from(dialog.querySelectorAll([
        'button',
        '.s-dialog__close',
        '.km-modal__close',
        '.s-button',
        '[class*="close"]',
        '[class*="cancel"]',
      ].join(', '))).filter(isVisible);
      const cancelControl = controls.find((node) => /取消|关闭|×/.test(
        normalizeText(node.textContent)
          || normalizeText(node.getAttribute('aria-label'))
          || normalizeText(node.getAttribute('title')),
      )) ?? controls.at(-1);
      if (cancelControl) {
        dispatchClick(cancelControl);
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
    }
  }).catch(() => undefined);
  await page.waitForTimeout(Math.min(150, remainingTime(deadline))).catch(() => undefined);
}

async function collectZhilianCascaderFilterOptions(
  page: Page,
  label: string,
  deadline: number,
): Promise<ZhilianDynamicFilterOptions | undefined> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    return undefined;
  }

  const result = await page.evaluate(async ({ targetIndex, targetLabel, otherFilterLabels }) => {
    const normalizeText = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
      }
      if (value === null || value === undefined) {
        return '';
      }
      return String(value).replace(/\s+/g, ' ').trim();
    };
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const readOtherLabel = (element: Element, index: number): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim() || otherFilterLabels[index] || '';
    const readChildren = (node: Record<string, unknown>): unknown[] => {
      for (const key of ['children', 'childList', 'list', 'items']) {
        const value = node[key];
        if (Array.isArray(value)) {
          return value;
        }
      }
      return [];
    };
    const readLabel = (node: Record<string, unknown>): string => {
      for (const key of ['label', 'name', 'title', 'text', 'fullName']) {
        const value = normalizeText(node[key]);
        if (value) {
          return value;
        }
      }
      return '';
    };
    const readValue = (node: Record<string, unknown>, fallback: string): string => {
      for (const key of ['value', 'id', 'code', 'serial']) {
        const value = normalizeText(node[key]);
        if (value) {
          return value;
        }
      }
      return fallback;
    };
    const pushOption = (
      node: unknown,
      parentPathLabels: string[],
      depth: number,
      options: SearchFilterOption[],
    ): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return;
      }

      const record = node as Record<string, unknown>;
      const optionLabel = readLabel(record);
      if (!optionLabel) {
        return;
      }

      const pathLabels = [...parentPathLabels, optionLabel];
      const children = readChildren(record);
      options.push({
        label: optionLabel,
        value: readValue(record, optionLabel),
        depth,
        disabled: Boolean(record.disabled),
        selected: Boolean(record.selected),
        parentPathLabels: parentPathLabels.length > 0 ? parentPathLabels : undefined,
        pathLabels,
      });

      for (const child of children) {
        pushOption(child, pathLabels, depth + 1, options);
      }
    };
    const uniqueOptions = (options: SearchFilterOption[]): SearchFilterOption[] => {
      const seen = new Set<string>();
      const result: SearchFilterOption[] = [];
      for (const option of options) {
        const key = [
          option.depth ?? 0,
          option.value ?? option.label,
          (option.pathLabels ?? [option.label]).join('\u0000'),
        ].join('\u0001');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(option);
      }
      return result;
    };

    let otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    if (!otherItems.some((item, index) => readOtherLabel(item, index) === targetLabel)) {
      const moreTrigger = Array.from(document.querySelectorAll('.filter-other-trigger, .filter-other-wrap__content .filter-other__item'))
        .find((item) => /更多筛选/.test(normalizeText(item.textContent)));
      if (moreTrigger instanceof HTMLElement) {
        dispatchClick(moreTrigger);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
        .filter((item) => !item.classList.contains('filter-other-trigger'));
    }

    const item = otherItems[targetIndex] ?? otherItems.find((candidate, index) => readOtherLabel(candidate, index) === targetLabel);
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return undefined;
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 650));

    const visibleCascader = Array.from(document.querySelectorAll('.s-cascader')).filter(isVisible).at(-1);
    const propsData = (
      visibleCascader as (HTMLElement & {
        __vue__?: {
          $options?: { propsData?: Record<string, unknown> };
          $props?: Record<string, unknown>;
        };
      }) | undefined
    )?.__vue__?.$options?.propsData ?? (
      visibleCascader as (HTMLElement & {
        __vue__?: {
          $props?: Record<string, unknown>;
        };
      }) | undefined
    )?.__vue__?.$props ?? {};
    const rootOptions = Array.isArray(propsData.options) ? propsData.options : [];
    if (rootOptions.length === 0) {
      return undefined;
    }

    const options: SearchFilterOption[] = [];
    for (const option of rootOptions) {
      pushOption(option, [], 0, options);
    }

    const dialog = Array.from(document.querySelectorAll('.s-dialog, [role="dialog"]')).filter(isVisible).at(-1);
    const inputPlaceholder = normalizeText(dialog?.querySelector('input[placeholder]')?.getAttribute('placeholder'));

    return {
      options: uniqueOptions(options),
      inputPlaceholder,
    };
  }, {
    targetIndex,
    targetLabel: label,
    otherFilterLabels: zhilianOtherFilterLabels,
    targetKind: 'cascader',
  }).catch(() => undefined);

  await closeZhilianVisibleFilterPopups(page, deadline);

  if (!result || !Array.isArray(result.options) || result.options.length === 0) {
    return undefined;
  }

  return {
    options: result.options,
    controlType: 'textInput',
    valueShape: 'string',
    childrenLazy: false,
    inputPlaceholder: result.inputPlaceholder || undefined,
    message: `Captured the full Zhilian ${label} cascader tree from Vue component props.`,
  };
}

async function collectZhilianLanguageFilterOptions(
  page: Page,
  deadline: number,
): Promise<ZhilianDynamicFilterOptions | undefined> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get('语言能力');
  if (targetIndex === undefined) {
    return undefined;
  }

  const values = await page.evaluate(async ({ targetIndex, otherFilterLabels }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const readOtherLabel = (element: Element, index: number): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim() || otherFilterLabels[index] || '';
    const unique = (options: string[]): string[] => {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const option of options.map(normalizeText).filter(Boolean)) {
        const key = option.replace(/\s+/g, '');
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(option);
      }
      return result;
    };

    let otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    if (!otherItems.some((item, index) => readOtherLabel(item, index) === '语言能力')) {
      const moreTrigger = Array.from(document.querySelectorAll('.filter-other-trigger, .filter-other-wrap__content .filter-other__item'))
        .find((item) => /更多筛选/.test(normalizeText(item.textContent)));
      if (moreTrigger instanceof HTMLElement) {
        dispatchClick(moreTrigger);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
        .filter((item) => !item.classList.contains('filter-other-trigger'));
    }

    const item = otherItems[targetIndex] ?? otherItems.find((candidate, index) => readOtherLabel(candidate, index) === '语言能力');
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return [];
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 650));

    const popover = Array.from(document.querySelectorAll('.search-language-popover, .km-popover.search-language-popover'))
      .filter(isVisible)
      .at(-1);
    const values = Array.from(popover?.querySelectorAll('.search-language-popover__item-text, .search-language-popover__item') ?? [])
      .filter(isVisible)
      .map((node) => normalizeText(node.textContent));
    return unique(values);
  }, {
    targetIndex,
    otherFilterLabels: zhilianOtherFilterLabels,
    targetKind: 'language',
  }).catch(() => []);

  await closeZhilianVisibleFilterPopups(page, deadline);

  const options = buildZhilianStringFilterOptions(values);
  if (options.length === 0) {
    return undefined;
  }

  return {
    options,
    controlType: 'singleSelect',
    valueShape: 'string',
    message: 'Captured from the Zhilian language ability popover.',
  };
}

async function collectZhilianDynamicSearchFilterOptions(
  page: Page,
  deadline: number,
): Promise<Map<string, ZhilianDynamicFilterOptions>> {
  const optionTargets = [
    ...Array.from(zhilianSimpleDropdownFilterLabels).map((label) => ({ label, kind: 'select' as const })),
    { label: '期望月薪', kind: 'salary' as const },
  ];
  const optionsByLabel = new Map<string, ZhilianDynamicFilterOptions>();

  for (const target of optionTargets) {
    if (remainingTime(deadline) <= 500) {
      break;
    }

    const options = await collectZhilianOtherFilterPopupOptions(page, target.label, target.kind, deadline);
    if (options.length > 0) {
      optionsByLabel.set(target.label, {
        options: buildZhilianStringFilterOptions(options),
        controlType: target.kind === 'salary' ? 'rangeInput' : 'singleSelect',
        valueShape: target.kind === 'salary' ? 'range' : 'string',
        message: target.kind === 'salary'
          ? 'Captured from the Zhilian salary popover.'
          : 'Captured from the Zhilian dropdown popover.',
      });
    }
  }

  for (const label of zhilianComplexCascaderFilterLabels) {
    if (remainingTime(deadline) <= 500) {
      break;
    }

    const options = await collectZhilianCascaderFilterOptions(page, label, deadline);
    if (options) {
      optionsByLabel.set(label, options);
    }
  }

  if (remainingTime(deadline) > 500) {
    const languageOptions = await collectZhilianLanguageFilterOptions(page, deadline);
    if (languageOptions) {
      optionsByLabel.set('语言能力', languageOptions);
    }
  }

  return optionsByLabel;
}

export async function discoverZhilianStaticSearchFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterCatalog> {
  const deadline = options.deadline ?? createDeadline(options.globalTimeoutMs ?? config.playwright.searchPageTimeoutMs);
  await prepareZhilianSavedQuickSearchPage(page, options.keyword, { deadline });
  await closeBlockingZhilianFilterDiscoveryDialogs(page);
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true });

  const rows = await page.evaluate((otherFilterLabels) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const readOptions = (root: Element): string[] => Array.from(root.querySelectorAll([
      '.search-education-new__selector-item',
      '.search-education-new-custom__label',
      '.button-group__list-item',
      '.search-school-nature-new__item',
    ].join(', ')))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean);
    const basicRows = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .map((row) => {
        const label = normalizeText(row.querySelector('.search-label-wrapper-new__label')?.textContent);
        return {
          label,
          options: readOptions(row),
          selectorHint: '.filter-panel-new .search-label-wrapper-new',
        };
      })
      .filter((row) => row.label);
    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const otherRows = otherItems.map((item, index) => {
      const fallbackLabel = normalizeText(item.querySelector('.talent-search-other-label')?.textContent)
        .replace(/·\d+/g, '')
        .replace(/收起筛选|更多筛选/g, '')
        .trim();
      const label = otherFilterLabels[index] ?? fallbackLabel;
      const visibleText = normalizeText(item.querySelector('.talent-search-other-label')?.textContent)
        .replace(/·\d+/g, '')
        .trim();
      const options = visibleText && visibleText !== label ? [visibleText] : [];
      return {
        label,
        options,
        selectorHint: '.filter-other-wrap__content .filter-other__item',
      };
    }).filter((row) => row.label);

    return [...basicRows, ...otherRows];
  }, zhilianOtherFilterLabels);

  const dynamicOptions = options.slowClick
    ? await collectZhilianDynamicSearchFilterOptions(page, deadline)
    : new Map<string, ZhilianDynamicFilterOptions>();
  const filters = rows
    .map((row) => ({
      ...row,
      dynamicOptions: dynamicOptions.get(row.label),
    }))
    .map((row, index) => buildZhilianStaticFilterDefinition(row, index, row.dynamicOptions));
  return {
    ...createEmptySearchFilterCatalog('zhilian', options.keyword, page.url()),
    filters,
    failures: [],
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}

function readZhilianApplicationFilterSingleValue(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  const normalizedValue = isRecord(condition.value)
    ? normalizeApplicationFilterValue(condition.value.label)
    : normalizeApplicationFilterValue(condition.value);
  const conditionValue = normalizedValue || normalizeApplicationFilterValue(condition.values?.[0]?.value);
  if (!conditionValue) {
    throw new Error(`Missing value for Zhilian application filter: ${condition.fieldId}`);
  }

  if (conditionValue === '自定义' || (isRecord(condition.value) && isRecord(condition.value.input))) {
    throw new Error(`Zhilian application filter ${condition.fieldId} does not support custom input replay yet.`);
  }

  return conditionValue;
}

function readZhilianCustomSelectRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianCustomSelectRangeInput | undefined {
  if (!isRecord(condition.value) || !isRecord(condition.value.input)) {
    return undefined;
  }

  const min = normalizeApplicationFilterValue(condition.value.input.min);
  const max = normalizeApplicationFilterValue(condition.value.input.max);
  if (!min || !max) {
    throw new Error(`Zhilian application filter ${condition.fieldId} custom input requires non-empty min and max values.`);
  }

  return { min, max };
}

async function readZhilianBasicCustomRangeState(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<{
  matches: boolean;
  rowText: string;
  inputValues: string[];
  activeOptions: string[];
}> {
  return await page.evaluate(({ rowLabels, expectedMin, expectedMax }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const compact = (value: string | null | undefined): string => normalizeText(value).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
    const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible)
      .find((candidate) => {
        const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
        return normalizedRowLabels.includes(label);
      });
    const inputValues = Array.from(row?.querySelectorAll('.search-select-two-new .km-select input') ?? [])
      .filter(isVisible)
      .map((element) => normalizeText((element as HTMLInputElement).value || element.getAttribute('placeholder')))
      .filter((value) => value && value !== '不限');
    const activeOptions = Array.from(row?.querySelectorAll([
      '.search-education-new__selector-item-active',
      '.button-group__list-item-active',
    ].join(', ')) ?? [])
      .filter(isVisible)
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);

    return {
      matches: inputValues.length >= 2
        && compact(inputValues[0]) === compact(expectedMin)
        && compact(inputValues[1]) === compact(expectedMax),
      rowText: normalizeText(row?.textContent),
      inputValues,
      activeOptions,
    };
  }, {
    rowLabels,
    expectedMin: input.min,
    expectedMax: input.max,
  }).catch((error) => {
    if (isAbortNavigationError(error)) {
      return {
        matches: false,
        rowText: '',
        inputValues: [],
        activeOptions: [],
      };
    }

    throw error;
  });
}

async function isZhilianBasicCustomRangeApplied(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<boolean> {
  return (await readZhilianBasicCustomRangeState(page, rowLabels, input)).matches;
}

async function assertZhilianBasicCustomRangeApplied(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<void> {
  let lastState: Awaited<ReturnType<typeof readZhilianBasicCustomRangeState>> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastState = await readZhilianBasicCustomRangeState(page, rowLabels, input);
    if (lastState.matches) {
      return;
    }

    await page.waitForTimeout(zhilianSearchStatePollMs).catch(() => undefined);
  }

  throw new Error(
    `Zhilian ${rowLabels[0]} custom range did not apply ${input.min}-${input.max}. `
    + `Observed inputs: ${(lastState?.inputValues ?? []).join(', ') || '(none)'}. `
    + `Active options: ${(lastState?.activeOptions ?? []).join(', ') || '(none)'}.`,
  );
}

function normalizeZhilianAgeBoundaryValue(value: unknown): string {
  const normalized = normalizeApplicationFilterValue(value);
  if (!normalized) {
    return '';
  }

  return /\d$/.test(normalized) ? `${normalized}岁` : normalized;
}

function toZhilianTextInputApplicationFilterValueEntry(
  value: string,
  pathLabels?: string[],
): ZhilianTextInputApplicationFilterValueEntry | undefined {
  if (!value || value === '不限') {
    return undefined;
  }

  const normalizedPathLabels = pathLabels?.map(normalizeApplicationFilterValue).filter(Boolean);
  return normalizedPathLabels && normalizedPathLabels.length > 0
    ? { value, pathLabels: normalizedPathLabels }
    : { value };
}

function readZhilianTextInputApplicationFilterValueEntries(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianTextInputApplicationFilterValueEntry[] {
  const rawValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  const entries = rawValues
    .map((value) => {
      const normalizedValue = isRecord(value)
        ? normalizeApplicationFilterValue(value.value) || normalizeApplicationFilterValue(value.label)
        : normalizeApplicationFilterValue(value);
      const pathLabels = isRecord(value) && Array.isArray(value.pathLabels)
        ? value.pathLabels.map((pathLabel) => normalizeApplicationFilterValue(pathLabel)).filter(Boolean)
        : undefined;
      return toZhilianTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is ZhilianTextInputApplicationFilterValueEntry => Boolean(value));

  if (entries.length > 0) {
    return entries;
  }

  return (condition.values ?? [])
    .map((value) => {
      const normalizedValue = normalizeApplicationFilterValue(value.value);
      const pathLabels = value.pathLabels
        ?.map((pathLabel) => normalizeApplicationFilterValue(pathLabel))
        .filter(Boolean);
      return toZhilianTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is ZhilianTextInputApplicationFilterValueEntry => Boolean(value));
}

export function buildZhilianAgePresetLabel(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian age application filter requires { min, max } value.');
  }

  const min = normalizeApplicationFilterValue(condition.value.min);
  const max = normalizeApplicationFilterValue(condition.value.max);
  if (min && max) {
    return `${min}-${max}`;
  }

  if (min && !max) {
    return `${min}以上`;
  }

  throw new Error('Zhilian age application filter currently requires a preset-compatible min/max range.');
}

function readZhilianAgeCustomSelectRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianCustomSelectRangeInput {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian age application filter requires { min, max } value.');
  }

  const min = normalizeZhilianAgeBoundaryValue(condition.value.min);
  const max = normalizeZhilianAgeBoundaryValue(condition.value.max) || '及以上';
  if (!min) {
    throw new Error('Zhilian age custom range requires a non-empty min value.');
  }

  return { min, max };
}

async function waitForZhilianApplicationFilterSettle(page: Page): Promise<void> {
  await page.waitForTimeout(500).catch(() => undefined);
}

async function clickZhilianBasicFilterOption(page: Page, rowLabels: string[], value: string): Promise<void> {
  const clicked = await page.evaluate(({ rowLabels, targetValue }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const rows = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible);
    const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
    const row = rows.find((candidate) => {
      const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
      return normalizedRowLabels.includes(label);
    });
    if (!row) {
      return false;
    }

    const candidates = Array.from(row.querySelectorAll([
      '.search-education-new__selector-item',
      '.search-education-new-custom__label',
      '.button-group__list-item',
      '.search-school-nature-new__item',
    ].join(', '))).filter(isVisible) as HTMLElement[];
    const target = candidates.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    dispatchClick(target);
    return true;
  }, { rowLabels, targetValue: value });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian filter option ${rowLabels.join('/')}=${value}.`);
  }

  await waitForZhilianApplicationFilterSettle(page);
}

async function clickZhilianBasicFilterCustomRangeTrigger(page: Page, rowLabels: string[]): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clickZhilianBasicFilterOption(page, rowLabels, '自定义');
    } catch (error) {
      if (!isAbortNavigationError(error) || attempt > 0) {
        throw error;
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      await ensureZhilianSearchConditionPanelOpen(page, createDeadline(8000), { expandMore: true });
    }

    const visible = await page.evaluate((rowLabels) => {
      const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
      const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
      const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
        .filter(isVisible)
        .find((candidate) => {
          const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
          return normalizedRowLabels.includes(label);
        });
      return Array.from(row?.querySelectorAll('.search-select-two-new .km-select') ?? []).filter(isVisible).length >= 2;
    }, rowLabels).catch((error) => {
      if (isAbortNavigationError(error)) {
        return false;
      }
      throw error;
    });

    if (visible) {
      return;
    }
  }

  throw new Error(`Unable to open Zhilian custom range controls for ${rowLabels.join('/')}.`);
}

async function clickZhilianBasicCustomSelectRangeOption(
  page: Page,
  rowLabels: string[],
  value: string,
  side: 'min' | 'max',
): Promise<void> {
  const clicked = await page.evaluate(async ({ rowLabels, targetValue, side }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible)
      .find((candidate) => {
        const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
        return rowLabels.map(compact).filter(Boolean).includes(label);
      });
    if (!row) {
      return false;
    }

    const selects = Array.from(row.querySelectorAll('.search-select-two-new .km-select')).filter(isVisible) as HTMLElement[];
    const targetSelect = selects[side === 'min' ? 0 : 1];
    if (!targetSelect) {
      return false;
    }

    dispatchClick(targetSelect);
    await wait(250);

    const popoverId = targetSelect.getAttribute('aria-describedby');
    const popovers = [
      ...(popoverId ? [document.getElementById(popoverId)] : []),
      ...Array.from(document.querySelectorAll('.km-popover.search-select-two-new__popover, .km-select__dropdown-wrapper')),
    ].filter(isVisible) as HTMLElement[];
    const activePopover = popovers.at(-1);
    const labels = Array.from(activePopover?.querySelectorAll('.km-option__label') ?? [])
      .filter(isVisible) as HTMLElement[];
    const targetLabel = labels.find((element) => compact(element.textContent) === compact(targetValue));
    if (!targetLabel) {
      return false;
    }

    const option = targetLabel.closest('.km-option') as HTMLElement | null;
    dispatchClick(option ?? targetLabel);
    return true;
  }, { rowLabels, targetValue: value, side }).catch((error) => {
    if (isAbortNavigationError(error)) {
      return true;
    }

    throw error;
  });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian custom range ${side} option ${rowLabels.join('/')}=${value}.`);
  }

  await waitForZhilianApplicationFilterSettle(page);
}

async function openZhilianOtherFilterDropdown(page: Page, label: string): Promise<void> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    throw new Error(`Unsupported Zhilian dropdown filter label: ${label}`);
  }

  await closeZhilianVisibleFilterPopups(page, createDeadline(1000)).catch(() => undefined);

  const opened = await page.evaluate(({ targetIndex, targetLabel }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const readOtherLabel = (element: Element): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const item = otherItems.find((candidate) => readOtherLabel(candidate) === targetLabel)
      ?? otherItems[targetIndex];
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!isVisible(trigger)) {
      return false;
    }

    dispatchClick(trigger);
    return true;
  }, { targetIndex, targetLabel: label });

  if (!opened) {
    throw new Error(`Unable to open Zhilian dropdown filter: ${label}.`);
  }

  await page.waitForTimeout(250).catch(() => undefined);
}

async function clickZhilianOpenedKmOption(page: Page, value: string): Promise<void> {
  const clicked = await page.evaluate((targetValue) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };

    const labels = Array.from(document.querySelectorAll('.km-popover .km-option__label, .km-select__dropdown-wrapper .km-option__label'))
      .filter(isVisible) as HTMLElement[];
    const target = labels.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    const option = target.closest('.km-option') as HTMLElement | null;
    dispatchClick(option ?? target);
    return true;
  }, value);

  if (!clicked) {
    throw new Error(`Unable to select Zhilian dropdown option: ${value}.`);
  }
}

async function applyZhilianDropdownApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const label = zhilianApplicationFilterDropdownLabelsByFieldId[condition.fieldId];
  if (!label) {
    throw new Error(`Unsupported Zhilian dropdown application filter: ${condition.fieldId}`);
  }

  const value = readZhilianApplicationFilterSingleValue(condition);
  await openZhilianOtherFilterDropdown(page, label);
  await clickZhilianOpenedKmOption(page, value);
  await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
}

async function clickZhilianLanguageOption(page: Page, value: string): Promise<void> {
  const clicked = await page.evaluate(async (targetValue) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const findPopover = (): HTMLElement | undefined => Array.from(document.querySelectorAll('.search-language-popover, .km-popover.search-language-popover'))
      .filter(isVisible)
      .at(-1) as HTMLElement | undefined;
    const findOptions = (popover: HTMLElement | undefined): HTMLElement[] => Array.from(
      popover?.querySelectorAll('.search-language-popover__item, .search-language-popover__item-text') ?? [],
    ).filter(isVisible) as HTMLElement[];
    const clickOption = (option: HTMLElement): void => {
      dispatchClick(option.closest('.search-language-popover__item') as HTMLElement | null ?? option);
    };

    const popover = findPopover();
    const options = findOptions(popover);
    const target = options.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    clickOption(target);
    await wait(220);

    const childOptions = findOptions(findPopover())
      .filter((element) => element.closest('.search-language-popover__item')?.classList.contains('is-child-item'));
    const preferredChild = childOptions.find((element) => compact(element.textContent) === compact('无证书要求'))
      ?? childOptions[0];
    if (preferredChild) {
      clickOption(preferredChild);
      await wait(220);
    }

    return true;
  }, value);

  if (!clicked) {
    throw new Error(`Unable to select Zhilian language option: ${value}.`);
  }
}

async function applyZhilianLanguageApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const value = readZhilianApplicationFilterSingleValue(condition);
  const valueCandidates = buildZhilianAppliedFilterValueCandidates(value);
  if (await isZhilianAppliedConditionValues(page, condition.fieldId, [valueCandidates])) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, '语言能力');
  await clickZhilianLanguageOption(page, value);
  await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
  await assertZhilianAppliedConditionValues(page, condition.fieldId, [valueCandidates]);
}

async function clearZhilianCascaderSelection(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const closeControl = Array.from(document.querySelectorAll('.s-dialog .s-tags__close, .s-dialog [class*="tags__close"]'))
        .filter(isVisible)
        .at(-1);
      if (!closeControl) {
        break;
      }

      dispatchClick(closeControl);
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  }).catch(() => undefined);
}

async function clickZhilianCascaderPath(page: Page, pathLabels: string[], value: string): Promise<void> {
  if (pathLabels.length === 0) {
    throw new Error(`Missing Zhilian cascader path labels for ${value}.`);
  }

  const clicked = await page.evaluate(async ({ pathLabels, value }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const findVisibleDialog = (): HTMLElement | undefined => Array.from(document.querySelectorAll('.s-dialog'))
      .filter(isVisible)
      .at(-1);
    const readNodeText = (element: Element): string => normalizeText(
      element.querySelector('.s-cascader__option-content, .s-checkbutton__item-text, span, p')?.textContent
        || element.textContent,
    );
    const findOption = (dialog: HTMLElement, label: string, depth: number): HTMLElement | undefined => {
      const optionSelectors = depth < pathLabels.length - 1
        ? [
          '.s-cascader__option',
          '.s-cascader__select-button-wrapper',
          '.s-checkbutton__item',
        ]
        : [
          '.s-checkbutton__item',
          '.s-cascader__select-button-wrapper',
          '.s-cascader__option',
        ];
      const options = optionSelectors.flatMap((selector) =>
        Array.from(dialog.querySelectorAll(selector)).filter(isVisible) as HTMLElement[]);
      const exact = options.find((element) => compact(readNodeText(element)) === compact(label));
      if (exact) {
        return exact;
      }

      if (depth === pathLabels.length - 1 && compact(label) === compact(value)) {
        return options.find((element) => compact(readNodeText(element)) === compact(value));
      }

      return undefined;
    };

    for (let index = 0; index < pathLabels.length; index += 1) {
      const dialog = findVisibleDialog();
      if (!dialog) {
        return false;
      }

      const target = findOption(dialog, pathLabels[index]!, index);
      if (!target) {
        return false;
      }

      dispatchClick(target);
      await wait(180);
    }

    return true;
  }, { pathLabels, value });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian cascader path: ${pathLabels.join(' / ')}`);
  }
}

async function clickZhilianCascaderConfirm(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const dialog = Array.from(document.querySelectorAll('.s-dialog')).filter(isVisible).at(-1);
    const confirm = Array.from(dialog?.querySelectorAll('button, .s-button') ?? [])
      .filter(isVisible)
      .find((element) => normalizeText(element.textContent).includes('确定'));
    if (!(confirm instanceof HTMLElement)) {
      return false;
    }

    dispatchClick(confirm);
    return true;
  });

  if (!clicked) {
    throw new Error('Unable to confirm Zhilian cascader selection.');
  }

  await waitForZhilianApplicationFilterSettle(page);
  await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
}

async function applyZhilianCascaderApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const label = zhilianApplicationFilterCascaderLabelsByFieldId[condition.fieldId];
  if (!label) {
    throw new Error(`Unsupported Zhilian cascader application filter: ${condition.fieldId}`);
  }

  const values = readZhilianTextInputApplicationFilterValueEntries(condition);
  if (values.length === 0) {
    throw new Error(`Missing values for Zhilian cascader application filter: ${condition.fieldId}`);
  }

  const valueCandidateGroups = values.slice(0, 3).map(buildZhilianAppliedFilterValueCandidatesForEntry);
  if (await isZhilianAppliedConditionValues(page, condition.fieldId, valueCandidateGroups)) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, label);
  await clearZhilianCascaderSelection(page);
  for (const entry of values.slice(0, 3)) {
    const pathLabels = entry.pathLabels && entry.pathLabels.length > 0 ? entry.pathLabels : [entry.value];
    await clickZhilianCascaderPath(page, pathLabels, entry.value);
  }
  await clickZhilianCascaderConfirm(page);
  await assertZhilianAppliedConditionValues(page, condition.fieldId, valueCandidateGroups);
}

async function clickZhilianSalaryOption(page: Page, value: string, side: 'min' | 'max'): Promise<void> {
  const itemSelector = side === 'min'
    ? '.search-salary_list-left-item'
    : '.search-salary_list-right-item';
  const option = page.locator(`.search-salary-popover ${itemSelector}`).filter({
    hasText: new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`),
  }).first();

  try {
    await waitPlatformActionPace(page, zhilianPlatform);
    await moveMouseToLocatorCenter(option, page, 3000).catch(() => false);
    await option.click({ timeout: 3000 });
    await page.waitForTimeout(150).catch(() => undefined);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a function|unexpected argument|too many arguments/i.test(message)) {
      throw new Error(`Unable to select Zhilian salary ${side} option: ${value}. ${message}`);
    }
  }

  const clicked = await page.evaluate(({ targetValue, side }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const fallbackItemSelector = side === 'min'
      ? '.search-salary_list-left-item'
      : '.search-salary_list-right-item, .search-salary_list-item:not(.search-salary_list-left-item)';
    const items = Array.from(document.querySelectorAll(`.search-salary-popover ${fallbackItemSelector}`))
      .filter(isVisible) as HTMLElement[];
    const target = items.find((element) => compact(element.querySelector('span')?.textContent || element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    dispatchClick(target);
    return true;
  }, { targetValue: value, side });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian salary ${side} option: ${value}.`);
  }
}

async function applyZhilianExpectedSalaryApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian expected salary application filter requires { min, max } value.');
  }

  const min = normalizeApplicationFilterValue(condition.value.min);
  const max = normalizeApplicationFilterValue(condition.value.max);
  if (!min || !max) {
    throw new Error('Zhilian expected salary application filter requires non-empty min and max values.');
  }

  if (await isZhilianExpectedSalaryApplied(page, min, max)) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, '期望月薪');
  await clickZhilianSalaryOption(page, min, 'min');
  await page.waitForTimeout(150).catch(() => undefined);
  try {
    await clickZhilianSalaryOption(page, max, 'max');
  } catch {
    await openZhilianOtherFilterDropdown(page, '期望月薪');
    await clickZhilianSalaryOption(page, max, 'max');
  }
  await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
  await assertZhilianExpectedSalaryApplied(page, min, max);
}

async function applyZhilianBasicApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const rowLabels = zhilianApplicationFilterBasicLabelsByFieldId[condition.fieldId];
  if (!rowLabels) {
    throw new Error(`Unsupported Zhilian basic application filter: ${condition.fieldId}`);
  }

  const customInput = readZhilianCustomSelectRangeInput(condition);
  if (customInput) {
    if (await isZhilianBasicCustomRangeApplied(page, rowLabels, customInput)) {
      return;
    }

    await clickZhilianBasicFilterCustomRangeTrigger(page, rowLabels);
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, customInput.min, 'min');
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, customInput.max, 'max');
    await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
    await waitForZhilianApplicationFilterSettle(page);
    await assertZhilianBasicCustomRangeApplied(page, rowLabels, customInput);
    return;
  }

  if (condition.fieldKind === 'numberRange' || condition.fieldId === 'age') {
    const presetValue = buildZhilianAgePresetLabel(condition);
    if (zhilianAgePresetLabels.has(presetValue)) {
      await clickZhilianBasicFilterOption(page, rowLabels, presetValue);
      return;
    }

    const ageCustomInput = readZhilianAgeCustomSelectRangeInput(condition);
    if (await isZhilianBasicCustomRangeApplied(page, rowLabels, ageCustomInput)) {
      return;
    }

    await clickZhilianBasicFilterCustomRangeTrigger(page, rowLabels);
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, ageCustomInput.min, 'min');
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, ageCustomInput.max, 'max');
    await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
    await waitForZhilianApplicationFilterSettle(page);
    await assertZhilianBasicCustomRangeApplied(page, rowLabels, ageCustomInput);
    return;
  }

  const value = readZhilianApplicationFilterSingleValue(condition);
  await clickZhilianBasicFilterOption(page, rowLabels, value);
}

async function applyZhilianSupportedApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!zhilianSupportedApplicationFilterFieldIds.has(condition.fieldId)) {
    throw new Error(`Unsupported Zhilian application filter: ${condition.fieldId}`);
  }

  if (condition.fieldKind === 'salaryRange' || condition.fieldId === 'expected_salary') {
    await applyZhilianExpectedSalaryApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId === 'language') {
    await applyZhilianLanguageApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId in zhilianApplicationFilterCascaderLabelsByFieldId) {
    await applyZhilianCascaderApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId in zhilianApplicationFilterDropdownLabelsByFieldId) {
    await applyZhilianDropdownApplicationFilter(page, condition);
    return;
  }

  await applyZhilianBasicApplicationFilter(page, condition);
}

async function applyZhilianApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<SearchConditionApplyResult> {
  try {
    await ensureZhilianSearchConditionPanelOpen(page, createDeadline(5000), { expandMore: true });
    clearObservedZhilianCandidateApi(page);
    await applyZhilianSupportedApplicationFilter(page, condition);
    return {
      platform: 'zhilian',
      condition,
      status: 'applied',
    };
  } catch (error) {
    await closeZhilianVisibleFilterPopups(page, createDeadline(1000)).catch(async () => {
      await pressPlatformKey(page, zhilianPlatform, 'Escape').catch(() => undefined);
    });
    return {
      platform: 'zhilian',
      condition,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyZhilianSearchCondition(
  page: Page,
  condition: SearchCondition,
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: 'zhilian',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for zhilian yet.`,
    };
  }

  return applyZhilianApplicationFilter(page, condition);
}
