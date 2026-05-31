import type { BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { clickPlatformLocator } from '../browser/pacing.js';
import {
  clickFirstVisibleText,
  clickPrimarySearchButton,
  fillFirstVisibleInput,
  fillInputNearText,
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../search/page-actions.js';
import type { CandidateListItem, CandidateResume, EducationExperience, WorkExperience } from '../types/job.js';
import type { PlatformAdapter, SearchWaitOptions } from './types.js';

const zhilianLoginUrl = 'https://passport.zhaopin.com/org/login';
const zhilianDesktopShellUrl = 'https://rd6.zhaopin.com/desktop';
const zhilianAuthenticatedHomeUrl = 'https://rd6.zhaopin.com/app/search';
const zhilianCandidateLinkSelector = [
  'a[href*="resume"]',
  'a[href*="candidate"]',
  'a[href*="talent"]',
  '[data-resume-id] a',
  '[data-candidate-id] a',
  '[data-talent-id] a',
  'a[data-resume-id]',
  'a[data-candidate-id]',
  'a[data-talent-id]',
].join(', ');
const resumeSectionTitles = ['求职意向', '工作经历', '项目经历', '项目经验', '教育经历', '教育背景', '技能', '语言能力', '证书', '个人优势', '自我评价'];

type ZhilianApiCandidate = {
  candidateId?: string;
  resumeId?: string;
  resumeNo?: string;
  talentId?: string;
  userId?: string;
  userMasterId?: string | number;
  name?: string;
  userName?: string;
  currentCompany?: string;
  companyName?: string;
  currentTitle?: string;
  jobTitle?: string;
  positionName?: string;
  resumeUrl?: string;
  detailUrl?: string;
  url?: string;
  resumeNumber?: string;
  resumeK?: string;
  resumeT?: string;
  desiredJobType?: string;
  workExperiences?: Array<{
    companyName?: string;
    jobTitle?: string;
  }>;
};

type ZhilianDomCandidateSnapshot = {
  href: string;
  anchorOuterHtml: string;
  containerOuterHtml: string;
  rawText: string;
  anchorText: string;
};

type ZhilianVueCandidateSnapshot = {
  candidate?: ZhilianApiCandidate;
  rawText: string;
  containerOuterHtml: string;
};

const observedZhilianSearchApiCandidates = new WeakMap<Page, CandidateListItem[]>();
const observedZhilianSearchApiSeenPages = new WeakSet<Page>();
const observedZhilianSearchApiListenerPages = new WeakSet<Page>();
const zhilianResumeDetailSelectors = [
  '.km-modal__wrapper.new-shortcut-resume__modal',
  '.resume-detail-wrap',
  '.resume-detail.km-scrollbar.new-resume-detail',
  '.new-shortcut-resume__inner',
];
const zhilianUnviewedFilterSelector = [
  '.km-checkbox:has-text("未看过")',
  '[class*="checkbox"]:has-text("未看过")',
  '[role="checkbox"]:has-text("未看过")',
  'label:has-text("未看过")',
].join(', ');
const zhilianViewedFilterSettleMs = 1000;
const zhilianViewedFilterPollMs = 100;
const zhilianViewedFilterMaxWaitMs = 8000;
const zhilianSearchStatePollMs = 100;
const zhilianPlatform = 'zhilian';

function createDeadline(timeoutMs = config.playwright.resumeDetailTimeoutMs): number {
  return Date.now() + Math.max(timeoutMs, 1);
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? createDeadline(config.playwright.searchPageTimeoutMs);
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function boundedTimeout(deadline: number, maxTimeoutMs = Number.POSITIVE_INFINITY): number {
  return Math.max(1, Math.min(remainingTime(deadline), maxTimeoutMs));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(resolve, Math.max(timeoutMs, 1), fallback);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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

async function assertZhilianAuthenticated(page: Page): Promise<void> {
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

function isAbortNavigationError(error: unknown): boolean {
  return error instanceof Error && /net::ERR_ABORTED|Navigation aborted|frame was detached/i.test(error.message);
}

function isZhilianRecruiterUrl(url: string): boolean {
  return /^https:\/\/(?:rd6|rd5|rd)\.zhaopin\.com(?:[/?#].*)?$/i.test(url)
    || (/^https:\/\/.*\.zhaopin\.com(?:[/?#].*)?$/i.test(url) && !/passport\.zhaopin\.com/i.test(url));
}

function isZhilianSearchUrl(url: string): boolean {
  return /^https:\/\/rd6\.zhaopin\.com\/app\/search(?:[/?#].*)?$/i.test(url);
}

async function closeExistingZhilianResumeModal(page: Page): Promise<void> {
  if (!isZhilianSearchUrl(page.url())) {
    return;
  }

  const modalLocator = await Promise.resolve()
    .then(() => page.locator(zhilianResumeDetailSelectors.join(', ')))
    .catch(() => undefined);
  const modalCount = modalLocator && typeof modalLocator.count === 'function'
    ? await modalLocator.count().catch(() => 0)
    : 0;
  if (modalCount === 0 && !/resumeNumber=/i.test(page.url())) {
    return;
  }

  const closeSelector = [
    '.km-modal__wrapper.new-shortcut-resume__modal .km-modal__close',
    '.km-modal__wrapper.new-shortcut-resume__modal [aria-label="关闭"]',
    '.km-modal__wrapper.new-shortcut-resume__modal .ant-modal-close',
    '.km-modal__wrapper.new-shortcut-resume__modal .close',
    '.km-modal__wrapper.new-shortcut-resume__modal [class*="close"]',
  ].join(', ');

  try {
    await clickPlatformLocator(
      page.locator(closeSelector).first(),
      page,
      zhilianPlatform,
      Math.min(config.playwright.resumeDetailTimeoutMs, 1000),
    );
  } catch {
    if (/resumeNumber=/i.test(page.url())) {
      const keyboard = (page as Partial<Pick<Page, 'keyboard'>>).keyboard;
      await keyboard?.press('Escape').catch(() => undefined);
    }
  }
}

async function waitForZhilianRecruiterShell(page: Page, options: { deadline?: number; timeoutMs?: number } = {}): Promise<void> {
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

async function openZhilianRecruiterHome(page: Page, options?: SearchWaitOptions): Promise<void> {
  const deadline = createSearchDeadline(options);
  if (isZhilianSearchUrl(page.url())) {
    await waitForZhilianRecruiterShell(page, { deadline });
    return;
  }

  try {
    await page.goto(zhilianAuthenticatedHomeUrl, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
  } catch (error) {
    if (!isAbortNavigationError(error) || !isZhilianRecruiterUrl(page.url())) {
      throw error;
    }
  }

  await waitForZhilianRecruiterShell(page, { deadline });
}

async function listVisibleZhilianQuickSearchTags(page: Page): Promise<string[]> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const quickSearchSectionMatch = bodyText.match(/(?:快捷搜索|猜你想搜：?)([\s\S]{0,600})/);
  const quickSearchSection = normalizeText(quickSearchSectionMatch?.[1] ?? bodyText);
  return quickSearchSection
    .split(/\s{2,}|[,\n]/)
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => !/^(快捷搜索|猜你想搜：?|清空筛选|使用高级搜索|搜索|搜 索)$/.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordToLoosePattern(keyword: string): RegExp {
  const segments = keyword
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => escapeRegExp(segment));

  const pattern = segments.length > 0 ? segments.join('\\s*') : escapeRegExp(keyword);
  return new RegExp(pattern, 'i');
}

function hasAppliedZhilianQuickSearchKeyword(bodyText: string, keyword: string): boolean {
  const normalizedText = normalizeText(bodyText);
  const keywordPattern = keywordToLoosePattern(keyword);
  const appliedKeywordMatch = normalizedText.match(/关键词[:：]\s*([^:：]*?)(?:\s+(?:学历要求|年龄要求|期望月薪|活跃日期|期望职位|从事职业|现居住地|保存为快捷搜索|今日搜索聊剩|综合排序|未看过|未聊过|近一段工作相关|其他过滤条件)|$)/);
  return keywordPattern.test(appliedKeywordMatch?.[1] ?? '');
}

async function isZhilianQuickSearchApplied(page: Page, keyword: string): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return hasAppliedZhilianQuickSearchKeyword(bodyText, keyword);
}

async function waitForZhilianQuickSearchApplied(page: Page, keyword: string, deadline: number): Promise<boolean> {
  while (Date.now() <= deadline) {
    if (await isZhilianQuickSearchApplied(page, keyword)) {
      return true;
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  return false;
}

async function clickSavedZhilianQuickSearchTag(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await isZhilianQuickSearchApplied(page, keyword)) {
    return;
  }

  const keywordPattern = keywordToLoosePattern(keyword);
  const quickSearchTagSelectors = [
    '.search-quick-search-new__content-item',
    '.search-quick-search__content-item',
    '[class*="quick-search"][class*="content-item"]',
    '[class*="quick-search"][class*="item"]',
  ];
  let quickSearchTag: ReturnType<Page['locator']> | undefined;

  for (const selector of quickSearchTagSelectors) {
    const candidate = page.locator(selector).filter({ hasText: keywordPattern }).first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: Math.min(2000, remainingTime(deadline)) });
      quickSearchTag = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!quickSearchTag) {
    const visibleTags = await listVisibleZhilianQuickSearchTags(page);
    throw new Error(`Could not find a saved Zhilian quick-search tag containing keyword "${keyword}". Visible tags: ${visibleTags.join(', ') || '(none)'}.`);
  }

  clearObservedZhilianCandidateApi(page);
  await clickPlatformLocator(quickSearchTag, page, zhilianPlatform, remainingTime(deadline));
  await waitForZhilianRecruiterShell(page, { deadline });
  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search tag containing keyword "${keyword}" was clicked, but its search conditions did not become active before timeout.`);
  }
}

async function ensureZhilianViewedFilterClearedForQuickSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await clearZhilianUnviewedFilter(page, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }

  if (!await isZhilianQuickSearchApplied(page, keyword)) {
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (await clearZhilianUnviewedFilter(page, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
  }

  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search conditions for keyword "${keyword}" were not active after clearing 未看过.`);
  }

  if (await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter remained checked after --include-viewed true.');
  }
}

async function isZhilianUnviewedFilterChecked(page: Page): Promise<boolean> {
  const unviewedFilter = page.locator(zhilianUnviewedFilterSelector).filter({ visible: true }).first();

  return unviewedFilter.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const control = element.closest('[class*="checkbox"], label, [role="checkbox"]') ?? element;
    const checkbox = control.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const ariaChecked = control.getAttribute('aria-checked');
    return checkbox?.checked === true
      || ariaChecked === 'true'
      || /\b(km-checkbox--checked|ant-checkbox-checked|is-checked|checked)\b/.test(String(control.className ?? ''));
  }).catch(() => false);
}

async function clearZhilianUnviewedFilter(page: Page, options?: SearchWaitOptions): Promise<boolean> {
  const deadline = createSearchDeadline(options);
  const waitUntil = Math.min(deadline, Date.now() + zhilianViewedFilterMaxWaitMs);
  const unviewedFilter = page.locator(zhilianUnviewedFilterSelector).filter({ visible: true }).first();

  try {
    await unviewedFilter.waitFor({ state: 'visible', timeout: Math.max(1, waitUntil - Date.now()) });
  } catch {
    return false;
  }

  let clicked = false;
  let uncheckedSince: number | undefined;

  while (Date.now() < waitUntil) {
    if (await isZhilianUnviewedFilterChecked(page)) {
      uncheckedSince = undefined;
      clearObservedZhilianCandidateApi(page);
      try {
        await clickPlatformLocator(
          unviewedFilter,
          page,
          zhilianPlatform,
          Math.min(1000, Math.max(1, waitUntil - Date.now())),
        );
        clicked = true;
      } catch {
        // The search page renders hidden duplicates; retry until a visible control is stable.
      }
    } else {
      const now = Date.now();
      uncheckedSince ??= now;
      if (now - uncheckedSince >= zhilianViewedFilterSettleMs) {
        return clicked;
      }
    }

    await page.waitForTimeout(Math.min(zhilianViewedFilterPollMs, Math.max(1, waitUntil - Date.now()))).catch(() => undefined);
  }

  return clicked;
}

async function fillZhilianKeywordSearchInput(page: Page, value: string): Promise<boolean> {
  const inputSelectors = [
    'input[placeholder*="搜公司"]',
    'input[placeholder*="职位"]',
    'input[placeholder*="专业"]',
    'input[placeholder*="学校"]',
    'input[placeholder*="行业"]',
    'input[placeholder*="技能"]',
    'input[placeholder*="关键词"]',
    'input[placeholder*="搜索"]',
    'input[type="search"]',
    'input[type="text"]',
  ];

  if (await fillInputNearText(
    page,
    value,
    ['搜公司、职位、专业、学校、行业、技能等', '搜索关键词', '关键词', '职位', '专业', '学校', '行业', '技能'],
    ['.search-item', '.filter-item', '.form-item', '[class*="search"]', '[class*="filter"]'],
    inputSelectors,
    1000,
    zhilianPlatform,
  )) {
    return true;
  }

  return fillFirstVisibleInput(page, value, inputSelectors, 1000, zhilianPlatform);
}

async function prepareZhilianSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });

  const didFillKeyword = await fillZhilianKeywordSearchInput(page, keyword);
  if (!didFillKeyword) {
    throw new Error('Search subscription on zhilian could not fill the keyword input on the recruiter search page.');
  }

  const didTriggerSearch = await clickPrimarySearchButton(page, 1000, zhilianPlatform)
    || await clickFirstVisibleText(page, ['搜索', '搜 索'], 1000, zhilianPlatform);
  if (!didTriggerSearch) {
    throw new Error('Search subscription on zhilian could not trigger the keyword search on the recruiter search page.');
  }

  await waitForZhilianRecruiterShell(page, { deadline });
  await clickFirstVisibleText(page, ['使用高级搜索', '高级搜索', '筛选', '更多筛选'], 1000, zhilianPlatform).catch(() => false);
  return page;
}

async function readZhilianSearchConditionResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const resultTotal = parseSearchResultTotalFromText(await page.locator('body').innerText());
  if (resultTotal === undefined) {
    throw new Error('Search subscription on zhilian could not read the page result total.');
  }

  return {
    resultTotal,
    resultTotalSource: 'page',
  };
}

function clearObservedZhilianCandidateApi(page: Page): void {
  observedZhilianSearchApiCandidates.delete(page);
  observedZhilianSearchApiSeenPages.delete(page);
}

function normalizeZhilianUrl(value: string | null | undefined): string | undefined {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return undefined;
  }

  if (/^https?:\/\//i.test(normalizedValue)) {
    return normalizedValue;
  }

  try {
    return new URL(normalizedValue, 'https://rd6.zhaopin.com').toString();
  } catch {
    return undefined;
  }
}

function scoreZhilianShareUrl(url: string): number {
  if (/^https:\/\/m\.zhaopin\.com\/b\/resume-package\?/i.test(url) && /[?&]zhaopinToken=/i.test(url)) {
    return 100;
  }

  if (/^https:\/\/[^/]*zhaopin\.com\/[^?#]*linkforward\/resume(?:[/?#].*)?$/i.test(url)) {
    return 80;
  }

  return 0;
}

function extractSafeZhilianShareUrls(value: string | null | undefined): string[] {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return [];
  }

  const explicitUrls = normalizedValue.match(/https:\/\/[^/\s"'<>]*zhaopin\.com\/[^\s"'<>]*/gi) ?? [normalizedValue];
  return explicitUrls
    .map((url) => url.replace(/[),，。]+$/g, ''))
    .filter((url) => scoreZhilianShareUrl(url) > 0);
}

function selectBestZhilianShareUrl(values: Array<string | null | undefined>): string | undefined {
  const candidates = values.flatMap((value) => extractSafeZhilianShareUrls(value));
  candidates.sort((left, right) => scoreZhilianShareUrl(right) - scoreZhilianShareUrl(left));
  return candidates[0];
}

function extractSafeZhilianShareUrl(value: string | null | undefined): string | undefined {
  return selectBestZhilianShareUrl([value]);
}

async function clickFirstVisibleZhilianText(page: Page, pattern: RegExp, timeout = 3000): Promise<boolean> {
  const locator = page.getByText(pattern, { exact: false });
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible({ timeout }).catch(() => false))) {
        continue;
      }

      await clickPlatformLocator(candidate, page, zhilianPlatform, timeout);
      return true;
    } catch {
      continue;
    }
  }

  try {
    const firstLocator = locator.first();
    await firstLocator.waitFor({ state: 'visible', timeout });
    await clickPlatformLocator(firstLocator, page, zhilianPlatform, timeout);
    return true;
  } catch {
    return false;
  }
}

