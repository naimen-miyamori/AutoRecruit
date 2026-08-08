import type { Page } from 'playwright';
import { config } from '../../../config.js';
import { gotoPlatformPage } from '../../../browser/pacing.js';
import type { SearchWaitOptions } from '../../types.js';
import { assertZhilianAuthenticated } from './authentication.js';
import {
  createZhilianActionDeadline as createDeadline,
  createZhilianSearchDeadline as createSearchDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';

export { assertZhilianAuthenticated } from './authentication.js';

export const zhilianLoginUrl = 'https://passport.zhaopin.com/org/login';
export const zhilianAuthenticatedHomeUrl = 'https://rd6.zhaopin.com/app/search';
const zhilianPlatform = 'zhilian';

export function isAbortNavigationError(error: unknown): boolean {
  return error instanceof Error && /net::ERR_ABORTED|Navigation aborted|frame was detached|Execution context was destroyed/i.test(error.message);
}

function isZhilianRecruiterUrl(url: string): boolean {
  return /^https:\/\/(?:rd6|rd5|rd)\.zhaopin\.com(?:[/?#].*)?$/i.test(url)
    || (/^https:\/\/.*\.zhaopin\.com(?:[/?#].*)?$/i.test(url) && !/passport\.zhaopin\.com/i.test(url));
}

export function isZhilianSearchUrl(url: string): boolean {
  return /^https:\/\/rd6\.zhaopin\.com\/app\/search(?:[/?#].*)?$/i.test(url);
}

export async function waitForZhilianRecruiterShell(
  page: Page,
  options: { deadline?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = options.deadline ?? createDeadline(options.timeoutMs ?? config.playwright.searchPageTimeoutMs);
  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (!waitForFunction) {
    await assertZhilianAuthenticated(page);
    return;
  }

  await waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const currentUrl = window.location.href;
      const hasLoginText = /扫码登录|验证码登录|密码登录|企业登录|立即登录|登录后继续|忘记密码/.test(bodyText)
        && !/简历管理|职位管理|招聘管理|候选人|人才库|面试|沟通/.test(bodyText);
      const hasSearchReadyText = /人才管理|使用高级搜索|快捷搜索|搜公司、职位、专业、学校、行业、技能等/.test(bodyText)
        || (/搜索/.test(bodyText) && /职位|推荐|人才|简历/.test(bodyText));
      const hasRecruiterText = /招聘管理|职位管理|简历管理|候选人|人才库|搜简历|搜索|沟通|面试/.test(bodyText);
      const hasDesktopShellText = /智联招聘桌面版|消息通知,?\s*实时提醒|持续在线,?\s*吸引投递|Windows下载|Mac下载/.test(bodyText);
      const isBlankRd6Shell = bodyText.trim().length === 0 && /^https:\/\/rd6\.zhaopin\.com(?:[/?#].*)?$/i.test(currentUrl);
      return /passport\.zhaopin\.com\/(?:org\/)?login/i.test(currentUrl)
        || hasLoginText
        || hasSearchReadyText
        || hasRecruiterText
        || hasDesktopShellText
        || isBlankRd6Shell;
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );

  await assertZhilianAuthenticated(page);
}

export async function openZhilianRecruiterHome(page: Page, options?: SearchWaitOptions): Promise<void> {
  const deadline = createSearchDeadline(options);
  if (isZhilianSearchUrl(page.url())) {
    await waitForZhilianRecruiterShell(page, { deadline });
    return;
  }

  try {
    await gotoPlatformPage(page, zhilianPlatform, zhilianAuthenticatedHomeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: remainingTime(deadline),
    });
  } catch (error) {
    if (!isAbortNavigationError(error) || !isZhilianRecruiterUrl(page.url())) {
      throw error;
    }
  }

  await waitForZhilianRecruiterShell(page, { deadline });
}

export async function openZhilianLoginPage(page: Page): Promise<void> {
  await gotoPlatformPage(page, zhilianPlatform, zhilianLoginUrl, { waitUntil: 'domcontentloaded' });
}

export async function openZhilianAuthenticatedHome(page: Page): Promise<Page> {
  await openZhilianRecruiterHome(page);
  return page;
}
