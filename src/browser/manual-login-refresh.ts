import { config, resolveStorageStatePath } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { Page } from 'playwright';
import type { BrowserSession } from './session.js';

type LiepinManualLoginWaitDiagnostic = {
  pageRole: 'context';
  page: Page;
  lastError: string;
};

export type ManualLoginRefreshDependencies = {
  openLoginSession(platform: SupportedPlatform): Promise<BrowserSession>;
  openAuthenticatedHome(page: Page, platform: SupportedPlatform): Promise<Page>;
  persistBrowserSession(session: BrowserSession, platform: SupportedPlatform): Promise<void>;
  verifyPersistedBrowserSession(platform: SupportedPlatform, options?: { headless?: boolean }): Promise<void>;
  closeBrowserSession(session: BrowserSession): Promise<void>;
};

export type ExistingManualLoginRefreshDependencies = Omit<ManualLoginRefreshDependencies, 'openLoginSession' | 'closeBrowserSession'>;

export type ManualLoginRefreshOptions = {
  keepOpen?: boolean;
};

const liepinReadyTextPattern = /搜简历|找简历|招聘管理|人才管理|候选人|人才库|面试|沟通中|职位管理|招聘职位|招聘助手|人才搜索|快捷搜索|共\d+位人选/;

function getManualLoginVerificationOptions(platform: SupportedPlatform): { headless: boolean } {
  return {
    headless: platform === 'liepin' || platform === 'boss' ? false : true,
  };
}

async function focusReadyPage(session: BrowserSession, readyPage: Page | null): Promise<void> {
  if (!readyPage) {
    return;
  }

  session.page = readyPage;
  const bringToFront = (readyPage as Partial<Pick<Page, 'bringToFront'>>).bringToFront?.bind(readyPage);
  await bringToFront?.().catch(() => undefined);
}

async function waitForNextLoginPoll(session: BrowserSession): Promise<void> {
  try {
    await session.page.waitForTimeout(config.playwright.loginPollIntervalMs);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, config.playwright.loginPollIntervalMs));
  }
}

function hasLiepinAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(uniquekey|liepin_login_valid|lt_auth|_h_ld_auth_)$/i.test(name));
}

function isLiepinLoginPageUrl(url: string): boolean {
  const normalizedUrl = url.toLowerCase();
  return /account\/login/.test(normalizedUrl)
    || /^https:\/\/h\.liepin\.com\/(?:\?.*)?#login$/.test(normalizedUrl);
}

function isLiepinHardLoginPageUrl(url: string): boolean {
  return /account\/login/.test(url.toLowerCase());
}

function isLiepinRecruiterSearchUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:[/?#].*)?$/i.test(url);
}

function isPageClosed(page: Page): boolean {
  const closablePage = page as Partial<Pick<Page, 'isClosed'>>;
  return typeof closablePage.isClosed === 'function' && closablePage.isClosed();
}

async function readPageBodyText(page: Page): Promise<string> {
  const readablePage = page as Partial<Pick<Page, 'locator'>>;
  return typeof readablePage.locator === 'function'
    ? await readablePage.locator('body').innerText().catch(() => '')
    : '';
}

async function hasLiepinAuthenticatedCookies(session: BrowserSession): Promise<boolean> {
  try {
    const cookies = await session.context.cookies();
    return hasLiepinAuthenticatedCookie(cookies.map((cookie) => cookie.name));
  } catch {
    return false;
  }
}

async function isLiepinRecruiterSearchReady(page: Page, hasAuthenticatedCookies: boolean): Promise<boolean> {
  const readablePage = page as Partial<Pick<Page, 'url'>>;
  const url = typeof readablePage.url === 'function' ? readablePage.url() : '';
  if (!isLiepinRecruiterSearchUrl(url)) {
    return false;
  }

  const bodyText = await readPageBodyText(page);
  return (hasAuthenticatedCookies && bodyText.trim().length === 0)
    || liepinReadyTextPattern.test(bodyText.replace(/\s+/g, ' ').trim());
}

function hasZhilianAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(at|rt|zp-route-meta)$/i.test(name));
}

