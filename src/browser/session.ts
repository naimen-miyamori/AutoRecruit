import { Browser, BrowserContext, Page } from 'playwright';
import { config, resolveStorageStatePath } from '../config.js';
import { waitForManualLoginAndPersistSession } from './manual-login-refresh.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { gotoPlatformPage } from './pacing.js';
import {
  attachPlatformRuntime,
  openOrRefreshPlatformRuntimeForLogin,
  preflightPlatformRuntimeManifests,
  publishPlatformRuntimeFromLogin,
  releasePlatformRuntime,
} from './platform-runtime.js';
import type { PlatformRuntimeLease } from './platform-runtime-lease.js';
import type { PlatformBrowserRuntimeManifestV1 } from './platform-runtime-inspector.js';
import type { PlatformRuntimeAttemptV1 } from './platform-runtime-store.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  platform?: SupportedPlatform;
  runtimeGenerationId?: string;
  workPageTargetId?: string;
  runtimeLease?: PlatformRuntimeLease;
  runtimeAttempt?: PlatformRuntimeAttemptV1;
  runtimePriorManifest?: PlatformBrowserRuntimeManifestV1;
  temporaryPages?: Map<Page, {
    purpose: string;
    identity: string;
    cleanupPolicy: 'close' | 'retain-for-inspection';
  }>;
}

export const openOrRefreshPlatformRuntimeForLoginRef = { fn: openOrRefreshPlatformRuntimeForLogin };
export const openLoginSessionRef = { fn: openLoginSession };
export const openAuthenticatedSubscribePageRef = { fn: openAuthenticatedHome };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const persistBrowserSessionRef = { fn: persistBrowserSession };
export const verifyPublishedBrowserRuntimeRef = { fn: verifyPublishedBrowserRuntime };
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
  await gotoPlatformPage(page, 'liepin', 'https://h.liepin.com/account/login', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');

  const diagnostics = await collectSessionDiagnostics(page);
  const finalUrl = diagnostics.finalUrl;
  const bodyText = diagnostics.bodyPreview;
  const landing = classifyLiepinManualLoginLanding(finalUrl, bodyText);

  if (landing === 'login') {
    return;
  }

  if (landing === 'redirect') {
    throw new Error(`Liepin manual login entry landed on a redirect/interstitial page instead of a usable login page: ${finalUrl}`);
  }

  throw new Error(`Liepin manual login entry landed on an unexpected page instead of a usable login page: ${finalUrl}`);
}

export async function persistBrowserSession(session: BrowserSession, platform: SupportedPlatform): Promise<void> {
  await session.context.storageState({ path: resolveStorageStatePath(platform) });
  await publishPlatformRuntimeFromLogin(session, platform);
}

export async function verifyPublishedBrowserRuntime(
  platform: SupportedPlatform,
  _options: { headless?: boolean } = {},
): Promise<void> {
  await preflightPlatformRuntimeManifests([platform]);
}

export async function openLoginSession(platform: SupportedPlatform): Promise<BrowserSession> {
  if (config.playwright.headless) {
    throw new Error('Manual login requires PLAYWRIGHT_HEADLESS=false.');
  }

  const session = await openOrRefreshPlatformRuntimeForLoginRef.fn(platform);
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

export async function bringAuthenticatedSessionPageToFront(
  session: BrowserSession,
  platform: SupportedPlatform,
  headless = config.playwright.headless,
): Promise<void> {
  if ((platform !== 'zhilian' && platform !== 'boss') || headless) {
    return;
  }

  try {
    await session.page.bringToFront();
  } catch (error) {
    console.warn(`Could not bring ${getPlatformAdapter(platform).displayName} browser page to front; continuing without changing the run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function ensureAuthenticatedBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  const session = await attachPlatformRuntime(platform);
  await bringAuthenticatedSessionPageToFront(session, platform, false);
  return session;
}

export async function refreshExpiredLoginSession(platform: SupportedPlatform): Promise<void> {
  await waitForManualLoginAndPersistSession(platform, {
    openLoginSession: openLoginSessionRef.fn,
    openAuthenticatedHome: openAuthenticatedSubscribePageRef.fn,
    persistBrowserSession: persistBrowserSessionRef.fn,
    verifyPublishedBrowserRuntime: verifyPublishedBrowserRuntimeRef.fn,
    closeBrowserSession: closeBrowserSessionRef.fn,
  });
}

export async function closeBrowserSession(
  session: BrowserSession,
  options: { announceKeptOpen?: boolean } = {},
): Promise<void> {
  if (!session.runtimeLease) {
    throw new Error('Cannot release a browser session without a login-owned runtime lease.');
  }
  const published = session.runtimeAttempt?.state === 'completed';
  await releasePlatformRuntime(session);
  if (options.announceKeptOpen !== false) {
    console.log(published
      ? 'Login-owned browser runtime remains open for the next task.'
      : 'Unpublished login-owned browser runtime was closed before releasing its lease.');
  }
}
