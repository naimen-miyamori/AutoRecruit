import { Page } from 'playwright';
import { config } from '../config.js';
import type { SearchWaitOptions } from '../platforms/types.js';
import { CandidateListItem } from '../types/job.js';

export const candidateCardSelector = 'div[id^="no_interested_"]';
const recommendationBoundaryText = '未找到更多，为你推荐人才';
const resultListSelector = '.virtual_list';
const candidateContainerSelector = '.talent-card, .resume-card, .candidate-card, li, .item, .result-item, [class*="card"]';
const emptyResultsPattern = /暂无(?:符合条件的)?人才|暂无.*人才|暂无搜索结果|暂无.*结果|没有找到.*人才|没有.*结果|未找到.*人才|无结果/;
const candidateListPollIntervalMs = 100;

export type CandidateListSourceCard = {
  elementId?: string;
  html?: string;
  text?: string;
  resumeUrl?: string;
  name?: string;
};

export function extractCandidateId(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const patterns = [
    /no_interested_(\d{5,})/i,
    /talent[_-]?id[=:\"']+(\d{5,})/i,
    /resume[_-]?id[=:\"']+(\d{5,})/i,
    /candidateId[=:\"']+(\d{5,})/i,
    /data-(?:id|resume-id|candidate-id)=\"?(\d{5,})/i,
    /人才ID[:：]?\s*(\d{5,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

export function extractCurrentCompany(cardText: string): string | undefined {
  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /公司|集团|科技|咨询|设备|阀门|控制|贸易|有限/.test(line));
}

export function extractCurrentTitle(cardText: string): string | undefined {
  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /工程师|经理|主管|顾问|销售|老师|总监|专员/.test(line));
}

export function parseCandidateCards(cards: CandidateListSourceCard[]): CandidateListItem[] {
  const results: CandidateListItem[] = [];
  const seenIds = new Set<string>();

  for (const card of cards) {
    const cardText = card.text?.trim() ?? '';
    const sourceText = `${card.elementId ?? ''} ${cardText} ${card.html ?? ''}`.trim();
    const candidateId = extractCandidateId(sourceText);

    if (!candidateId || seenIds.has(candidateId)) {
      continue;
    }

    seenIds.add(candidateId);
    results.push({
      candidateId,
      resumeUrl: card.resumeUrl,
      name: card.name?.trim() || undefined,
      currentCompany: cardText ? extractCurrentCompany(cardText) : undefined,
      currentTitle: cardText ? extractCurrentTitle(cardText) : undefined,
      cardText,
      sourceText,
    });
  }

  return results;
}

export function isRecommendationBoundaryText(text: string | null | undefined): boolean {
  return (text ?? '').replace(/\s+/g, '').includes(recommendationBoundaryText);
}

function resolveSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + config.playwright.searchPageTimeoutMs;
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 0);
}

async function waitForPageTimeout(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }

  const waitForTimeout = (page as Partial<Pick<Page, 'waitForTimeout'>>).waitForTimeout?.bind(page);
  if (waitForTimeout) {
    await waitForTimeout(timeoutMs);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function isLocatorVisible(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

async function isAnyLoadingVisible(page: Page): Promise<boolean> {
  const selectors = ['.base-page-loading', '.el-loading-mask'];
  for (const selector of selectors) {
    if (await isLocatorVisible(page, selector)) {
      return true;
    }
  }

  return false;
}

class CandidateListStateTimeout extends Error {
  constructor(readonly stableEmptyListObservedMs: number) {
    super('Candidate list state did not become ready before deadline.');
  }
}

async function waitForKnownCandidateListState(page: Page, deadline: number): Promise<'candidates' | 'empty' | 'empty-list'> {
  let stableEmptyListStartedAt: number | undefined;
  let stableEmptyListObservedMs = 0;

  while (Date.now() <= deadline) {
    const candidateCardCount = await page.locator(candidateCardSelector).count().catch(() => 0);
    if (candidateCardCount > 0) {
      return 'candidates';
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (emptyResultsPattern.test(bodyText)) {
      return 'empty';
    }

    const resultListVisible = await isLocatorVisible(page, resultListSelector);
    const loadingVisible = await isAnyLoadingVisible(page);
    if (resultListVisible && !loadingVisible) {
      const now = Date.now();
      stableEmptyListStartedAt ??= now;
      stableEmptyListObservedMs = now - stableEmptyListStartedAt;

      if (stableEmptyListObservedMs >= config.playwright.emptyResultsStableMs) {
        return 'empty-list';
      }
    } else {
      stableEmptyListStartedAt = undefined;
      stableEmptyListObservedMs = 0;
    }

    const waitMs = Math.min(candidateListPollIntervalMs, remainingTime(deadline));
    if (waitMs <= 0) {
      break;
    }

    await waitForPageTimeout(page, waitMs);
  }

  throw new CandidateListStateTimeout(stableEmptyListObservedMs);
}

async function collectCandidateListDiagnostics(page: Page): Promise<{
  url: string;
  bodyTextLength: number;
  emptyTextMatched: boolean;
  loadingVisible: boolean;
  resultListVisible: boolean;
  appRootCount: number;
  candidateCardCount: number;
  stableEmptyListObservedMs: number;
  deadlineRemainingMs: number;
}> {
  return collectCandidateListDiagnosticsWithState(page, {
    stableEmptyListObservedMs: 0,
    deadline: Date.now(),
  });
}

async function collectCandidateListDiagnosticsWithState(page: Page, state: {
  stableEmptyListObservedMs: number;
  deadline: number;
}): Promise<{
  url: string;
  bodyTextLength: number;
  emptyTextMatched: boolean;
  loadingVisible: boolean;
  resultListVisible: boolean;
  appRootCount: number;
  candidateCardCount: number;
  stableEmptyListObservedMs: number;
  deadlineRemainingMs: number;
}> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const loadingVisible = await isAnyLoadingVisible(page);
  const resultListVisible = await isLocatorVisible(page, resultListSelector);
  const appRootCount = await page.locator('#app, #root, [data-testid="app-root"]').count().catch(() => 0);
  const candidateCardCount = await page.locator(candidateCardSelector).count().catch(() => 0);

  return {
    url: page.url(),
    bodyTextLength: bodyText.trim().length,
    emptyTextMatched: emptyResultsPattern.test(bodyText),
    loadingVisible,
    resultListVisible,
    appRootCount,
    candidateCardCount,
    stableEmptyListObservedMs: state.stableEmptyListObservedMs,
    deadlineRemainingMs: remainingTime(state.deadline),
  };
}

function buildCandidateListTimeoutMessage(diagnostics: {
  url: string;
  bodyTextLength: number;
  emptyTextMatched: boolean;
  loadingVisible: boolean;
  resultListVisible: boolean;
  appRootCount: number;
  candidateCardCount: number;
  stableEmptyListObservedMs: number;
  deadlineRemainingMs: number;
}): string {
  return [
    'Candidate list did not render before timeout.',
    `url=${diagnostics.url}`,
    `bodyTextLength=${diagnostics.bodyTextLength}`,
    `emptyTextMatched=${diagnostics.emptyTextMatched}`,
    `loadingVisible=${diagnostics.loadingVisible}`,
    `resultListVisible=${diagnostics.resultListVisible}`,
    `appRootCount=${diagnostics.appRootCount}`,
    `candidateCardCount=${diagnostics.candidateCardCount}`,
    `stableEmptyListObservedMs=${diagnostics.stableEmptyListObservedMs}`,
    `deadlineRemainingMs=${diagnostics.deadlineRemainingMs}`,
  ].join(' ');
}

export async function waitForCandidateResultsReady(page: Page, options?: SearchWaitOptions): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  await page.waitForLoadState('domcontentloaded');

  try {
    await waitForKnownCandidateListState(page, deadline);
    return;
  } catch (error) {
    const stableEmptyListObservedMs = error instanceof CandidateListStateTimeout
      ? error.stableEmptyListObservedMs
      : 0;
    const diagnostics = await collectCandidateListDiagnosticsWithState(page, {
      stableEmptyListObservedMs,
      deadline,
    });

    throw new Error(buildCandidateListTimeoutMessage(diagnostics));
  }
}

export async function collectCandidateList(page: Page, options?: SearchWaitOptions): Promise<CandidateListItem[]> {
  await waitForCandidateResultsReady(page, options);

  const firstResultList = page.locator(resultListSelector).first();
  const cards = await firstResultList.locator(candidateCardSelector).evaluateAll((elements, containerSelector) => {
    return elements.map((element) => {
      const container = element.closest(containerSelector) ?? element.parentElement?.parentElement ?? element.parentElement;
      const linkElement = container?.querySelector('a[href]') as HTMLAnchorElement | null;
      const nameElement = container?.querySelector('[class*=name], [title]');

      return {
        elementId: element.id || undefined,
        html: container?.outerHTML ?? element.outerHTML,
        text: container?.textContent?.trim() ?? element.textContent?.trim() ?? '',
        resumeUrl: linkElement?.href,
        name: nameElement?.textContent?.trim() || undefined,
      };
    });
  }, candidateContainerSelector);

  return parseCandidateCards(cards);
}
