import type { Page } from 'playwright';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isZhilianLoginPageUrl(url: string): boolean {
  return /passport\.zhaopin\.com\/org\/login/i.test(url)
    || /passport\.zhaopin\.com\/login/i.test(url);
}

function isZhilianUnauthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /扫码登录|验证码登录|密码登录|企业登录|立即登录|登录后继续|忘记密码/.test(normalizedText)
    && !/简历管理|职位管理|招聘管理|候选人|人才库|面试|沟通/.test(normalizedText);
}

function isZhilianAuthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /智联|招聘管理|职位管理|简历管理|候选人|人才库|面试|沟通|招聘效果|企业中心|职位发布/.test(normalizedText);
}

function isZhilianSearchReadyText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /人才管理|使用高级搜索|快捷搜索|搜公司、职位、专业、学校、行业、技能等/.test(normalizedText)
    || (/搜索/.test(normalizedText) && /职位|推荐|人才|简历/.test(normalizedText));
}

function isZhilianDesktopShellText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /智联招聘桌面版|消息通知,?\s*实时提醒|持续在线,?\s*吸引投递|Windows下载|Mac下载/.test(normalizedText);
}

function hasZhilianAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(at|rt|zp-route-meta)$/i.test(name));
}

export async function assertZhilianAuthenticated(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });

  const bodyText = await body.innerText();
  const currentUrl = page.url();

  if (isZhilianLoginPageUrl(currentUrl) || isZhilianUnauthenticatedText(bodyText)) {
    throw new Error('Zhilian authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (bodyText.trim().length === 0 && /^https:\/\/rd6\.zhaopin\.com(?:[/?#].*)?$/i.test(currentUrl)) {
    const cookies = await page.context().cookies().catch(() => []);
    if (hasZhilianAuthenticatedCookie(cookies.map((cookie) => cookie.name))) {
      return;
    }
  }

  if (!isZhilianAuthenticatedText(bodyText) && !isZhilianSearchReadyText(bodyText) && !isZhilianDesktopShellText(bodyText)) {
    throw new Error('Zhilian authenticated page is not available because the recruiter shell is not ready.');
  }
}
