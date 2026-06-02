import type { Locator, Page } from 'playwright';
import {
  clickPlatformLocator,
  waitPlatformActionPace,
} from '../browser/pacing.js';
import {
  buildSearchFilterDiscoveryStats,
  type SearchFilterCatalog,
  type SearchFilterDefinition,
  type SearchFilterOption,
} from '../search/filter-catalog.js';

const liepinPlatform = 'liepin';

export type LiepinIndustryFieldId = 'engaged_industry' | 'expected_industry';

export interface LiepinIndustryRootSnapshot {
  label: string;
  children: string[];
}

export interface LiepinIndustryFieldSnapshot {
  fieldId: LiepinIndustryFieldId;
  label: string;
  roots: LiepinIndustryRootSnapshot[];
  filter: SearchFilterDefinition;
}

export interface LiepinIndustryTreeDiscovery {
  platform: 'liepin';
  capturedAt: string;
  pageUrl: string;
  fields: LiepinIndustryFieldSnapshot[];
}

const liepinIndustryLabelByFieldId: Record<LiepinIndustryFieldId, string> = {
  engaged_industry: '当前行业',
  expected_industry: '期望行业',
};

function normalizeLiepinIndustryText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createLiepinIndustryFilterKey(label: string): string {
  return `liepin-${label.replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '')}-filter`;
}

function createExactTextPattern(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`);
}

function toIndustryOption(rootLabel: string, childLabel: string): SearchFilterOption {
  return {
    label: childLabel,
    value: childLabel,
    depth: 1,
    parentPathLabels: [rootLabel],
    pathLabels: [rootLabel, childLabel],
  };
}

export function buildLiepinIndustryFilterDefinition(
  label: string,
  roots: readonly LiepinIndustryRootSnapshot[],
): SearchFilterDefinition {
  const options: SearchFilterOption[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const rootLabel = normalizeLiepinIndustryText(root.label);
    if (!rootLabel) {
      continue;
    }

    for (const child of root.children) {
      const childLabel = normalizeLiepinIndustryText(child);
      if (!childLabel) {
        continue;
      }

      const key = `${rootLabel}\u0000${childLabel}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      options.push(toIndustryOption(rootLabel, childLabel));
    }
  }

  return {
    key: createLiepinIndustryFilterKey(label),
    label,
    controlType: 'textInput',
    valueShape: 'string',
    status: options.length > 0 ? 'optionsExtracted' : 'noOptions',
    childrenLazy: false,
    inputPlaceholder: label,
    selectorHints: [
      { kind: 'text', value: label },
      { kind: 'cssPath', value: '.antd-fd-industry-modal' },
    ],
    options,
  };
}

