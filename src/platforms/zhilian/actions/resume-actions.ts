import type { BrowserContext, Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { CandidateProfileDetailResult } from '../../../types/talent-mapping.js';
import type { CandidateProfileDetailOptions } from '../../types.js';
import { parseZhilianResumeText } from '../parsing/resume-parser.js';
import { assertZhilianAuthenticated } from './authentication.js';
import { extractZhilianCandidateIdFromText } from './candidate-actions.js';
import { resolveZhilianDetailDeadline } from './context.js';
import {
  createZhilianActionDeadline as createDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import { isZhilianSearchUrl } from './navigation-actions.js';

const zhilianPlatform = 'zhilian';
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
const zhilianResumeDetailSelectors = [
  '.km-modal__wrapper.new-shortcut-resume__modal',
  '.resume-detail-wrap',
  '.resume-detail.km-scrollbar.new-resume-detail',
  '.new-shortcut-resume__inner',
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

const resumeModalSelectorsByPriority = [
  '.km-modal__wrapper.new-shortcut-resume__modal',
  '.resume-detail-wrap',
  '.resume-detail.km-scrollbar.new-resume-detail',
  '.new-shortcut-resume__inner',
  '[role="dialog"]',
  '.ant-modal',
  '.resume-detail',
  '[class*="resume"][class*="modal"]',
  '[class*="resume"][class*="dialog"]',
] as const;

function remainingDetailMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Zhilian candidate profile detail deadline exhausted');
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
        timeout = setTimeout(() => reject(new Error('Zhilian candidate profile detail deadline exhausted')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function findVisibleResumeModals(page: Page, selector: string): Promise<Locator[]> {
  const locators = page.locator(selector);
  const count = await locators.count().catch(() => 0);
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    if (await locator.isVisible().catch(() => false)) {
      visible.push(locator);
    }
  }
  return visible;
}

async function modalContainsCandidateId(modal: Locator, candidateId: string): Promise<boolean> {
  return modal.evaluate((root, expectedCandidateId) => {
    const expected = String(expectedCandidateId);
    const elements = [root, ...Array.from(root.querySelectorAll('*'))];
    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.value.includes(expected)) {
          return true;
        }
      }
    }

    const seen = new WeakSet<object>();
    const containsExpectedIdentity = (value: unknown, depth: number): boolean => {
      if (depth > 4 || value === null || value === undefined) return false;
      if (typeof value === 'string' || typeof value === 'number') return String(value) === expected;
      if (typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (/candidate|resume|user|master|talent|props|data/i.test(key)
          && containsExpectedIdentity(nested, depth + 1)) {
          return true;
        }
      }
      return false;
    };

    return elements.some((element) => {
      const vueElement = element as Element & {
        __vue__?: unknown;
        __vueParentComponent?: unknown;
      };
      return containsExpectedIdentity(vueElement.__vue__, 0)
        || containsExpectedIdentity(vueElement.__vueParentComponent, 0);
    });
  }, candidateId).catch(() => false);
}

export async function requireExactZhilianResumeModal(
  page: Page,
  candidateId: string,
  deadline: number,
): Promise<Locator> {
  for (const selector of resumeModalSelectorsByPriority) {
    const modals = await withinDetailDeadline(deadline, findVisibleResumeModals(page, selector));
    const exact: Locator[] = [];
    for (const modal of modals) {
      if (await withinDetailDeadline(deadline, modalContainsCandidateId(modal, candidateId))) {
        exact.push(modal);
      }
    }
    if (exact.length > 1) {
      throw new Error(`Zhilian resume modal identity ${candidateId} is ambiguous`);
    }
    if (exact.length === 1) {
      return exact[0]!;
    }
  }
  throw new Error(`Zhilian resume modal does not expose exact candidate identity ${candidateId}`);
}

export async function parseZhilianResumeDetail(
  page: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<CandidateResume> {
  const deadline = resolveZhilianDetailDeadline(options);
  const resume = await withinDetailDeadline(
    deadline,
    parseZhilianResumeDetailFromPage(page, candidate, { deadline }),
  );
  if (resume.candidateId !== candidate.candidateId) {
    throw new Error(
      `Zhilian candidate profile identity mismatch: expected ${candidate.candidateId}, got ${resume.candidateId}`,
    );
  }
  return resume;
}

export async function readZhilianCandidateProfileDetail(
  context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options: CandidateProfileDetailOptions,
): Promise<CandidateProfileDetailResult> {
  const detailPage = await openZhilianResumeDetail(context, searchPage, candidate, options);
  const deadline = resolveZhilianDetailDeadline(options);
  const modal = await requireExactZhilianResumeModal(detailPage, candidate.candidateId, deadline);
  if (remainingDetailMs(deadline) <= config.playwright.actionDelayMaxMsByPlatform.zhilian) {
    throw new Error('Zhilian candidate profile detail deadline cannot accommodate the required post-open pacing interval');
  }
  await waitPlatformActionPace(detailPage, 'zhilian');
  const resume = await withinDetailDeadline(deadline, parseZhilianResumeDetail(detailPage, candidate, {
    deadline,
  }));
  const rawText = await withinDetailDeadline(deadline, modal.innerText()).catch(() => undefined);
  return { resume, rawText, detailPage };
}

async function closeExistingZhilianResumeModal(
  page: Page,
  options: { pace?: boolean } = {},
): Promise<void> {
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
      { pace: options.pace },
    );
  } catch {
    if (/resumeNumber=/i.test(page.url())) {
      const keyboard = (page as Partial<Pick<Page, 'keyboard'>>).keyboard;
      await keyboard?.press('Escape').catch(() => undefined);
    }
  }
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

  const snapshots = (await evaluateAll((elements) => {
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

    return elements.map((element, index) => ({
      index,
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      html: (element as HTMLElement).outerHTML,
      isRelatedRecommendation: isAfterRelatedTalentBoundary(element),
    }));
  })).filter((snapshot) => !snapshot.isRelatedRecommendation);

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


export async function openZhilianResumeDetail(
  _context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<Page> {
  const deadline = options?.deadline ?? createDeadline();
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
}

async function parseZhilianResumeDetailFromPage(
  page: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<CandidateResume> {
  const deadline = options?.deadline ?? createDeadline();
  await waitForZhilianResumeDetailReady(page, { deadline });
  const bodyRawText = await readZhilianResumeDetailText(page);
  const parsed = parseZhilianResumeText(bodyRawText, candidate, page.url());
  return {
    ...parsed,
    candidateId: candidate.candidateId || extractZhilianCandidateIdFromText(page.url()) || candidate.candidateId,
  };
}

export async function closeZhilianResumeDetail(searchPage: Page): Promise<void> {
  await closeExistingZhilianResumeModal(searchPage, { pace: false });
}

