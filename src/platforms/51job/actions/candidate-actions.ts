import type { Locator, Page } from 'playwright';
import { collectCandidateList } from '../../../browser/candidate-list.js';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
import { buildCandidateBatchIdentity } from '../../../talent-mapping/batch-identity.js';
import type {
  AdvanceCandidateBatchInput,
  AdvanceCandidateBatchResult,
  CandidateResultBatch,
} from '../../../types/talent-mapping.js';
import type { PlatformAdapter, SearchWaitOptions } from '../../types.js';

const nextControlSelectors = [
  '.el-pagination .btn-next',
  '.ant-pagination-next button',
  '.ant-pagination-next a',
  '[aria-label="下一页"]',
  '[aria-label="Next page"]',
  '.pagination-next',
  '.next-page',
];
const currentPageSelector = [
  '.el-pager li.active',
  '.ant-pagination-item-active',
  '[aria-current="page"]',
  '.pagination .active',
].join(', ');

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('51job candidate batch deadline exhausted');
  }
  return remaining;
}

async function firstUniqueVisibleLocator(page: Page, locators: Locator[]): Promise<Locator | undefined> {
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
      throw new Error('51job next candidate batch control is ambiguous');
    }
    if (visible.length === 1) {
      return visible[0];
    }
  }
  return undefined;
}

async function find51jobNextBatchControl(page: Page): Promise<Locator | undefined> {
  return firstUniqueVisibleLocator(page, [
    ...nextControlSelectors.map((selector) => page.locator(selector)),
    page.getByRole('button', { name: /下一页|next/i }),
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
  return ariaDisabled === 'true' || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(className ?? '');
}

async function read51jobBatchNumber(page: Page): Promise<number | undefined> {
  const activePages = page.locator(currentPageSelector);
  const count = await activePages.count().catch(() => 0);
  if (count > 1) {
    throw new Error('51job current candidate batch identity is ambiguous');
  }
  if (count === 0) {
    return undefined;
  }
  const value = Number((await activePages.first().innerText().catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function extract51jobCandidateList(
  ...args: Parameters<PlatformAdapter['extractCandidateList']>
): Promise<Awaited<ReturnType<PlatformAdapter['extractCandidateList']>>> {
  const [page, options] = args;
  return { candidates: await collectCandidateList(page, options) };
}

export async function read51jobCurrentCandidateBatch(
  page: Page,
  options: SearchWaitOptions,
): Promise<CandidateResultBatch> {
  if (options.deadline !== undefined) {
    remainingMs(options.deadline);
  }
  const candidates = await collectCandidateList(page, options);
  const batchNumber = await read51jobBatchNumber(page);
  const nextControl = candidates.length > 0 ? await find51jobNextBatchControl(page) : undefined;
  return {
    candidates,
    batchIdentity: buildCandidateBatchIdentity('51job', candidates, batchNumber),
    batchNumber,
    endReached: candidates.length === 0 || Boolean(nextControl && await isDisabled(nextControl)),
  };
}

export async function advance51jobToNextCandidateBatch(
  page: Page,
  input: AdvanceCandidateBatchInput,
): Promise<AdvanceCandidateBatchResult> {
  remainingMs(input.deadline);
  const current = await read51jobCurrentCandidateBatch(page, { deadline: input.deadline });
  if (current.batchIdentity !== input.expectedCurrentBatchIdentity) {
    throw new Error(`51job candidate batch changed before advance: expected ${input.expectedCurrentBatchIdentity}, got ${current.batchIdentity}`);
  }

  const nextControl = await find51jobNextBatchControl(page);
  if (!nextControl) {
    throw new Error('51job candidate batch end cannot be established because no explicit next-page state is visible');
  }
  if (await isDisabled(nextControl)) {
    return { status: 'end-reached' };
  }

  await waitPlatformActionPace(page, '51job');
  await clickPlatformLocator(nextControl, page, '51job', remainingMs(input.deadline), { pace: false });
  while (Date.now() < input.deadline) {
    const next = await read51jobCurrentCandidateBatch(page, { deadline: input.deadline });
    if (next.batchIdentity !== current.batchIdentity) {
      return { status: 'advanced', batch: next };
    }
    await page.waitForTimeout(Math.min(150, remainingMs(input.deadline))).catch(() => undefined);
  }

  throw new Error(`51job next candidate batch did not change from ${current.batchIdentity}`);
}
