import type { BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { clickPlatformLocator } from '../browser/pacing.js';
import {
  clickFirstVisibleText,
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../search/page-actions.js';
import {
  buildSearchFilterDiscoveryStats,
  createEmptySearchFilterCatalog,
  type SearchFilterCatalog,
  type SearchFilterControlSnapshot,
  type SearchFilterDefinition,
  type SearchFilterDiscoveryRunOptions,
  type SearchFilterOption,
  type SearchFilterOptionInputSpec,
} from '../search/filter-catalog.js';
import type {
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  SearchCondition,
  SearchConditionApplyResult,
  WorkExperience,
} from '../types/job.js';
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
const zhilianOtherFilterLabels = [
  '活跃日期',
  '性别要求',
  '求职状态',
  '现居住地',
  '期望月薪',
  '期望职位',
  '从事职位',
  '从事行业',
  '期望行业',
  '户口所在地',
  '语言能力',
  '人才类型',
  '人才照片',
  '简历语言',
  '跳槽频率',
];
const zhilianOtherFilterIndexByLabel = new Map(zhilianOtherFilterLabels.map((label, index) => [label, index]));
const zhilianSimpleDropdownFilterLabels = new Set([
  '活跃日期',
  '性别要求',
  '求职状态',
  '人才类型',
  '人才照片',
  '简历语言',
  '跳槽频率',
]);
const zhilianComplexCascaderFilterLabels = [
  '现居住地',
  '户口所在地',
  '从事行业',
  '期望行业',
  '从事职位',
  '期望职位',
] as const;
const zhilianApplicationFilterBasicLabelsByFieldId: Record<string, string[]> = {
  education: ['学历要求'],
  work_years: ['经验要求'],
  school_nature: ['院校要求'],
  age: ['年龄要求'],
};
const zhilianBasicCustomSelectRangeInputSpecByLabel: Record<string, SearchFilterOptionInputSpec> = {
  学历要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低学历' },
      { key: 'max', valueType: 'string', label: '最高学历' },
    ],
  },
  经验要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低经验' },
      { key: 'max', valueType: 'string', label: '最高经验' },
    ],
  },
};
const zhilianAgePresetLabels = new Set(['20-25', '25-30', '30-35', '35-40', '40以上']);
const zhilianApplicationFilterDropdownLabelsByFieldId: Record<string, string> = {
  recent_activity_time: '活跃日期',
  gender: '性别要求',
  job_status: '求职状态',
  talent_type: '人才类型',
  talent_photo: '人才照片',
  resume_language: '简历语言',
  job_hopping_count: '跳槽频率',
};
const zhilianApplicationFilterCascaderLabelsByFieldId: Record<string, string> = {
  living_location: '现居住地',
  hukou_location: '户口所在地',
  engaged_industry: '从事行业',
  expected_industry: '期望行业',
  engaged_function: '从事职位',
  expected_function: '期望职位',
};
const zhilianAppliedConditionLabelsByFieldId: Record<string, string[]> = {
  education: ['学历要求'],
  work_years: ['经验要求'],
  age: ['年龄要求'],
  language: ['语言能力'],
  living_location: ['现居住地'],
  hukou_location: ['户口所在地'],
  engaged_industry: ['从事行业'],
  expected_industry: ['期望行业'],
  engaged_function: ['从事职业', '从事职位'],
  expected_function: ['期望职位'],
};
const zhilianSupportedApplicationFilterFieldIds = new Set([
  ...Object.keys(zhilianApplicationFilterBasicLabelsByFieldId),
  ...Object.keys(zhilianApplicationFilterDropdownLabelsByFieldId),
  ...Object.keys(zhilianApplicationFilterCascaderLabelsByFieldId),
  'language',
  'expected_salary',
]);

type ZhilianDynamicFilterOptions = {
  options: SearchFilterOption[];
  controlType?: SearchFilterDefinition['controlType'];
  valueShape?: SearchFilterDefinition['valueShape'];
  childrenLazy?: boolean;
  inputPlaceholder?: string;
  message?: string;
};

type ZhilianTextInputApplicationFilterValueEntry = {
  value: string;
  pathLabels?: string[];
};

type ZhilianCustomSelectRangeInput = {
  min: string;
  max: string;
};

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

function normalizeApplicationFilterValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' ? normalizeText(value) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isApplicationFilterCondition(condition: SearchCondition): condition is Extract<SearchCondition, { kind: 'applicationFilter' }> {
  return condition.kind === 'applicationFilter'
    && typeof condition.fieldId === 'string'
    && typeof condition.label === 'string'
    && typeof condition.fieldKind === 'string';
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
  return error instanceof Error && /net::ERR_ABORTED|Navigation aborted|frame was detached|Execution context was destroyed/i.test(error.message);
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

function compactZhilianFilterText(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function formatZhilianSalaryRange(min: string, max: string): string {
  return `${compactZhilianFilterText(min)}-${compactZhilianFilterText(max)}`;
}

function matchesZhilianSalaryRange(text: string, min: string, max: string): boolean {
  const compactText = compactZhilianFilterText(text);
  const expected = formatZhilianSalaryRange(min, max);
  return compactText === expected
    || compactText.includes(`期望月薪：${expected}`)
    || compactText.includes(`期望月薪:${expected}`);
}

async function readZhilianExpectedSalarySelectionTexts(page: Page): Promise<string[]> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBodyText = normalizeText(bodyText);
  const texts = Array.from(normalizedBodyText.matchAll(/期望月薪[:：]\s*([^\s]+)/g))
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);

  const salaryControlTexts = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };

    return Array.from(document.querySelectorAll('.search-salary'))
      .filter(isVisible)
      .map((element) => normalize(element.textContent))
      .filter(Boolean);
  }).catch(() => []);

  if (Array.isArray(salaryControlTexts)) {
    texts.push(...salaryControlTexts);
  }

  return [...new Set(texts.map(normalizeText).filter(Boolean))];
}

function buildZhilianAppliedFilterValueCandidates(value: string): string[] {
  const compactValue = compactZhilianFilterText(value);
  const candidates = [value];

  if (compactValue.startsWith('全') && compactValue.length > 1) {
    candidates.push(compactValue.slice(1));
  }

  return [...new Set(candidates.map(normalizeText).filter(Boolean))];
}

function buildZhilianAppliedFilterValueCandidatesForEntry(
  entry: ZhilianTextInputApplicationFilterValueEntry,
): string[] {
  const values = [entry.value];
  const lastPathLabel = entry.pathLabels?.at(-1);
  if (lastPathLabel) {
    values.push(lastPathLabel);
  }

  return [...new Set(values.flatMap(buildZhilianAppliedFilterValueCandidates))];
}

function matchesZhilianAppliedConditionValue(bodyText: string, labels: string[], valueCandidates: string[]): boolean {
  const compactBodyText = compactZhilianFilterText(bodyText);
  return labels.some((label) => {
    const compactLabel = compactZhilianFilterText(label);
    return valueCandidates.some((value) => {
      const compactValue = compactZhilianFilterText(value);
      return compactBodyText.includes(`${compactLabel}：${compactValue}`)
        || compactBodyText.includes(`${compactLabel}:${compactValue}`);
    });
  });
}

