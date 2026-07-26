import type { Page } from 'playwright';
import {
  clickPlatformLocator,
  waitPlatformActionPace,
} from '../../../browser/pacing.js';

const zhilianPlatform = 'zhilian';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function scoreZhilianShareUrl(url: string): number {
  if (/^https:\/\/m\.zhaopin\.com\/b\/resume-package\?/i.test(url) && /[?&]zhaopinToken=/i.test(url)) {
    return 100;
  }

  if (/^https:\/\/[^/]*zhaopin\.com\/[^?#]*linkforward\/resume(?:[/?#].*)?$/i.test(url)) {
    return 80;
  }

  return 0;
}

function extractSafeZhilianShareUrls(value: string | null | undefined): string[] {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return [];
  }

  const explicitUrls = normalizedValue.match(/https:\/\/[^/\s"'<>]*zhaopin\.com\/[^\s"'<>]*/gi) ?? [normalizedValue];
  return explicitUrls
    .map((url) => url.replace(/[),，。]+$/g, ''))
    .filter((url) => scoreZhilianShareUrl(url) > 0);
}

function selectBestZhilianShareUrl(values: Array<string | null | undefined>): string | undefined {
  const candidates = values.flatMap((value) => extractSafeZhilianShareUrls(value));
  candidates.sort((left, right) => scoreZhilianShareUrl(right) - scoreZhilianShareUrl(left));
  return candidates[0];
}

function extractSafeZhilianShareUrl(value: string | null | undefined): string | undefined {
  return selectBestZhilianShareUrl([value]);
}

async function clickFirstVisibleZhilianText(page: Page, pattern: RegExp, timeout = 3000): Promise<boolean> {
  const locator = page.getByText(pattern, { exact: false });
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible({ timeout }).catch(() => false))) {
        continue;
      }

      await clickPlatformLocator(candidate, page, zhilianPlatform, timeout);
      return true;
    } catch {
      continue;
    }
  }

  try {
    const firstLocator = locator.first();
    await firstLocator.waitFor({ state: 'visible', timeout });
    await clickPlatformLocator(firstLocator, page, zhilianPlatform, timeout);
    return true;
  } catch {
    return false;
  }
}

async function readZhilianShareLinkFromPage(page: Page): Promise<string | undefined> {
  const linkSelector = [
    'input',
    'textarea',
    '[contenteditable="true"]',
    'a[href*="zhaopin.com"]',
    '[data-clipboard-text]',
    '[data-clipboard]',
    '[data-copy]',
    '[data-url]',
    '[title*="zhaopin.com"]',
  ].join(', ');

  try {
    const values = await page.locator(linkSelector).evaluateAll((elements) => elements.flatMap((element) => {
      if (element instanceof HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const isHidden = style.display === 'none'
          || style.visibility === 'hidden'
          || style.opacity === '0'
          || (rect.width === 0 && rect.height === 0);
        if (isHidden) {
          return [];
        }
      }

      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const anchor = element as HTMLAnchorElement;
      return [
        input.value,
        anchor.href,
        element.getAttribute('href'),
        element.getAttribute('data-clipboard-text'),
        element.getAttribute('data-clipboard'),
        element.getAttribute('data-copy'),
        element.getAttribute('data-url'),
        element.getAttribute('title'),
        element.textContent,
      ];
    }));

    return selectBestZhilianShareUrl(values);
  } catch {
    return undefined;
  }
}

async function installZhilianClipboardWriteInterceptor(page: Page): Promise<void> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return;
  }

  try {
    await evaluate(() => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
        __autorecruitZhilianClipboardInstalled?: boolean;
        __autorecruitZhilianOriginalClipboardWriteText?: (value: string) => Promise<void>;
      };
      if (windowWithShareClipboard.__autorecruitZhilianClipboardInstalled) {
        windowWithShareClipboard.__autorecruitZhilianCopiedText = '';
        return;
      }

      windowWithShareClipboard.__autorecruitZhilianClipboardInstalled = true;
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';

      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard && 'writeText' in clipboard) {
        windowWithShareClipboard.__autorecruitZhilianOriginalClipboardWriteText = clipboard.writeText.bind(clipboard);
        Object.defineProperty(clipboard, 'writeText', {
          configurable: true,
          value: async (value: string) => {
            windowWithShareClipboard.__autorecruitZhilianCopiedText = String(value ?? '');
            return undefined;
          },
        });
      }

      document.addEventListener('copy', (event) => {
        const selectedText = window.getSelection()?.toString() ?? '';
        if (selectedText) {
          windowWithShareClipboard.__autorecruitZhilianCopiedText = selectedText;
        }
        event.clipboardData?.setData('text/plain', selectedText);
        event.preventDefault();
      }, true);
    });
  } catch {
    // If script patching is blocked, DOM and permission-granted clipboard fallbacks still apply.
  }
}

