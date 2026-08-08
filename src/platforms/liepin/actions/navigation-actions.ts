import type { Locator, Page } from 'playwright';
import {
  createLiepinSearchDeadline,
  clickLiepinLocator,
  remainingLiepinActionMs,
  waitLiepinActionPace,
} from './context.js';
import { assertLiepinAuthenticated } from './authentication.js';

export { assertLiepinAuthenticated } from './authentication.js';

export const liepinLoginUrl = 'https://h.liepin.com/account/login';
export const liepinAuthenticatedUrl = 'https://h.liepin.com/search/getConditionItem';

export function isLiepinSearchUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:[/?#].*)?$/i.test(url);
}

function isLiepinHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isAbortNavigationError(error: unknown): boolean {
  return error instanceof Error && /net::ERR_ABORTED|Navigation aborted|frame was detached/i.test(error.message);
}

async function clickLiepinFindTalentEntry(page: Page, deadline: number): Promise<boolean> {
  const getByText = (page as Partial<Pick<Page, 'getByText'>>).getByText?.bind(page);
  if (!getByText) {
    return false;
  }

  const findTalent = getByText(/^\s*找人\s*$/).first();
  const isVisible = (findTalent as Partial<Pick<Locator, 'isVisible'>>).isVisible?.bind(findTalent);
  const visible = isVisible
    ? await isVisible({ timeout: Math.min(remainingLiepinActionMs(deadline), 1000) }).catch(() => false)
    : await findTalent.waitFor({ state: 'visible', timeout: Math.min(remainingLiepinActionMs(deadline), 1000) })
      .then(() => true)
      .catch(() => false);
  if (!visible) {
    return false;
  }

  await clickLiepinLocator(findTalent, page, Math.min(remainingLiepinActionMs(deadline), 5000));
  return true;
}

async function openLiepinSearchFromAuthenticatedHome(page: Page, deadline: number): Promise<boolean> {
  if (isLiepinSearchUrl(page.url())) {
    return true;
  }

  const clicked = await clickLiepinFindTalentEntry(page, deadline);
  if (!clicked) {
    return false;
  }

  const waitForUrl = (page as Partial<Pick<Page, 'waitForURL'>>).waitForURL?.bind(page);
  await waitForUrl?.(
    (url) => isLiepinSearchUrl(url.toString()),
    { timeout: remainingLiepinActionMs(deadline) },
  ).catch(() => undefined);
  return isLiepinSearchUrl(page.url());
}

export async function openLiepinRecruiterSearchPage(page: Page, deadline: number): Promise<void> {
  if (isLiepinSearchUrl(page.url())) {
    return;
  }

  if (isLiepinHttpUrl(page.url())) {
    await assertLiepinAuthenticated(page);
    if (await openLiepinSearchFromAuthenticatedHome(page, deadline)) {
      return;
    }
  }

  try {
    await waitLiepinActionPace(page);
    await page.goto(liepinAuthenticatedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: remainingLiepinActionMs(deadline),
    });
  } catch (error) {
    if (!isAbortNavigationError(error) || !isLiepinSearchUrl(page.url())) {
      throw error;
    }
  }

  if (!isLiepinSearchUrl(page.url())) {
    throw new Error('Liepin recruiter-search navigation did not reach the expected search page.');
  }
  await assertLiepinAuthenticated(page);
}

export async function ensureLiepinRecruiterSearchPage(page: Page, deadline: number): Promise<void> {
  await assertLiepinAuthenticated(page);
  if (!(await openLiepinSearchFromAuthenticatedHome(page, deadline))) {
    throw new Error('Liepin authenticated page is available, but recruiter-search was not reached from the current page.');
  }
}

export async function waitForLiepinSearchShell(page: Page, deadline: number): Promise<void> {
  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (!waitForFunction) {
    return;
  }

  await waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const hasSearchText = /搜索条件|人才搜索|快捷搜索|共\d+位人选|搜简历|找简历|人才管理/.test(bodyText);
      return hasSearchText && bodyText.trim().length > 0;
    },
    undefined,
    { timeout: remainingLiepinActionMs(deadline), polling: 250 },
  );
}

export async function openLiepinLoginPage(page: Page): Promise<void> {
  await waitLiepinActionPace(page);
  await page.goto(liepinLoginUrl, { waitUntil: 'domcontentloaded' });
}

export async function openLiepinAuthenticatedHome(page: Page): Promise<Page> {
  const deadline = createLiepinSearchDeadline();
  await openLiepinRecruiterSearchPage(page, deadline);
  await assertLiepinAuthenticated(page);
  await waitForLiepinSearchShell(page, deadline);
  return page;
}
