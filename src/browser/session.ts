import { spawn } from 'node:child_process';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import {
  buildContextOptions as buildCloakBrowserContextOptions,
  buildLaunchOptions as buildCloakBrowserLaunchOptions,
  launch as launchCloakBrowser,
  launchPersistentContext as launchCloakBrowserPersistentContext,
} from 'cloakbrowser';
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
  keepOpenOnExit?: boolean;
  reusableExternalBrowser?: boolean;
  reusedExistingBrowser?: boolean;
  platform?: SupportedPlatform;
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

type BrowserStorageState = Parameters<BrowserContext['setStorageState']>[0];

const platformPreferredUrlPatterns: Record<SupportedPlatform, RegExp[]> = {
  '51job': [
    /^https:\/\/ehire\.51job\.com\/Revision\/talent\/search(?:[/?#].*)?$/i,
    /^https:\/\/ehire\.51job\.com\/Revision\/talent\/subscribe(?:[/?#].*)?$/i,
    /^https:\/\/ehire\.51job\.com\//i,
  ],
  liepin: [
    /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:[/?#].*)?$/i,
    /^https:\/\/h\.liepin\.com\//i,
  ],
  zhilian: [
    /^https:\/\/rd6\.zhaopin\.com\/app\/search(?:[/?#].*)?$/i,
    /^https:\/\/(?:rd6|rd5|rd)\.zhaopin\.com\//i,
  ],
};

function resolveReusableBrowserUserDataDir(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'browser-profile');
}

function resolveReusableBrowserCdpEndpoint(platform: SupportedPlatform): string {
  return `http://127.0.0.1:${config.playwright.reuseCdpPortByPlatform[platform]}`;
}

async function waitForReusableBrowserCdpEndpoint(platform: SupportedPlatform, timeoutMs = 30000): Promise<void> {
  const endpoint = `${resolveReusableBrowserCdpEndpoint(platform)}/json/version`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the detached browser exposes the CDP endpoint.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${getPlatformAdapter(platform).displayName} reusable browser CDP endpoint: ${endpoint}`);
}

async function connectReusableBrowser(platform: SupportedPlatform): Promise<Browser | undefined> {
  try {
    return await chromium.connectOverCDP(resolveReusableBrowserCdpEndpoint(platform), { timeout: 2000 });
  } catch {
    return undefined;
  }
}

function firstUsablePage(context: BrowserContext): Page | undefined {
  return context.pages().find((page) => !page.isClosed()) ?? undefined;
}

function preferredSessionPage(platform: SupportedPlatform, context: BrowserContext): Page | undefined {
  const pages = context.pages().filter((page) => !page.isClosed());
  const preferredPatterns = platformPreferredUrlPatterns[platform];
  for (const pattern of preferredPatterns) {
    const matchedPage = pages.find((page) => pattern.test(page.url()));
    if (matchedPage) {
      return matchedPage;
    }
  }

  return pages[0];
}

async function readStorageStateIfExists(platform: SupportedPlatform): Promise<BrowserStorageState | undefined> {
  const storageStatePath = resolveStorageStatePath(platform);
  if (!(await fileExists(storageStatePath))) {
    return undefined;
  }

  return JSON.parse(await fs.readFile(storageStatePath, 'utf8')) as BrowserStorageState;
}

async function applyPersistedStorageState(context: BrowserContext, platform: SupportedPlatform): Promise<void> {
  const storageState = await readStorageStateIfExists(platform);
  if (storageState) {
    await context.setStorageState(storageState);
  }
}

async function buildReusableBrowserLaunchOptions(headless: boolean): Promise<{
  executablePath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}> {
  if (config.browser.engine === 'playwright') {
    return {
      executablePath: chromium.executablePath(),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        '--disable-sync',
        ...(headless ? ['--headless=new'] : []),
      ],
    };
  }

  const launchOptions = await buildCloakBrowserLaunchOptions({ headless });
  const executablePath = typeof launchOptions.executablePath === 'string'
    ? launchOptions.executablePath
    : undefined;
  if (!executablePath) {
    throw new Error('CloakBrowser did not resolve a Chromium executable path for the reusable browser.');
  }

  const cloakArgs = Array.isArray(launchOptions.args) ? launchOptions.args : [];
  const env = typeof launchOptions.env === 'object' && launchOptions.env
    ? { ...process.env, ...launchOptions.env as NodeJS.ProcessEnv }
    : process.env;

  return {
    executablePath,
    args: [
      ...cloakArgs,
      ...(headless ? ['--headless=new'] : []),
    ],
    env,
  };
}

async function createReusableBrowserSession(platform: SupportedPlatform, headless: boolean): Promise<BrowserSession> {
  const existingBrowser = await connectReusableBrowser(platform);
  if (existingBrowser) {
    const existingContext = existingBrowser.contexts()[0];
    if (existingContext) {
      const existingPage = preferredSessionPage(platform, existingContext) ?? await existingContext.newPage();
      return {
        browser: existingBrowser,
        context: existingContext,
        page: existingPage,
        closeBrowser: false,
        keepOpenOnExit: true,
        reusableExternalBrowser: true,
        reusedExistingBrowser: true,
        platform,
      };
    }

    await existingBrowser.close().catch(() => undefined);
  }

  const userDataDir = resolveReusableBrowserUserDataDir(platform);
  await fs.mkdir(userDataDir, { recursive: true });
  const launchOptions = await buildReusableBrowserLaunchOptions(headless);
  const browserArgs = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${config.playwright.reuseCdpPortByPlatform[platform]}`,
    '--remote-debugging-address=127.0.0.1',
    ...launchOptions.args,
    'about:blank',
  ];
  const child = spawn(launchOptions.executablePath, browserArgs, {
    detached: true,
    env: launchOptions.env ?? process.env,
    stdio: 'ignore',
  });
  child.unref();

  await waitForReusableBrowserCdpEndpoint(platform);
  const browser = await chromium.connectOverCDP(resolveReusableBrowserCdpEndpoint(platform));
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error(`${getPlatformAdapter(platform).displayName} reusable browser started without a default context.`);
  }

  if (config.browser.engine === 'cloakbrowser') {
    const cloakContextOptions = buildCloakBrowserContextOptions({});
    const viewport = cloakContextOptions.viewport ?? undefined;
    if (viewport) {
      for (const page of context.pages()) {
        await page.setViewportSize(viewport).catch(() => undefined);
      }
    }
  }

  await applyPersistedStorageState(context, platform);
  const page = preferredSessionPage(platform, context) ?? firstUsablePage(context) ?? await context.newPage();

  return {
    browser,
    context,
    page,
    closeBrowser: false,
    keepOpenOnExit: true,
    reusableExternalBrowser: true,
    reusedExistingBrowser: false,
    platform,
  };
}

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

export function shouldKeepBrowserOpenOnExit(platform: SupportedPlatform, headless = config.playwright.headless): boolean {
  return isReusableBrowserEnabled(platform, headless);
}

export function resolveBrowserHeadless(platform: SupportedPlatform, requestedHeadless = config.playwright.headless): boolean {
  return platform === 'liepin' ? false : requestedHeadless;
}

export function isReusableBrowserEnabled(platform: SupportedPlatform, headless = config.playwright.headless): boolean {
  return config.playwright.reuseBrowserByPlatform[platform] && !resolveBrowserHeadless(platform, headless);
}

export function isLiepinReusableBrowserEnabled(headless = config.playwright.headless): boolean {
  return isReusableBrowserEnabled('liepin', headless);
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
  const minDelayMs = Math.max(0, Math.floor(Math.min(config.playwright.liepinActionDelayMinMs, config.playwright.liepinActionDelayMaxMs)));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(Math.max(config.playwright.liepinActionDelayMinMs, config.playwright.liepinActionDelayMaxMs)));
  await page.waitForTimeout(minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)));
  await page.goto('https://h.liepin.com/account/login', { waitUntil: 'domcontentloaded' });
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

async function launchBrowser(headless: boolean): Promise<Browser> {
  if (config.browser.engine === 'playwright') {
    return chromium.launch({ headless });
  }

  return launchCloakBrowser({ headless });
}

async function launchPersistentBrowserContext(userDataDir: string, headless: boolean): Promise<BrowserContext> {
  if (config.browser.engine === 'playwright') {
    return chromium.launchPersistentContext(userDataDir, { headless });
  }

  return launchCloakBrowserPersistentContext({ userDataDir, headless });
}

async function createBrowserSessionWithHeadless(
  platform: SupportedPlatform,
  headless: boolean,
  options: { keepOpenOnExit?: boolean } = {},
): Promise<BrowserSession> {
  const effectiveHeadless = resolveBrowserHeadless(platform, headless);
  if (
    isReusableBrowserEnabled(platform, effectiveHeadless)
    && !effectiveHeadless
    && options.keepOpenOnExit !== false
  ) {
    return createReusableBrowserSession(platform, effectiveHeadless);
  }

  const browser = await launchBrowser(effectiveHeadless);
  const context = await createBrowserContext(browser, platform);
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    platform,
    keepOpenOnExit: options.keepOpenOnExit ?? shouldKeepBrowserOpenOnExit(platform, effectiveHeadless),
  };
}

export async function createBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  return createBrowserSessionWithHeadless(platform, config.playwright.headless);
}

