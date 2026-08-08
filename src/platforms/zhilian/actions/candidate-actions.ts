import type { Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
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
  boundedZhilianActionMs as boundedTimeout,
  createZhilianSearchDeadline as createSearchDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import { waitForZhilianRecruiterShell } from './navigation-actions.js';

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
  searchResultIndex?: number;
  isRelatedRecommendation?: boolean;
};

type ZhilianVueCandidateSnapshot = {
  candidate?: ZhilianApiCandidate;
  rawText: string;
  containerOuterHtml: string;
  searchResultIndex?: number;
  isRelatedRecommendation?: boolean;
};

type ZhilianCollectedCards = {
  candidates: CandidateListItem[];
  sawSearchResultCards: boolean;
  sawRelatedRecommendationCards: boolean;
};

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
const observedZhilianSearchApiCandidates = new WeakMap<Page, CandidateListItem[]>();
const observedZhilianSearchApiSeenPages = new WeakSet<Page>();
const observedZhilianSearchApiListenerPages = new WeakSet<Page>();
const zhilianSearchStatePollMs = 100;

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
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

const nextControlSelectors = [
  '.el-pagination .btn-next',
  '.ant-pagination-next button',
  '.ant-pagination-next a',
  '.ant-pagination-next',
  '[aria-label="下一页"]',
  '[aria-label="Next page"]',
  '.pagination-next',
  '.next-page',
  'button:has-text("加载更多")',
];
const currentPageSelector = [
  '.el-pager li.active',
  '.ant-pagination-item-active',
  '[aria-current="page"]',
  '.pagination .active',
].join(', ');
const virtualCandidateAnchorSelector = [
  'a[href*="resume"]',
  'a[href*="candidate"]',
  'a[href*="talent"]',
  '[data-resume-id]',
  '[data-candidate-id]',
  '[data-talent-id]',
].join(', ');

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Zhilian candidate batch deadline exhausted');
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
      throw new Error('Zhilian next candidate batch control is ambiguous');
    }
    if (visible.length === 1) {
      return visible[0];
    }
  }
  return undefined;
}