function readZhilianAppliedConditionObservations(bodyText: string, labels: string[]): string[] {
  const normalizedBodyText = normalizeText(bodyText);
  const observations = labels.flatMap((label) => {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*([^\\s]+)`, 'g');
    return Array.from(normalizedBodyText.matchAll(pattern))
      .map((match) => `${label}：${normalizeText(match[1])}`)
      .filter(Boolean);
  });

  return [...new Set(observations)];
}

async function assertZhilianAppliedConditionValues(
  page: Page,
  fieldId: string,
  valueCandidateGroups: string[][],
): Promise<void> {
  const labels = zhilianAppliedConditionLabelsByFieldId[fieldId];
  const candidateGroups = valueCandidateGroups
    .map((group) => [...new Set(group.map(normalizeText).filter(Boolean))])
    .filter((group) => group.length > 0 && !group.some((value) => value === '不限'));
  if (!labels || candidateGroups.length === 0) {
    return;
  }

  let lastBodyText = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastBodyText = await page.locator('body').innerText().catch(() => '');
    if (candidateGroups.every((group) => matchesZhilianAppliedConditionValue(lastBodyText, labels, group))) {
      return;
    }

    await page.waitForTimeout(zhilianSearchStatePollMs).catch(() => undefined);
  }

  const observed = readZhilianAppliedConditionObservations(lastBodyText, labels);
  const expected = candidateGroups.map((group) => group.join('/')).join(', ');
  throw new Error(`Zhilian ${labels[0]} did not apply ${expected}. Observed: ${observed.join(', ') || '(none)'}.`);
}

async function isZhilianAppliedConditionValues(
  page: Page,
  fieldId: string,
  valueCandidateGroups: string[][],
): Promise<boolean> {
  const labels = zhilianAppliedConditionLabelsByFieldId[fieldId];
  if (!labels) {
    return false;
  }

  const candidateGroups = valueCandidateGroups
    .map((group) => [...new Set(group.map(normalizeText).filter(Boolean))])
    .filter((group) => group.length > 0 && !group.some((value) => value === '不限'));
  if (candidateGroups.length === 0) {
    return true;
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  return candidateGroups.every((group) => matchesZhilianAppliedConditionValue(bodyText, labels, group));
}

async function isZhilianExpectedSalaryApplied(page: Page, min: string, max: string): Promise<boolean> {
  const texts = await readZhilianExpectedSalarySelectionTexts(page);
  return texts.some((text) => matchesZhilianSalaryRange(text, min, max));
}

async function assertZhilianExpectedSalaryApplied(page: Page, min: string, max: string): Promise<void> {
  const texts = await readZhilianExpectedSalarySelectionTexts(page);
  if (texts.some((text) => matchesZhilianSalaryRange(text, min, max))) {
    return;
  }

  throw new Error(`Zhilian expected salary did not apply ${formatZhilianSalaryRange(min, max)}. Observed: ${texts.join(', ') || '(none)'}.`);
}

function hasAppliedZhilianQuickSearchKeyword(bodyText: string, keyword: string): boolean {
  const normalizedText = normalizeText(bodyText);
  const keywordPattern = keywordToLoosePattern(keyword);
  const appliedKeywordMatch = normalizedText.match(/关键词[:：]\s*([^:：]*?)(?:\s+(?:学历要求|经验要求|年龄要求|期望月薪|活跃日期|期望职位|从事职业|从事行业|期望行业|现居住地|户口所在地|语言能力|性别要求|求职状态|人才类型|人才照片|简历语言|跳槽频率|保存为快捷搜索|今日搜索聊剩|综合排序|未看过|未聊过|近一段工作相关|其他过滤条件)|$)/);
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

async function clickSavedZhilianQuickSearchTag(
  page: Page,
  keyword: string,
  deadline: number,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && await isZhilianQuickSearchApplied(page, keyword)) {
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
    if (options.force && await isZhilianQuickSearchApplied(page, keyword)) {
      return;
    }

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

async function prepareZhilianSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await clickSavedZhilianQuickSearchTag(page, keyword, deadline, { force: true });
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true });
  return page;
}

async function ensureZhilianSearchConditionPanelOpen(
  page: Page,
  deadline: number,
  options: { expandMore?: boolean } = {},
): Promise<void> {
  const panel = page.locator('.search-condition-panel-new').first();
  const hasVisiblePanel = await panel.waitFor({
    state: 'visible',
    timeout: Math.min(1000, remainingTime(deadline)),
  }).then(() => true).catch(() => false);

  if (!hasVisiblePanel) {
    const advancedTriggers = [
      page.locator('button:has-text("使用高级搜索")').first(),
      page.locator('[role="button"]:has-text("使用高级搜索")').first(),
      page.locator('[class*="advanced"]:has-text("使用高级搜索")').first(),
      page.getByText('使用高级搜索', { exact: true }).first(),
    ];

    let clicked = false;
    for (const trigger of advancedTriggers) {
      try {
        await trigger.waitFor({ state: 'visible', timeout: Math.min(1000, remainingTime(deadline)) });
        await clickPlatformLocator(trigger, page, zhilianPlatform, Math.min(1000, remainingTime(deadline)));
        clicked = true;
        break;
      } catch {
        continue;
      }
    }

    if (!clicked) {
      throw new Error('Could not find the Zhilian advanced-search trigger.');
    }

    await panel.waitFor({ state: 'visible', timeout: Math.min(2000, remainingTime(deadline)) });
  }

  if (!options.expandMore) {
    return;
  }

  const panelText = await panel.innerText({ timeout: Math.min(1000, remainingTime(deadline)) }).catch(() => '');
  if (/户口所在地|语言能力|人才类型|人才照片|简历语言|跳槽频率/.test(panelText)) {
    return;
  }

  const moreTriggers = [
    panel.locator('.filter-other-trigger.filter-other__item').first(),
    panel.locator('[class*="filter-other-trigger"]:has-text("更多筛选")').first(),
    panel.locator('.filter-other__item:has-text("更多筛选")').first(),
    panel.getByText('更多筛选', { exact: true }).first(),
  ];

  for (const trigger of moreTriggers) {
    try {
      await trigger.waitFor({ state: 'visible', timeout: Math.min(1000, remainingTime(deadline)) });
      await clickPlatformLocator(trigger, page, zhilianPlatform, Math.min(1000, remainingTime(deadline)));
      await page.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
      return;
    } catch {
      continue;
    }
  }
}

async function closeBlockingZhilianFilterDiscoveryDialogs(page: Page): Promise<void> {
  const blockingDialog = page.locator([
    '.km-modal__wrapper.required-hide-age-modal',
    '.km-modal__wrapper:has-text("隐藏年龄")',
    '.km-modal__wrapper:has-text("年龄")',
  ].join(', ')).filter({ visible: true }).first();

  if (await blockingDialog.count().catch(() => 0) === 0) {
    return;
  }

  const closeControl = blockingDialog.locator([
    '.km-modal__close',
    '[aria-label="关闭"]',
    '[class*="close"]',
    'button:has-text("取消")',
    'button:has-text("知道了")',
    'button:has-text("确定")',
  ].join(', ')).filter({ visible: true }).first();

  try {
    await clickPlatformLocator(closeControl, page, zhilianPlatform, 1000);
  } catch {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

function buildZhilianFilterDiscoveryHaystack(control: SearchFilterControlSnapshot): string {
  return normalizeText([
    control.label,
    control.text,
    control.placeholder,
    control.containerText,
    control.cssPath,
  ].join(' '));
}

function shouldIncludeZhilianFilterDiscoveryControl(control: SearchFilterControlSnapshot): boolean {
  return /学历要求|年龄要求|经验要求|院校要求|其他筛选|性别要求|求职状态|现居住地|期望月薪|期望职位|从事职位|从事行业|期望行业|更多筛选|户口所在地|语言能力|人才类型|人才照片|简历语言|跳槽频率/.test(
    buildZhilianFilterDiscoveryHaystack(control),
  );
}

function shouldIgnoreZhilianFilterDiscoveryControl(control: SearchFilterControlSnapshot): boolean {
  const haystack = buildZhilianFilterDiscoveryHaystack(control);
  if (/快捷搜索|猜你想搜|搜公司、职位、专业、学校、行业、技能等|搜索$|清空筛选/.test(haystack)) {
    return true;
  }
  return /推荐|职位管理|简历管理|聊天|个人中心|打电话|打招呼|候选人|简历列表|第\d+页|共\d+条/.test(haystack);
}

function buildZhilianFilterKey(label: string, index: number): string {
  const normalizedLabel = normalizeText(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `zhilian-${normalizedLabel || 'filter'}-${index + 1}`;
}

function uniqueZhilianFilterOptions(values: string[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const value of values.map((item) => normalizeText(item)).filter(Boolean)) {
    const normalized = value.replace(/·\d+$/g, '').replace(/\s+/g, '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    options.push(value);
  }

  return options;
}

function uniqueZhilianFilterOptionObjects(options: SearchFilterOption[]): SearchFilterOption[] {
  const seen = new Set<string>();
  const uniqueOptions: SearchFilterOption[] = [];

  for (const option of options) {
    const label = normalizeText(option.label);
    const value = normalizeText(option.value) || label;
    if (!label && !value) {
      continue;
    }

    const pathLabels = (option.pathLabels ?? []).map(normalizeText).filter(Boolean);
    const parentPathLabels = (option.parentPathLabels ?? []).map(normalizeText).filter(Boolean);
    const dedupeKey = [
      option.depth ?? 0,
      value,
      pathLabels.length > 0 ? pathLabels.join('\u0000') : label,
    ].join('\u0001');
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    uniqueOptions.push({
      label: label || value,
      value,
      depth: option.depth,
      disabled: option.disabled,
      selected: option.selected,
      parentPathLabels: parentPathLabels.length > 0 ? parentPathLabels : undefined,
      pathLabels: pathLabels.length > 0 ? pathLabels : undefined,
      message: option.message,
      inputSpec: option.inputSpec,
    });
  }

  return uniqueOptions;
}

function buildZhilianStringFilterOptions(values: string[]): SearchFilterOption[] {
  return uniqueZhilianFilterOptions(values).map((option) => ({
    label: option,
    value: option,
    selected: /\b(active|selected|checked)\b/i.test(option) || undefined,
  }));
}

function withZhilianBasicCustomInputSpecs(label: string, options: SearchFilterOption[]): SearchFilterOption[] {
  const inputSpec = zhilianBasicCustomSelectRangeInputSpecByLabel[label];
  if (!inputSpec) {
    return options;
  }

  return options.map((option) => (
    compactZhilianFilterText(option.label) === '自定义'
      ? { ...option, inputSpec }
      : option
  ));
}

function buildZhilianStaticFilterDefinition(
  row: { label: string; options: string[]; selectorHint?: string },
  index: number,
  dynamicOptions?: ZhilianDynamicFilterOptions,
): SearchFilterDefinition {
  const staticOptions = buildZhilianStringFilterOptions(row.options).filter((option) => option.label !== row.label);
  const options = uniqueZhilianFilterOptionObjects(
    withZhilianBasicCustomInputSpecs(row.label, dynamicOptions?.options ?? staticOptions),
  );
  const isRange = /年龄|薪/.test(row.label);
  const controlType = dynamicOptions?.controlType ?? (isRange ? 'rangeInput' : options.length > 0 ? 'singleSelect' : 'unknown');
  const valueShape = dynamicOptions?.valueShape ?? (isRange ? 'range' : options.length > 0 ? 'string' : 'string');

  return {
    key: buildZhilianFilterKey(row.label, index),
    label: row.label,
    controlType,
    valueShape,
    status: options.length > 0 ? 'optionsExtracted' : 'inspected',
    options: options.length > 0 ? options : undefined,
    selectorHints: [
      { kind: 'text', value: row.label },
      ...(row.selectorHint ? [{ kind: 'cssPath' as const, value: row.selectorHint }] : []),
    ],
    inputPlaceholder: dynamicOptions?.inputPlaceholder,
    childrenLazy: dynamicOptions?.childrenLazy,
    message: dynamicOptions?.message ?? 'Captured from the visible Zhilian search-condition panel.',
  };
}

async function collectZhilianOtherFilterPopupOptions(
  page: Page,
  label: string,
  kind: 'select' | 'salary',
  deadline: number,
): Promise<string[]> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    return [];
  }

  const options = await page.evaluate(async ({ targetIndex, targetLabel, targetKind }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readOtherLabel = (element: Element): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim();
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const unique = (values: string[]): string[] => {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const value of values.map(normalizeText).filter(Boolean)) {
        const dedupeKey = value.replace(/\s+/g, '');
        if (!dedupeKey || seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        result.push(value);
      }
      return result;
    };

    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const item = otherItems[targetIndex] ?? otherItems.find((candidate) => readOtherLabel(candidate) === targetLabel);
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return [];
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 350));

    const popupSelectors = [
      '.km-popover',
      '.km-popper',
      '.km-select__dropdown-wrapper',
      '.search-salary-popover',
      '[role="listbox"]',
    ];
    const popups = Array.from(document.querySelectorAll(popupSelectors.join(', '))).filter(isVisible);
    const optionSelector = targetKind === 'salary'
      ? '.search-salary_list-item span'
      : '.km-option__label';
    const values = popups.flatMap((popup) => Array.from(popup.querySelectorAll(optionSelector))
      .filter(isVisible)
      .map((node) => normalizeText(node.textContent)));

    return unique(values);
  }, { targetIndex, targetLabel: label, targetKind: kind }).catch(() => []);

  await closeZhilianVisibleFilterPopups(page, deadline);
  return options;
}

async function closeZhilianVisibleFilterPopups(page: Page, deadline: number): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.evaluate(async () => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const dialogs = Array.from(document.querySelectorAll('.s-dialog, .km-modal, [role="dialog"]'))
      .filter(isVisible)
      .reverse();
    for (const dialog of dialogs) {
      const controls = Array.from(dialog.querySelectorAll([
        'button',
        '.s-dialog__close',
        '.km-modal__close',
        '.s-button',
        '[class*="close"]',
        '[class*="cancel"]',
      ].join(', '))).filter(isVisible);
      const cancelControl = controls.find((node) => /取消|关闭|×/.test(
        normalizeText(node.textContent)
          || normalizeText(node.getAttribute('aria-label'))
          || normalizeText(node.getAttribute('title')),
      )) ?? controls.at(-1);
      if (cancelControl) {
        dispatchClick(cancelControl);
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
    }
  }).catch(() => undefined);
  await page.waitForTimeout(Math.min(150, remainingTime(deadline))).catch(() => undefined);
}

async function collectZhilianCascaderFilterOptions(
  page: Page,
  label: string,
  deadline: number,
): Promise<ZhilianDynamicFilterOptions | undefined> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    return undefined;
  }

  const result = await page.evaluate(async ({ targetIndex, targetLabel, otherFilterLabels }) => {
    const normalizeText = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
      }
      if (value === null || value === undefined) {
        return '';
      }
      return String(value).replace(/\s+/g, ' ').trim();
    };
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const readOtherLabel = (element: Element, index: number): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim() || otherFilterLabels[index] || '';
    const readChildren = (node: Record<string, unknown>): unknown[] => {
      for (const key of ['children', 'childList', 'list', 'items']) {
        const value = node[key];
        if (Array.isArray(value)) {
          return value;
        }
      }
      return [];
    };
    const readLabel = (node: Record<string, unknown>): string => {
      for (const key of ['label', 'name', 'title', 'text', 'fullName']) {
        const value = normalizeText(node[key]);
        if (value) {
          return value;
        }
      }
      return '';
    };
    const readValue = (node: Record<string, unknown>, fallback: string): string => {
      for (const key of ['value', 'id', 'code', 'serial']) {
        const value = normalizeText(node[key]);
        if (value) {
          return value;
        }
      }
      return fallback;
    };
    const pushOption = (
      node: unknown,
      parentPathLabels: string[],
      depth: number,
      options: SearchFilterOption[],
    ): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return;
      }

      const record = node as Record<string, unknown>;
      const optionLabel = readLabel(record);
      if (!optionLabel) {
        return;
      }

      const pathLabels = [...parentPathLabels, optionLabel];
      const children = readChildren(record);
      options.push({
        label: optionLabel,
        value: readValue(record, optionLabel),
        depth,
        disabled: Boolean(record.disabled),
        selected: Boolean(record.selected),
        parentPathLabels: parentPathLabels.length > 0 ? parentPathLabels : undefined,
        pathLabels,
      });

      for (const child of children) {
        pushOption(child, pathLabels, depth + 1, options);
      }
    };
    const uniqueOptions = (options: SearchFilterOption[]): SearchFilterOption[] => {
      const seen = new Set<string>();
      const result: SearchFilterOption[] = [];
      for (const option of options) {
        const key = [
          option.depth ?? 0,
          option.value ?? option.label,
          (option.pathLabels ?? [option.label]).join('\u0000'),
        ].join('\u0001');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(option);
      }
      return result;
    };

    let otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    if (!otherItems.some((item, index) => readOtherLabel(item, index) === targetLabel)) {
      const moreTrigger = Array.from(document.querySelectorAll('.filter-other-trigger, .filter-other-wrap__content .filter-other__item'))
        .find((item) => /更多筛选/.test(normalizeText(item.textContent)));
      if (moreTrigger instanceof HTMLElement) {
        dispatchClick(moreTrigger);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
        .filter((item) => !item.classList.contains('filter-other-trigger'));
    }

    const item = otherItems[targetIndex] ?? otherItems.find((candidate, index) => readOtherLabel(candidate, index) === targetLabel);
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return undefined;
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 650));

    const visibleCascader = Array.from(document.querySelectorAll('.s-cascader')).filter(isVisible).at(-1);
    const propsData = (
      visibleCascader as (HTMLElement & {
        __vue__?: {
          $options?: { propsData?: Record<string, unknown> };
          $props?: Record<string, unknown>;
        };
      }) | undefined
    )?.__vue__?.$options?.propsData ?? (
      visibleCascader as (HTMLElement & {
        __vue__?: {
          $props?: Record<string, unknown>;
        };
      }) | undefined
    )?.__vue__?.$props ?? {};
    const rootOptions = Array.isArray(propsData.options) ? propsData.options : [];
    if (rootOptions.length === 0) {
      return undefined;
    }

    const options: SearchFilterOption[] = [];
    for (const option of rootOptions) {
      pushOption(option, [], 0, options);
    }

    const dialog = Array.from(document.querySelectorAll('.s-dialog, [role="dialog"]')).filter(isVisible).at(-1);
    const inputPlaceholder = normalizeText(dialog?.querySelector('input[placeholder]')?.getAttribute('placeholder'));

    return {
      options: uniqueOptions(options),
      inputPlaceholder,
    };
  }, {
    targetIndex,
    targetLabel: label,
    otherFilterLabels: zhilianOtherFilterLabels,
    targetKind: 'cascader',
  }).catch(() => undefined);

  await closeZhilianVisibleFilterPopups(page, deadline);

  if (!result || !Array.isArray(result.options) || result.options.length === 0) {
    return undefined;
  }

  return {
    options: result.options,
    controlType: 'textInput',
    valueShape: 'string',
    childrenLazy: false,
    inputPlaceholder: result.inputPlaceholder || undefined,
    message: `Captured the full Zhilian ${label} cascader tree from Vue component props.`,
  };
}

async function collectZhilianLanguageFilterOptions(
  page: Page,
  deadline: number,
): Promise<ZhilianDynamicFilterOptions | undefined> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get('语言能力');
  if (targetIndex === undefined) {
    return undefined;
  }

  const values = await page.evaluate(async ({ targetIndex, otherFilterLabels }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const readOtherLabel = (element: Element, index: number): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim() || otherFilterLabels[index] || '';
    const unique = (options: string[]): string[] => {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const option of options.map(normalizeText).filter(Boolean)) {
        const key = option.replace(/\s+/g, '');
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(option);
      }
      return result;
    };

    let otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    if (!otherItems.some((item, index) => readOtherLabel(item, index) === '语言能力')) {
      const moreTrigger = Array.from(document.querySelectorAll('.filter-other-trigger, .filter-other-wrap__content .filter-other__item'))
        .find((item) => /更多筛选/.test(normalizeText(item.textContent)));
      if (moreTrigger instanceof HTMLElement) {
        dispatchClick(moreTrigger);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
        .filter((item) => !item.classList.contains('filter-other-trigger'));
    }

    const item = otherItems[targetIndex] ?? otherItems.find((candidate, index) => readOtherLabel(candidate, index) === '语言能力');
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!(trigger instanceof HTMLElement)) {
      return [];
    }

    dispatchClick(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 650));

    const popover = Array.from(document.querySelectorAll('.search-language-popover, .km-popover.search-language-popover'))
      .filter(isVisible)
      .at(-1);
    const values = Array.from(popover?.querySelectorAll('.search-language-popover__item-text, .search-language-popover__item') ?? [])
      .filter(isVisible)
      .map((node) => normalizeText(node.textContent));
    return unique(values);
  }, {
    targetIndex,
    otherFilterLabels: zhilianOtherFilterLabels,
    targetKind: 'language',
  }).catch(() => []);

  await closeZhilianVisibleFilterPopups(page, deadline);

  const options = buildZhilianStringFilterOptions(values);
  if (options.length === 0) {
    return undefined;
  }

  return {
    options,
    controlType: 'singleSelect',
    valueShape: 'string',
    message: 'Captured from the Zhilian language ability popover.',
  };
}

async function collectZhilianDynamicSearchFilterOptions(
  page: Page,
  deadline: number,
): Promise<Map<string, ZhilianDynamicFilterOptions>> {
  const optionTargets = [
    ...Array.from(zhilianSimpleDropdownFilterLabels).map((label) => ({ label, kind: 'select' as const })),
    { label: '期望月薪', kind: 'salary' as const },
  ];
  const optionsByLabel = new Map<string, ZhilianDynamicFilterOptions>();

  for (const target of optionTargets) {
    if (remainingTime(deadline) <= 500) {
      break;
    }

    const options = await collectZhilianOtherFilterPopupOptions(page, target.label, target.kind, deadline);
    if (options.length > 0) {
      optionsByLabel.set(target.label, {
        options: buildZhilianStringFilterOptions(options),
        controlType: target.kind === 'salary' ? 'rangeInput' : 'singleSelect',
        valueShape: target.kind === 'salary' ? 'range' : 'string',
        message: target.kind === 'salary'
          ? 'Captured from the Zhilian salary popover.'
          : 'Captured from the Zhilian dropdown popover.',
      });
    }
  }

  for (const label of zhilianComplexCascaderFilterLabels) {
    if (remainingTime(deadline) <= 500) {
      break;
    }

    const options = await collectZhilianCascaderFilterOptions(page, label, deadline);
    if (options) {
      optionsByLabel.set(label, options);
    }
  }

  if (remainingTime(deadline) > 500) {
    const languageOptions = await collectZhilianLanguageFilterOptions(page, deadline);
    if (languageOptions) {
      optionsByLabel.set('语言能力', languageOptions);
    }
  }

  return optionsByLabel;
}

async function discoverZhilianStaticSearchFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterCatalog> {
  const deadline = options.deadline ?? createDeadline(options.globalTimeoutMs ?? config.playwright.searchPageTimeoutMs);
  await prepareZhilianSearchConditionPage(page, options.keyword, { deadline });
  await closeBlockingZhilianFilterDiscoveryDialogs(page);
  await ensureZhilianSearchConditionPanelOpen(page, deadline, { expandMore: true });

  const rows = await page.evaluate((otherFilterLabels) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const readOptions = (root: Element): string[] => Array.from(root.querySelectorAll([
      '.search-education-new__selector-item',
      '.search-education-new-custom__label',
      '.button-group__list-item',
      '.search-school-nature-new__item',
    ].join(', ')))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean);
    const basicRows = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .map((row) => {
        const label = normalizeText(row.querySelector('.search-label-wrapper-new__label')?.textContent);
        return {
          label,
          options: readOptions(row),
          selectorHint: '.filter-panel-new .search-label-wrapper-new',
        };
      })
      .filter((row) => row.label);
    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const otherRows = otherItems.map((item, index) => {
      const fallbackLabel = normalizeText(item.querySelector('.talent-search-other-label')?.textContent)
        .replace(/·\d+/g, '')
        .replace(/收起筛选|更多筛选/g, '')
        .trim();
      const label = otherFilterLabels[index] ?? fallbackLabel;
      const visibleText = normalizeText(item.querySelector('.talent-search-other-label')?.textContent)
        .replace(/·\d+/g, '')
        .trim();
      const options = visibleText && visibleText !== label ? [visibleText] : [];
      return {
        label,
        options,
        selectorHint: '.filter-other-wrap__content .filter-other__item',
      };
    }).filter((row) => row.label);

    return [...basicRows, ...otherRows];
  }, zhilianOtherFilterLabels);

  const dynamicOptions = options.slowClick
    ? await collectZhilianDynamicSearchFilterOptions(page, deadline)
    : new Map<string, ZhilianDynamicFilterOptions>();
  const filters = rows
    .map((row) => ({
      ...row,
      dynamicOptions: dynamicOptions.get(row.label),
    }))
    .map((row, index) => buildZhilianStaticFilterDefinition(row, index, row.dynamicOptions));
  return {
    ...createEmptySearchFilterCatalog('zhilian', options.keyword, page.url()),
    filters,
    failures: [],
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}

async function readZhilianSearchConditionResultTotal(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const deadline = createSearchDeadline(options);

  while (Date.now() <= deadline) {
    const bodyText = await page.locator('body').innerText();
    const resultTotal = parseSearchResultTotalFromText(bodyText);
    if (resultTotal !== undefined) {
      return {
        resultTotal,
        resultTotalSource: 'page',
      };
    }

    if (/没有符合条件的人才|没有搜索到相关的人才|暂无符合条件|暂无数据|未搜索到相关/.test(bodyText)) {
      return {
        resultTotal: 0,
        resultTotalSource: 'page',
      };
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  throw new Error('Search subscription on zhilian could not read the page result total.');
}

function readZhilianApplicationFilterSingleValue(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  const normalizedValue = isRecord(condition.value)
    ? normalizeApplicationFilterValue(condition.value.label)
    : normalizeApplicationFilterValue(condition.value);
  const conditionValue = normalizedValue || normalizeApplicationFilterValue(condition.values?.[0]?.value);
  if (!conditionValue) {
    throw new Error(`Missing value for Zhilian application filter: ${condition.fieldId}`);
  }

  if (conditionValue === '自定义' || (isRecord(condition.value) && isRecord(condition.value.input))) {
    throw new Error(`Zhilian application filter ${condition.fieldId} does not support custom input replay yet.`);
  }

  return conditionValue;
}

function readZhilianCustomSelectRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianCustomSelectRangeInput | undefined {
  if (!isRecord(condition.value) || !isRecord(condition.value.input)) {
    return undefined;
  }

  const min = normalizeApplicationFilterValue(condition.value.input.min);
  const max = normalizeApplicationFilterValue(condition.value.input.max);
  if (!min || !max) {
    throw new Error(`Zhilian application filter ${condition.fieldId} custom input requires non-empty min and max values.`);
  }

  return { min, max };
}

async function readZhilianBasicCustomRangeState(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<{
  matches: boolean;
  rowText: string;
  inputValues: string[];
  activeOptions: string[];
}> {
  return await page.evaluate(({ rowLabels, expectedMin, expectedMax }) => {
    const normalizeText = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const compact = (value: string | null | undefined): string => normalizeText(value).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
    const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible)
      .find((candidate) => {
        const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
        return normalizedRowLabels.includes(label);
      });
    const inputValues = Array.from(row?.querySelectorAll('.search-select-two-new .km-select input') ?? [])
      .filter(isVisible)
      .map((element) => normalizeText((element as HTMLInputElement).value || element.getAttribute('placeholder')))
      .filter((value) => value && value !== '不限');
    const activeOptions = Array.from(row?.querySelectorAll([
      '.search-education-new__selector-item-active',
      '.button-group__list-item-active',
    ].join(', ')) ?? [])
      .filter(isVisible)
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);

    return {
      matches: inputValues.length >= 2
        && compact(inputValues[0]) === compact(expectedMin)
        && compact(inputValues[1]) === compact(expectedMax),
      rowText: normalizeText(row?.textContent),
      inputValues,
      activeOptions,
    };
  }, {
    rowLabels,
    expectedMin: input.min,
    expectedMax: input.max,
  }).catch((error) => {
    if (isAbortNavigationError(error)) {
      return {
        matches: false,
        rowText: '',
        inputValues: [],
        activeOptions: [],
      };
    }

    throw error;
  });
}

async function isZhilianBasicCustomRangeApplied(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<boolean> {
  return (await readZhilianBasicCustomRangeState(page, rowLabels, input)).matches;
}

async function assertZhilianBasicCustomRangeApplied(
  page: Page,
  rowLabels: string[],
  input: ZhilianCustomSelectRangeInput,
): Promise<void> {
  let lastState: Awaited<ReturnType<typeof readZhilianBasicCustomRangeState>> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastState = await readZhilianBasicCustomRangeState(page, rowLabels, input);
    if (lastState.matches) {
      return;
    }

    await page.waitForTimeout(zhilianSearchStatePollMs).catch(() => undefined);
  }

  throw new Error(
    `Zhilian ${rowLabels[0]} custom range did not apply ${input.min}-${input.max}. `
    + `Observed inputs: ${(lastState?.inputValues ?? []).join(', ') || '(none)'}. `
    + `Active options: ${(lastState?.activeOptions ?? []).join(', ') || '(none)'}.`,
  );
}

function normalizeZhilianAgeBoundaryValue(value: unknown): string {
  const normalized = normalizeApplicationFilterValue(value);
  if (!normalized) {
    return '';
  }

  return /\d$/.test(normalized) ? `${normalized}岁` : normalized;
}

function toZhilianTextInputApplicationFilterValueEntry(
  value: string,
  pathLabels?: string[],
): ZhilianTextInputApplicationFilterValueEntry | undefined {
  if (!value || value === '不限') {
    return undefined;
  }

  const normalizedPathLabels = pathLabels?.map(normalizeApplicationFilterValue).filter(Boolean);
  return normalizedPathLabels && normalizedPathLabels.length > 0
    ? { value, pathLabels: normalizedPathLabels }
    : { value };
}

function readZhilianTextInputApplicationFilterValueEntries(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianTextInputApplicationFilterValueEntry[] {
  const rawValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  const entries = rawValues
    .map((value) => {
      const normalizedValue = isRecord(value)
        ? normalizeApplicationFilterValue(value.value) || normalizeApplicationFilterValue(value.label)
        : normalizeApplicationFilterValue(value);
      const pathLabels = isRecord(value) && Array.isArray(value.pathLabels)
        ? value.pathLabels.map((pathLabel) => normalizeApplicationFilterValue(pathLabel)).filter(Boolean)
        : undefined;
      return toZhilianTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is ZhilianTextInputApplicationFilterValueEntry => Boolean(value));

  if (entries.length > 0) {
    return entries;
  }

  return (condition.values ?? [])
    .map((value) => {
      const normalizedValue = normalizeApplicationFilterValue(value.value);
      const pathLabels = value.pathLabels
        ?.map((pathLabel) => normalizeApplicationFilterValue(pathLabel))
        .filter(Boolean);
      return toZhilianTextInputApplicationFilterValueEntry(normalizedValue, pathLabels);
    })
    .filter((value): value is ZhilianTextInputApplicationFilterValueEntry => Boolean(value));
}

function buildZhilianAgePresetLabel(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian age application filter requires { min, max } value.');
  }

  const min = normalizeApplicationFilterValue(condition.value.min);
  const max = normalizeApplicationFilterValue(condition.value.max);
  if (min && max) {
    return `${min}-${max}`;
  }

  if (min && !max) {
    return `${min}以上`;
  }

  throw new Error('Zhilian age application filter currently requires a preset-compatible min/max range.');
}

function readZhilianAgeCustomSelectRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): ZhilianCustomSelectRangeInput {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian age application filter requires { min, max } value.');
  }

  const min = normalizeZhilianAgeBoundaryValue(condition.value.min);
  const max = normalizeZhilianAgeBoundaryValue(condition.value.max) || '及以上';
  if (!min) {
    throw new Error('Zhilian age custom range requires a non-empty min value.');
  }

  return { min, max };
}

async function waitForZhilianApplicationFilterSettle(page: Page): Promise<void> {
  await page.waitForTimeout(500).catch(() => undefined);
}

async function clickZhilianBasicFilterOption(page: Page, rowLabels: string[], value: string): Promise<void> {
  const clicked = await page.evaluate(({ rowLabels, targetValue }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const rows = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible);
    const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
    const row = rows.find((candidate) => {
      const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
      return normalizedRowLabels.includes(label);
    });
    if (!row) {
      return false;
    }

    const candidates = Array.from(row.querySelectorAll([
      '.search-education-new__selector-item',
      '.search-education-new-custom__label',
      '.button-group__list-item',
      '.search-school-nature-new__item',
    ].join(', '))).filter(isVisible) as HTMLElement[];
    const target = candidates.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    dispatchClick(target);
    return true;
  }, { rowLabels, targetValue: value });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian filter option ${rowLabels.join('/')}=${value}.`);
  }

  await waitForZhilianApplicationFilterSettle(page);
}

