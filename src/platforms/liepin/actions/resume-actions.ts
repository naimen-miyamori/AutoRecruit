import type { BrowserContext, Page } from 'playwright';
import { waitPlatformActionPace } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { CandidateProfileDetailResult } from '../../../types/talent-mapping.js';
import type { CandidateProfileDetailOptions } from '../../types.js';
import {
  isLiepinPublicZhaopinUrl,
  isSafeLiepinResumeUrl,
} from './resume-url.js';
import { parseLiepinResumeText } from '../parsing/resume-parser.js';
import {
  clickLiepinLocator,
  createLiepinActionDeadline as createDeadline,
  remainingLiepinActionMs as remainingTime,
  waitLiepinActionPace,
} from './context.js';
import { waitForLiepinPageReady } from './readiness.js';
import { registerTemporaryRuntimePageForContext } from '../../../browser/runtime-page-registry.js';

export {
  isLiepinPublicZhaopinUrl,
  isSafeLiepinResumeUrl,
};

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
const detailReadySelectors = [
  '[class*="resume"]',
  '[class*="detail"]',
  '[class*="profile"]',
  '[class*="work"]',
  'main',
];

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

export async function openLiepinResumePage(
  context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<Page> {
  const deadline = options?.deadline ?? createDeadline();

  if (candidate.resumeUrl && isSafeLiepinResumeUrl(candidate.resumeUrl)) {
    const page = await context.newPage();
    registerTemporaryRuntimePageForContext(context, page, {
      purpose: 'candidate-detail',
      identity: candidate.candidateId,
      cleanupPolicy: 'retain-for-inspection',
    });
    await waitLiepinActionPace(page);
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
      () => clickLiepinLocator(candidateLink, searchPage, remainingTime(deadline)),
    );
    if (detailPage) {
      if (detailPage !== searchPage) {
        registerTemporaryRuntimePageForContext(context, detailPage, {
          purpose: 'candidate-detail',
          identity: candidate.candidateId,
          cleanupPolicy: 'retain-for-inspection',
        });
      }
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


export async function parseLiepinResumeDetail(
  page: Page,
  candidate: CandidateListItem,
): Promise<CandidateResume> {
  await waitForLiepinPageReady(page);
  const bodyRawText = await page.locator('body').innerText();
  for (const selector of detailReadySelectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'attached', timeout: 1 }).catch(() => undefined);
  }
  return parseLiepinResumeText(bodyRawText, candidate, page.url());
}