function isZhilianLoginPageUrl(url: string): boolean {
  const normalizedUrl = url.toLowerCase();
  return /passport\.zhaopin\.com\/org\/login/.test(normalizedUrl)
    || /passport\.zhaopin\.com\/login/.test(normalizedUrl);
}

async function hasZhilianAuthenticatedCookies(session: BrowserSession): Promise<boolean> {
  try {
    const cookies = await session.context.cookies();
    return hasZhilianAuthenticatedCookie(cookies.map((cookie) => cookie.name));
  } catch {
    return false;
  }
}

async function findLiepinReadyPage(
  session: BrowserSession,
  deps: ExistingManualLoginRefreshDependencies,
): Promise<{
  readyPage: Page | null;
  waitDiagnostic?: LiepinManualLoginWaitDiagnostic;
}> {
  const contextPages = typeof session.context.pages === 'function' ? session.context.pages() : [session.page];
  const existingPages = contextPages.filter((page) => !isPageClosed(page));
  const hasAuthenticatedCookies = await hasLiepinAuthenticatedCookies(session);

  for (const page of existingPages) {
    if (await isLiepinRecruiterSearchReady(page, hasAuthenticatedCookies)) {
      return { readyPage: page };
    }
  }

  if (!hasAuthenticatedCookies) {
    return { readyPage: null };
  }

  let lastWaitDiagnostic: LiepinManualLoginWaitDiagnostic | undefined;
  for (const page of existingPages) {
    const pageUrl = page.url();
    if (isLiepinHardLoginPageUrl(pageUrl)) {
      continue;
    }

    if (isLiepinRecruiterSearchUrl(pageUrl)) {
      lastWaitDiagnostic = {
        pageRole: 'context',
        page,
        lastError: 'recruiter-search page exists but is not ready',
      };
      continue;
    }

    if (!/^https?:\/\//i.test(pageUrl)) {
      lastWaitDiagnostic = {
        pageRole: 'context',
        page,
        lastError: 'authenticated cookies detected but no existing browser page can be used to enter recruiter-search',
      };
      continue;
    }

    try {
      const openedPage = await deps.openAuthenticatedHome(page, 'liepin');
      if (await isLiepinRecruiterSearchReady(openedPage, true)) {
        return { readyPage: openedPage };
      }
      lastWaitDiagnostic = {
        pageRole: 'context',
        page: openedPage,
        lastError: isLiepinRecruiterSearchUrl(openedPage.url())
          ? 'recruiter-search page exists but is not ready'
          : 'authenticated cookies detected but the authenticated page did not enter recruiter-search',
      };
    } catch (error) {
      lastWaitDiagnostic = {
        pageRole: 'context',
        page,
        lastError: `authenticated cookies detected but recruiter-search entry failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { readyPage: null, waitDiagnostic: lastWaitDiagnostic };
}

async function findZhilianReadyPage(
  session: BrowserSession,
  deps: ExistingManualLoginRefreshDependencies,
): Promise<{
  loginReady: boolean;
}> {
  const contextPages = typeof session.context.pages === 'function' ? session.context.pages() : [session.page];
  const existingPages = contextPages.filter((page) => !isPageClosed(page));
  const loginPageInContext = existingPages.includes(session.page);
  const loginPageMissing = !loginPageInContext && isZhilianLoginPageUrl(session.page.url());
  const loginPageClosed = isPageClosed(session.page) || loginPageMissing;
  const canProbeLoginPage = !loginPageClosed && !isZhilianLoginPageUrl(session.page.url());

  for (const page of existingPages) {
    if (page === session.page && !canProbeLoginPage) {
      continue;
    }

    try {
      await deps.openAuthenticatedHome(page, 'zhilian');
      return { loginReady: true };
    } catch {
      continue;
    }
  }

  return { loginReady: await hasZhilianAuthenticatedCookies(session) };
}

async function logAuthenticatedReadyPage(platform: SupportedPlatform, page: Page): Promise<void> {
  const readablePage = page as Partial<Pick<Page, 'url' | 'title'>>;
  const url = typeof readablePage.url === 'function' ? readablePage.url() : '';
  const title = typeof readablePage.title === 'function'
    ? await readablePage.title().catch(() => '')
    : '';
  console.log(
    `Authenticated page ready: url=${url} title=${JSON.stringify(title)} storageStatePath=${resolveStorageStatePath(platform)}`,
  );
}

async function formatLiepinManualLoginWaitDiagnostic(diagnostic: LiepinManualLoginWaitDiagnostic): Promise<string> {
  const readablePage = diagnostic.page as Partial<Pick<Page, 'url' | 'title' | 'locator'>>;
  const finalUrl = typeof readablePage.url === 'function' ? readablePage.url() : '';
  const title = typeof readablePage.title === 'function'
    ? await readablePage.title().catch(() => '')
    : '';
  const bodyPreview = typeof readablePage.locator === 'function'
    ? await readablePage.locator('body').innerText().then((text) => text.slice(0, 1200)).catch(() => '')
    : '';

  return `Liepin manual login is still waiting for recruiter-search readiness after authenticated cookies were detected: pageRole=${diagnostic.pageRole} finalUrl=${finalUrl} title=${JSON.stringify(title)} bodyPreview=${JSON.stringify(bodyPreview)} storageStatePath=${resolveStorageStatePath('liepin')} lastError=${JSON.stringify(diagnostic.lastError)}`;
}

export async function waitForManualLoginAndPersistSession(
  platform: SupportedPlatform,
  deps: ManualLoginRefreshDependencies,
  options: ManualLoginRefreshOptions = {},
): Promise<void> {
  const session = await deps.openLoginSession(platform);

  try {
    await waitForManualLoginAndPersistExistingSession(platform, session, deps, options);
  } finally {
    await deps.closeBrowserSession(session);
  }
}

export async function waitForManualLoginAndPersistExistingSession(
  platform: SupportedPlatform,
  session: BrowserSession,
  deps: ExistingManualLoginRefreshDependencies,
  options: ManualLoginRefreshOptions = {},
): Promise<void> {
  const { keepOpen = false } = options;
  let deadline = Date.now() + config.playwright.loginTimeoutMs;
  let readyPage: Page | null = null;
  let lastLiepinWaitDiagnosticMessage: string | null = null;

  console.log('Waiting for login to complete.');

  while (Date.now() < deadline) {
    try {
      if (platform === 'liepin') {
        const readyState = await findLiepinReadyPage(session, deps);
        readyPage = readyState.readyPage;
        if (!readyPage && readyState.waitDiagnostic) {
          const message = await formatLiepinManualLoginWaitDiagnostic(readyState.waitDiagnostic);
          if (message !== lastLiepinWaitDiagnosticMessage) {
            console.error(message);
            lastLiepinWaitDiagnosticMessage = message;
          }
        }
        if (!readyPage) {
          throw new Error('login not ready');
        }
        lastLiepinWaitDiagnosticMessage = null;
      } else if (platform === 'zhilian') {
        const readyState = await findZhilianReadyPage(session, deps);
        if (!readyState.loginReady) {
          throw new Error('login not ready');
        }
        readyPage = null;
      } else {
        readyPage = await deps.openAuthenticatedHome(session.page, platform);
      }
    } catch {
      await waitForNextLoginPoll(session);
      continue;
    }

    if (readyPage) {
      await logAuthenticatedReadyPage(platform, readyPage);
    }
    await deps.persistBrowserSession(session, platform);
    if (platform !== 'liepin') {
      await deps.verifyPersistedBrowserSession(platform, getManualLoginVerificationOptions(platform));
    }
    await focusReadyPage(session, readyPage);

    const successMessage = platform === 'liepin'
      ? 'Authenticated page confirmed and storage state saved.'
      : 'Authenticated page confirmed, storage state saved, and fresh-session reuse verified.';

    if (!keepOpen) {
      console.log(successMessage);
      return;
    }

    console.log(`${successMessage} Browser will stay open until you press Ctrl+C.`);
    await new Promise(() => {});
  }

  throw new Error('Login confirmation timed out before the authenticated page became ready. Re-run with PLAYWRIGHT_HEADLESS=false and complete the login flow.');
}