async function clickZhilianBasicFilterCustomRangeTrigger(page: Page, rowLabels: string[]): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clickZhilianBasicFilterOption(page, rowLabels, '自定义');
    } catch (error) {
      if (!isAbortNavigationError(error) || attempt > 0) {
        throw error;
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      await ensureZhilianSearchConditionPanelOpen(page, createDeadline(8000), { expandMore: true });
    }

    const visible = await page.evaluate((rowLabels) => {
      const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
      const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const normalizedRowLabels = rowLabels.map(compact).filter(Boolean);
      const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
        .filter(isVisible)
        .find((candidate) => {
          const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
          return normalizedRowLabels.includes(label);
        });
      return Array.from(row?.querySelectorAll('.search-select-two-new .km-select') ?? []).filter(isVisible).length >= 2;
    }, rowLabels).catch((error) => {
      if (isAbortNavigationError(error)) {
        return false;
      }
      throw error;
    });

    if (visible) {
      return;
    }
  }

  throw new Error(`Unable to open Zhilian custom range controls for ${rowLabels.join('/')}.`);
}

async function clickZhilianBasicCustomSelectRangeOption(
  page: Page,
  rowLabels: string[],
  value: string,
  side: 'min' | 'max',
): Promise<void> {
  const clicked = await page.evaluate(async ({ rowLabels, targetValue, side }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const row = Array.from(document.querySelectorAll('.filter-panel-new .search-label-wrapper-new'))
      .filter(isVisible)
      .find((candidate) => {
        const label = compact(candidate.querySelector('.search-label-wrapper-new__label')?.textContent);
        return rowLabels.map(compact).filter(Boolean).includes(label);
      });
    if (!row) {
      return false;
    }

    const selects = Array.from(row.querySelectorAll('.search-select-two-new .km-select')).filter(isVisible) as HTMLElement[];
    const targetSelect = selects[side === 'min' ? 0 : 1];
    if (!targetSelect) {
      return false;
    }

    dispatchClick(targetSelect);
    await wait(250);

    const popoverId = targetSelect.getAttribute('aria-describedby');
    const popovers = [
      ...(popoverId ? [document.getElementById(popoverId)] : []),
      ...Array.from(document.querySelectorAll('.km-popover.search-select-two-new__popover, .km-select__dropdown-wrapper')),
    ].filter(isVisible) as HTMLElement[];
    const activePopover = popovers.at(-1);
    const labels = Array.from(activePopover?.querySelectorAll('.km-option__label') ?? [])
      .filter(isVisible) as HTMLElement[];
    const targetLabel = labels.find((element) => compact(element.textContent) === compact(targetValue));
    if (!targetLabel) {
      return false;
    }

    const option = targetLabel.closest('.km-option') as HTMLElement | null;
    dispatchClick(option ?? targetLabel);
    return true;
  }, { rowLabels, targetValue: value, side }).catch((error) => {
    if (isAbortNavigationError(error)) {
      return true;
    }

    throw error;
  });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian custom range ${side} option ${rowLabels.join('/')}=${value}.`);
  }

  await waitForZhilianApplicationFilterSettle(page);
}

async function openZhilianOtherFilterDropdown(page: Page, label: string): Promise<void> {
  const targetIndex = zhilianOtherFilterIndexByLabel.get(label);
  if (targetIndex === undefined) {
    throw new Error(`Unsupported Zhilian dropdown filter label: ${label}`);
  }

  await closeZhilianVisibleFilterPopups(page, createDeadline(1000)).catch(() => undefined);

  const opened = await page.evaluate(({ targetIndex, targetLabel }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const readOtherLabel = (element: Element): string => normalizeText(
      element.querySelector('.talent-search-other-label')?.textContent,
    )
      .replace(/·\d+/g, '')
      .replace(/收起筛选|更多筛选/g, '')
      .trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const otherItems = Array.from(document.querySelectorAll('.filter-other-wrap__content .filter-other__item'))
      .filter((item) => !item.classList.contains('filter-other-trigger'));
    const item = otherItems.find((candidate) => readOtherLabel(candidate) === targetLabel)
      ?? otherItems[targetIndex];
    const trigger = item?.querySelector('.talent-search-other-label') ?? item;
    if (!isVisible(trigger)) {
      return false;
    }

    dispatchClick(trigger);
    return true;
  }, { targetIndex, targetLabel: label });

  if (!opened) {
    throw new Error(`Unable to open Zhilian dropdown filter: ${label}.`);
  }

  await page.waitForTimeout(250).catch(() => undefined);
}

async function clickZhilianOpenedKmOption(page: Page, value: string): Promise<void> {
  const clicked = await page.evaluate((targetValue) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };

    const labels = Array.from(document.querySelectorAll('.km-popover .km-option__label, .km-select__dropdown-wrapper .km-option__label'))
      .filter(isVisible) as HTMLElement[];
    const target = labels.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    const option = target.closest('.km-option') as HTMLElement | null;
    dispatchClick(option ?? target);
    return true;
  }, value);

  if (!clicked) {
    throw new Error(`Unable to select Zhilian dropdown option: ${value}.`);
  }
}

async function applyZhilianDropdownApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const label = zhilianApplicationFilterDropdownLabelsByFieldId[condition.fieldId];
  if (!label) {
    throw new Error(`Unsupported Zhilian dropdown application filter: ${condition.fieldId}`);
  }

  const value = readZhilianApplicationFilterSingleValue(condition);
  await openZhilianOtherFilterDropdown(page, label);
  await clickZhilianOpenedKmOption(page, value);
  await page.keyboard.press('Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
}

async function clickZhilianLanguageOption(page: Page, value: string): Promise<void> {
  const clicked = await page.evaluate(async (targetValue) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const findPopover = (): HTMLElement | undefined => Array.from(document.querySelectorAll('.search-language-popover, .km-popover.search-language-popover'))
      .filter(isVisible)
      .at(-1) as HTMLElement | undefined;
    const findOptions = (popover: HTMLElement | undefined): HTMLElement[] => Array.from(
      popover?.querySelectorAll('.search-language-popover__item, .search-language-popover__item-text') ?? [],
    ).filter(isVisible) as HTMLElement[];
    const clickOption = (option: HTMLElement): void => {
      dispatchClick(option.closest('.search-language-popover__item') as HTMLElement | null ?? option);
    };

    const popover = findPopover();
    const options = findOptions(popover);
    const target = options.find((element) => compact(element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    clickOption(target);
    await wait(220);

    const childOptions = findOptions(findPopover())
      .filter((element) => element.closest('.search-language-popover__item')?.classList.contains('is-child-item'));
    const preferredChild = childOptions.find((element) => compact(element.textContent) === compact('无证书要求'))
      ?? childOptions[0];
    if (preferredChild) {
      clickOption(preferredChild);
      await wait(220);
    }

    return true;
  }, value);

  if (!clicked) {
    throw new Error(`Unable to select Zhilian language option: ${value}.`);
  }
}

async function applyZhilianLanguageApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const value = readZhilianApplicationFilterSingleValue(condition);
  const valueCandidates = buildZhilianAppliedFilterValueCandidates(value);
  if (await isZhilianAppliedConditionValues(page, condition.fieldId, [valueCandidates])) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, '语言能力');
  await clickZhilianLanguageOption(page, value);
  await page.keyboard.press('Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
  await assertZhilianAppliedConditionValues(page, condition.fieldId, [valueCandidates]);
}

async function clearZhilianCascaderSelection(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const closeControl = Array.from(document.querySelectorAll('.s-dialog .s-tags__close, .s-dialog [class*="tags__close"]'))
        .filter(isVisible)
        .at(-1);
      if (!closeControl) {
        break;
      }

      dispatchClick(closeControl);
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  }).catch(() => undefined);
}

async function clickZhilianCascaderPath(page: Page, pathLabels: string[], value: string): Promise<void> {
  if (pathLabels.length === 0) {
    throw new Error(`Missing Zhilian cascader path labels for ${value}.`);
  }

  const clicked = await page.evaluate(async ({ pathLabels, value }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
          view: window,
        }));
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    const findVisibleDialog = (): HTMLElement | undefined => Array.from(document.querySelectorAll('.s-dialog'))
      .filter(isVisible)
      .at(-1);
    const readNodeText = (element: Element): string => normalizeText(
      element.querySelector('.s-cascader__option-content, .s-checkbutton__item-text, span, p')?.textContent
        || element.textContent,
    );
    const findOption = (dialog: HTMLElement, label: string, depth: number): HTMLElement | undefined => {
      const optionSelectors = depth < pathLabels.length - 1
        ? [
          '.s-cascader__option',
          '.s-cascader__select-button-wrapper',
          '.s-checkbutton__item',
        ]
        : [
          '.s-checkbutton__item',
          '.s-cascader__select-button-wrapper',
          '.s-cascader__option',
        ];
      const options = optionSelectors.flatMap((selector) =>
        Array.from(dialog.querySelectorAll(selector)).filter(isVisible) as HTMLElement[]);
      const exact = options.find((element) => compact(readNodeText(element)) === compact(label));
      if (exact) {
        return exact;
      }

      if (depth === pathLabels.length - 1 && compact(label) === compact(value)) {
        return options.find((element) => compact(readNodeText(element)) === compact(value));
      }

      return undefined;
    };

    for (let index = 0; index < pathLabels.length; index += 1) {
      const dialog = findVisibleDialog();
      if (!dialog) {
        return false;
      }

      const target = findOption(dialog, pathLabels[index]!, index);
      if (!target) {
        return false;
      }

      dispatchClick(target);
      await wait(180);
    }

    return true;
  }, { pathLabels, value });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian cascader path: ${pathLabels.join(' / ')}`);
  }
}

