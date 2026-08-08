import type { Page } from 'playwright';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isLiepinAuthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /搜简历|找简历|招聘管理|人才管理|候选人|人才库|面试|沟通中|职位管理|招聘职位|招聘助手|搜索条件|人才搜索|快捷搜索|共\d+位人选/.test(normalizedText);
}

function isLiepinAuthenticatedResumeDetailText(text: string): boolean {
  const normalizedText = normalizeText(text);
  const hasResumeIdentity = /中文简历|英文简历|简历编号[:：]|最后一次登录时间/.test(normalizedText);
  const hasResumeSections = /求职意向|工作经历|教育经历|项目经历|项目经验|个人优势/.test(normalizedText);
  return hasResumeIdentity && hasResumeSections;
}

function isLiepinUnauthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return normalizedText.includes('登录/注册')
    || /扫码登录|密码登录|立即登录|注册登录|登录即代表/.test(normalizedText);
}

function isLiepinLoginPageUrl(url: string): boolean {
  const normalizedUrl = url.toLowerCase();
  return /account\/login/.test(normalizedUrl)
    || /^https:\/\/h\.liepin\.com\/(?:\?.*)?#login$/.test(normalizedUrl);
}

function hasLiepinAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(uniquekey|liepin_login_valid|lt_auth|_h_ld_auth_)$/i.test(name));
}

async function readLiepinCookieNames(page: Page): Promise<string[]> {
  const context = (page as Partial<Pick<Page, 'context'>>).context?.();
  if (!context) {
    return [];
  }

  const cookies = await context.cookies().catch(() => []);
  return cookies.map((cookie) => cookie.name);
}

function isLiepinResumeDetailUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/resume\/showresumedetail\//i.test(url);
}

export async function assertLiepinAuthenticated(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });

  const bodyText = await body.innerText();
  const currentUrl = page.url();
  if (isLiepinUnauthenticatedText(bodyText) || isLiepinLoginPageUrl(currentUrl)) {
    const cookieNames = await readLiepinCookieNames(page);
    if (isLiepinLoginPageUrl(currentUrl) && hasLiepinAuthenticatedCookie(cookieNames)) {
      return;
    }

    throw new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (bodyText.trim().length === 0 && /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:\?.*)?(?:#.*)?$/i.test(currentUrl)) {
    const cookieNames = await readLiepinCookieNames(page);
    if (hasLiepinAuthenticatedCookie(cookieNames)) {
      return;
    }

    throw new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (isLiepinResumeDetailUrl(currentUrl) && isLiepinAuthenticatedResumeDetailText(bodyText)) {
    return;
  }

  if (!isLiepinAuthenticatedText(bodyText)) {
    throw new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
  }
}
