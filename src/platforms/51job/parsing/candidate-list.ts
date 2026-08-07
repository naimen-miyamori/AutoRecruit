import type { CandidateListItem } from '../../../types/job.js';

/**
 * The card anchor is a platform-owned identity signal. It is intentionally
 * kept next to the pure conversion code so offline source validation and the
 * live 51job action use the same candidate-ID semantics.
 */
export const fiftyOneJobCandidateAnchorSelector = 'div[id^="no_interested_"]';
export const fiftyOneJobCandidateContainerSelector = '.talent-card, .resume-card, .candidate-card, li, .item, .result-item, [class*="card"]';
export const fiftyOneJobRecommendationBoundaryText = '未找到更多，为你推荐人才';

export type FiftyOneJobCandidateSourceCard = {
  elementId?: string;
  html?: string;
  text?: string;
  resumeUrl?: string;
  name?: string;
};

export function is51jobRecommendationBoundaryText(text: string | null | undefined): boolean {
  return (text ?? '').replace(/\s+/g, '').includes(fiftyOneJobRecommendationBoundaryText);
}

export function extract51jobCandidateId(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const patterns = [
    /no_interested_(\d{5,})/i,
    /talent[_-]?id[=:"']+(\d{5,})/i,
    /resume[_-]?id[=:"']+(\d{5,})/i,
    /candidateId[=:"']+(\d{5,})/i,
    /data-(?:id|resume-id|candidate-id)="?(\d{5,})/i,
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

export function extract51jobCurrentCompany(cardText: string): string | undefined {
  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /公司|集团|科技|咨询|设备|阀门|控制|贸易|有限/.test(line));
}

export function extract51jobCurrentTitle(cardText: string): string | undefined {
  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /工程师|经理|主管|顾问|销售|老师|总监|专员/.test(line));
}

export function parse51jobCandidateCards(cards: FiftyOneJobCandidateSourceCard[]): CandidateListItem[] {
  const results: CandidateListItem[] = [];
  const seenIds = new Set<string>();

  for (const card of cards) {
    const cardText = card.text?.trim() ?? '';
    const sourceText = `${card.elementId ?? ''} ${cardText} ${card.html ?? ''}`.trim();
    const candidateId = extract51jobCandidateId(sourceText);

    if (!candidateId || seenIds.has(candidateId)) {
      continue;
    }

    seenIds.add(candidateId);
    results.push({
      candidateId,
      resumeUrl: card.resumeUrl,
      name: card.name?.trim() || undefined,
      currentCompany: cardText ? extract51jobCurrentCompany(cardText) : undefined,
      currentTitle: cardText ? extract51jobCurrentTitle(cardText) : undefined,
      cardText,
      sourceText,
    });
  }

  return results;
}
