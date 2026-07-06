import type { BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import type { CandidateListItem, CandidateResume } from '../types/job.js';
import type { PlatformAdapter, SearchWaitOptions } from './types.js';

const bossLoginUrl = 'https://www.zhipin.com/web/user/?ka=header-login';
const bossAuthenticatedHomeUrl = 'https://www.zhipin.com/web/user/';
const bossChatSearchUrl = 'https://www.zhipin.com/web/chat/search';
const bossUnrestrictedJobName = '不限职位';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isBossLoginEntryUrl(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/user\/?(?:[?#].*)?$/i.test(url)
    && /(?:[?&]ka=header-login|[?#].*login)/i.test(url);
}

function isBossLoginText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /扫码登录|验证码登录|密码登录|登录\/注册|欢迎登录|手机号|获取验证码/.test(normalizedText)
    && !/职位管理|招聘管理|我的职位|账号设置/.test(normalizedText);
}

function isBossAuthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /职位管理|招聘管理|沟通|牛人|简历|直豆|我的职位|我的客服|账号设置/.test(normalizedText);
}

function hasBossAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(?:wt2|wbg|boss_login_mode|identity|zp_token)$/i.test(name));
}

async function readBossCookieNames(page: Page): Promise<string[]> {
  const cookies = await page.context().cookies('https://www.zhipin.com').catch(() => []);
  return cookies.map((cookie) => cookie.name);
}

async function readBodyText(page: Page): Promise<string> {
  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });
  return body.innerText();
}

async function assertBossAuthenticated(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  const currentUrl = page.url();
  const bodyText = await readBodyText(page).catch(() => '');
  const cookieNames = await readBossCookieNames(page);
  const hasAuthenticatedCookie = hasBossAuthenticatedCookie(cookieNames);

  if (isBossLoginText(bodyText)) {
    throw new Error('Boss authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (isBossLoginEntryUrl(currentUrl) && !hasAuthenticatedCookie) {
    throw new Error('Boss authenticated page is not available because the session is still on the login screen.');
  }

  if (hasAuthenticatedCookie && bodyText.trim().length === 0) {
    return;
  }

  if (hasAuthenticatedCookie && /^https:\/\/(?:www\.)?zhipin\.com(?:[/?#].*)?$/i.test(currentUrl)) {
    return;
  }

  if (!hasAuthenticatedCookie && !isBossAuthenticatedText(bodyText)) {
    throw new Error('Boss authenticated page is not available because the authenticated shell is not ready.');
  }
}

async function openBossAuthenticatedHome(page: Page): Promise<Page> {
  const currentUrl = page.url();
  if (isBossLoginEntryUrl(currentUrl)) {
    const bodyText = await readBodyText(page).catch(() => '');
    if (isBossLoginText(bodyText)) {
      throw new Error('Boss login is not complete yet.');
    }
    const cookieNames = await readBossCookieNames(page);
    if (!hasBossAuthenticatedCookie(cookieNames)) {
      throw new Error('Boss login is not complete yet.');
    }
  }

  if (!/^https:\/\/(?:www\.)?zhipin\.com\/web\//i.test(currentUrl)) {
    await page.goto(bossAuthenticatedHomeUrl, { waitUntil: 'domcontentloaded' });
  }

  await assertBossAuthenticated(page);
  return page;
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function isBossChatSearchUrl(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/chat\/search(?:[/?#].*)?$/i.test(url);
}

async function openBossSearchMenu(page: Page, deadline: number): Promise<void> {
  if (isBossChatSearchUrl(page.url())) {
    return;
  }

  await openBossAuthenticatedHome(page);
  if (isBossChatSearchUrl(page.url())) {
    return;
  }

  await page.locator('a[ka="menu-geek-search"], .menu-geeksearch a, .menu-geeksearch').first().click({
    timeout: remainingTime(deadline),
  });
  await page.waitForURL((url) => isBossChatSearchUrl(url.toString()), { timeout: remainingTime(deadline) });
}

async function waitForBossSearchFrame(page: Page, deadline: number) {
  await page.waitForFunction(
    () => Array.from(window.frames).some((frame) => {
      try {
        return /\/web\/frame\/search\//.test(frame.location.href);
      } catch {
        return false;
      }
    }),
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );

  const frame = page.frames().find((candidate) => /\/web\/frame\/search\//.test(candidate.url()))
    ?? page.frame({ name: 'searchFrame' });
  if (!frame) {
    throw new Error('Boss search frame did not become available.');
  }

  await frame.locator('.search-job-list-C').first().waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return frame;
}

async function readBossSelectedJob(page: Page, deadline: number): Promise<string> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return normalizeText(await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().innerText({
    timeout: remainingTime(deadline),
  }));
}

async function selectBossUnrestrictedJob(page: Page, deadline: number): Promise<void> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const currentJob = await readBossSelectedJob(page, deadline).catch(() => '');
  if (currentJob === bossUnrestrictedJobName) {
    return;
  }

  await frame.locator('.search-job-list-C .ui-dropmenu-label, .search-job-list-C .search-current-job').first().click({
    timeout: remainingTime(deadline),
  });
  await frame.locator('.search-job-list-C .ui-dropmenu-list >> text=不限职位').first().click({
    timeout: remainingTime(deadline),
  });
  await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().waitFor({
    timeout: remainingTime(deadline),
  });

  const selectedJob = await readBossSelectedJob(page, deadline);
  if (selectedJob !== bossUnrestrictedJobName) {
    throw new Error(`Boss search job selector did not switch to ${bossUnrestrictedJobName}; current value: ${selectedJob || '(empty)'}`);
  }
}

async function openBossSubscribeSearch(page: Page, _keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);

  await openBossSearchMenu(page, deadline);
  await waitForBossSearchFrame(page, deadline);
  await selectBossUnrestrictedJob(page, deadline);
  return page;
}

function bossUnsupported(feature: string): never {
  throw new Error(`Boss platform currently supports manual login/session persistence and search-page preparation only; ${feature} is not implemented yet.`);
}

export const bossAdapter: PlatformAdapter = {
  platform: 'boss',
  displayName: 'Boss',
  subscribeSearchUrl: bossChatSearchUrl,
  loginUrl: bossLoginUrl,
  storageStateFileName: 'storage-state.boss.json',
  openLoginPage: async (page) => {
    await page.goto(bossLoginUrl, { waitUntil: 'domcontentloaded' });
  },
  openAuthenticatedHome: openBossAuthenticatedHome,
  assertAuthenticated: assertBossAuthenticated,
  openSubscribeSearch: openBossSubscribeSearch,
  openDirectSearch: async () => bossUnsupported('direct search'),
  extractCandidateList: async () => bossUnsupported('candidate extraction'),
  openResumeDetail: async (_context: BrowserContext, _searchPage: Page, _candidate: CandidateListItem) => bossUnsupported('resume detail opening'),
  parseResumeDetail: async (_page: Page, _candidate: CandidateListItem): Promise<CandidateResume> => bossUnsupported('resume parsing'),
};
