import type { Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
import { buildCandidateBatchIdentity } from '../../../talent-mapping/batch-identity.js';
import type {
  AdvanceCandidateBatchInput,
  AdvanceCandidateBatchResult,
  CandidateResultBatch,
} from '../../../types/talent-mapping.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  extractLiepinCandidateList,
  getLiepinCandidatePaceDelayMs,
  waitLiepinCandidatePace,
} from './internal-page-actions.js';

export {
  extractLiepinCandidateList,
  getLiepinCandidatePaceDelayMs,
  waitLiepinCandidatePace,
};

const nextControlSelectors = [
  '.ant-pagination-next button',
  '.ant-pagination-next a',
  '.ant-pagination-next',
  'li[title="下一页"] button',
  '[aria-label="下一页"]',
  '[aria-label="Next page"]',
  '.pagination-next',
  '.next-page',
  'button:has-text("加载更多")',
];
const currentPageSelector = [
  '.ant-pagination-item-active',
  '[aria-current="page"]',
  '.pagination .active',
].join(', ');

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Liepin candidate batch deadline exhausted');
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
      throw new Error('Liepin next candidate batch control is ambiguous');
    }
    if (visible.length === 1) {
      return visible[0];
    }
  }
  return undefined;
}

async function findLiepinNextBatchControl(page: Page): Promise<Locator | undefined> {
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

async function readLiepinBatchNumber(page: Page): Promise<number | undefined> {
  const activePages = page.locator(currentPageSelector);
  const count = await activePages.count().catch(() => 0);
  if (count > 1) {
    throw new Error('Liepin current candidate batch identity is ambiguous');
  }
  if (count === 0) {
    return undefined;
  }
  const value = Number((await activePages.first().innerText().catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function hasExplicitLiepinEndState(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有更多|已加载全部|到底了|暂无更多/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function hasExplicitLiepinEmptyResult(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有符合条件的人才|暂无符合条件的人才|暂无搜索结果/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

export async function readLiepinCurrentCandidateBatch(
  page: Page,
  options: SearchWaitOptions,
): Promise<CandidateResultBatch> {
  if (options.deadline !== undefined) {
    remainingMs(options.deadline);
  }
  const { candidates } = await extractLiepinCandidateList(page, options);
  const batchNumber = await readLiepinBatchNumber(page);
  const nextControl = candidates.length > 0 ? await findLiepinNextBatchControl(page) : undefined;
  const terminalEvidence = await hasExplicitLiepinEmptyResult(page)
    ? 'explicit-empty-result' as const
    : await hasExplicitLiepinEndState(page) || Boolean(nextControl && await isDisabled(nextControl))
      ? 'explicit-pagination-end' as const
      : 'not-terminal' as const;
  return {
    candidates,
    batchIdentity: buildCandidateBatchIdentity('liepin', candidates, batchNumber),
    batchNumber,
    endReached: terminalEvidence !== 'not-terminal',
    terminalEvidence,
  };
}

export async function advanceLiepinToNextCandidateBatch(
  page: Page,
  input: AdvanceCandidateBatchInput,
): Promise<AdvanceCandidateBatchResult> {
  remainingMs(input.deadline);
  const current = await readLiepinCurrentCandidateBatch(page, { deadline: input.deadline });
  if (current.batchIdentity !== input.expectedCurrentBatchIdentity) {
    throw new Error(`Liepin candidate batch changed before advance: expected ${input.expectedCurrentBatchIdentity}, got ${current.batchIdentity}`);
  }
  if (current.endReached) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  const nextControl = await findLiepinNextBatchControl(page);
  if (!nextControl) {
    throw new Error('Liepin candidate batch end cannot be established because no explicit next-page or terminal state is visible');
  }
  if (await isDisabled(nextControl)) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  await waitPlatformActionPace(page, 'liepin');
  await clickPlatformLocator(nextControl, page, 'liepin', remainingMs(input.deadline), { pace: false });
  while (Date.now() < input.deadline) {
    const next = await readLiepinCurrentCandidateBatch(page, { deadline: input.deadline });
    if (next.batchIdentity !== current.batchIdentity) {
      return { status: 'advanced', batch: next };
    }
    await page.waitForTimeout(Math.min(150, remainingMs(input.deadline))).catch(() => undefined);
  }

  throw new Error(`Liepin next candidate batch did not change from ${current.batchIdentity}`);
}
