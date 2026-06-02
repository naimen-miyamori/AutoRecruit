import type { Locator, Page } from 'playwright';
import { clickPlatformLocator, fillPlatformLocator } from '../browser/pacing.js';
import type { SupportedPlatform } from '../platforms/types.js';

export const searchResultTotalTextPatterns = [
  /共搜出\s*([\d,]+)\+?\s*个结果/,
  /共\s*([\d,]+)\+?\s*位人选/,
  /共\s*([\d,]+)\+?\s*条/,
  /共\s*([\d,]+)\+?\s*份简历/,
];

export function normalizeInlineText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function parseSearchResultTotalFromText(text: string): number | undefined {
  const normalizedText = normalizeInlineText(text);
  for (const pattern of searchResultTotalTextPatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      return Number.parseInt(match[1].replace(/,/g, ''), 10);
    }
  }

  return undefined;
}

export async function clickFirstVisibleText(
  page: Page,
  labels: Array<string | RegExp>,
  timeoutMs = 1000,
  platform?: SupportedPlatform,
): Promise<boolean> {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: false }).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (platform) {
        await clickPlatformLocator(locator, page, platform, timeoutMs);
      } else {
        await locator.click({ timeout: timeoutMs });
      }
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function clickFirstVisibleSelector(
  page: Page,
  selectors: string[],
  timeoutMs = 1000,
  platform?: SupportedPlatform,
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (platform) {
        await clickPlatformLocator(locator, page, platform, timeoutMs);
      } else {
        await locator.click({ timeout: timeoutMs });
      }
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function clickPrimarySearchButton(page: Page, timeoutMs = 1000, platform?: SupportedPlatform): Promise<boolean> {
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
      if (platform) {
        await clickPlatformLocator(locator, page, platform, timeoutMs);
      } else {
        await locator.click({ timeout: timeoutMs });
      }
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function fillFirstVisibleInput(
  page: Page,
  value: string,
  selectors: string[],
  timeoutMs = 1000,
  platform?: SupportedPlatform,
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (platform) {
        await fillPlatformLocator(locator, page, platform, value, timeoutMs);
      } else {
        await locator.fill(value, { timeout: timeoutMs });
      }
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function fillInputNearText(
  page: Page,
  value: string,
  rowHints: Array<string | RegExp>,
  rowSelectors: string[],
  inputSelectors: string[],
  timeoutMs = 1000,
  platform?: SupportedPlatform,
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
          if (platform) {
            await fillPlatformLocator(locator, page, platform, value, timeoutMs);
          } else {
            await locator.fill(value, { timeout: timeoutMs });
          }
          return true;
        } catch {
          continue;
        }
      }
    }
  }

  return false;
}

export async function saveSearchConditionByCommonDialog(
  page: Page,
  savedSearchName: string,
  options: { platformLabel: string; timeoutMs?: number; platform?: SupportedPlatform } = { platformLabel: 'platform' },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const didOpenSaveDialog = await clickFirstVisibleText(page, ['订阅', '保存搜索条件', '保存条件', '保存搜索', '保存'], timeoutMs, options.platform);
  if (!didOpenSaveDialog) {
    throw new Error(`Search subscription on ${options.platformLabel} could not find the save search condition action.`);
  }

  const didFillSaveName = await fillFirstVisibleInput(page, savedSearchName, [
    'input[placeholder*="订阅名称"]',
    'input[placeholder*="名称"]',
    'input[placeholder*="搜索"]',
    'input[placeholder*="条件"]',
    'input[type="text"]',
  ], timeoutMs, options.platform);

  if (!didFillSaveName) {
    throw new Error(`Search subscription on ${options.platformLabel} could not fill the saved search name.`);
  }

  const didConfirm = await clickFirstVisibleText(page, ['确定', '保存', '确认'], timeoutMs, options.platform);
  if (!didConfirm) {
    throw new Error(`Search subscription on ${options.platformLabel} could not confirm saving the search condition.`);
  }
}