async function readZhilianShareLinkFromPage(page: Page): Promise<string | undefined> {
  const linkSelector = [
    'input',
    'textarea',
    '[contenteditable="true"]',
    'a[href*="zhaopin.com"]',
    '[data-clipboard-text]',
    '[data-clipboard]',
    '[data-copy]',
    '[data-url]',
    '[title*="zhaopin.com"]',
  ].join(', ');

  try {
    const values = await page.locator(linkSelector).evaluateAll((elements) => elements.flatMap((element) => {
      if (element instanceof HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const isHidden = style.display === 'none'
          || style.visibility === 'hidden'
          || style.opacity === '0'
          || (rect.width === 0 && rect.height === 0);
        if (isHidden) {
          return [];
        }
      }

      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const anchor = element as HTMLAnchorElement;
      return [
        input.value,
        anchor.href,
        element.getAttribute('href'),
        element.getAttribute('data-clipboard-text'),
        element.getAttribute('data-clipboard'),
        element.getAttribute('data-copy'),
        element.getAttribute('data-url'),
        element.getAttribute('title'),
        element.textContent,
      ];
    }));

    return selectBestZhilianShareUrl(values);
  } catch {
    return undefined;
  }
}

async function installZhilianClipboardWriteInterceptor(page: Page): Promise<void> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return;
  }

  try {
    await evaluate(() => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
        __autorecruitZhilianClipboardInstalled?: boolean;
        __autorecruitZhilianOriginalClipboardWriteText?: (value: string) => Promise<void>;
      };
      if (windowWithShareClipboard.__autorecruitZhilianClipboardInstalled) {
        windowWithShareClipboard.__autorecruitZhilianCopiedText = '';
        return;
      }

      windowWithShareClipboard.__autorecruitZhilianClipboardInstalled = true;
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';

      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard && 'writeText' in clipboard) {
        windowWithShareClipboard.__autorecruitZhilianOriginalClipboardWriteText = clipboard.writeText.bind(clipboard);
        Object.defineProperty(clipboard, 'writeText', {
          configurable: true,
          value: async (value: string) => {
            windowWithShareClipboard.__autorecruitZhilianCopiedText = String(value ?? '');
            return undefined;
          },
        });
      }

      document.addEventListener('copy', (event) => {
        const selectedText = window.getSelection()?.toString() ?? '';
        if (selectedText) {
          windowWithShareClipboard.__autorecruitZhilianCopiedText = selectedText;
        }
        event.clipboardData?.setData('text/plain', selectedText);
        event.preventDefault();
      }, true);
    });
  } catch {
    // If script patching is blocked, DOM and permission-granted clipboard fallbacks still apply.
  }
}

