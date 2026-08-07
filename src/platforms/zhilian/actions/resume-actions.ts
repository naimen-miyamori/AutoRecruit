import type { BrowserContext, Locator, Page } from 'playwright';
import { waitPlatformActionPace } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { CandidateProfileDetailResult } from '../../../types/talent-mapping.js';
import type { CandidateProfileDetailOptions } from '../../types.js';
import {
  closeZhilianResumeDetail,
  openZhilianResumeDetail,
  parseZhilianResumeDetail as parseZhilianResumeDetailFromPage,
} from './internal-page-actions.js';
import { resolveZhilianDetailDeadline } from './context.js';

export {
  closeZhilianResumeDetail,
  openZhilianResumeDetail,
};

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
