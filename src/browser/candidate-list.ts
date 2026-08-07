/**
 * Compatibility exports for callers that predate the 51job semantic action
 * boundary. Live page reads delegate to the platform action; this shared
 * module owns no 51job selector, loading, or snapshot behavior.
 */
import type { Page } from 'playwright';
import {
  collectStable51jobCandidateList,
  waitFor51jobCandidateResultsReady,
} from '../platforms/51job/actions/result-actions.js';
import {
  extract51jobCandidateId,
  extract51jobCurrentCompany,
  extract51jobCurrentTitle,
  fiftyOneJobCandidateAnchorSelector,
  is51jobRecommendationBoundaryText,
  parse51jobCandidateCards,
  type FiftyOneJobCandidateSourceCard,
} from '../platforms/51job/parsing/candidate-list.js';
import type { SearchWaitOptions } from '../platforms/types.js';
import type { CandidateListItem } from '../types/job.js';

export const candidateCardSelector = fiftyOneJobCandidateAnchorSelector;
export type CandidateListSourceCard = FiftyOneJobCandidateSourceCard;
export const extractCandidateId = extract51jobCandidateId;
export const extractCurrentCompany = extract51jobCurrentCompany;
export const extractCurrentTitle = extract51jobCurrentTitle;
export const parseCandidateCards = parse51jobCandidateCards;

export function isRecommendationBoundaryText(text: string | null | undefined): boolean {
  return is51jobRecommendationBoundaryText(text);
}

export async function waitForCandidateResultsReady(page: Page, options?: SearchWaitOptions): Promise<void> {
  await waitFor51jobCandidateResultsReady(page, options);
}

export async function collectCandidateList(page: Page, options?: SearchWaitOptions): Promise<CandidateListItem[]> {
  return collectStable51jobCandidateList(page, options);
}