async function clearZhilianClipboardBeforeCopy(page: Page): Promise<boolean> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return false;
  }

  try {
    return Boolean(await evaluate(async () => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
        __autorecruitZhilianOriginalClipboardWriteText?: (value: string) => Promise<void>;
      };
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';

      const writeText = windowWithShareClipboard.__autorecruitZhilianOriginalClipboardWriteText
        ?? navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (!writeText) {
        return false;
      }

      await writeText('');
      windowWithShareClipboard.__autorecruitZhilianCopiedText = '';
      return true;
    }));
  } catch {
    return false;
  }
}

async function readZhilianInterceptedClipboardText(page: Page): Promise<string | undefined> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return undefined;
  }

  try {
    const copiedText = await evaluate(() => {
      const windowWithShareClipboard = window as typeof window & {
        __autorecruitZhilianCopiedText?: string;
      };
      return windowWithShareClipboard.__autorecruitZhilianCopiedText ?? '';
    });
    return extractSafeZhilianShareUrl(String(copiedText));
  } catch {
    return undefined;
  }
}

async function readZhilianShareLinkFromClipboard(page: Page): Promise<string | undefined> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  if (!evaluate) {
    return undefined;
  }

  try {
    const clipboardText = await evaluate(async () => navigator.clipboard?.readText?.() ?? '');
    return extractSafeZhilianShareUrl(String(clipboardText));
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFreshZhilianCopiedShareLink(
  page: Page,
  options: {
    previousInterceptedClipboardLink?: string;
    previousClipboardLink?: string;
    clearedClipboard: boolean;
  },
): Promise<string | undefined> {
  const timeoutMs = 1500;
  const intervalMs = 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const interceptedClipboardLink = await readZhilianInterceptedClipboardText(page);
    if (
      interceptedClipboardLink
      && interceptedClipboardLink !== options.previousInterceptedClipboardLink
    ) {
      return interceptedClipboardLink;
    }

    const clipboardLink = await readZhilianShareLinkFromClipboard(page);
    if (
      clipboardLink
      && (options.clearedClipboard || clipboardLink !== options.previousClipboardLink)
    ) {
      return clipboardLink;
    }

    const pageLink = await readZhilianShareLinkFromPage(page);
    if (pageLink) {
      return pageLink;
    }

    await wait(intervalMs);
  }

  return undefined;
}

