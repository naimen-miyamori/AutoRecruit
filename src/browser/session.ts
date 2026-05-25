import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, resolveStorageStatePath } from '../config.js';
import { waitForManualLoginAndPersistSession } from './manual-login-refresh.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  temporaryUserDataDir?: string;
  closeBrowser?: boolean;
}

export const createBrowserSessionRef = { fn: createBrowserSession };
export const createFreshBrowserSessionRef = { fn: createFreshBrowserSession };
export const createPersistentBrowserSessionRef = { fn: createPersistentBrowserSession };
export const openLoginSessionRef = { fn: openLoginSession };
export const openAuthenticatedSubscribePageRef = { fn: openAuthenticatedHome };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const persistBrowserSessionRef = { fn: persistBrowserSession };
export const verifyPersistedBrowserSessionRef = { fn: verifyPersistedBrowserSession };
export const refreshExpiredLoginSessionRef = { fn: refreshExpiredLoginSession };

type SessionDiagnostics = {
  finalUrl: string;
  title: string;
  bodyPreview: string;
};

async function collectSessionDiagnostics(page: Page): Promise<SessionDiagnostics> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return {
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    bodyPreview: bodyText.slice(0, 1200),
  };
}

function formatSessionDiagnostics(diagnostics: SessionDiagnostics): string {
  return ` finalUrl=${diagnostics.finalUrl} title=${JSON.stringify(diagnostics.title)} bodyPreview=${JSON.stringify(diagnostics.bodyPreview)}`;
}

function shouldAppendExperimentalPlatformDiagnostics(platform: SupportedPlatform): boolean {
  return platform !== '51job';
}

