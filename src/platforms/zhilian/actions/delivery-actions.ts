import type { Page } from 'playwright';
import type { CandidateListItem } from '../../../types/job.js';
import type {
  CandidatePostOpenActions,
  CandidatePostOpenResult,
  CandidateProfileDetailOptions,
} from '../../types.js';
import {
  clickPlatformLocator,
} from '../../../browser/pacing.js';
import {
  estimateZhilianCandidateDetailBudget,
  resolveZhilianDetailDeadline,
} from './context.js';
import { requireExactZhilianResumeModal } from './resume-actions.js';

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

function remainingDeliveryMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Zhilian colleague-forward action exhausted its detail deadline.');
  }
  return remaining;
}

async function clickFirstVisibleZhilianText(page: Page, pattern: RegExp, deadline: number): Promise<boolean> {
  const locator = page.getByText(pattern, { exact: false });
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible({
      timeout: Math.min(1_000, remainingDeliveryMs(deadline)),
    }).catch(() => false))) {
      continue;
    }

    await clickPlatformLocator(
      candidate,
      page,
      zhilianPlatform,
      remainingDeliveryMs(deadline),
      {
        beforeClick: async () => {
          remainingDeliveryMs(deadline);
          if (!(await candidate.isVisible().catch(() => false))) {
            throw new Error('Zhilian colleague-forward control became stale before click.');
          }
        },
      },
    );
    return true;
  }

  const firstLocator = locator.first();
  try {
    await firstLocator.waitFor({
      state: 'visible',
      timeout: Math.min(1_000, remainingDeliveryMs(deadline)),
    });
  } catch {
    return false;
  }

  await clickPlatformLocator(
    firstLocator,
    page,
    zhilianPlatform,
    remainingDeliveryMs(deadline),
    {
      beforeClick: async () => {
        remainingDeliveryMs(deadline);
        if (!(await firstLocator.isVisible().catch(() => false))) {
          throw new Error('Zhilian colleague-forward control became stale before click.');
        }
      },
    },
  );
  return true;
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
    deadline: number;
  },
): Promise<string | undefined> {
  const pollingDeadline = Math.min(options.deadline, Date.now() + 5_000);
  const intervalMs = 100;

  while (Date.now() < pollingDeadline) {
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

    await wait(Math.min(intervalMs, Math.max(1, pollingDeadline - Date.now())));
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

async function visibleLocatorCount(page: Page, selector: string, deadline: number): Promise<number> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible({
      timeout: Math.min(1_000, remainingDeliveryMs(deadline)),
    }).catch(() => false)) {
      visibleCount += 1;
    }
  }
  return visibleCount;
}

async function waitForForwardDialogClosedAndResumeRestored(page: Page, deadline: number): Promise<void> {
  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (waitForFunction) {
    await waitForFunction(
      () => {
        const isVisible = (element: Element | null): boolean => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && (rect.width > 0 || rect.height > 0);
        };
        const forwardDialogVisible = Array.from(
          document.querySelectorAll('.km-modal__wrapper.forward-resume'),
        ).some(isVisible);
        const resumeDetailVisible = Array.from(document.querySelectorAll([
          '.km-modal__wrapper.new-shortcut-resume__modal',
          '.resume-detail-wrap',
          '.new-shortcut-resume__inner',
        ].join(', '))).some(isVisible);
        return !forwardDialogVisible && resumeDetailVisible;
      },
      undefined,
      { timeout: remainingDeliveryMs(deadline), polling: 100 },
    );
    return;
  }

  const forwardDialogCount = await visibleLocatorCount(
    page,
    '.km-modal__wrapper.forward-resume',
    deadline,
  );
  const resumeDetailCount = await visibleLocatorCount(
    page,
    '.km-modal__wrapper.new-shortcut-resume__modal, .resume-detail-wrap, .new-shortcut-resume__inner',
    deadline,
  );
  if (forwardDialogCount !== 0 || resumeDetailCount === 0) {
    throw new Error('Zhilian colleague-forward dialog did not close while preserving the resume detail.');
  }
}

