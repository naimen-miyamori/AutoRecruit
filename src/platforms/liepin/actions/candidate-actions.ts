import type { Locator, Page, Response } from 'playwright';
import {
  clickPlatformLocator,
  getPlatformCandidatePaceDelayMs,
  waitPlatformActionPace,
  waitPlatformCandidatePace,
} from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import { buildCandidateBatchIdentity } from '../../../talent-mapping/batch-identity.js';
import type { CandidateListItem } from '../../../types/job.js';
import type {
  AdvanceCandidateBatchInput,
  AdvanceCandidateBatchResult,
  CandidateResultBatch,
} from '../../../types/talent-mapping.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  boundedLiepinActionMs as boundedTimeout,
  createLiepinSearchDeadline as createSearchDeadline,
  remainingLiepinActionMs as remainingTime,
} from './context.js';
import { isLiepinSearchUrl } from './navigation-actions.js';
import { waitForLiepinExtractionReady } from './readiness.js';
import { isSafeLiepinResumeUrl } from './resume-url.js';

const liepinPlatform = 'liepin';
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
const observedLiepinSearchApiCandidates = new WeakMap<Page, CandidateListItem[]>();
const observedLiepinSearchApiSeenPages = new WeakSet<Page>();
const observedLiepinSearchApiListenerPages = new WeakSet<Page>();
const observedLiepinSearchApiGenerations = new WeakMap<Page, number>();
const observedLiepinSearchApiMinRequestStartTimes = new WeakMap<Page, number>();
const observedLiepinSearchApiEmptyResultPages = new WeakSet<Page>();

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

const nextControlSelectors = [
  '.ant-pagination-next button',
  '.ant-pagination-next a',
  '.ant-pagination-next',
  'li[title="下一页"] button',
  '[aria-label="下一页"]',
  '[aria-label="Next page"]',
  '.pagination-next',
  '.next-page',
  'button:has-text("加载更多")',
];
const currentPageSelector = [
  '.ant-pagination-item-active',
  '[aria-current="page"]',
  '.pagination .active',
].join(', ');

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Liepin candidate batch deadline exhausted');
  }
  return remaining;
}

async function findUniqueVisibleControl(page: Page, locators: Locator[]): Promise<Locator | undefined> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visible.push(candidate);
      }
    }
    if (visible.length > 1) {
      throw new Error('Liepin next candidate batch control is ambiguous');
    }
    if (visible.length === 1) {
      return visible[0];
    }
  }
  return undefined;
}

async function findLiepinNextBatchControl(page: Page): Promise<Locator | undefined> {
  return findUniqueVisibleControl(page, [
    ...nextControlSelectors.map((selector) => page.locator(selector)),
    page.getByRole('button', { name: /下一页|加载更多|next/i }),
    page.getByRole('link', { name: /下一页|next/i }),
  ]);
}

async function isDisabled(locator: Locator): Promise<boolean> {
  if (await locator.isDisabled().catch(() => false)) {
    return true;
  }
  const [ariaDisabled, className] = await Promise.all([
    locator.getAttribute('aria-disabled').catch(() => null),
    locator.getAttribute('class').catch(() => null),
  ]);
  return ariaDisabled === 'true' || /(?:^|\s)(?:disabled|ant-pagination-disabled|is-disabled)(?:\s|$)/i.test(className ?? '');
}