function classifyLiepinManualLoginLanding(url: string, bodyText: string): 'login' | 'redirect' | 'unexpected' {
  const normalizedUrl = url.toLowerCase();
  const normalizedBody = bodyText.replace(/\s+/g, ' ').trim();
  const isWowRedirect = /^https:\/\/wow\.liepin\.com\/(?:[^/?#]+\/)?[^?#]+(?:\?.*)?(?:#.*)?$/.test(normalizedUrl);

  if (isWowRedirect) {
    return 'redirect';
  }

  if (
    normalizedUrl.startsWith('https://h.liepin.com/account/login')
    && (/登录|注册|获取验证码|我已有账号/.test(normalizedBody) || normalizedBody.length === 0)
  ) {
    return 'login';
  }

  return 'unexpected';
}

async function openLiepinManualLoginEntry(page: Page): Promise<void> {
  await page.goto('https://h.liepin.com/account/login', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');

  const finalUrl = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const landing = classifyLiepinManualLoginLanding(finalUrl, bodyText);

  if (landing === 'login') {
    return;
  }

  if (landing === 'redirect') {
    throw new Error(`Liepin manual login entry landed on a redirect/interstitial page instead of a usable login page: ${finalUrl}`);
  }

  throw new Error(`Liepin manual login entry landed on an unexpected page instead of a usable login page: ${finalUrl}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createBrowserContext(browser: Browser, platform: SupportedPlatform): Promise<BrowserContext> {
  const storageStatePath = resolveStorageStatePath(platform);
  const hasStorageState = await fileExists(storageStatePath);
  return browser.newContext({
    storageState: hasStorageState ? storageStatePath : undefined,
  });
}

async function createBrowserSessionWithHeadless(
  platform: SupportedPlatform,
  headless: boolean,
): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless });
  const context = await createBrowserContext(browser, platform);
  const page = await context.newPage();

  return { browser, context, page };
}

export async function createBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  return createBrowserSessionWithHeadless(platform, config.playwright.headless);
}

export async function createFreshBrowserSession(): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: config.playwright.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  return { browser, context, page };
}

export async function createPersistentBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  const temporaryUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `autorecruit-${platform}-`));
  const context = await chromium.launchPersistentContext(temporaryUserDataDir, {
    headless: config.playwright.headless,
  });
  const page = context.pages()[0] ?? await context.newPage();

  return {
    browser: context.browser() ?? context as unknown as Browser,
    context,
    page,
    temporaryUserDataDir,
    closeBrowser: false,
  };
}

export async function persistBrowserSession(session: BrowserSession, platform: SupportedPlatform): Promise<void> {
  await session.context.storageState({ path: resolveStorageStatePath(platform) });
}

export async function verifyPersistedBrowserSession(
  platform: SupportedPlatform,
  options: { headless?: boolean } = {},
): Promise<void> {
  const session = options.headless === undefined
    ? await createBrowserSessionRef.fn(platform)
    : await createBrowserSessionWithHeadless(platform, options.headless);
  const adapter = getPlatformAdapter(platform);

  try {
    await openAuthenticatedSubscribePageRef.fn(session.page, platform);
  } catch (error) {
    const diagnosticSuffix = shouldAppendExperimentalPlatformDiagnostics(platform)
      ? formatSessionDiagnostics(await collectSessionDiagnostics(session.page))
      : '';
    throw new Error(
      `Saved ${adapter.displayName} storage state could not be reused in a fresh browser session. Original error: ${error instanceof Error ? error.message : String(error)}${diagnosticSuffix}`,
    );
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

export async function openLoginSession(platform: SupportedPlatform): Promise<BrowserSession> {
  if (config.playwright.headless) {
    throw new Error('Manual login requires PLAYWRIGHT_HEADLESS=false.');
  }

  const session = await createPersistentBrowserSessionRef.fn(platform);
  if (platform === 'liepin') {
    await openLiepinManualLoginEntry(session.page);
  } else {
    await getPlatformAdapter(platform).openLoginPage(session.page);
  }
  console.log(`Browser opened for ${getPlatformAdapter(platform).displayName} manual login. Complete the login flow, then return to the terminal when you are done.`);
  return session;
}

export async function openAuthenticatedHome(page: Page, platform: SupportedPlatform): Promise<Page> {
  return getPlatformAdapter(platform).openAuthenticatedHome(page);
}

export async function ensureAuthenticatedBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  const session = await createBrowserSessionRef.fn(platform);
  const adapter = getPlatformAdapter(platform);

  try {
    await openAuthenticatedSubscribePageRef.fn(session.page, platform);
    return session;
  } catch (error) {
    const diagnosticSuffix = shouldAppendExperimentalPlatformDiagnostics(platform)
      ? formatSessionDiagnostics(await collectSessionDiagnostics(session.page))
      : '';
    await closeBrowserSessionRef.fn(session);
    if (config.playwright.headless) {
      throw new Error(
        `${adapter.displayName} login state is invalid and cannot be refreshed in headless mode. Re-run with PLAYWRIGHT_HEADLESS=false. Original error: ${error instanceof Error ? error.message : String(error)}${diagnosticSuffix}`,
      );
    }

    console.log(`${adapter.displayName} login state is invalid. Waiting for manual login refresh. Original error: ${error instanceof Error ? error.message : String(error)}${diagnosticSuffix}`);
    await refreshExpiredLoginSessionRef.fn(platform);
    return ensureAuthenticatedBrowserSession(platform);
  }
}

export async function refreshExpiredLoginSession(platform: SupportedPlatform): Promise<void> {
  await waitForManualLoginAndPersistSession(platform, {
    openLoginSession: openLoginSessionRef.fn,
    openAuthenticatedHome: openAuthenticatedSubscribePageRef.fn,
    persistBrowserSession: persistBrowserSessionRef.fn,
    verifyPersistedBrowserSession: verifyPersistedBrowserSessionRef.fn,
    closeBrowserSession: closeBrowserSessionRef.fn,
  });
}

export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  let closeError: unknown;

  try {
    await session.context.close();
  } catch (error) {
    closeError = error;
  }

  try {
    if (session.closeBrowser !== false) {
      await session.browser.close();
    }
  } catch (error) {
    closeError ??= error;
  }

  try {
    if (session.temporaryUserDataDir) {
      await fs.rm(session.temporaryUserDataDir, { recursive: true, force: true });
    }
  } catch (error) {
    closeError ??= error;
  }

  if (closeError) {
    throw closeError;
  }
}
