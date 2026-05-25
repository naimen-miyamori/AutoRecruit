import { Page } from 'playwright';
import { CandidateListItem } from '../types/job.js';

export const candidateCardSelector = 'div[id^="no_interested_"]';
const recommendationBoundaryText = '未找到更多，为你推荐人才';
const resultListSelector = '.virtual_list';
const candidateContainerSelector = '.talent-card, .resume-card, .candidate-card, li, .item, .result-item, [class*="card"]';
const emptyResultsPattern = /暂无人才|暂无搜索结果|没有找到.*人才|未找到.*人才|无结果/;

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

async function isVisibleResultListEmpty(page: Page): Promise<boolean> {
  const resultList = page.locator(resultListSelector).first();

  try {
    await resultList.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return false;
  }

  return (await page.locator(candidateCardSelector).count()) === 0;
}

async function waitForKnownCandidateListState(page: Page): Promise<'candidates' | 'empty' | 'empty-list'> {
  const firstCandidateCard = page.locator(candidateCardSelector).first();

  return Promise.race([
    firstCandidateCard.waitFor({ state: 'visible', timeout: 10000 }).then(() => 'candidates' as const),
    page.locator('body').innerText()
      .then((bodyText) => (emptyResultsPattern.test(bodyText) ? 'empty' as const : new Promise<never>(() => undefined))),
    isVisibleResultListEmpty(page).then((isEmpty) => (isEmpty ? 'empty-list' as const : new Promise<never>(() => undefined))),
  ]);
}

async function collectCandidateListDiagnostics(page: Page): Promise<{
  url: string;
  bodyTextLength: number;
  loadingVisible: boolean;
  resultListVisible: boolean;
  appRootCount: number;
  candidateCardCount: number;
}> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const loadingVisible = await page.locator('.base-page-loading').count().then((count) => count > 0).catch(() => false);
  const resultListVisible = await page.locator(resultListSelector).count().then((count) => count > 0).catch(() => false);
  const appRootCount = await page.locator('#app, #root, [data-testid="app-root"]').count().catch(() => 0);
  const candidateCardCount = await page.locator(candidateCardSelector).count().catch(() => 0);

  return {
    url: page.url(),
    bodyTextLength: bodyText.trim().length,
    loadingVisible,
    resultListVisible,
    appRootCount,
    candidateCardCount,
  };
}

function buildCandidateListTimeoutMessage(diagnostics: {
  url: string;
  bodyTextLength: number;
  loadingVisible: boolean;
  resultListVisible: boolean;
  appRootCount: number;
  candidateCardCount: number;
}): string {
  return [
    'Candidate list did not render before timeout.',
    `url=${diagnostics.url}`,
    `bodyTextLength=${diagnostics.bodyTextLength}`,
    `loadingVisible=${diagnostics.loadingVisible}`,
    `resultListVisible=${diagnostics.resultListVisible}`,
    `appRootCount=${diagnostics.appRootCount}`,
    `candidateCardCount=${diagnostics.candidateCardCount}`,
  ].join(' ');
}

export async function waitForCandidateResultsReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  try {
    await waitForKnownCandidateListState(page);
    return;
  } catch {
    const diagnostics = await collectCandidateListDiagnostics(page);

    if (diagnostics.resultListVisible && diagnostics.candidateCardCount === 0) {
      return;
    }

    throw new Error(buildCandidateListTimeoutMessage(diagnostics));
  }
}

export async function collectCandidateList(page: Page): Promise<CandidateListItem[]> {
  await waitForCandidateResultsReady(page);

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