export async function createFreshBrowserSession(): Promise<BrowserSession> {
  const browser = await launchBrowser(config.playwright.headless);
  const context = await browser.newContext();
  const page = await context.newPage();

  return { browser, context, page };
}

export async function createPersistentBrowserSession(platform: SupportedPlatform): Promise<BrowserSession> {
  const temporaryUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `autorecruit-${platform}-`));
  const headless = resolveBrowserHeadless(platform);
  const context = await launchPersistentBrowserContext(temporaryUserDataDir, headless);
  const page = context.pages()[0] ?? await context.newPage();

  return {
    browser: context.browser() ?? context as unknown as Browser,
    context,
    page,
    temporaryUserDataDir,
    closeBrowser: false,
    keepOpenOnExit: shouldKeepBrowserOpenOnExit(platform, headless),
    platform,
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
    : await createBrowserSessionWithHeadless(platform, options.headless, { keepOpenOnExit: false });
  session.keepOpenOnExit = false;
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
  if (resolveBrowserHeadless(platform)) {
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
  const headless = resolveBrowserHeadless(platform);

  try {
    await openAuthenticatedSubscribePageRef.fn(session.page, platform);
    return session;
  } catch (error) {
    const diagnostics = shouldAppendExperimentalPlatformDiagnostics(platform)
      ? await collectSessionDiagnostics(session.page)
      : undefined;
    const diagnosticSuffix = shouldAppendExperimentalPlatformDiagnostics(platform)
      ? formatSessionDiagnostics(diagnostics!)
      : '';
    if (headless) {
      await closeBrowserSessionRef.fn(session);
      throw new Error(
        `${adapter.displayName} login state is invalid and cannot be refreshed in headless mode. Re-run with PLAYWRIGHT_HEADLESS=false. Original error: ${error instanceof Error ? error.message : String(error)}${diagnosticSuffix}`,
      );
    }

    await closeBrowserSessionRef.fn(session);
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
  if (session.keepOpenOnExit) {
    console.log('Browser will stay open. Close it manually when finished.');
    const cleanupTemporaryUserDataDir = () => {
      if (session.temporaryUserDataDir) {
        void fs.rm(session.temporaryUserDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
    const browserEvents = session.browser as unknown as {
      isConnected?: () => boolean;
      once?: (event: string, listener: () => void) => unknown;
    };
    const contextEvents = session.context as unknown as {
      once?: (event: string, listener: () => void) => unknown;
    };

    if (typeof browserEvents.isConnected === 'function' && !browserEvents.isConnected()) {
      cleanupTemporaryUserDataDir();
      return;
    }

    if (session.reusableExternalBrowser) {
      if (session.platform) {
        await session.context.storageState({ path: resolveStorageStatePath(session.platform) }).catch(() => undefined);
      }
      await session.browser.close().catch(() => undefined);
      cleanupTemporaryUserDataDir();
      return;
    }

    browserEvents.once?.('disconnected', cleanupTemporaryUserDataDir);
    contextEvents.once?.('close', cleanupTemporaryUserDataDir);
    return;
  }

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
