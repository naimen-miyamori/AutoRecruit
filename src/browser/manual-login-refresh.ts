import { config, resolveStorageStatePath } from '../config.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { Page } from 'playwright';
import type { BrowserSession } from './session.js';

type LiepinManualLoginWaitDiagnostic = {
  pageRole: 'probe' | 'context';
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

export type ManualLoginRefreshOptions = {
  keepOpen?: boolean;
};

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

function isLiepinRecruiterSearchUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:[/?#].*)?$/i.test(url);
}

function isPageClosed(page: Page): boolean {
  const closablePage = page as Partial<Pick<Page, 'isClosed'>>;
  return typeof closablePage.isClosed === 'function' && closablePage.isClosed();
}

async function hasLiepinAuthenticatedCookies(session: BrowserSession): Promise<boolean> {
  try {
    const cookies = await session.context.cookies();
    return hasLiepinAuthenticatedCookie(cookies.map((cookie) => cookie.name));
  } catch {
    return false;
  }
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
  currentProbePage: Page | null,
  deps: ManualLoginRefreshDependencies,
): Promise<{
  readyPage: Page | null;
  probePage: Page | null;
  waitDiagnostic?: LiepinManualLoginWaitDiagnostic;
}> {
  const contextPages = typeof session.context.pages === 'function' ? session.context.pages() : [session.page];
  const existingPages = contextPages.filter((page) => !isPageClosed(page));
  const hasAuthenticatedCookies = await hasLiepinAuthenticatedCookies(session);
  const loginPageInContext = existingPages.includes(session.page);
  const loginPageMissing = !loginPageInContext && isLiepinLoginPageUrl(session.page.url());
  const loginPageClosed = isPageClosed(session.page) || loginPageMissing;
  const canProbeLoginPage = !loginPageClosed && !isLiepinLoginPageUrl(session.page.url());
  let lastContextDiagnostic: LiepinManualLoginWaitDiagnostic | undefined;

  if (!hasAuthenticatedCookies) {
    if (canProbeLoginPage) {
      try {
        await deps.openAuthenticatedHome(session.page, 'liepin');
        return { readyPage: session.page, probePage: currentProbePage };
      } catch (error) {
        lastContextDiagnostic = {
          pageRole: 'context',
          page: session.page,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    for (const page of existingPages) {
      if (page === session.page || !isLiepinRecruiterSearchUrl(page.url())) {
        continue;
      }

      try {
        await deps.openAuthenticatedHome(page, 'liepin');
        return { readyPage: page, probePage: currentProbePage };
      } catch (error) {
        lastContextDiagnostic = {
          pageRole: 'context',
          page,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (loginPageClosed) {
      const newPage = typeof session.context.newPage === 'function' ? session.context.newPage.bind(session.context) : undefined;
      if (newPage) {
        const replacementLoginPage = await newPage();
        await getPlatformAdapter('liepin').openLoginPage(replacementLoginPage);
      }
    }

    return { readyPage: null, probePage: currentProbePage, waitDiagnostic: lastContextDiagnostic };
  }

  for (const page of existingPages) {
    if (page === session.page && !canProbeLoginPage) {
      continue;
    }

    if (isLiepinLoginPageUrl(page.url())) {
      continue;
    }

    try {
      await deps.openAuthenticatedHome(page, 'liepin');
      return { readyPage: page, probePage: currentProbePage };
    } catch (error) {
      lastContextDiagnostic = {
        pageRole: 'context',
        page,
        lastError: error instanceof Error ? error.message : String(error),
      };
      continue;
    }
  }

  const newPage = typeof session.context.newPage === 'function' ? session.context.newPage.bind(session.context) : undefined;
  if (!currentProbePage) {
    if (!newPage) {
      return { readyPage: null, probePage: null, waitDiagnostic: lastContextDiagnostic };
    }

    currentProbePage = await newPage();
  }

  try {
    await deps.openAuthenticatedHome(currentProbePage, 'liepin');
    return { readyPage: currentProbePage, probePage: currentProbePage };
  } catch (error) {
    return {
      readyPage: null,
      probePage: currentProbePage,
      waitDiagnostic: {
        pageRole: 'probe',
        page: currentProbePage,
        lastError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function findZhilianReadyPage(
  session: BrowserSession,
  deps: ManualLoginRefreshDependencies,
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
  const { keepOpen = false } = options;
  const session = await deps.openLoginSession(platform);
  const deadline = Date.now() + config.playwright.loginTimeoutMs;
  let liepinProbePage: Page | null = null;
  let readyPage: Page | null = null;
  let lastLiepinWaitDiagnosticMessage: string | null = null;

  try {
    console.log('Waiting for login to complete.');

    while (Date.now() < deadline) {
      try {
        if (platform === 'liepin') {
          const readyState = await findLiepinReadyPage(session, liepinProbePage, deps);
          readyPage = readyState.readyPage;
          liepinProbePage = readyState.probePage;
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
      await deps.verifyPersistedBrowserSession(platform, { headless: true });

      if (!keepOpen) {
        console.log('Authenticated page confirmed, storage state saved, and fresh-session reuse verified.');
        return;
      }

      console.log('Authenticated page confirmed, storage state saved, and fresh-session reuse verified. Browser will stay open until you press Ctrl+C.');
      await new Promise(() => {});
    }

    throw new Error('Login confirmation timed out before the authenticated page became ready. Re-run with PLAYWRIGHT_HEADLESS=false and complete the login flow.');
  } finally {
    await deps.closeBrowserSession(session);
  }
}