async function clearZhilianClipboardBeforeCopy(page: Page): Promise<boolean> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return false;
  }

  try {
    return Boolean(await evaluate(async () => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
        __autorecruitZhilianOriginalClipboardWriteText?: (value: string) => Promise<void>;
      };
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';

      const writeText = windowWithShareClipboard.__autorecruitZhilianOriginalClipboardWriteText
        ?? navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (!writeText) {
        return false;
      }

      await writeText('');
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';
      return true;
    }));
  } catch {
    return false;
  }
}

async function readZhilianInterceptedClipboardText(page: Page): Promise<string | undefined> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return undefined;
  }

  try {
    const copiedText = await evaluate(() => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
      };
      return windowWithShareClipboard.__autorecruitZhilianCopiedText ?? '';
    });
    return extractSafeZhilianShareUrl(String(copiedText));
  } catch {
    return undefined;
  }
}

async function readZhilianShareLinkFromClipboard(page: Page): Promise<string | undefined> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return undefined;
  }

  try {
    const clipboardText = await evaluate(async () => navigator.clipboard?.readText?.() ?? '');
    return extractSafeZhilianShareUrl(String(clipboardText));
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFreshZhilianCopiedShareLink(
  page: Page,
  options: {
    previousInterceptedClipboardLink?: string;
    previousClipboardLink?: string;
    clearedClipboard: boolean;
  },
): Promise<string | undefined> {
  const timeoutMs = 1500;
  const intervalMs = 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const interceptedClipboardLink = await readZhilianInterceptedClipboardText(page);
    if (
      interceptedClipboardLink
      && interceptedClipboardLink !== options.previousInterceptedClipboardLink
    ) {
      return interceptedClipboardLink;
    }

    const clipboardLink = await readZhilianShareLinkFromClipboard(page);
    if (
      clipboardLink
      && (options.clearedClipboard || clipboardLink !== options.previousClipboardLink)
    ) {
      return clipboardLink;
    }

    const pageLink = await readZhilianShareLinkFromPage(page);
    if (pageLink) {
      return pageLink;
    }

    await wait(intervalMs);
  }

  return undefined;
}

async function grantZhilianClipboardPermissions(page: Page): Promise<void> {
  const context = (page as Partial<Pick<Page, 'context'>>).context?.();
  const grantPermissions = (context as Partial<{
    grantPermissions: (permissions: string[], options?: { origin?: string }) => Promise<void>;
  }> | undefined)?.grantPermissions?.bind(context);
  if (!grantPermissions) {
    return;
  }

  try {
    await grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
  } catch {
    // Fall back to visible link controls. Some browser contexts do not support clipboard grants.
  }
}

async function dismissZhilianColleagueForwardDialog(page: Page): Promise<void> {
  const keyboard = (page as { keyboard?: { press?: (key: string) => Promise<void> } }).keyboard;
  if (!keyboard?.press) {
    return;
  }

  try {
    await waitPlatformActionPace(page, zhilianPlatform);
    await keyboard.press('Escape');
  } catch {
    // Best effort only. Resume parsing should not fail because the share dialog cannot be dismissed.
  }
}

export async function copyZhilianColleagueForwardLink(page: Page): Promise<string | undefined> {
  const openedForwardDialog = await clickFirstVisibleZhilianText(page, /转给同事/);
  if (!openedForwardDialog) {
    throw new Error('Could not find or click the visible Zhilian "转给同事" resume action.');
  }

  try {
    const openedLinkForward = await clickFirstVisibleZhilianText(page, /链接转发/);
    if (!openedLinkForward) {
      throw new Error('Could not find or click the visible Zhilian "链接转发" option.');
    }

    const visiblePageLink = await readZhilianShareLinkFromPage(page);
    if (visiblePageLink) {
      return visiblePageLink;
    }

    const previousInterceptedClipboardLink = await readZhilianInterceptedClipboardText(page);
    await installZhilianClipboardWriteInterceptor(page);
    await grantZhilianClipboardPermissions(page);
    const previousClipboardLink = await readZhilianShareLinkFromClipboard(page);
    const clearedClipboard = await clearZhilianClipboardBeforeCopy(page);
    const clickedCopyLink = await clickFirstVisibleZhilianText(page, /复制链接|复制/);
    if (!clickedCopyLink) {
      throw new Error('Could not find or click the visible Zhilian "复制链接" action.');
    }

    const copiedShareLink = await waitForFreshZhilianCopiedShareLink(page, {
      previousInterceptedClipboardLink,
      previousClipboardLink,
      clearedClipboard,
    });
    if (!copiedShareLink) {
      throw new Error('Could not read a copied Zhilian colleague-forward link after clicking "复制链接".');
    }

    return copiedShareLink;
  } finally {
    await dismissZhilianColleagueForwardDialog(page);
  }
}
