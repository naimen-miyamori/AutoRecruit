import type { BrowserContext, Page, Response } from 'playwright';
import { config } from '../config.js';
import {
  clickFirstVisibleText,
  clickPrimarySearchButton,
  fillFirstVisibleInput,
  fillInputNearText,
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../search/page-actions.js';
import type { CandidateListItem, CandidateResume, EducationExperience, ProjectExperience, WorkExperience } from '../types/job.js';
import type { PlatformAdapter, SearchWaitOptions } from './types.js';

const candidateLinkSelector = [
  'a[href*="/resume/"]',
  'a[href*="/resume-detail/"]',
  'a[href*="/zhaopin/"]',
  'a[href*="resumeId="]',
  'a[href*="candidateId="]',
  '[data-resume-id] a',
  '[data-candidate-id] a',
  'a[data-resume-id]',
  'a[data-candidate-id]',
].join(', ');
const lineBreakToken = '__AUTORECRUIT_LINE_BREAK__';
const detailReadySelectors = [
  '[class*="resume"]',
  '[class*="detail"]',
  '[class*="profile"]',
  '[class*="work"]',
  'main',
];
const sectionTitles = ['工作经历', '项目经历', '项目经验', '教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势'];
const liepinLoginUrl = 'https://h.liepin.com/account/login';
const liepinAuthenticatedUrl = 'https://h.liepin.com/search/getConditionItem';
const observedLiepinSearchApiCandidates = new WeakMap<Page, CandidateListItem[]>();
const observedLiepinSearchApiSeenPages = new WeakSet<Page>();
const observedLiepinSearchApiListenerPages = new WeakSet<Page>();
const observedLiepinSearchApiGenerations = new WeakMap<Page, number>();
const observedLiepinSearchApiMinRequestStartTimes = new WeakMap<Page, number>();
const liepinDetailPollIntervalMs = 250;

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

function throwLastAggregateError(error: unknown): never {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const lastError = error.errors[error.errors.length - 1];
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  throw error instanceof Error ? error : new Error(String(error));
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePreservingLines(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, lineBreakToken)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(new RegExp(`${lineBreakToken}+`, 'g'), lineBreakToken)
    .trim();
}

function splitNormalizedLines(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n|__AUTORECRUIT_LINE_BREAK__/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function isLikelyPersonName(line: string): boolean {
  return /^[一-龥A-Za-z·]{2,20}$/.test(line)
    && !/猎聘|简历|男|女|本科|硕士|博士|大专|中专|现居住地|期望城市|工作地点/.test(line);
}

function isLikelyCompany(line: string): boolean {
  return /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line);
}

function isLikelyTitle(line: string): boolean {
  return /工程师|经理|主管|顾问|销售|总监|专员|招商主管|总经理|主任|业务员|运营|设计师|分析师|店长|讲师/.test(line);
}

function isLikelyEducation(line: string): boolean {
  return /博士|硕士|本科|大专|中专|高中/.test(line);
}

function isLikelyRegion(line: string): boolean {
  return /期望城市|意向城市|所在地|现居住地|工作地点|居住地/.test(line);
}

function isSectionTitle(line: string): boolean {
  return sectionTitles.includes(line);
}

function isTimeRangeLine(line: string): boolean {
  return /(\d{4}(?:[./-]\d{2})?)\s*[-~至]\s*(至今|\d{4}(?:[./-]\d{2})?)/.test(line);
}

function normalizeTimeRange(line: string): string {
  const match = line.match(/(\d{4}(?:[./-]\d{2})?)\s*[-~至]\s*(至今|\d{4}(?:[./-]\d{2})?)/);
  if (!match) {
    return line;
  }

  return `${match[1]}-${match[2]}`;
}

function isNoiseLine(line: string): boolean {
  return /^(猎聘|在线简历|简历|举报|下载简历|立即沟通|沟通|打招呼|登录后可查看)/.test(line);
}

function extractCandidateIdFromText(text: string): string | undefined {
  const patterns = [
    /resume(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /candidate(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /data-(?:resume-id|candidate-id|id)="?(\d{5,})/i,
    /(?:resume|candidate)[_-]?id\D{0,8}(\d{5,})/i,
    /\/(\d{5,})(?:\?.*)?$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
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

function trimTrailingSectionNoise(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (!isNoiseLine(last) && !isSectionTitle(last)) {
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

function parseWorkExperiences(lines: string[], fallbackCompany?: string, fallbackTitle?: string): WorkExperience[] {
  const workLines = trimTrailingSectionNoise(collectSection(lines, ['工作经历'], ['项目经历', '项目经验', '教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势']));
  const experiences: WorkExperience[] = [];
  let current: WorkExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.company || current.title || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of workLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { details: [normalizeTimeRange(line)] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.company && isLikelyCompany(line)) {
      current.company = line;
      continue;
    }

    if (!current.title && isLikelyTitle(line)) {
      current.title = line;
      continue;
    }

    if (isTimeRangeLine(line)) {
      current.details.push(normalizeTimeRange(line));
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();

  if (experiences.length > 0) {
    return experiences;
  }

  return fallbackCompany || fallbackTitle ? [{ company: fallbackCompany, title: fallbackTitle, details: [] }] : [];
}

function parseProjectExperiences(lines: string[]): ProjectExperience[] {
  const projectLines = trimTrailingSectionNoise(collectSection(lines, ['项目经历', '项目经验'], ['教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势']));
  if (projectLines.length === 0) {
    return [];
  }

  const experiences: ProjectExperience[] = [];
  let current: ProjectExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.name || current.company || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of projectLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { start: normalizeTimeRange(line), details: [] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.name && !isLikelyCompany(line) && !isLikelyTitle(line) && line.length <= 40) {
      current.name = line;
      continue;
    }

    if (!current.company && isLikelyCompany(line)) {
      current.company = line;
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();
  return experiences;
}

function parseEducationExperiences(lines: string[], fallbackEducation?: string): EducationExperience[] {
  const educationLines = trimTrailingSectionNoise(collectSection(lines, ['教育经历', '教育背景'], ['技能', '技能标签', '语言能力', '证书', '个人优势']));
  if (educationLines.length === 0) {
    return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
  }

  const experiences: EducationExperience[] = [];
  let current: EducationExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.school || current.degree || current.major || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of educationLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { details: [normalizeTimeRange(line)] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.school && /大学|学院|学校|中学/.test(line)) {
      current.school = line;
      continue;
    }

    if (!current.degree && isLikelyEducation(line)) {
      current.degree = line.match(/博士|硕士|本科|大专|中专|高中/)?.[0] ?? line;
      const major = line.replace(/博士|硕士|本科|大专|中专|高中/g, '').trim();
      if (major) {
        current.major = major;
      }
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();
  return experiences.length > 0 ? experiences : (fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : []);
}

function parseCertificates(lines: string[]): string[] {
  return collectSection(lines, ['证书'], ['个人优势'])
    .filter((line) => !isNoiseLine(line) && !isSectionTitle(line));
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

function isLiepinResumeDetailUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/resume\/showresumedetail\//i.test(url);
}

async function assertLiepinAuthenticated(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });

  const bodyText = await body.innerText();
  const currentUrl = page.url();
  if (isLiepinUnauthenticatedText(bodyText) || isLiepinLoginPageUrl(currentUrl)) {
    throw new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (bodyText.trim().length === 0 && /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:\?.*)?(?:#.*)?$/i.test(currentUrl)) {
    const cookies = await page.context().cookies().catch(() => []);
    const cookieNames = cookies.map((cookie) => cookie.name);
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

function isAbortNavigationError(error: unknown): boolean {
  return error instanceof Error && /net::ERR_ABORTED|Navigation aborted|frame was detached/i.test(error.message);
}

export function isLiepinPublicZhaopinUrl(url: string | null | undefined): boolean {
  return /^https:\/\/www\.liepin\.com\/zhaopin\/(?:[?#].*)?$/i.test(normalizeText(url));
}

export function isSafeLiepinResumeUrl(url: string | null | undefined): boolean {
  const normalizedUrl = normalizeText(url);
  return /^https:\/\/h\.liepin\.com\/resume\/showresumedetail\//i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/a\/resume(?:[/?#].*)?$/i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/resume(?:\/|[-?])/i.test(normalizedUrl)
    || /^https:\/\/www\.liepin\.com\/resume-detail(?:\/|[-?])/i.test(normalizedUrl);
}

function isLiepinSearchUrl(url: string): boolean {
  return /^https:\/\/h\.liepin\.com\/search\/getconditionitem(?:[/?#].*)?$/i.test(url);
}

async function fillLiepinKeywordSearchInput(page: Page, value: string): Promise<boolean> {
  return fillInputNearText(
    page,
    value,
    ['职位名称', '包含任意关键词', '包含全部关键词'],
    ['.search-item', '.filter-item', '.form-item', '[class*="search"]', '[class*="filter"]'],
    [
      'input.ant-select-selection-search-input[type="search"]',
      'input.search-component-input',
      'input.ant-input',
      'input[type="search"]',
      'input[type="text"]',
    ],
  ) || fillFirstVisibleInput(page, value, [
    'input.ant-select-selection-search-input[type="search"]',
    'input.search-component-input',
    'input.ant-input',
    'input[type="search"]',
    'input[type="text"]',
  ]);
}

async function prepareLiepinSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  resetObservedLiepinSearchResumesApi(page);
  attachLiepinSearchResumesApiObserver(page);

  if (!isLiepinSearchUrl(page.url())) {
    try {
      await page.goto(liepinAuthenticatedUrl, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
    } catch (error) {
      if (!isAbortNavigationError(error) || !isLiepinSearchUrl(page.url())) {
        throw error;
      }
    }
  }

  await waitForLiepinPageReady(page, { deadline });
  const didFillKeyword = await fillLiepinKeywordSearchInput(page, keyword);
  if (!didFillKeyword) {
    throw new Error('Search subscription on liepin could not fill the keyword input on the recruiter search page.');
  }

  const didTriggerSearch = await clickPrimarySearchButton(page)
    || await clickFirstVisibleText(page, ['搜索', '搜 索']);
  if (!didTriggerSearch) {
    throw new Error('Search subscription on liepin could not trigger the keyword search on the recruiter search page.');
  }

  await waitForLiepinPageReady(page, { deadline });
  await clickFirstVisibleText(page, ['更多', '展开', '高级搜索', '更多筛选']).catch(() => false);
  return page;
}

async function readLiepinSearchConditionResultTotal(page: Page): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const resultTotal = parseSearchResultTotalFromText(await page.locator('body').innerText());
  if (resultTotal === undefined) {
    throw new Error('Search subscription on liepin could not read the page result total.');
  }

  return {
    resultTotal,
    resultTotalSource: 'page',
  };
}

async function waitForLiepinInitialData(page: Page, deadline: number): Promise<void> {
  const waitForResponse = (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse?.bind(page);
  if (!waitForResponse) {
    return;
  }

  const response = await waitForResponse(
    (response) => /api-h\.liepin\.com\/api\/com\.liepin\.recruitbff\.clt\.search\.get-initial-data/.test(response.url())
      && response.status() >= 200
      && response.status() < 400,
    { timeout: remainingTime(deadline) },
  );
  if (!response) {
    throw new Error('Liepin initial-data response did not arrive before deadline.');
  }
}

type LiepinSearchResumesApiCandidate = {
  resIdEncode?: string;
  resName?: string;
  highLightCompOrIndustry?: string;
  highLightJobTitle?: string;
  detailUrl?: string;
  wantDq?: string;
  wantJobTitle?: string;
  simpleResumeForm?: {
    resIdEncode?: string;
    resName?: string;
    workYearName?: string;
    eduLevelName?: string;
    liveDq?: string;
  };
};

function stripHtmlTags(value: string | null | undefined): string {
  return normalizeText((value ?? '').replace(/<[^>]+>/g, ''));
}

function resolveLiepinUrl(value: string | null | undefined): string | undefined {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return undefined;
  }

  if (/^https?:\/\//i.test(normalizedValue)) {
    return normalizedValue;
  }

  try {
    return new URL(normalizedValue, 'https://h.liepin.com').toString();
  } catch {
    return undefined;
  }
}

function parseLiepinSearchResumesApiCandidates(payload: string): CandidateListItem[] {
  const parsed = JSON.parse(payload) as {
    data?: {
      resList?: LiepinSearchResumesApiCandidate[];
    };
  };
  const resList = Array.isArray(parsed.data?.resList) ? parsed.data.resList : [];
  const candidates: CandidateListItem[] = [];

  for (const entry of resList) {
    const candidateId = normalizeText(entry.resIdEncode ?? entry.simpleResumeForm?.resIdEncode);
    if (!candidateId) {
      continue;
    }

    const name = normalizeText(entry.resName ?? entry.simpleResumeForm?.resName) || undefined;
    const currentCompany = stripHtmlTags(entry.highLightCompOrIndustry) || undefined;
    const currentTitle = stripHtmlTags(entry.highLightJobTitle) || undefined;
    const regions = [
      normalizeText(entry.simpleResumeForm?.liveDq),
      normalizeText(entry.wantDq),
    ].filter(Boolean);
    const workYear = normalizeText(entry.simpleResumeForm?.workYearName);
    const education = normalizeText(entry.simpleResumeForm?.eduLevelName);
    const wantJobTitle = normalizeText(entry.wantJobTitle);
    const cardText = [
      name,
      workYear,
      education,
      ...regions,
      wantJobTitle,
      currentCompany,
      currentTitle,
    ].filter(Boolean).join(lineBreakToken) || undefined;

    candidates.push({
      candidateId,
      name,
      currentCompany,
      currentTitle,
      resumeUrl: resolveLiepinUrl(entry.detailUrl),
      cardText,
      sourceText: JSON.stringify(entry),
    });
  }

  return candidates;
}

function mergeLiepinApiCandidateIntoCardCandidate(
  cardCandidate: CandidateListItem,
  apiCandidate: CandidateListItem | undefined,
): CandidateListItem {
  const safeResumeUrl = isSafeLiepinResumeUrl(apiCandidate?.resumeUrl)
    ? apiCandidate?.resumeUrl
    : (isSafeLiepinResumeUrl(cardCandidate.resumeUrl) ? cardCandidate.resumeUrl : undefined);

  return {
    ...cardCandidate,
    resumeUrl: safeResumeUrl,
    name: cardCandidate.name ?? apiCandidate?.name,
    currentCompany: cardCandidate.currentCompany ?? apiCandidate?.currentCompany,
    currentTitle: cardCandidate.currentTitle ?? apiCandidate?.currentTitle,
    cardText: cardCandidate.cardText ?? apiCandidate?.cardText,
    sourceText: cardCandidate.sourceText ?? apiCandidate?.sourceText,
  };
}

function candidateNeedsSafeLiepinResumeUrl(candidate: CandidateListItem): boolean {
  return !isSafeLiepinResumeUrl(candidate.resumeUrl);
}

function isLiepinSearchResumesApiResponse(response: Pick<Response, 'url' | 'status'>): boolean {
  return /api-h\.liepin\.com\/api\/com\.liepin\.searchfront4r\.h\.search-resumes/.test(response.url())
    && response.status() >= 200
    && response.status() < 400;
}

function getLiepinSearchResumesApiRequestStartTime(
  response: Partial<Pick<Response, 'request'>>,
): number | undefined {
  try {
    const startTime = response.request?.().timing().startTime;
    return typeof startTime === 'number' && Number.isFinite(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function isLiepinSearchResumesApiResponseBeforeMinimumRequestStart(
  page: Page,
  response: Partial<Pick<Response, 'request'>>,
): boolean {
  const minimumStartTime = observedLiepinSearchApiMinRequestStartTimes.get(page);
  if (minimumStartTime === undefined) {
    return false;
  }

  const requestStartTime = getLiepinSearchResumesApiRequestStartTime(response);
  return requestStartTime === undefined || requestStartTime < minimumStartTime;
}

function isEligibleLiepinSearchResumesApiResponse(
  page: Page,
  response: Pick<Response, 'url' | 'status'> & Partial<Pick<Response, 'request'>>,
): boolean {
  return isLiepinSearchResumesApiResponse(response)
    && !isLiepinSearchResumesApiResponseBeforeMinimumRequestStart(page, response);
}

function getObservedLiepinSearchApiGeneration(page: Page): number {
  return observedLiepinSearchApiGenerations.get(page) ?? 0;
}

function bumpObservedLiepinSearchApiGeneration(page: Page): void {
  observedLiepinSearchApiGenerations.set(page, getObservedLiepinSearchApiGeneration(page) + 1);
}

async function cacheLiepinSearchResumesApiResponse(
  page: Page,
  response: Pick<Response, 'url' | 'status' | 'text'> & Partial<Pick<Response, 'request'>>,
  generation = getObservedLiepinSearchApiGeneration(page),
): Promise<void> {
  if (!isEligibleLiepinSearchResumesApiResponse(page, response)) {
    return;
  }

  let candidates: CandidateListItem[];
  try {
    candidates = parseLiepinSearchResumesApiCandidates(await response.text());
  } catch {
    candidates = [];
  }

  if (getObservedLiepinSearchApiGeneration(page) !== generation) {
    return;
  }

  observedLiepinSearchApiCandidates.set(page, candidates);
  observedLiepinSearchApiSeenPages.add(page);
}

function clearObservedLiepinSearchResumesApi(page: Page): void {
  observedLiepinSearchApiCandidates.delete(page);
  observedLiepinSearchApiSeenPages.delete(page);
  bumpObservedLiepinSearchApiGeneration(page);
}

function resetObservedLiepinSearchResumesApi(page: Page): void {
  observedLiepinSearchApiMinRequestStartTimes.delete(page);
  clearObservedLiepinSearchResumesApi(page);
}

function clearObservedLiepinSearchResumesApiBeforeNextAction(page: Page): void {
  observedLiepinSearchApiMinRequestStartTimes.set(page, Date.now());
  clearObservedLiepinSearchResumesApi(page);
}

function attachLiepinSearchResumesApiObserver(page: Page): void {
  const observablePage = page as Page & {
    on?: (event: string, listener: (response: Response) => void) => void;
  };
  if (typeof observablePage.on !== 'function' || observedLiepinSearchApiListenerPages.has(page)) {
    return;
  }

  observedLiepinSearchApiListenerPages.add(page);
  observablePage.on('response', (response) => {
    void cacheLiepinSearchResumesApiResponse(page, response, getObservedLiepinSearchApiGeneration(page));
  });
}

async function waitForLiepinSearchResumesApi(page: Page, timeoutMs?: number): Promise<CandidateListItem[]> {
  if (observedLiepinSearchApiSeenPages.has(page)) {
    return observedLiepinSearchApiCandidates.get(page) ?? [];
  }

  attachLiepinSearchResumesApiObserver(page);
  const waitForResponse = (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse?.bind(page);
  if (!waitForResponse) {
    return observedLiepinSearchApiCandidates.get(page) ?? [];
  }

  const effectiveTimeoutMs = Math.max(timeoutMs ?? config.playwright.searchPageTimeoutMs, 1);
  const responsePromise = waitForResponse(
    (candidateResponse) => isEligibleLiepinSearchResumesApiResponse(page, candidateResponse),
    { timeout: effectiveTimeoutMs },
  ).catch(() => undefined);
  const response = await withTimeout(responsePromise, effectiveTimeoutMs, undefined);

  if (response) {
    await cacheLiepinSearchResumesApiResponse(page, response);
  }

  return observedLiepinSearchApiCandidates.get(page) ?? [];
}

async function waitForLiepinSearchShell(page: Page, deadline: number): Promise<void> {
  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (!waitForFunction) {
    return;
  }

  await waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const hasSearchText = /搜索条件|人才搜索|快捷搜索|共\d+位人选|搜简历|找简历|人才管理/.test(bodyText);
      return hasSearchText && bodyText.trim().length > 0;
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );
}

async function clickLiepinQuickSearchTag(page: Page, keyword: string, deadline: number): Promise<void> {
  const getByText = (page as Partial<Pick<Page, 'getByText'>>).getByText?.bind(page);
  if (!getByText) {
    return;
  }

  const tag = getByText(keyword, { exact: true }).first();
  await tag.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  await tag.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await tag.click();
  });
}

type LiepinHideViewedState = {
  found: boolean;
  checked: boolean;
  clickSelector?: string;
  searchButtonSelector?: string;
  bodyText?: string;
};

function getLiepinHideViewedControlState(): LiepinHideViewedState {
  const normalizeNodeText = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (element: Element | null | undefined): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const selectorForElement = (element: Element): string | undefined => {
    const escapeCssString = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (element.id) {
      return `[id="${escapeCssString(element.id)}"]`;
    }

    const className = typeof element.className === 'string' ? element.className : '';
    if (/\bhide-view-checkbox\b/.test(className)) {
      return 'label.hide-view-checkbox';
    }
    if (element.tagName.toLowerCase() === 'button' && /\bsearch-btn\b/.test(className)) {
      return 'button.search-btn';
    }

    const dataAttributes = [
      'data-testid',
      'data-test-id',
      'data-tlg-elem-id',
      'name',
    ];
    for (const attributeName of dataAttributes) {
      const value = element.getAttribute(attributeName);
      if (value) {
        return `${element.tagName.toLowerCase()}[${attributeName}="${escapeCssString(value)}"]`;
      }
    }

    return undefined;
  };
  const isChecked = (element: Element): boolean => {
    if (element instanceof HTMLInputElement) {
      return element.checked;
    }

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }
    if (ariaChecked === 'false') {
      return false;
    }

    const className = typeof element.className === 'string' ? element.className : '';
    return /\b(?:checked|selected|active|is-checked|is-active|ant-checkbox-checked|ant-switch-checked|semi-checkbox-checked|semi-switch-checked)\b/i.test(className);
  };
  const bodyText = normalizeNodeText(document.body?.innerText);
  const searchButton = Array.from(document.querySelectorAll<HTMLElement>('button.search-btn, button'))
    .find((element) => isVisible(element) && /搜\s*索|搜索/.test(normalizeNodeText(element.innerText ?? element.textContent)));
  const searchButtonSelector = searchButton ? selectorForElement(searchButton) : undefined;
  const textNodes = Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter((element) => normalizeNodeText(element.textContent).includes('隐藏已查看'))
    .filter((element) => !Array.from(element.children).some((child) => normalizeNodeText(child.textContent).includes('隐藏已查看')));

  for (const textNode of textNodes) {
    if (!isVisible(textNode)) {
      continue;
    }

    const containers = [
      textNode.closest('label'),
      textNode.closest('[role="checkbox"], [role="switch"]'),
      textNode.closest('li, div, section, span'),
      textNode.parentElement,
    ].filter((element): element is Element => Boolean(element));

    for (const container of containers) {
      const input = container.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"], input');
      const ariaControl = container.matches('[role="checkbox"], [role="switch"]')
        ? container
        : container.querySelector('[role="checkbox"], [role="switch"]');
      const classControl = container.querySelector('[class*="checkbox"], [class*="switch"]');
      const control = input ?? ariaControl ?? classControl ?? container;
      const clickTarget = [
        input,
        ariaControl,
        classControl,
        container,
        textNode,
      ].find(isVisible);
      const checked = input ? input.checked : isChecked(control);
      const clickSelector = clickTarget ? (selectorForElement(clickTarget) ?? selectorForElement(container)) : selectorForElement(container);

      return {
        found: true,
        checked,
        clickSelector,
        searchButtonSelector,
        bodyText,
      };
    }
  }

  return {
    found: false,
    checked: false,
    searchButtonSelector,
    bodyText,
  };
}

async function readLiepinHideViewedState(page: Page): Promise<LiepinHideViewedState> {
  return page.evaluate(getLiepinHideViewedControlState);
}

async function waitForLiepinHideViewedState(page: Page, deadline: number): Promise<LiepinHideViewedState> {
  const state = await readLiepinHideViewedState(page);
  if (state.found) {
    return state;
  }

  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  if (waitForFunction) {
    await waitForFunction(
      () => (document.body?.innerText ?? '').includes('隐藏已查看'),
      undefined,
      { timeout: remainingTime(deadline), polling: 250 },
    ).catch(() => undefined);
  }

  return readLiepinHideViewedState(page);
}

async function clickLiepinSearchButtonIfHideViewedMissing(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await readLiepinHideViewedState(page);
  if (state.found || !state.searchButtonSelector) {
    return false;
  }

  const searchButton = page.locator(state.searchButtonSelector).first();
  await searchButton.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await searchButton.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await searchButton.click();
  });
  return true;
}

async function ensureLiepinHideViewedChecked(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await waitForLiepinHideViewedState(page, deadline);
  if (!state.found) {
    throw new Error(`Could not find Liepin "隐藏已查看" filter. Page text: ${(state.bodyText ?? '').slice(0, 500)}`);
  }

  if (state.checked) {
    return false;
  }

  const verifyChecked = async () => {
    const nextState = await waitForLiepinHideViewedState(page, deadline);
    if (!nextState.checked) {
      throw new Error(`Liepin "隐藏已查看" filter was clicked but did not become checked. Page text: ${(nextState.bodyText ?? '').slice(0, 500)}`);
    }
  };

  if (state.clickSelector) {
    const control = page.locator(state.clickSelector).first();
    await control.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
    options.beforeClick?.();
    await control.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unexpected argument|too many arguments/i.test(message)) {
        throw error;
      }

      await control.click();
    });
    await verifyChecked();
    return true;
  }

  const filterText = page.getByText('隐藏已查看', { exact: false }).first();
  await filterText.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await filterText.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await filterText.click();
  });
  await verifyChecked();
  return true;
}

async function ensureLiepinHideViewedUnchecked(
  page: Page,
  deadline: number,
  options: { beforeClick?: () => void } = {},
): Promise<boolean> {
  const state = await waitForLiepinHideViewedState(page, deadline);
  if (!state.found || !state.checked) {
    return false;
  }

  const verifyUnchecked = async () => {
    const nextState = await waitForLiepinHideViewedState(page, deadline);
    if (nextState.checked) {
      throw new Error(`Liepin "隐藏已查看" filter was clicked but did not become unchecked. Page text: ${(nextState.bodyText ?? '').slice(0, 500)}`);
    }
  };

  if (state.clickSelector) {
    const control = page.locator(state.clickSelector).first();
    await control.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
    options.beforeClick?.();
    await control.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unexpected argument|too many arguments/i.test(message)) {
        throw error;
      }

      await control.click();
    });
    await verifyUnchecked();
    return true;
  }

  const filterText = page.getByText('隐藏已查看', { exact: false }).first();
  await filterText.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  options.beforeClick?.();
  await filterText.click({ timeout: remainingTime(deadline) }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await filterText.click();
  });
  await verifyUnchecked();
  return true;
}

async function waitForLiepinResumeDetailReady(page: Page, deadline = createDeadline()): Promise<void> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, Math.ceil(remainingTime(deadline) / liepinDetailPollIntervalMs));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await assertLiepinAuthenticated(page);
      return;
    } catch (error) {
      lastError = error;
    }

    const waitMs = Math.min(liepinDetailPollIntervalMs, remainingTime(deadline));
    if (waitMs <= 1) {
      break;
    }

    await page.waitForTimeout(waitMs).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    });
  }

  throw lastError;
}

