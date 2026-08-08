import type { Page } from 'playwright';
import { config } from '../../../config.js';
import { assertLiepinAuthenticated } from './authentication.js';
import {
  createLiepinActionDeadline,
  remainingLiepinActionMs,
} from './context.js';
import {
  ensureLiepinRecruiterSearchPage,
  isLiepinSearchUrl,
  waitForLiepinSearchShell,
} from './navigation-actions.js';

const liepinDetailPollIntervalMs = 250;

function isLiepinResumeDetailUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/resume\/showresumedetail\//i.test(url);
}

function throwLastAggregateError(error: unknown): never {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const lastError = error.errors[error.errors.length - 1];
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  throw error instanceof Error ? error : new Error(String(error));
}

async function waitForLiepinInitialData(page: Page, deadline: number): Promise<void> {
  const waitForResponse = (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse?.bind(page);
  if (!waitForResponse) {
    return;
  }

  const response = await waitForResponse(
    (candidateResponse) => /api-h\.liepin\.com\/api\/com\.liepin\.recruitbff\.clt\.search\.get-initial-data/.test(candidateResponse.url())
      && candidateResponse.status() >= 200
      && candidateResponse.status() < 400,
    { timeout: remainingLiepinActionMs(deadline) },
  );
  if (!response) {
    throw new Error('Liepin initial-data response did not arrive before deadline.');
  }
}

async function waitForLiepinResumeDetailReady(
  page: Page,
  deadline = createLiepinActionDeadline(),
): Promise<void> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, Math.ceil(remainingLiepinActionMs(deadline) / liepinDetailPollIntervalMs));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await assertLiepinAuthenticated(page);
      return;
    } catch (error) {
      lastError = error;
    }

    const waitMs = Math.min(liepinDetailPollIntervalMs, remainingLiepinActionMs(deadline));
    if (waitMs <= 1) {
      break;
    }

    await page.waitForTimeout(waitMs).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    });
  }

  throw lastError;
}

export async function waitForLiepinPageReady(
  page: Page,
  options: { deadline?: number; timeoutMs?: number; requireSearchPage?: boolean } = {},
): Promise<void> {
  const defaultTimeoutMs = isLiepinResumeDetailUrl(page.url())
    ? config.playwright.resumeDetailTimeoutMs
    : config.playwright.searchPageTimeoutMs;
  const deadline = options.deadline ?? createLiepinActionDeadline(options.timeoutMs ?? defaultTimeoutMs);
  await page.waitForLoadState('domcontentloaded');

  if (isLiepinResumeDetailUrl(page.url())) {
    await waitForLiepinResumeDetailReady(page, deadline);
    return;
  }

  await assertLiepinAuthenticated(page);
  if (options.requireSearchPage) {
    await ensureLiepinRecruiterSearchPage(page, deadline);
  }

  if (!isLiepinSearchUrl(page.url())) {
    return;
  }

  const canWaitForShell = typeof (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction === 'function';
  const canWaitForInitialData = typeof (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse === 'function';

  if (canWaitForShell && canWaitForInitialData) {
    await Promise.any([
      waitForLiepinInitialData(page, deadline).catch(async (error) => {
        await assertLiepinAuthenticated(page);
        throw error;
      }),
      waitForLiepinSearchShell(page, deadline),
    ]).catch(async (error) => {
      await assertLiepinAuthenticated(page);
      throwLastAggregateError(error);
    });
    await assertLiepinAuthenticated(page);
    return;
  }

  if (canWaitForShell) {
    await waitForLiepinSearchShell(page, deadline);
    await assertLiepinAuthenticated(page);
    return;
  }

  if (canWaitForInitialData) {
    try {
      await waitForLiepinInitialData(page, deadline);
      await assertLiepinAuthenticated(page);
    } catch (error) {
      await assertLiepinAuthenticated(page);
      throw error;
    }
  }
}

export async function waitForLiepinExtractionReady(page: Page, deadline: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  if (isLiepinSearchUrl(page.url())) {
    await waitForLiepinSearchShell(page, deadline);
  }

  await assertLiepinAuthenticated(page);
}