export function mergeLiepinIndustryFiltersIntoCatalog(
  catalog: SearchFilterCatalog,
  industryFilters: readonly SearchFilterDefinition[],
  capturedAt = new Date().toISOString(),
  pageUrl = catalog.pageUrl,
): SearchFilterCatalog {
  const industryLabels = new Set(industryFilters.map((filter) => filter.label));
  const filters = [
    ...catalog.filters.filter((filter) => !industryLabels.has(filter.label)),
    ...industryFilters,
  ];

  return {
    ...catalog,
    capturedAt,
    pageUrl,
    filters,
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}

async function clickLiepinScopedExactText(
  scope: Locator,
  page: Page,
  selector: string,
  value: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const candidates = scope.locator(selector, { hasText: createExactTextPattern(value) });
  const count = await candidates.count().catch(() => 0);

  for (let index = 0; index < Math.max(count, 1); index += 1) {
    const candidate = count > 0 ? candidates.nth(index) : candidates.first();
    if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    const candidateText = normalizeLiepinIndustryText(await candidate.innerText({ timeout: timeoutMs }).catch(() => ''));
    if (candidateText && candidateText !== value) {
      continue;
    }

    await clickPlatformLocator(candidate, page, liepinPlatform, timeoutMs);
    await waitPlatformActionPace(page, liepinPlatform);
    return true;
  }

  return false;
}

async function clickLiepinLocatorForceFallback(locator: Locator, page: Page, timeoutMs = 3000): Promise<boolean> {
  if (!(await locator.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  try {
    await clickPlatformLocator(locator, page, liepinPlatform, timeoutMs);
    await waitPlatformActionPace(page, liepinPlatform);
    return true;
  } catch {
    await locator.click({ timeout: timeoutMs, force: true }).catch(async () => {
      const box = await locator.boundingBox().catch(() => null);
      if (!box) {
        return;
      }
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await waitPlatformActionPace(page, liepinPlatform);
    return true;
  }
}

async function dispatchLiepinIndustryTriggerEvents(locator: Locator, page: Page): Promise<void> {
  await locator.evaluate((element) => {
    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };
    const targets = [
      element,
      element.closest('.antd-fd-industry-input-icon-wrapper'),
      element.closest('.ant-select-selector'),
      element.closest('.antd-fd-industry'),
      element.closest('.ant-select'),
    ].filter((item): item is Element => Boolean(item));

    for (const target of targets) {
      target.dispatchEvent(new MouseEvent('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));
      if (target instanceof HTMLElement) {
        target.click();
      }
    }
  }).catch(() => undefined);
  await waitPlatformActionPace(page, liepinPlatform);
}

async function clickLiepinIndustryRoot(modal: Locator, page: Page, rootLabel: string): Promise<void> {
  const clicked = await clickLiepinScopedExactText(
    modal,
    page,
    '.antd-fd-industry-sider .ant-menu-item',
    rootLabel,
  );
  if (!clicked) {
    throw new Error(`Unable to click Liepin industry root ${rootLabel}.`);
  }
}

export async function clickLiepinIndustryPath(
  modal: Locator,
  page: Page,
  pathLabels: readonly string[],
  fallbackValue: string,
): Promise<void> {
  const normalizedPathLabels = pathLabels.map(normalizeLiepinIndustryText).filter(Boolean);
  if (normalizedPathLabels.length >= 2) {
    const rootLabel = normalizedPathLabels[0] ?? '';
    const childLabel = normalizedPathLabels.at(-1) ?? '';
    await clickLiepinIndustryRoot(modal, page, rootLabel);
    const clickedChild = await clickLiepinScopedExactText(
      modal,
      page,
      [
        '.antd-fd-industry-content-wrapper-node .antd-fd-industry-content-third-level-item',
        '.antd-fd-industry-content-wrapper-node .ant-tag',
      ].join(', '),
      childLabel,
    );
    if (!clickedChild) {
      throw new Error(`Unable to click Liepin industry child ${normalizedPathLabels.join(' > ')}.`);
    }
    return;
  }

  const normalizedValue = normalizeLiepinIndustryText(fallbackValue);
  if (!normalizedValue) {
    throw new Error('Missing Liepin industry value.');
  }

  const clickedContent = await clickLiepinScopedExactText(
    modal,
    page,
    [
      '.antd-fd-industry-content-wrapper-node .antd-fd-industry-content-third-level-item',
      '.antd-fd-industry-content-wrapper-node .ant-tag',
    ].join(', '),
    normalizedValue,
  );
  if (clickedContent) {
    return;
  }

  const clickedAnywhere = await clickLiepinScopedExactText(
    modal,
    page,
    '.ant-tag, .ant-menu-item, span, div, li',
    normalizedValue,
  );
  if (!clickedAnywhere) {
    throw new Error(`Unable to click Liepin industry option ${normalizedValue}.`);
  }
}

export async function openLiepinIndustryModalByLabel(page: Page, label: string): Promise<Locator> {
  const row = page.locator('.search-item.sfilter-industry, .search-item', { hasText: new RegExp(escapeRegExp(label)) }).first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await row.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }).catch(() => undefined);
  await row.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
  await row.hover({ timeout: 2000 }).catch(() => undefined);

  const triggerSelectors = [
    '.antd-fd-industry-input-icon-wrapper',
    '.ant-select-selector',
    '.ant-select-selection-search-input',
    '.ant-select',
    '.antd-fd-industry',
    'input[role="combobox"]',
    'svg',
  ];
  for (const selector of triggerSelectors) {
    const trigger = row.locator(selector).first();
    if (!(await trigger.isVisible({ timeout: 800 }).catch(() => false))) {
      continue;
    }

    await trigger.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }).catch(() => undefined);
    await clickLiepinLocatorForceFallback(trigger, page, 3000);

    const visibleModal = await findVisibleLiepinIndustryModal(page, 3000);
    if (visibleModal) {
      return visibleModal;
    }

    await dispatchLiepinIndustryTriggerEvents(trigger, page);
    const eventOpenedModal = await findVisibleLiepinIndustryModal(page, 3000);
    if (eventOpenedModal) {
      return eventOpenedModal;
    }
  }

  const forceTrigger = row.locator('.ant-select-selector, .antd-fd-industry, input[role="combobox"]').first();
  if (await clickLiepinLocatorForceFallback(forceTrigger, page, 3000)) {
    const visibleModal = await findVisibleLiepinIndustryModal(page, 3000);
    if (visibleModal) {
      return visibleModal;
    }
  }

  const icon = row.locator('.antd-fd-industry-input-icon-wrapper').first();
  const iconBox = await icon.boundingBox().catch(() => null);
  if (iconBox) {
    await page.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2);
    await waitPlatformActionPace(page, liepinPlatform);
  }

  const modal = await findVisibleLiepinIndustryModal(page, 5000);
  if (!modal) {
    throw new Error(`Unable to open Liepin industry modal for ${label}.`);
  }

  return modal;
}

async function findVisibleLiepinIndustryModal(page: Page, timeoutMs: number): Promise<Locator | undefined> {
  const modalCandidates = [
    page.locator('.antd-fd-industry-modal', { hasText: /请选择行业/ }).first(),
    page.locator('.ant-modal-wrap, .ant-modal, [role="dialog"]', { hasText: /请选择行业/ }).filter({ hasText: /请选择行业/ }).first(),
    page.locator('.antd-fd-industry-modal').first(),
  ];

  for (const modal of modalCandidates) {
    if (await modal.isVisible({ timeout: timeoutMs }).catch(() => false)) {
      return modal;
    }
  }

  return undefined;
}

async function closeLiepinIndustryModal(page: Page, modal: Locator): Promise<void> {
  const closeButton = modal.locator('.antd-fd-industry-modal-close, .ant-modal-close').first();
  if (await closeButton.isVisible({ timeout: 800 }).catch(() => false)) {
    await clickPlatformLocator(closeButton, page, liepinPlatform, 2000).catch(() => undefined);
  } else {
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  await waitPlatformActionPace(page, liepinPlatform);
}

async function readLiepinIndustryRootLabels(modal: Locator): Promise<string[]> {
  return modal.evaluate((element) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (item: Element): boolean => {
      if (!(item instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(item);
      const rect = item.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const values: string[] = [];
    const seen = new Set<string>();
    for (const item of Array.from(element.querySelectorAll('.antd-fd-industry-sider .ant-menu-item'))) {
      if (!isVisible(item)) {
        continue;
      }

      const label = normalize((item as HTMLElement).innerText || item.textContent);
      if (!label || seen.has(label)) {
        continue;
      }

      seen.add(label);
      values.push(label);
    }

    return values;
  });
}

async function readLiepinIndustryChildLabels(modal: Locator): Promise<string[]> {
  return modal.evaluate((element) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (item: Element): boolean => {
      if (!(item instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(item);
      const rect = item.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const labels: string[] = [];
    const seen = new Set<string>();
    const selectors = [
      '.antd-fd-industry-content-wrapper-node .antd-fd-industry-content-top-level-name-wrapper .ant-tag',
      '.antd-fd-industry-content-wrapper-node .antd-fd-industry-content-third-level-item',
    ].join(', ');

    for (const item of Array.from(element.querySelectorAll(selectors))) {
      if (!isVisible(item)) {
        continue;
      }

      const label = normalize((item as HTMLElement).innerText || item.textContent);
      if (!label || /^已选|^确认$|^请选择行业$|^意见反馈$/.test(label) || seen.has(label)) {
        continue;
      }

      seen.add(label);
      labels.push(label);
    }

    return labels;
  });
}

async function discoverLiepinIndustryField(
  page: Page,
  fieldId: LiepinIndustryFieldId,
): Promise<LiepinIndustryFieldSnapshot> {
  const label = liepinIndustryLabelByFieldId[fieldId];
  const modal = await openLiepinIndustryModalByLabel(page, label);

  try {
    const rootLabels = await readLiepinIndustryRootLabels(modal);
    const roots: LiepinIndustryRootSnapshot[] = [];

    for (const rootLabel of rootLabels) {
      await clickLiepinIndustryRoot(modal, page, rootLabel);
      roots.push({
        label: rootLabel,
        children: await readLiepinIndustryChildLabels(modal),
      });
    }

    return {
      fieldId,
      label,
      roots,
      filter: buildLiepinIndustryFilterDefinition(label, roots),
    };
  } finally {
    await closeLiepinIndustryModal(page, modal).catch(() => undefined);
  }
}

export async function discoverLiepinIndustryTree(
  page: Page,
  fieldIds: readonly LiepinIndustryFieldId[] = ['engaged_industry', 'expected_industry'],
): Promise<LiepinIndustryTreeDiscovery> {
  const fields: LiepinIndustryFieldSnapshot[] = [];
  for (const fieldId of fieldIds) {
    fields.push(await discoverLiepinIndustryField(page, fieldId));
  }

  return {
    platform: 'liepin',
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    fields,
  };
}