async function grantZhilianClipboardPermissions(page: Page): Promise<void> {
  const context = (page as Partial<Pick<Page, 'context'>>).context?.();
  const grantPermissions = (context as Partial<{
    grantPermissions: (permissions: string[], options?: { origin?: string }) => Promise<void>;
  }> | undefined)?.grantPermissions?.bind(context);
  if (!grantPermissions) {
    return;
  }

  try {
    await grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
  } catch {
    // Fall back to visible link controls. Some browser contexts do not support clipboard grants.
  }
}

async function dismissZhilianColleagueForwardDialog(page: Page): Promise<void> {
  const keyboard = (page as { keyboard?: { press?: (key: string) => Promise<void> } }).keyboard;
  if (!keyboard?.press) {
    return;
  }

  try {
    await keyboard.press('Escape');
  } catch {
    // Best effort only. Resume parsing should not fail because the share dialog cannot be dismissed.
  }
}

async function copyZhilianColleagueForwardLink(page: Page): Promise<string | undefined> {
  const openedForwardDialog = await clickFirstVisibleZhilianText(page, /转给同事/);
  if (!openedForwardDialog) {
    throw new Error('Could not find or click the visible Zhilian "转给同事" resume action.');
  }

  try {
    const openedLinkForward = await clickFirstVisibleZhilianText(page, /链接转发/);
    if (!openedLinkForward) {
      throw new Error('Could not find or click the visible Zhilian "链接转发" option.');
    }

    const visiblePageLink = await readZhilianShareLinkFromPage(page);
    if (visiblePageLink) {
      return visiblePageLink;
    }

    const previousInterceptedClipboardLink = await readZhilianInterceptedClipboardText(page);
    await installZhilianClipboardWriteInterceptor(page);
    await grantZhilianClipboardPermissions(page);
    const previousClipboardLink = await readZhilianShareLinkFromClipboard(page);
    const clearedClipboard = await clearZhilianClipboardBeforeCopy(page);
    const clickedCopyLink = await clickFirstVisibleZhilianText(page, /复制链接|复制/);
    if (!clickedCopyLink) {
      throw new Error('Could not find or click the visible Zhilian "复制链接" action.');
    }

    const copiedShareLink = await waitForFreshZhilianCopiedShareLink(page, {
      previousInterceptedClipboardLink,
      previousClipboardLink,
      clearedClipboard,
    });
    if (!copiedShareLink) {
      throw new Error('Could not read a copied Zhilian colleague-forward link after clicking "复制链接".');
    }

    return copiedShareLink;
  } finally {
    await dismissZhilianColleagueForwardDialog(page);
  }
}