async function clickZhilianCascaderConfirm(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const dialog = Array.from(document.querySelectorAll('.s-dialog')).filter(isVisible).at(-1);
    const confirm = Array.from(dialog?.querySelectorAll('button, .s-button') ?? [])
      .filter(isVisible)
      .find((element) => normalizeText(element.textContent).includes('确定'));
    if (!(confirm instanceof HTMLElement)) {
      return false;
    }

    dispatchClick(confirm);
    return true;
  });

  if (!clicked) {
    throw new Error('Unable to confirm Zhilian cascader selection.');
  }

  await waitForZhilianApplicationFilterSettle(page);
  await page.keyboard.press('Escape').catch(() => undefined);
}

async function applyZhilianCascaderApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const label = zhilianApplicationFilterCascaderLabelsByFieldId[condition.fieldId];
  if (!label) {
    throw new Error(`Unsupported Zhilian cascader application filter: ${condition.fieldId}`);
  }

  const values = readZhilianTextInputApplicationFilterValueEntries(condition);
  if (values.length === 0) {
    throw new Error(`Missing values for Zhilian cascader application filter: ${condition.fieldId}`);
  }

  const valueCandidateGroups = values.slice(0, 3).map(buildZhilianAppliedFilterValueCandidatesForEntry);
  if (await isZhilianAppliedConditionValues(page, condition.fieldId, valueCandidateGroups)) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, label);
  await clearZhilianCascaderSelection(page);
  for (const entry of values.slice(0, 3)) {
    const pathLabels = entry.pathLabels && entry.pathLabels.length > 0 ? entry.pathLabels : [entry.value];
    await clickZhilianCascaderPath(page, pathLabels, entry.value);
  }
  await clickZhilianCascaderConfirm(page);
  await assertZhilianAppliedConditionValues(page, condition.fieldId, valueCandidateGroups);
}

