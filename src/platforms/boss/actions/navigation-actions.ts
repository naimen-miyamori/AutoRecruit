import type { Page } from 'playwright';
import { config } from '../../../config.js';
import { clickBossControl, runBossAction } from './context.js';

const bossChatUrlPattern = /^https:\/\/www\.zhipin\.com\/web\/chat\/index(?:[/?#].*)?$/i;
export const bossLoginUrl = 'https://www.zhipin.com/web/user/?ka=header-login';
export const bossAuthenticatedHomeUrl = 'https://www.zhipin.com/web/user/';
export const bossChatSearchUrl = 'https://www.zhipin.com/web/chat/search';

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

export async function assertBossAuthenticated(page: Page): Promise<void> {
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

export async function openBossAuthenticatedHome(page: Page): Promise<Page> {
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
    await runBossAction(page, () => page.goto(bossAuthenticatedHomeUrl, { waitUntil: 'domcontentloaded' }));
  }

  await assertBossAuthenticated(page);
  return page;
}

export async function openBossLoginPage(page: Page): Promise<void> {
  await runBossAction(page, () => page.goto(bossLoginUrl, { waitUntil: 'domcontentloaded' }));
}

export function isBossChatPage(url: string): boolean {
  return bossChatUrlPattern.test(url);
}

export async function openBossChatPage(page: Page): Promise<Page> {
  if (!isBossChatPage(page.url())) {
    await clickBossControl(
      page.locator('a[ka="menu-im"], a[href^="/web/chat/index"]').first(),
      page,
      config.playwright.searchPageTimeoutMs,
    );
    await page.waitForURL((url) => isBossChatPage(url.toString()), {
      timeout: config.playwright.searchPageTimeoutMs,
    });
  }

  await runBossAction(page, () => page.reload({
    waitUntil: 'domcontentloaded',
    timeout: config.playwright.searchPageTimeoutMs,
  }));

  const unreadTab = page.locator('.chat-message-filter-left span').filter({ hasText: '未读' }).first();
  await unreadTab.waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  const className = await unreadTab.getAttribute('class') ?? '';
  if (!className.split(/\s+/).includes('active')) {
    await clickBossControl(unreadTab, page, config.playwright.searchPageTimeoutMs);
  }

  await page.locator('.user-list').first().waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  return page;
}