function findCandidateArrays(value: unknown): ZhilianApiCandidate[][] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directList = record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>).list
    : undefined;
  if (Array.isArray(directList)) {
    return [directList as ZhilianApiCandidate[]];
  }

  if (Array.isArray(value)) {
    const hasCandidateShape = value.some((entry) => entry && typeof entry === 'object' && /resume|candidate|talent|user/i.test(Object.keys(entry as Record<string, unknown>).join(' ')));
    return hasCandidateShape ? [value as ZhilianApiCandidate[]] : value.flatMap(findCandidateArrays);
  }

  return Object.values(record).flatMap(findCandidateArrays);
}

function candidateIdFromZhilianEntry(entry: ZhilianApiCandidate): string {
  const rawValues = [
    entry.candidateId,
    entry.resumeId,
    entry.resumeNo,
    entry.talentId,
    entry.userId,
    entry.userMasterId,
  ];

  for (const rawValue of rawValues) {
    const normalizedValue = normalizeText(rawValue === undefined || rawValue === null ? undefined : String(rawValue));
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return '';
}

function resumeUrlFromZhilianEntry(entry: ZhilianApiCandidate): string | undefined {
  const explicitUrl = normalizeZhilianUrl(entry.resumeUrl ?? entry.detailUrl ?? entry.url);
  if (explicitUrl) {
    return explicitUrl;
  }

  const resumeNumber = normalizeText(entry.resumeNumber);
  if (!resumeNumber) {
    return undefined;
  }

  return `https://rd6.zhaopin.com/app/search?resumeNumber=${resumeNumber}`;
}

function currentCompanyFromZhilianEntry(entry: ZhilianApiCandidate): string | undefined {
  return normalizeText(
    entry.currentCompany
      ?? entry.companyName
      ?? entry.workExperiences?.[0]?.companyName,
  ) || undefined;
}

function currentTitleFromZhilianEntry(entry: ZhilianApiCandidate): string | undefined {
  return normalizeText(
    entry.currentTitle
      ?? entry.jobTitle
      ?? entry.positionName
      ?? entry.workExperiences?.[0]?.jobTitle
      ?? entry.desiredJobType,
  ) || undefined;
}

function parseZhilianApiCandidates(payload: string): CandidateListItem[] {
  const parsed = JSON.parse(payload) as unknown;
  const entries = findCandidateArrays(parsed).flat();
  const candidatesById = new Map<string, CandidateListItem>();

  for (const [index, entry] of entries.entries()) {
    const candidateId = candidateIdFromZhilianEntry(entry);
    if (!candidateId) {
      continue;
    }

    const name = normalizeText(entry.name ?? entry.userName) || undefined;
    const currentCompany = currentCompanyFromZhilianEntry(entry);
    const currentTitle = currentTitleFromZhilianEntry(entry);
    const resumeUrl = resumeUrlFromZhilianEntry(entry);
    const cardText = [name, currentCompany, currentTitle].filter(Boolean).join('\n') || undefined;

    candidatesById.set(candidateId, {
      candidateId,
      resumeUrl,
      name,
      currentCompany,
      currentTitle,
      cardText,
      sourceText: JSON.stringify(entry),
      searchResultIndex: index,
    });
  }

  return Array.from(candidatesById.values());
}

function isZhilianCandidateApiResponse(response: { url(): string; status(): number }): boolean {
  return /\/api\/talent\/search\/list(?:[/?#]|$)/i.test(response.url())
    && response.status() >= 200
    && response.status() < 400;
}

async function cacheZhilianCandidateApiResponse(page: Page, response: { url(): string; status(): number; text(): Promise<string> }): Promise<void> {
  if (!isZhilianCandidateApiResponse(response)) {
    return;
  }

  try {
    const candidates = parseZhilianApiCandidates(await response.text());
    if (candidates.length > 0) {
      observedZhilianSearchApiCandidates.set(page, candidates);
    }
  } catch {
    observedZhilianSearchApiCandidates.set(page, observedZhilianSearchApiCandidates.get(page) ?? []);
  }

  observedZhilianSearchApiSeenPages.add(page);
}

function attachZhilianCandidateApiObserver(page: Page): void {
  const observablePage = page as Page & {
    on?: (event: string, listener: (response: { url(): string; status(): number; text(): Promise<string> }) => void) => void;
  };
  if (typeof observablePage.on !== 'function' || observedZhilianSearchApiListenerPages.has(page)) {
    return;
  }

  observedZhilianSearchApiListenerPages.add(page);
  observablePage.on('response', (response) => {
    void cacheZhilianCandidateApiResponse(page, response);
  });
}

async function waitForZhilianCandidateApi(page: Page, timeoutMs?: number): Promise<CandidateListItem[]> {
  if (observedZhilianSearchApiSeenPages.has(page)) {
    return observedZhilianSearchApiCandidates.get(page) ?? [];
  }

  attachZhilianCandidateApiObserver(page);
  const waitForResponse = (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse?.bind(page);
  if (!waitForResponse) {
    return observedZhilianSearchApiCandidates.get(page) ?? [];
  }

  const effectiveTimeoutMs = Math.max(timeoutMs ?? config.playwright.searchPageTimeoutMs, 1);
  const responsePromise = waitForResponse(
    (candidateResponse) => isZhilianCandidateApiResponse(candidateResponse),
    { timeout: effectiveTimeoutMs },
  ).catch(() => undefined);
  const response = await withTimeout(responsePromise, effectiveTimeoutMs, undefined);

  if (response) {
    await cacheZhilianCandidateApiResponse(page, response);
  }

  return observedZhilianSearchApiCandidates.get(page) ?? [];
}

function extractZhilianCandidateIdFromText(text: string): string | undefined {
  const patterns = [
    /resume(?:Id|ID|id|No)[=:\/"'&?]+([A-Za-z0-9_-]{5,})/i,
    /candidate(?:Id|ID|id)[=:\/"'&?]+([A-Za-z0-9_-]{5,})/i,
    /talent(?:Id|ID|id)[=:\/"'&?]+([A-Za-z0-9_-]{5,})/i,
    /data-(?:resume-id|candidate-id|talent-id)="?([A-Za-z0-9_-]{5,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function extractZhilianCardsInPage(elements: Element[]): CandidateListItem[] {
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const resultById = new Map<string, CandidateListItem>();

  for (const element of elements) {
    const anchor = element as HTMLAnchorElement;
    const container = anchor.closest('li, [class*="card"], [class*="item"], [class*="resume"], [class*="candidate"], [class*="talent"], article, section, div') ?? anchor;
    const rawText = (container.textContent ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cardText = normalize(rawText);
    const sourceText = [anchor.href, anchor.outerHTML, (container as HTMLElement).outerHTML, cardText].filter(Boolean).join(' ');
    const candidateId = extractZhilianCandidateIdFromText(sourceText);

    if (!candidateId) {
      continue;
    }

    const segments = rawText
      .split(/\r?\n|[|｜]/)
      .map(normalize)
      .filter(Boolean);
    const anchorText = normalize(anchor.textContent);
    const name = (anchorText && /^[一-龥A-Za-z·]{2,20}$/.test(anchorText) && !/简历|候选人|人才|本科|硕士|博士|大专|男|女/.test(anchorText))
      ? anchorText
      : segments.find((line) => /^[一-龥A-Za-z·]{2,20}$/.test(line) && !/简历|候选人|人才|本科|硕士|博士|大专|男|女/.test(line));
    const currentCompany = segments.find((line) => /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line));
    const currentTitle = segments.find((line) => /工程师|经理|主管|顾问|销售|总监|专员|运营|设计师|分析师|店长|讲师/.test(line));

    resultById.set(candidateId, {
      candidateId,
      resumeUrl: anchor.href || undefined,
      name,
      currentCompany,
      currentTitle,
      cardText,
      sourceText,
    });
  }

  return Array.from(resultById.values());
}

function parseZhilianDomCandidateSnapshots(snapshots: ZhilianDomCandidateSnapshot[]): CandidateListItem[] {
  const resultById = new Map<string, CandidateListItem>();

  for (const snapshot of snapshots) {
    const rawText = snapshot.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cardText = normalizeText(rawText);
    const sourceText = [snapshot.href, snapshot.anchorOuterHtml, snapshot.containerOuterHtml, cardText].filter(Boolean).join(' ');
    const candidateId = extractZhilianCandidateIdFromText(sourceText);

    if (!candidateId) {
      continue;
    }

    const segments = rawText
      .split(/\r?\n|[|｜]/)
      .map((value) => normalizeText(value))
      .filter(Boolean);
    const anchorText = normalizeText(snapshot.anchorText);
    const name = (anchorText && /^[一-龥A-Za-z·]{2,20}$/.test(anchorText) && !/简历|候选人|人才|本科|硕士|博士|大专|男|女/.test(anchorText))
      ? anchorText
      : segments.find((line) => /^[一-龥A-Za-z·]{2,20}$/.test(line) && !/简历|候选人|人才|本科|硕士|博士|大专|男|女/.test(line));
    const currentCompany = segments.find((line) => /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line));
    const currentTitle = segments.find((line) => /工程师|经理|主管|顾问|销售|总监|专员|运营|设计师|分析师|店长|讲师/.test(line));

    resultById.set(candidateId, {
      candidateId,
      resumeUrl: snapshot.href || undefined,
      name,
      currentCompany,
      currentTitle,
      cardText,
      sourceText,
    });
  }

  return Array.from(resultById.values());
}

function parseZhilianVueCandidateSnapshots(snapshots: ZhilianVueCandidateSnapshot[]): CandidateListItem[] {
  const candidatesById = new Map<string, CandidateListItem>();

  for (const [index, snapshot] of snapshots.entries()) {
    if (!snapshot.candidate) {
      continue;
    }

    const parsedCandidates = parseZhilianApiCandidates(JSON.stringify([snapshot.candidate]));
    const candidate = parsedCandidates[0];
    if (!candidate) {
      continue;
    }

    const rawText = snapshot.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cardText = normalizeText(rawText) || candidate.cardText;
    candidatesById.set(candidate.candidateId, {
      ...candidate,
      cardText,
      sourceText: JSON.stringify(snapshot.candidate),
      searchResultIndex: index,
    });
  }

  return Array.from(candidatesById.values());
}

async function collectZhilianCards(page: Page): Promise<CandidateListItem[]> {
  const vueSnapshots = await page.locator('.search-resume-item-wrap').evaluateAll((elements) => elements.map((element) => {
    const maybeVueElement = element as Element & {
      __vue__?: {
        _props?: {
          candidate?: ZhilianApiCandidate;
        };
      };
    };

    return {
      candidate: maybeVueElement.__vue__?._props?.candidate,
      containerOuterHtml: (element as HTMLElement).outerHTML,
      rawText: element.textContent ?? '',
    };
  })).catch(() => []);
  const vueCandidates = parseZhilianVueCandidateSnapshots(vueSnapshots);
  if (vueCandidates.length > 0) {
    return vueCandidates;
  }

  const snapshots = await page.locator(zhilianCandidateLinkSelector).evaluateAll((elements) => elements.map((element) => {
    const anchor = element as HTMLAnchorElement;
    const container = anchor.closest('li, [class*="card"], [class*="item"], [class*="resume"], [class*="candidate"], [class*="talent"], article, section, div') ?? anchor;
    return {
      href: anchor.href,
      anchorOuterHtml: anchor.outerHTML,
      containerOuterHtml: (container as HTMLElement).outerHTML,
      rawText: container.textContent ?? '',
      anchorText: anchor.textContent ?? '',
    };
  }));

  return parseZhilianDomCandidateSnapshots(snapshots);
}

function isZhilianExplicitEmptyText(text: string): boolean {
  return /暂无(?:符合条件的)?人才|暂无.*候选人|暂无.*简历|暂无.*结果|没有找到.*(?:人才|候选人|简历|结果)|未找到.*(?:人才|候选人|简历|结果)|无结果/.test(normalizeText(text));
}

async function hasZhilianExplicitEmptyResults(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return isZhilianExplicitEmptyText(bodyText);
}

async function clickZhilianSearchResultCard(searchPage: Page, candidate: CandidateListItem, deadline = createDeadline()): Promise<boolean> {
  const contentLocator = searchPage.locator('.search-resume-item-wrap .resume-item__content');
  const contentEvaluateAll = (contentLocator as Partial<Pick<typeof contentLocator, 'evaluateAll'>>).evaluateAll?.bind(contentLocator);
  const cardLocator = searchPage.locator('.search-resume-item-wrap');
  const cardEvaluateAll = (cardLocator as Partial<Pick<typeof cardLocator, 'evaluateAll'>>).evaluateAll?.bind(cardLocator);
  const evaluateAll = contentEvaluateAll ?? cardEvaluateAll;
  if (!evaluateAll) {
    return false;
  }

  const snapshots = await evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    html: (element as HTMLElement).outerHTML,
  })));

  const normalizedName = normalizeText(candidate.name);
  const normalizedCompany = normalizeText(candidate.currentCompany);
  const matchedSnapshot = snapshots.find((snapshot) => {
    const normalizedSnapshotText = normalizeText(snapshot.text);
    return Boolean(
      normalizedSnapshotText
      && (!normalizedName || normalizedSnapshotText.includes(normalizedName))
      && (!normalizedCompany || normalizedSnapshotText.includes(normalizedCompany)),
    );
  });

  const targetIndex = matchedSnapshot?.index ?? candidate.searchResultIndex;
  if (targetIndex === undefined) {
    return false;
  }

  if (contentEvaluateAll) {
    await clickPlatformLocator(contentLocator.nth(targetIndex), searchPage, zhilianPlatform, remainingTime(deadline));
    return true;
  }

  await clickPlatformLocator(cardLocator.nth(targetIndex), searchPage, zhilianPlatform, remainingTime(deadline));
  return true;
}

function isSafeZhilianResumeUrl(url: string | null | undefined): boolean {
  const normalizedUrl = normalizeText(url);
  return /^https:\/\/[^/]*zhaopin\.com\/.*(?:resume|candidate|talent)/i.test(normalizedUrl)
    && !/passport\.zhaopin\.com/i.test(normalizedUrl)
    && !/\/jobs?\//i.test(normalizedUrl);
}

async function waitForZhilianResumeDetailReady(page: Page, options: { deadline?: number; timeoutMs?: number } = {}): Promise<void> {
  const deadline = options.deadline ?? createDeadline(options.timeoutMs);
  await page.waitForLoadState('domcontentloaded');
  await assertZhilianAuthenticated(page);

  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (!waitForFunction) {
    return;
  }

  await waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const hasResumeDetailModal = Boolean(document.querySelector('.km-modal__wrapper.new-shortcut-resume__modal'))
        || Boolean(document.querySelector('.resume-detail-wrap'))
        || Boolean(document.querySelector('.new-shortcut-resume__inner'));
      return hasResumeDetailModal && /工作经历|教育经历|项目经历|求职意向|个人优势|自我评价|简历/.test(bodyText);
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );
}

async function readZhilianResumeDetailText(page: Page): Promise<string> {
  for (const selector of zhilianResumeDetailSelectors) {
    try {
      const text = await page.locator(selector).first().innerText();
      if (normalizeText(text)) {
        return text;
      }
    } catch {
      continue;
    }
  }

  return page.locator('body').innerText();
}

function normalizePreservingLines(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim();
}

function splitResumeLines(value: string): string[] {
  return normalizePreservingLines(value)
    .split('\n')
    .map(normalizeText)
    .filter(Boolean);
}

function collectSection(lines: string[], startTitles: string[], stopTitles: string[]): string[] {
  const startIndex = lines.findIndex((line) => startTitles.includes(line));
  if (startIndex === -1) {
    return [];
  }

  const section: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (stopTitles.includes(line)) {
      break;
    }
    section.push(line);
  }

  return section;
}

function parseZhilianWorkExperiences(lines: string[], fallbackCompany?: string, fallbackTitle?: string): WorkExperience[] {
  const workLines = collectSection(lines, ['工作经历'], ['项目经历', '项目经验', '教育经历', '教育背景', '技能', '语言能力', '证书', '个人优势', '自我评价']);
  if (workLines.length === 0 && (fallbackCompany || fallbackTitle)) {
    return [{ company: fallbackCompany, title: fallbackTitle, details: [] }];
  }

  return workLines.length > 0
    ? [{ company: fallbackCompany, title: fallbackTitle, details: workLines.filter((line) => !resumeSectionTitles.includes(line)) }]
    : [];
}

function parseZhilianEducationExperiences(lines: string[], fallbackEducation?: string): EducationExperience[] {
  const educationLines = collectSection(lines, ['教育经历', '教育背景'], ['技能', '语言能力', '证书', '个人优势', '自我评价']);
  if (educationLines.length === 0) {
    return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
  }

  return [{ degree: fallbackEducation, details: educationLines.filter((line) => !resumeSectionTitles.includes(line)) }];
}

function parseZhilianCertificates(lines: string[]): string[] {
  return collectSection(lines, ['证书'], ['个人优势', '自我评价']).filter((line) => !resumeSectionTitles.includes(line));
}

export const zhilianAdapter: PlatformAdapter = {
  platform: 'zhilian',
  displayName: 'Zhilian',
  subscribeSearchUrl: zhilianAuthenticatedHomeUrl,
  loginUrl: zhilianLoginUrl,
  storageStateFileName: 'storage-state.zhilian.json',
  openLoginPage: async (page) => {
    await page.goto(zhilianLoginUrl, { waitUntil: 'domcontentloaded' });
  },
  openAuthenticatedHome: async (page) => {
    await openZhilianRecruiterHome(page);
    return page;
  },
  assertAuthenticated: assertZhilianAuthenticated,
  openSubscribeSearch: async (page, keyword, options) => {
    const deadline = createSearchDeadline(options);
    clearObservedZhilianCandidateApi(page);
    attachZhilianCandidateApiObserver(page);
    await openZhilianRecruiterHome(page, { deadline });
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (options?.includeViewedCandidates) {
      await ensureZhilianViewedFilterClearedForQuickSearch(page, keyword, deadline);
    }
    return page;
  },
  prepareSearchConditionPage: prepareZhilianSearchConditionPage,
  readSearchConditionResultTotal: readZhilianSearchConditionResultTotal,
  saveSearchCondition: async (page, savedSearchName) => {
    await saveSearchConditionByCommonDialog(page, savedSearchName, {
      platformLabel: 'zhilian',
      platform: zhilianPlatform,
    });
    await waitForZhilianRecruiterShell(page);
  },
  extractCandidateList: async (page, options) => {
    const deadline = createSearchDeadline(options);
    attachZhilianCandidateApiObserver(page);
    await waitForZhilianRecruiterShell(page, { deadline });

    const domCandidates = await collectZhilianCards(page);
    if (domCandidates.length > 0) {
      return { candidates: domCandidates };
    }

    while (Date.now() <= deadline) {
      const apiCandidates = await waitForZhilianCandidateApi(
        page,
        boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs),
      ).catch(() => []);
      if (apiCandidates.length > 0) {
        return { candidates: apiCandidates };
      }

      const nextDomCandidates = await collectZhilianCards(page);
      if (nextDomCandidates.length > 0) {
        return { candidates: nextDomCandidates };
      }

      if (await hasZhilianExplicitEmptyResults(page)) {
        return { candidates: [] };
      }

      if (observedZhilianSearchApiSeenPages.has(page)) {
        return { candidates: [] };
      }
    }

    return { candidates: observedZhilianSearchApiCandidates.get(page) ?? [] };
  },
  openResumeDetail: async (context, searchPage, candidate) => {
    const deadline = createDeadline();
    await closeExistingZhilianResumeModal(searchPage);

    let clicked = await clickZhilianSearchResultCard(searchPage, candidate, deadline);
    if (!clicked) {
      try {
        const candidateLink = searchPage.locator(`${zhilianCandidateLinkSelector}[href*="${candidate.candidateId}"]`).first();
        await candidateLink.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
        await clickPlatformLocator(candidateLink, searchPage, zhilianPlatform, remainingTime(deadline));
        clicked = true;
      } catch {
        clicked = false;
      }
    }

    if (!clicked) {
      throw new Error(`Could not open Zhilian resume detail for candidate ${candidate.candidateId}.`);
    }

    await waitForZhilianResumeDetailReady(searchPage, { deadline });
    return searchPage;
  },
  parseResumeDetail: async (page, candidate): Promise<CandidateResume> => {
    await waitForZhilianResumeDetailReady(page, { timeoutMs: Math.min(config.playwright.resumeDetailTimeoutMs, 1000) });
    const bodyRawText = await readZhilianResumeDetailText(page);
    const candidateShareUrl = await copyZhilianColleagueForwardLink(page);
    const lines = splitResumeLines(bodyRawText);
    const education = lines.find((line) => /博士|硕士|本科|大专|中专|高中/.test(line));
    const regionLine = lines.find((line) => /期望城市|现居住地|所在地|工作地点|居住地/.test(line));
    const company = candidate.currentCompany ?? lines.find((line) => /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line));
    const title = candidate.currentTitle ?? lines.find((line) => /工程师|经理|主管|顾问|销售|总监|专员|运营|设计师|分析师|店长|讲师/.test(line));

    return {
      candidateId: candidate.candidateId || extractZhilianCandidateIdFromText(page.url()) || candidate.candidateId,
      resumeUrl: candidate.resumeUrl ?? page.url(),
      candidateShareUrl,
      name: candidate.name ?? lines.find((line) => /^[一-龥A-Za-z·]{2,20}$/.test(line) && !/简历|男|女|本科|硕士|博士|大专|中专/.test(line)),
      education,
      regions: regionLine ? [regionLine] : [],
      pr: [],
      workExperiences: parseZhilianWorkExperiences(lines, company, title),
      projectExperiences: [],
      educationExperiences: parseZhilianEducationExperiences(lines, education),
      skill: [],
      certificates: parseZhilianCertificates(lines),
    };
  },
};

export const zhilianTestExports = {
  parseZhilianApiCandidates,
  extractZhilianCandidateIdFromText,
  extractZhilianCardsInPage,
  parseZhilianDomCandidateSnapshots,
  parseZhilianVueCandidateSnapshots,
  clearZhilianUnviewedFilter,
  hasAppliedZhilianQuickSearchKeyword,
  isZhilianQuickSearchApplied,
  listVisibleZhilianQuickSearchTags,
};