async function findZhilianNextBatchControl(page: Page): Promise<Locator | undefined> {
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

async function readZhilianBatchNumber(page: Page): Promise<number | undefined> {
  const activePages = page.locator(currentPageSelector);
  const count = await activePages.count().catch(() => 0);
  if (count > 1) {
    throw new Error('Zhilian current candidate batch identity is ambiguous');
  }
  if (count === 0) {
    return undefined;
  }
  const value = Number((await activePages.first().innerText().catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function hasZhilianSearchResultBoundary(page: Page): Promise<boolean> {
  const markers = [
    page.getByText(/更多相关人才/, { exact: false }),
    page.getByText(/没有更多|已加载全部|到底了|暂无更多/, { exact: false }),
  ];
  for (const marker of markers) {
    const count = await marker.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await marker.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

async function hasExplicitZhilianEmptyResult(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有符合条件的人才|暂无符合条件的人才|暂无搜索结果/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function scrollZhilianVirtualCandidateBatch(
  page: Page,
  candidates: readonly CandidateListItem[],
  deadline: number,
): Promise<boolean> {
  const lastCandidate = candidates.at(-1);
  if (!lastCandidate) {
    return false;
  }
  const anchors = page.locator(virtualCandidateAnchorSelector);
  const index = await anchors.evaluateAll((elements, candidateId) => {
    for (let itemIndex = elements.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const element = elements[itemIndex];
      const identity = [
        element.getAttribute('href'),
        element.getAttribute('data-resume-id'),
        element.getAttribute('data-candidate-id'),
        element.getAttribute('data-talent-id'),
      ].filter(Boolean).join(' ');
      if (identity.includes(String(candidateId))) {
        return itemIndex;
      }
    }
    return -1;
  }, lastCandidate.candidateId).catch(() => -1);
  if (index < 0) {
    return false;
  }

  await waitPlatformActionPace(page, 'zhilian');
  await anchors.nth(index).scrollIntoViewIfNeeded({ timeout: remainingMs(deadline) });
  return true;
}

export async function readZhilianCurrentCandidateBatch(
  page: Page,
  options: SearchWaitOptions,
): Promise<CandidateResultBatch> {
  if (options.deadline !== undefined) {
    remainingMs(options.deadline);
  }
  const { candidates } = await extractZhilianCandidateList(page, options);
  const batchNumber = await readZhilianBatchNumber(page);
  const nextControl = candidates.length > 0 ? await findZhilianNextBatchControl(page) : undefined;
  const terminalEvidence = await hasExplicitZhilianEmptyResult(page)
    ? 'explicit-empty-result' as const
    : await hasZhilianSearchResultBoundary(page) || Boolean(nextControl && await isDisabled(nextControl))
      ? 'explicit-pagination-end' as const
      : 'not-terminal' as const;
  return {
    candidates,
    batchIdentity: buildCandidateBatchIdentity('zhilian', candidates, batchNumber),
    batchNumber,
    endReached: terminalEvidence !== 'not-terminal',
    terminalEvidence,
  };
}

export async function advanceZhilianToNextCandidateBatch(
  page: Page,
  input: AdvanceCandidateBatchInput,
): Promise<AdvanceCandidateBatchResult> {
  remainingMs(input.deadline);
  const current = await readZhilianCurrentCandidateBatch(page, { deadline: input.deadline });
  if (current.batchIdentity !== input.expectedCurrentBatchIdentity) {
    throw new Error(`Zhilian candidate batch changed before advance: expected ${input.expectedCurrentBatchIdentity}, got ${current.batchIdentity}`);
  }
  if (current.endReached) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  const nextControl = await findZhilianNextBatchControl(page);
  if (nextControl) {
    if (await isDisabled(nextControl)) {
      return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
    }
    await waitPlatformActionPace(page, 'zhilian');
    await clickPlatformLocator(nextControl, page, 'zhilian', remainingMs(input.deadline), { pace: false });
  } else if (!await scrollZhilianVirtualCandidateBatch(page, current.candidates, input.deadline)) {
    throw new Error('Zhilian candidate batch end cannot be established and no virtual-list advance target is available');
  }

  while (Date.now() < input.deadline) {
    const next = await readZhilianCurrentCandidateBatch(page, { deadline: input.deadline });
    if (next.batchIdentity !== current.batchIdentity) {
      return { status: 'advanced', batch: next };
    }
    if (next.endReached) {
      return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
    }
    await page.waitForTimeout(Math.min(150, remainingMs(input.deadline))).catch(() => undefined);
  }

  throw new Error(`Zhilian next candidate batch did not change from ${current.batchIdentity}`);
}

export function clearObservedZhilianCandidateApi(page: Page): void {
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

export function parseZhilianApiCandidates(payload: string): CandidateListItem[] {
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

export function attachZhilianCandidateApiObserver(page: Page): void {
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

export function extractZhilianCandidateIdFromText(text: string): string | undefined {
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

export function extractZhilianCardsInPage(elements: Element[]): CandidateListItem[] {
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

export function parseZhilianDomCandidateSnapshots(snapshots: ZhilianDomCandidateSnapshot[]): CandidateListItem[] {
  const resultById = new Map<string, CandidateListItem>();

  for (const snapshot of snapshots) {
    if (snapshot.isRelatedRecommendation) {
      continue;
    }

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

    const candidate: CandidateListItem = {
      candidateId,
      resumeUrl: snapshot.href || undefined,
      name,
      currentCompany,
      currentTitle,
      cardText,
      sourceText,
    };

    if (snapshot.searchResultIndex !== undefined) {
      candidate.searchResultIndex = snapshot.searchResultIndex;
    }

    resultById.set(candidateId, candidate);
  }

  return Array.from(resultById.values());
}

export function parseZhilianVueCandidateSnapshots(snapshots: ZhilianVueCandidateSnapshot[]): CandidateListItem[] {
  const candidatesById = new Map<string, CandidateListItem>();

  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.isRelatedRecommendation) {
      continue;
    }

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
      searchResultIndex: snapshot.searchResultIndex ?? index,
    });
  }

  return Array.from(candidatesById.values());
}

async function collectZhilianCards(page: Page): Promise<ZhilianCollectedCards> {
  const vueSnapshots = await page.locator('.search-resume-item-wrap').evaluateAll((elements) => {
    const isAfterRelatedTalentBoundary = (element: Element): boolean => {
      const hasBoundaryText = (text: string | null | undefined) => /更多\s*相关\s*人才/.test(text ?? '');
      const querySelector = (element as Element & { querySelector?: Element['querySelector'] }).querySelector;
      if (querySelector && hasBoundaryText(querySelector.call(element, '.search-item-separator')?.textContent)) {
        return true;
      }
      let current: Element | null = element;
      while (current) {
        let previous = current.previousSibling;
        while (previous) {
          if (hasBoundaryText(previous.textContent)) {
            return true;
          }
          previous = previous.previousSibling;
        }
        current = current.parentElement;
      }
      return false;
    };

    return elements.map((element, index) => {
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
        searchResultIndex: index,
        isRelatedRecommendation: isAfterRelatedTalentBoundary(element),
      };
    });
  }).catch(() => []);
  const vueCandidates = parseZhilianVueCandidateSnapshots(vueSnapshots);
  const hasVueSearchResultSnapshots = vueSnapshots.some((snapshot) => !snapshot.isRelatedRecommendation);
  const hasVueRelatedRecommendationSnapshots = vueSnapshots.some((snapshot) => snapshot.isRelatedRecommendation);
  if (vueCandidates.length > 0 || (!hasVueSearchResultSnapshots && hasVueRelatedRecommendationSnapshots)) {
    return {
      candidates: vueCandidates,
      sawSearchResultCards: hasVueSearchResultSnapshots,
      sawRelatedRecommendationCards: hasVueRelatedRecommendationSnapshots,
    };
  }

  const snapshots = await page.locator(zhilianCandidateLinkSelector).evaluateAll((elements) => {
    const isAfterRelatedTalentBoundary = (element: Element): boolean => {
      const hasBoundaryText = (text: string | null | undefined) => /更多\s*相关\s*人才/.test(text ?? '');
      const querySelector = (element as Element & { querySelector?: Element['querySelector'] }).querySelector;
      if (querySelector && hasBoundaryText(querySelector.call(element, '.search-item-separator')?.textContent)) {
        return true;
      }
      let current: Element | null = element;
      while (current) {
        let previous = current.previousSibling;
        while (previous) {
          if (hasBoundaryText(previous.textContent)) {
            return true;
          }
          previous = previous.previousSibling;
        }
        current = current.parentElement;
      }
      return false;
    };

    return elements.map((element, index) => {
      const anchor = element as HTMLAnchorElement;
      const container = anchor.closest('li, [class*="card"], [class*="item"], [class*="resume"], [class*="candidate"], [class*="talent"], article, section, div') ?? anchor;
      return {
        href: anchor.href,
        anchorOuterHtml: anchor.outerHTML,
        containerOuterHtml: (container as HTMLElement).outerHTML,
        rawText: container.textContent ?? '',
        anchorText: anchor.textContent ?? '',
        searchResultIndex: index,
        isRelatedRecommendation: isAfterRelatedTalentBoundary(container),
      };
    });
  });

  return {
    candidates: parseZhilianDomCandidateSnapshots(snapshots),
    sawSearchResultCards: snapshots.some((snapshot) => !snapshot.isRelatedRecommendation),
    sawRelatedRecommendationCards: snapshots.some((snapshot) => snapshot.isRelatedRecommendation),
  };
}

function isZhilianExplicitEmptyText(text: string): boolean {
  return /暂无(?:符合条件的)?人才|暂无.*候选人|暂无.*简历|暂无.*结果|没有找到.*(?:人才|候选人|简历|结果)|未找到.*(?:人才|候选人|简历|结果)|无结果/.test(normalizeText(text));
}

async function hasZhilianExplicitEmptyResults(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return isZhilianExplicitEmptyText(bodyText);
}


export async function extractZhilianCandidateList(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ candidates: CandidateListItem[] }> {
  const deadline = createSearchDeadline(options);
  let stableEmptyApiStartedAt: number | undefined;
  attachZhilianCandidateApiObserver(page);
  await waitForZhilianRecruiterShell(page, { deadline });

  const domCandidates = await collectZhilianCards(page);
  if (domCandidates.candidates.length > 0) {
    return { candidates: domCandidates.candidates };
  }
  if (!domCandidates.sawSearchResultCards && domCandidates.sawRelatedRecommendationCards) {
    return { candidates: [] };
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
    if (nextDomCandidates.candidates.length > 0) {
      return { candidates: nextDomCandidates.candidates };
    }
    if (!nextDomCandidates.sawSearchResultCards && nextDomCandidates.sawRelatedRecommendationCards) {
      return { candidates: [] };
    }

    if (await hasZhilianExplicitEmptyResults(page)) {
      return { candidates: [] };
    }

    if (observedZhilianSearchApiSeenPages.has(page)) {
      const now = Date.now();
      stableEmptyApiStartedAt ??= now;
      if (now - stableEmptyApiStartedAt >= config.playwright.emptyResultsStableMs) {
        return { candidates: [] };
      }
    } else {
      stableEmptyApiStartedAt = undefined;
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  return { candidates: observedZhilianSearchApiCandidates.get(page) ?? [] };
}