async function readLiepinBatchNumber(page: Page): Promise<number | undefined> {
  const activePages = page.locator(currentPageSelector);
  const count = await activePages.count().catch(() => 0);
  if (count > 1) {
    throw new Error('Liepin current candidate batch identity is ambiguous');
  }
  if (count === 0) {
    return undefined;
  }
  const value = Number((await activePages.first().innerText().catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function hasExplicitLiepinEndState(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有更多|已加载全部|到底了|暂无更多/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function hasExplicitLiepinEmptyResult(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有符合条件的人才|暂无符合条件的人才|暂无搜索结果/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

export async function readLiepinCurrentCandidateBatch(
  page: Page,
  options: SearchWaitOptions,
): Promise<CandidateResultBatch> {
  if (options.deadline !== undefined) {
    remainingMs(options.deadline);
  }
  const { candidates } = await extractLiepinCandidateList(page, options);
  const batchNumber = await readLiepinBatchNumber(page);
  const nextControl = candidates.length > 0 ? await findLiepinNextBatchControl(page) : undefined;
  const terminalEvidence = await hasExplicitLiepinEmptyResult(page)
    ? 'explicit-empty-result' as const
    : await hasExplicitLiepinEndState(page) || Boolean(nextControl && await isDisabled(nextControl))
      ? 'explicit-pagination-end' as const
      : 'not-terminal' as const;
  return {
    candidates,
    batchIdentity: buildCandidateBatchIdentity('liepin', candidates, batchNumber),
    batchNumber,
    endReached: terminalEvidence !== 'not-terminal',
    terminalEvidence,
  };
}

export async function advanceLiepinToNextCandidateBatch(
  page: Page,
  input: AdvanceCandidateBatchInput,
): Promise<AdvanceCandidateBatchResult> {
  remainingMs(input.deadline);
  const current = await readLiepinCurrentCandidateBatch(page, { deadline: input.deadline });
  if (current.batchIdentity !== input.expectedCurrentBatchIdentity) {
    throw new Error(`Liepin candidate batch changed before advance: expected ${input.expectedCurrentBatchIdentity}, got ${current.batchIdentity}`);
  }
  if (current.endReached) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  const nextControl = await findLiepinNextBatchControl(page);
  if (!nextControl) {
    throw new Error('Liepin candidate batch end cannot be established because no explicit next-page or terminal state is visible');
  }
  if (await isDisabled(nextControl)) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  await waitPlatformActionPace(page, 'liepin');
  await clickPlatformLocator(nextControl, page, 'liepin', remainingMs(input.deadline), { pace: false });
  while (Date.now() < input.deadline) {
    const next = await readLiepinCurrentCandidateBatch(page, { deadline: input.deadline });
    if (next.batchIdentity !== current.batchIdentity) {
      return { status: 'advanced', batch: next };
    }
    await page.waitForTimeout(Math.min(150, remainingMs(input.deadline))).catch(() => undefined);
  }

  throw new Error(`Liepin next candidate batch did not change from ${current.batchIdentity}`);
}

export function getLiepinCandidatePaceDelayMs(): number {
  return getPlatformCandidatePaceDelayMs(liepinPlatform);
}

export async function waitLiepinCandidatePace(page: Page): Promise<void> {
  await waitPlatformCandidatePace(page, liepinPlatform);
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
  if (candidates.length === 0) {
    observedLiepinSearchApiEmptyResultPages.add(page);
  } else {
    observedLiepinSearchApiEmptyResultPages.delete(page);
  }
}

function clearObservedLiepinSearchResumesApi(page: Page): void {
  observedLiepinSearchApiCandidates.delete(page);
  observedLiepinSearchApiSeenPages.delete(page);
  observedLiepinSearchApiEmptyResultPages.delete(page);
  bumpObservedLiepinSearchApiGeneration(page);
}

export function resetObservedLiepinSearchResumesApi(page: Page): void {
  observedLiepinSearchApiMinRequestStartTimes.delete(page);
  clearObservedLiepinSearchResumesApi(page);
}

export function clearObservedLiepinSearchResumesApiBeforeNextAction(page: Page): void {
  observedLiepinSearchApiMinRequestStartTimes.set(page, Date.now());
  clearObservedLiepinSearchResumesApi(page);
}

export async function waitForLiepinFinalSearchResumesOrEmptyResults(page: Page, deadline: number): Promise<void> {
  await waitForLiepinSearchResumesApi(
    page,
    boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs),
  ).catch(() => []);

  if (!observedLiepinSearchApiSeenPages.has(page)) {
    await hasLiepinExplicitEmptyResults(page).catch(() => false);
  }
}

export async function waitForLiepinQuickSearchResults(page: Page, deadline: number): Promise<void> {
  await waitForLiepinSearchResumesApi(
    page,
    boundedTimeout(deadline, config.playwright.apiFallbackTimeoutMs),
  ).catch(() => []);
}

export function attachLiepinSearchResumesApiObserver(page: Page): void {
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


export async function extractLiepinCandidateList(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ candidates: CandidateListItem[] }> {
  const deadline = createSearchDeadline(options);
  const isSearchPage = isLiepinSearchUrl(page.url());
  attachLiepinSearchResumesApiObserver(page);
  await waitForLiepinExtractionReady(page, deadline);
  if (observedLiepinSearchApiEmptyResultPages.has(page) || await hasLiepinExplicitEmptyResults(page)) {
    return { candidates: [] };
  }

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
      if (apiCandidates.length > 0) return { candidates: apiCandidates };
    }
    candidates = await readLiepinDomCandidates(page);
    if (candidates.length > 0) {
      return resolveLiepinCardCandidates(page, candidates, isSearchPage, deadline);
    }
    if (await hasLiepinExplicitEmptyResults(page)) return { candidates: [] };
    if (!isSearchPage || observedLiepinSearchApiSeenPages.has(page)) return { candidates };
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingTime(deadline))));
  }

  const finalApiCandidates = isSearchPage
    ? await waitForLiepinSearchResumesApi(page, 1).catch(() => [])
    : [];
  if (finalApiCandidates.length > 0) return { candidates: finalApiCandidates };
  candidates = await readLiepinDomCandidates(page);
  if (candidates.length > 0) {
    return resolveLiepinCardCandidates(page, candidates, isSearchPage, deadline);
  }
  return { candidates: [] };
}