async function waitForLiepinPageReady(page: Page, options: { deadline?: number; timeoutMs?: number } = {}): Promise<void> {
  const defaultTimeoutMs = isLiepinResumeDetailUrl(page.url())
    ? config.playwright.resumeDetailTimeoutMs
    : config.playwright.searchPageTimeoutMs;
  const deadline = options.deadline ?? createDeadline(options.timeoutMs ?? defaultTimeoutMs);
  await page.waitForLoadState('domcontentloaded');

  if (isLiepinResumeDetailUrl(page.url())) {
    await waitForLiepinResumeDetailReady(page, deadline);
    return;
  }

  await assertLiepinAuthenticated(page);

  if (isLiepinSearchUrl(page.url())) {
    const canWaitForShell = typeof (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction === 'function';
    const canWaitForInitialData = typeof (page as Partial<Pick<Page, 'waitForResponse'>>).waitForResponse === 'function';

    if (canWaitForShell && canWaitForInitialData) {
      await Promise.any([
        waitForLiepinInitialData(page, deadline).catch(async (error) => {
          await assertLiepinAuthenticated(page);
          throw error;
        }),
        waitForLiepinSearchShell(page, deadline),
      ]).catch(async (error) => {
        await assertLiepinAuthenticated(page);
        throwLastAggregateError(error);
      });
      await assertLiepinAuthenticated(page);
      return;
    }

    if (canWaitForShell) {
      await waitForLiepinSearchShell(page, deadline);
      await assertLiepinAuthenticated(page);
      return;
    }

    if (canWaitForInitialData) {
      try {
        await waitForLiepinInitialData(page, deadline);
        await assertLiepinAuthenticated(page);
      } catch (error) {
        await assertLiepinAuthenticated(page);
        throw error;
      }
    }
  }
}

async function waitForLiepinExtractionReady(page: Page, deadline: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  if (isLiepinSearchUrl(page.url())) {
    await waitForLiepinSearchShell(page, deadline);
  }

  await assertLiepinAuthenticated(page);
}

function extractLiepinCardsInPage(elements: Element[]): Array<{
  candidateId: string;
  resumeUrl?: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  cardText?: string;
  sourceText?: string;
}> {
  const candidatePatterns = [
    /resume(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /candidate(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /data-(?:resume-id|candidate-id|id)="?(\d{5,})/i,
    /(?:resume|candidate)[_-]?id\D{0,8}(\d{5,})/i,
    /\/(\d{5,})(?:\?.*)?$/,
  ];
  const personNamePattern = /^[一-龥A-Za-z·]{2,20}$/;
  const nonNamePattern = /猎聘|简历|男|女|本科|硕士|博士|大专|中专|现居住地|期望城市|工作地点/;
  const companyPattern = /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/;
  const titlePattern = /工程师|经理|主管|顾问|销售|总监|专员|招商主管|总经理|主任|业务员|运营|设计师|分析师|店长|讲师/;
  const lineBreakTokenInPage = '__AUTORECRUIT_LINE_BREAK__';
  const sourceIdPattern = /data-resume-id|data-candidate-id|resumeId=|candidateId=/i;
  const resumeDetailPattern = /\/resume\//;
  const resumeDetailAltPattern = /\/resume-detail\//;
  const resumeQueryPattern = /resumeId=|candidateId=/i;
  const resultById = new Map<string, {
    candidateId: string;
    resumeUrl?: string;
    name?: string;
    currentCompany?: string;
    currentTitle?: string;
    cardText?: string;
    sourceText?: string;
  }>();

  for (const element of elements) {
    const anchor = element as HTMLAnchorElement;
    const container = anchor.closest('li, [class*="card"], [class*="item"], [class*="list"], article, section, div, [data-resume-id], [data-candidate-id]') ?? anchor;
    const cardText = (container.textContent ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n+/g, lineBreakTokenInPage)
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/(?:__AUTORECRUIT_LINE_BREAK__)+/g, lineBreakTokenInPage)
      .trim();
    const sourceParts: string[] = [];

    if (anchor.href) {
      sourceParts.push(anchor.href);
    }
    if (anchor.outerHTML) {
      sourceParts.push(anchor.outerHTML);
    }
    if (cardText) {
      sourceParts.push(cardText.split(lineBreakTokenInPage).join(' ').replace(/\s+/g, ' ').trim());
    }

    for (const [node, attributeName] of [
      [anchor, 'data-resume-id'],
      [anchor, 'data-candidate-id'],
      [container, 'data-resume-id'],
      [container, 'data-candidate-id'],
      [container, 'href'],
      [container, 'outerHTML'],
    ] as const) {
      if (typeof node.getAttribute !== 'function') {
        continue;
      }
      const value = node.getAttribute(attributeName);
      if (value) {
        sourceParts.push(value);
      }
    }

    const sourceText = sourceParts.join(' ');
    let candidateId: string | undefined;
    for (const pattern of candidatePatterns) {
      const match = sourceText.match(pattern);
      if (match) {
        candidateId = match[1];
        break;
      }
    }

    if (!candidateId) {
      continue;
    }

    const lines: string[] = [];
    for (const rawLine of cardText.split(/\r?\n|__AUTORECRUIT_LINE_BREAK__/)) {
      const line = (rawLine ?? '').replace(/\s+/g, ' ').trim();
      if (line) {
        lines.push(line);
      }
    }

    let name: string | undefined;
    let currentCompany: string | undefined;
    let currentTitle: string | undefined;

    for (const line of lines) {
      if (!name && personNamePattern.test(line) && !nonNamePattern.test(line)) {
        name = line;
      }
      if (!currentCompany && companyPattern.test(line)) {
        currentCompany = line;
      }
      if (!currentTitle && titlePattern.test(line)) {
        currentTitle = line;
      }
    }

    const containerHref = typeof container.getAttribute === 'function' ? container.getAttribute('href') : null;
    const nextCandidate = {
      candidateId,
      resumeUrl: anchor.href || containerHref || undefined,
      name,
      currentCompany,
      currentTitle,
      cardText,
      sourceText,
    };
    const existingCandidate = resultById.get(candidateId);

    if (!existingCandidate) {
      resultById.set(candidateId, nextCandidate);
      continue;
    }

    let nextScore = 0;
    let existingScore = 0;

    if (nextCandidate.sourceText && sourceIdPattern.test(nextCandidate.sourceText)) {
      nextScore += 2;
    }
    if (existingCandidate.sourceText && sourceIdPattern.test(existingCandidate.sourceText)) {
      existingScore += 2;
    }

    if (nextCandidate.resumeUrl && !(resumeDetailPattern.test(nextCandidate.resumeUrl) || resumeDetailAltPattern.test(nextCandidate.resumeUrl))) {
      nextScore += 1;
    }
    if (existingCandidate.resumeUrl && !(resumeDetailPattern.test(existingCandidate.resumeUrl) || resumeDetailAltPattern.test(existingCandidate.resumeUrl))) {
      existingScore += 1;
    }

    if (nextCandidate.name && !/^重复/.test(nextCandidate.name)) {
      nextScore += 1;
    }
    if (existingCandidate.name && !/^重复/.test(existingCandidate.name)) {
      existingScore += 1;
    }

    if (nextCandidate.resumeUrl) {
      if (resumeDetailPattern.test(nextCandidate.resumeUrl) || resumeDetailAltPattern.test(nextCandidate.resumeUrl)) {
        nextScore += 3;
      } else if (resumeQueryPattern.test(nextCandidate.resumeUrl)) {
        nextScore += 2;
      } else {
        nextScore += 1;
      }
    }
    if (existingCandidate.resumeUrl) {
      if (resumeDetailPattern.test(existingCandidate.resumeUrl) || resumeDetailAltPattern.test(existingCandidate.resumeUrl)) {
        existingScore += 3;
      } else if (resumeQueryPattern.test(existingCandidate.resumeUrl)) {
        existingScore += 2;
      } else {
        existingScore += 1;
      }
    }

    if (nextCandidate.currentCompany) {
      nextScore += 1;
    }
    if (existingCandidate.currentCompany) {
      existingScore += 1;
    }

    if (nextCandidate.currentTitle) {
      nextScore += 1;
    }
    if (existingCandidate.currentTitle) {
      existingScore += 1;
    }

    if (nextCandidate.cardText) {
      nextScore += 1;
    }
    if (existingCandidate.cardText) {
      existingScore += 1;
    }

    if (nextScore > existingScore) {
      resultById.set(candidateId, nextCandidate);
    }
  }

  return Array.from(resultById.values());
}

async function collectLiepinCards(page: Page): Promise<Array<{
  candidateId: string;
  resumeUrl?: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  cardText?: string;
  sourceText?: string;
}>> {
  return page.locator(candidateLinkSelector).evaluateAll(extractLiepinCardsInPage);
}

function isLiepinExplicitEmptyText(text: string): boolean {
  return /暂无(?:符合条件的)?人才|暂无.*人选|暂无.*简历|暂无.*结果|没有找到.*(?:人才|人选|简历|结果)|未找到.*(?:人才|人选|简历|结果)|共0位人选/.test(normalizeText(text));
}

async function hasLiepinExplicitEmptyResults(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return isLiepinExplicitEmptyText(bodyText);
}

function mergeLiepinCardCandidatesWithApi(
  cardCandidates: CandidateListItem[],
  apiCandidates: CandidateListItem[],
): CandidateListItem[] {
  const apiCandidatesById = new Map(apiCandidates.map((candidate) => [candidate.candidateId, candidate]));
  return cardCandidates.map((candidate) => mergeLiepinApiCandidateIntoCardCandidate(candidate, apiCandidatesById.get(candidate.candidateId)));
}

async function readLiepinDomCandidates(page: Page): Promise<CandidateListItem[]> {
  return (await collectLiepinCards(page))
    .map((candidate) => mergeLiepinApiCandidateIntoCardCandidate(candidate, undefined));
}

async function resolveLiepinCardCandidates(
  page: Page,
  cardCandidates: CandidateListItem[],
  isSearchPage: boolean,
  deadline: number,
): Promise<{ candidates: CandidateListItem[] }> {
  if (!isSearchPage || !cardCandidates.some(candidateNeedsSafeLiepinResumeUrl)) {
    return { candidates: cardCandidates };
  }

  const apiCandidates = await waitForLiepinSearchResumesApi(
    page,
    boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs),
  ).catch(() => []);

  return {
    candidates: mergeLiepinCardCandidatesWithApi(cardCandidates, apiCandidates),
  };
}

async function requireLiepinReadyPage(pagePromise: Promise<Page | null>): Promise<Page> {
  const page = await pagePromise;
  if (!page) {
    throw new Error('Liepin resume detail page was not ready');
  }

  return page;
}

async function waitForLiepinResumeOpenAfterClick(
  context: BrowserContext,
  searchPage: Page,
  previousUrl: string,
  deadline: number,
  clickAction: () => Promise<void>,
): Promise<Page | null> {
  let popupSettled = false;
  const popupPagePromise = context.waitForEvent('page', { timeout: remainingTime(deadline) })
    .then(async (popupPage) => {
      if (isLiepinPublicZhaopinUrl(popupPage.url())) {
        await popupPage.close().catch(() => undefined);
        return null;
      }

      await waitForLiepinPageReady(popupPage, { deadline });
      return popupPage;
    })
    .catch(() => null)
    .finally(() => {
      popupSettled = true;
    });
  const popupPromise = requireLiepinReadyPage(popupPagePromise);
  const waitForFunction = (searchPage as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(searchPage);
  const currentPagePromise = waitForFunction
    ? requireLiepinReadyPage(waitForFunction(
      (url) => window.location.href !== url,
      previousUrl,
      { timeout: remainingTime(deadline), polling: 100 },
    )
      .then(async () => {
        if (isLiepinPublicZhaopinUrl(searchPage.url())) {
          return null;
        }

        await waitForLiepinPageReady(searchPage, { deadline });
        return searchPage;
      })
      .catch(() => null))
    : undefined;
  const readyPromise = Promise.any([
    popupPromise,
    ...(currentPagePromise ? [currentPagePromise] : []),
  ]).catch(() => null);

  try {
    await clickAction();
  } catch (error) {
    void readyPromise.catch(() => undefined);
    throw error;
  }

  if (!currentPagePromise && !popupSettled && searchPage.url() !== previousUrl && !isLiepinPublicZhaopinUrl(searchPage.url())) {
    await waitForLiepinPageReady(searchPage, { deadline });
    return searchPage;
  }

  return readyPromise;
}

async function openResumePage(context: BrowserContext, searchPage: Page, candidate: CandidateListItem): Promise<Page> {
  const deadline = createDeadline();

  if (candidate.resumeUrl && isSafeLiepinResumeUrl(candidate.resumeUrl)) {
    const page = await context.newPage();
    await page.goto(candidate.resumeUrl, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
    await waitForLiepinPageReady(page, { deadline });
    return page;
  }

  const previousUrl = searchPage.url();
  const candidateLink = searchPage.locator(`${candidateLinkSelector}[href*="${candidate.candidateId}"]`).first();
  try {
    await candidateLink.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
    const detailPage = await waitForLiepinResumeOpenAfterClick(
      context,
      searchPage,
      previousUrl,
      deadline,
      () => candidateLink.click({ timeout: remainingTime(deadline) }),
    );
    if (detailPage) {
      return detailPage;
    }
    if (searchPage.url() !== previousUrl && !isLiepinPublicZhaopinUrl(searchPage.url())) {
      await waitForLiepinPageReady(searchPage, { deadline });
      return searchPage;
    }
  } catch {
    throw new Error(`Could not open Liepin resume detail for candidate ${candidate.candidateId} without using a public zhaopin URL.`);
  }

  throw new Error(`Could not open Liepin resume detail for candidate ${candidate.candidateId} without using a public zhaopin URL.`);
}

export const liepinAdapter: PlatformAdapter = {
  platform: 'liepin',
  displayName: 'Liepin',
  subscribeSearchUrl: liepinAuthenticatedUrl,
  loginUrl: liepinLoginUrl,
  storageStateFileName: 'storage-state.liepin.json',
  openLoginPage: async (page) => {
    await page.goto(liepinLoginUrl, { waitUntil: 'domcontentloaded' });
  },
  openAuthenticatedHome: async (page) => {
    await page.goto(liepinAuthenticatedUrl, { waitUntil: 'domcontentloaded' });
    await waitForLiepinPageReady(page);
    return page;
  },
  assertAuthenticated: assertLiepinAuthenticated,
  openSubscribeSearch: async (page, keyword, options) => {
    const deadline = createSearchDeadline(options);
    resetObservedLiepinSearchResumesApi(page);
    attachLiepinSearchResumesApiObserver(page);

    if (!isLiepinSearchUrl(page.url())) {
      try {
        await page.goto(liepinAuthenticatedUrl, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
      } catch (error) {
        if (!isAbortNavigationError(error) || !isLiepinSearchUrl(page.url())) {
          throw error;
        }
      }
    }

    await waitForLiepinPageReady(page, { deadline });
    await clickLiepinQuickSearchTag(page, keyword, deadline);
    await waitForLiepinPageReady(page, { deadline });

    if (options?.includeViewedCandidates) {
      const clickedSearchButton = await clickLiepinSearchButtonIfHideViewedMissing(page, deadline, {
        beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
      });
      if (clickedSearchButton) {
        await waitForLiepinPageReady(page, { deadline });
      }

      const clickedHideViewed = await ensureLiepinHideViewedUnchecked(page, deadline, {
        beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
      });
      if (clickedSearchButton || clickedHideViewed) {
        await waitForLiepinSearchResumesApi(page, boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs)).catch(() => []);
      }
      await waitForLiepinPageReady(page, { deadline });
      return page;
    }

    if (await clickLiepinSearchButtonIfHideViewedMissing(page, deadline)) {
      await waitForLiepinPageReady(page, { deadline });
    }
    const clickedHideViewed = await ensureLiepinHideViewedChecked(page, deadline, {
      beforeClick: () => clearObservedLiepinSearchResumesApiBeforeNextAction(page),
    });
    if (clickedHideViewed) {
      await waitForLiepinSearchResumesApi(page, boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs)).catch(() => []);
    }
    await waitForLiepinPageReady(page, { deadline });
    return page;
  },
  prepareSearchConditionPage: prepareLiepinSearchConditionPage,
  readSearchConditionResultTotal: readLiepinSearchConditionResultTotal,
  saveSearchCondition: async (page, savedSearchName) => {
    await saveSearchConditionByCommonDialog(page, savedSearchName, { platformLabel: 'liepin' });
    await waitForLiepinPageReady(page);
  },
  extractCandidateList: async (page, options) => {
    const deadline = createSearchDeadline(options);
    const isSearchPage = isLiepinSearchUrl(page.url());
    attachLiepinSearchResumesApiObserver(page);

    await waitForLiepinExtractionReady(page, deadline);
    let candidates = await readLiepinDomCandidates(page);
    if (candidates.length > 0) {
      return resolveLiepinCardCandidates(page, candidates, isSearchPage, deadline);
    }

    while (Date.now() <= deadline) {
      if (isSearchPage) {
        const apiCandidates = await waitForLiepinSearchResumesApi(
          page,
          Math.min(100, remainingTime(deadline)),
        ).catch(() => []);
        if (apiCandidates.length > 0) {
          return { candidates: apiCandidates };
        }
      }

      candidates = await readLiepinDomCandidates(page);
      if (candidates.length > 0) {
        return resolveLiepinCardCandidates(page, candidates, isSearchPage, deadline);
      }

      if (await hasLiepinExplicitEmptyResults(page)) {
        return { candidates: [] };
      }

      if (!isSearchPage || observedLiepinSearchApiSeenPages.has(page)) {
        return { candidates };
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingTime(deadline))));
    }

    const finalApiCandidates = isSearchPage
      ? await waitForLiepinSearchResumesApi(page, 1).catch(() => [])
      : [];
    if (finalApiCandidates.length > 0) {
      return { candidates: finalApiCandidates };
    }

    candidates = await readLiepinDomCandidates(page);
    if (candidates.length > 0) {
      return resolveLiepinCardCandidates(page, candidates, isSearchPage, deadline);
    }

    if (await hasLiepinExplicitEmptyResults(page)) {
      return { candidates: [] };
    }

    return { candidates: [] };
  },
  openResumeDetail: async (context, searchPage, candidate) => openResumePage(context, searchPage, candidate),
  parseResumeDetail: async (page, candidate) => {
    await waitForLiepinPageReady(page);
    const bodyRawText = await page.locator('body').innerText();
    const bodyText = normalizePreservingLines(bodyRawText);
    const lines = splitNormalizedLines(bodyText).filter((line) => !isNoiseLine(line));

    for (const selector of detailReadySelectors) {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'attached', timeout: 1 }).catch(() => undefined);
    }

    const name = candidate.name
      ?? lines.find((line) => isLikelyPersonName(line))
      ?? undefined;
    const education = lines.find((line) => isLikelyEducation(line));
    const regionLine = lines.find((line) => isLikelyRegion(line));
    const company = candidate.currentCompany ?? lines.find((line) => isLikelyCompany(line));
    const title = candidate.currentTitle ?? lines.find((line) => isLikelyTitle(line));
    const workExperiences = parseWorkExperiences(lines, company, title);
    const projectExperiences = parseProjectExperiences(lines);
    const educationExperiences = parseEducationExperiences(lines, education);
    const certificates = parseCertificates(lines);

    return {
      candidateId: candidate.candidateId || extractCandidateIdFromText(page.url()) || candidate.candidateId,
      resumeUrl: candidate.resumeUrl ?? page.url(),
      name,
      education,
      regions: regionLine ? [regionLine] : [],
      pr: [],
      workExperiences,
      projectExperiences,
      educationExperiences,
      skill: [],
      certificates,
    } satisfies CandidateResume;
  },
};
