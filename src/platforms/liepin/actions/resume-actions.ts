import type { BrowserContext, Page } from 'playwright';
import { waitPlatformActionPace } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { CandidateProfileDetailResult } from '../../../types/talent-mapping.js';
import type { CandidateProfileDetailOptions } from '../../types.js';
import {
  isLiepinPublicZhaopinUrl,
  isSafeLiepinResumeUrl,
  openLiepinResumePage,
  parseLiepinResumeDetail,
} from './internal-page-actions.js';

export {
  isLiepinPublicZhaopinUrl,
  isSafeLiepinResumeUrl,
  openLiepinResumePage,
  parseLiepinResumeDetail,
};

function remainingDetailMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Liepin candidate profile detail deadline exhausted');
  }
  return remaining;
}

async function withinDetailDeadline<T>(deadline: number, operation: Promise<T>): Promise<T> {
  const timeoutMs = remainingDetailMs(deadline);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Liepin candidate profile detail deadline exhausted')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readLiepinCandidateProfileDetail(
  context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options: CandidateProfileDetailOptions,
): Promise<CandidateProfileDetailResult> {
  const detailPage = await openLiepinResumePage(context, searchPage, candidate, options);
  if (remainingDetailMs(options.deadline) <= config.playwright.actionDelayMaxMsByPlatform.liepin) {
    throw new Error('Liepin candidate profile detail deadline cannot accommodate the required post-open pacing interval');
  }
  await waitPlatformActionPace(detailPage, 'liepin');
  const resume = await withinDetailDeadline(options.deadline, parseLiepinResumeDetail(detailPage, candidate));
  if (resume.candidateId !== candidate.candidateId) {
    throw new Error(`Liepin candidate profile identity mismatch: expected ${candidate.candidateId}, got ${resume.candidateId}`);
  }
  const rawText = await withinDetailDeadline(options.deadline, detailPage.locator('body').innerText()).catch(() => undefined);
  return { resume, rawText, detailPage };
}