async function clickZhilianSalaryOption(page: Page, value: string, side: 'min' | 'max'): Promise<void> {
  const itemSelector = side === 'min'
    ? '.search-salary_list-left-item'
    : '.search-salary_list-right-item';
  const option = page.locator(`.search-salary-popover ${itemSelector}`).filter({
    hasText: new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`),
  }).first();

  try {
    await option.click({ timeout: 3000 });
    await page.waitForTimeout(150).catch(() => undefined);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a function|unexpected argument|too many arguments/i.test(message)) {
      throw new Error(`Unable to select Zhilian salary ${side} option: ${value}. ${message}`);
    }
  }

  const clicked = await page.evaluate(({ targetValue, side }) => {
    const normalizeText = (input: string | null | undefined): string => (input ?? '').replace(/\s+/g, ' ').trim();
    const compact = (input: string | null | undefined): string => normalizeText(input).replace(/\s+/g, '');
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };

    const fallbackItemSelector = side === 'min'
      ? '.search-salary_list-left-item'
      : '.search-salary_list-right-item, .search-salary_list-item:not(.search-salary_list-left-item)';
    const items = Array.from(document.querySelectorAll(`.search-salary-popover ${fallbackItemSelector}`))
      .filter(isVisible) as HTMLElement[];
    const target = items.find((element) => compact(element.querySelector('span')?.textContent || element.textContent) === compact(targetValue));
    if (!target) {
      return false;
    }

    dispatchClick(target);
    return true;
  }, { targetValue: value, side });

  if (!clicked) {
    throw new Error(`Unable to select Zhilian salary ${side} option: ${value}.`);
  }
}

async function applyZhilianExpectedSalaryApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!isRecord(condition.value)) {
    throw new Error('Zhilian expected salary application filter requires { min, max } value.');
  }

  const min = normalizeApplicationFilterValue(condition.value.min);
  const max = normalizeApplicationFilterValue(condition.value.max);
  if (!min || !max) {
    throw new Error('Zhilian expected salary application filter requires non-empty min and max values.');
  }

  if (await isZhilianExpectedSalaryApplied(page, min, max)) {
    return;
  }

  await openZhilianOtherFilterDropdown(page, '期望月薪');
  await clickZhilianSalaryOption(page, min, 'min');
  await page.waitForTimeout(150).catch(() => undefined);
  try {
    await clickZhilianSalaryOption(page, max, 'max');
  } catch {
    await openZhilianOtherFilterDropdown(page, '期望月薪');
    await clickZhilianSalaryOption(page, max, 'max');
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await waitForZhilianApplicationFilterSettle(page);
  await assertZhilianExpectedSalaryApplied(page, min, max);
}

async function applyZhilianBasicApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  const rowLabels = zhilianApplicationFilterBasicLabelsByFieldId[condition.fieldId];
  if (!rowLabels) {
    throw new Error(`Unsupported Zhilian basic application filter: ${condition.fieldId}`);
  }

  const customInput = readZhilianCustomSelectRangeInput(condition);
  if (customInput) {
    if (await isZhilianBasicCustomRangeApplied(page, rowLabels, customInput)) {
      return;
    }

    await clickZhilianBasicFilterCustomRangeTrigger(page, rowLabels);
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, customInput.min, 'min');
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, customInput.max, 'max');
    await page.keyboard.press('Escape').catch(() => undefined);
    await waitForZhilianApplicationFilterSettle(page);
    await assertZhilianBasicCustomRangeApplied(page, rowLabels, customInput);
    return;
  }

  if (condition.fieldKind === 'numberRange' || condition.fieldId === 'age') {
    const presetValue = buildZhilianAgePresetLabel(condition);
    if (zhilianAgePresetLabels.has(presetValue)) {
      await clickZhilianBasicFilterOption(page, rowLabels, presetValue);
      return;
    }

    const ageCustomInput = readZhilianAgeCustomSelectRangeInput(condition);
    if (await isZhilianBasicCustomRangeApplied(page, rowLabels, ageCustomInput)) {
      return;
    }

    await clickZhilianBasicFilterCustomRangeTrigger(page, rowLabels);
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, ageCustomInput.min, 'min');
    await clickZhilianBasicCustomSelectRangeOption(page, rowLabels, ageCustomInput.max, 'max');
    await page.keyboard.press('Escape').catch(() => undefined);
    await waitForZhilianApplicationFilterSettle(page);
    await assertZhilianBasicCustomRangeApplied(page, rowLabels, ageCustomInput);
    return;
  }

  const value = readZhilianApplicationFilterSingleValue(condition);
  await clickZhilianBasicFilterOption(page, rowLabels, value);
}

async function applyZhilianSupportedApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!zhilianSupportedApplicationFilterFieldIds.has(condition.fieldId)) {
    throw new Error(`Unsupported Zhilian application filter: ${condition.fieldId}`);
  }

  if (condition.fieldKind === 'salaryRange' || condition.fieldId === 'expected_salary') {
    await applyZhilianExpectedSalaryApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId === 'language') {
    await applyZhilianLanguageApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId in zhilianApplicationFilterCascaderLabelsByFieldId) {
    await applyZhilianCascaderApplicationFilter(page, condition);
    return;
  }

  if (condition.fieldId in zhilianApplicationFilterDropdownLabelsByFieldId) {
    await applyZhilianDropdownApplicationFilter(page, condition);
    return;
  }

  await applyZhilianBasicApplicationFilter(page, condition);
}

async function applyZhilianApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<SearchConditionApplyResult> {
  try {
    await ensureZhilianSearchConditionPanelOpen(page, createDeadline(5000), { expandMore: true });
    clearObservedZhilianCandidateApi(page);
    await applyZhilianSupportedApplicationFilter(page, condition);
    return {
      platform: 'zhilian',
      condition,
      status: 'applied',
    };
  } catch (error) {
    await closeZhilianVisibleFilterPopups(page, createDeadline(1000)).catch(async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
    });
    return {
      platform: 'zhilian',
      condition,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function applyZhilianSearchCondition(
  page: Page,
  condition: SearchCondition,
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: 'zhilian',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for zhilian yet.`,
    };
  }

  return applyZhilianApplicationFilter(page, condition);
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
  discoverSearchFilters: discoverZhilianStaticSearchFilters,
  applySearchCondition: applyZhilianSearchCondition,
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
  prepareZhilianSearchConditionPage,
  readZhilianSearchConditionResultTotal,
  ensureZhilianSearchConditionPanelOpen,
  shouldIncludeZhilianFilterDiscoveryControl,
  shouldIgnoreZhilianFilterDiscoveryControl,
  buildZhilianAgePresetLabel,
};