async function dismissZhilianColleagueForwardDialog(page: Page, deadline: number): Promise<void> {
  const forwardDialogSelector = '.km-modal__wrapper.forward-resume';
  const closeSelector = `${forwardDialogSelector} .km-modal__close-btn`;
  const visibleForwardDialogs = await visibleLocatorCount(page, forwardDialogSelector, deadline);
  if (visibleForwardDialogs === 0) {
    await waitForForwardDialogClosedAndResumeRestored(page, deadline);
    return;
  }
  if (visibleForwardDialogs !== 1) {
    throw new Error('Zhilian colleague-forward dialog is ambiguous; refusing to close it.');
  }

  const closeLocators = page.locator(closeSelector);
  const closeCount = await closeLocators.count().catch(() => 0);
  const visibleCloseLocators = [];
  for (let index = 0; index < closeCount; index += 1) {
    const locator = closeLocators.nth(index);
    if (await locator.isVisible({
      timeout: Math.min(1_000, remainingDeliveryMs(deadline)),
    }).catch(() => false)) {
      visibleCloseLocators.push(locator);
    }
  }
  if (visibleCloseLocators.length !== 1) {
    throw new Error('Zhilian colleague-forward dialog does not expose one unique safe close control.');
  }

  const closeLocator = visibleCloseLocators[0]!;
  await clickPlatformLocator(
    closeLocator,
    page,
    zhilianPlatform,
    remainingDeliveryMs(deadline),
    {
      beforeClick: async () => {
        if (await visibleLocatorCount(page, forwardDialogSelector, deadline) !== 1
          || await visibleLocatorCount(page, closeSelector, deadline) !== 1) {
          throw new Error('Zhilian colleague-forward dialog changed before its close click.');
        }
      },
    },
  );
  await waitForForwardDialogClosedAndResumeRestored(page, deadline);
}

function resolveDeliveryDetailOptions(
  options?: CandidateProfileDetailOptions,
): CandidateProfileDetailOptions {
  if (options) return options;
  const estimate = estimateZhilianCandidateDetailBudget();
  return {
    deadline: Date.now() + estimate.timeoutMs,
    cleanupReserveMs: estimate.cleanupReserveMs,
  };
}

async function copyZhilianColleagueForwardLink(
  page: Page,
  options?: CandidateProfileDetailOptions,
): Promise<string> {
  const detailOptions = resolveDeliveryDetailOptions(options);
  const actionDeadline = resolveZhilianDetailDeadline(detailOptions);
  const cleanupDeadline = resolveZhilianDetailDeadline(detailOptions, true);
  let openedForwardDialog = false;
  let copiedShareLink: string | undefined;
  let actionError: unknown;

  try {
    await installZhilianClipboardWriteInterceptor(page);
    await grantZhilianClipboardPermissions(page);
    openedForwardDialog = await clickFirstVisibleZhilianText(page, /转给同事/, actionDeadline);
    if (!openedForwardDialog) {
      throw new Error('Could not find or click the visible Zhilian "转给同事" resume action.');
    }

    const openedLinkForward = await clickFirstVisibleZhilianText(page, /链接转发/, actionDeadline);
    if (!openedLinkForward) {
      throw new Error('Could not find or click the visible Zhilian "链接转发" option.');
    }

    const visiblePageLink = await readZhilianShareLinkFromPage(page);
    if (visiblePageLink) {
      copiedShareLink = visiblePageLink;
    } else {
      const previousInterceptedClipboardLink = await readZhilianInterceptedClipboardText(page);
      const previousClipboardLink = await readZhilianShareLinkFromClipboard(page);
      const clearedClipboard = await clearZhilianClipboardBeforeCopy(page);
      const clickedCopyLink = await clickFirstVisibleZhilianText(page, /复制链接|复制/, actionDeadline);
      if (!clickedCopyLink) {
        throw new Error('Could not find or click the visible Zhilian "复制链接" action.');
      }

      copiedShareLink = await waitForFreshZhilianCopiedShareLink(page, {
        previousInterceptedClipboardLink,
        previousClipboardLink,
        clearedClipboard,
        deadline: actionDeadline,
      });
      if (!copiedShareLink) {
        throw new Error('Could not read a copied Zhilian colleague-forward link after clicking "复制链接".');
      }
    }
  } catch (error) {
    actionError = error;
  }

  let cleanupError: unknown;
  if (openedForwardDialog) {
    try {
      await dismissZhilianColleagueForwardDialog(page, cleanupDeadline);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (actionError) {
    if (cleanupError) {
      throw new Error(
        `${actionError instanceof Error ? actionError.message : String(actionError)}; `
        + `Zhilian colleague-forward cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: actionError },
      );
    }
    throw actionError;
  }
  if (cleanupError) throw cleanupError;
  if (!copiedShareLink) {
    throw new Error('Zhilian colleague-forward action completed without a share link.');
  }
  return copiedShareLink;
}

export async function collectZhilianResumeDeliveryMetadata(
  page: Page,
  candidate: CandidateListItem,
  _actions: CandidatePostOpenActions,
  options?: CandidateProfileDetailOptions,
): Promise<CandidatePostOpenResult> {
  const detailOptions = resolveDeliveryDetailOptions(options);
  const actionDeadline = resolveZhilianDetailDeadline(detailOptions);
  await requireExactZhilianResumeModal(page, candidate.candidateId, actionDeadline);
  const candidateShareUrl = await copyZhilianColleagueForwardLink(page, detailOptions);
  await requireExactZhilianResumeModal(page, candidate.candidateId, actionDeadline);
  return { candidateShareUrl };
}
