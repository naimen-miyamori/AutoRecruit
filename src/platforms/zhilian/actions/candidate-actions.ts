import type { Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
import { buildCandidateBatchIdentity } from '../../../talent-mapping/batch-identity.js';
import type { CandidateListItem } from '../../../types/job.js';
import type {
  AdvanceCandidateBatchInput,
  AdvanceCandidateBatchResult,
  CandidateResultBatch,
} from '../../../types/talent-mapping.js';
import type { SearchWaitOptions } from '../../types.js';
import { extractZhilianCandidateList } from './internal-page-actions.js';

export { extractZhilianCandidateList };

const nextControlSelectors = [
  '.el-pagination .btn-next',
  '.ant-pagination-next button',
  '.ant-pagination-next a',
  '.ant-pagination-next',
  '[aria-label="下一页"]',
  '[aria-label="Next page"]',
  '.pagination-next',
  '.next-page',
  'button:has-text("加载更多")',
];
const currentPageSelector = [
  '.el-pager li.active',
  '.ant-pagination-item-active',
  '[aria-current="page"]',
  '.pagination .active',
].join(', ');
const virtualCandidateAnchorSelector = [
  'a[href*="resume"]',
  'a[href*="candidate"]',
  'a[href*="talent"]',
  '[data-resume-id]',
  '[data-candidate-id]',
  '[data-talent-id]',
].join(', ');

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Zhilian candidate batch deadline exhausted');
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
      throw new Error('Zhilian next candidate batch control is ambiguous');
    }
    if (visible.length === 1) {
      return visible[0];
    }
  }
  return undefined;
}

async function findZhilianNextBatchControl(page: Page): Promise<Locator | undefined> {
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

async function readZhilianBatchNumber(page: Page): Promise<number | undefined> {
  const activePages = page.locator(currentPageSelector);
  const count = await activePages.count().catch(() => 0);
  if (count > 1) {
    throw new Error('Zhilian current candidate batch identity is ambiguous');
  }
  if (count === 0) {
    return undefined;
  }
  const value = Number((await activePages.first().innerText().catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function hasZhilianSearchResultBoundary(page: Page): Promise<boolean> {
  const markers = [
    page.getByText(/更多相关人才/, { exact: false }),
    page.getByText(/没有更多|已加载全部|到底了|暂无更多/, { exact: false }),
  ];
  for (const marker of markers) {
    const count = await marker.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await marker.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

async function hasExplicitZhilianEmptyResult(page: Page): Promise<boolean> {
  const marker = page.getByText(/没有符合条件的人才|暂无符合条件的人才|暂无搜索结果/, { exact: false });
  const count = await marker.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await marker.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function scrollZhilianVirtualCandidateBatch(
  page: Page,
  candidates: readonly CandidateListItem[],
  deadline: number,
): Promise<boolean> {
  const lastCandidate = candidates.at(-1);
  if (!lastCandidate) {
    return false;
  }
  const anchors = page.locator(virtualCandidateAnchorSelector);
  const index = await anchors.evaluateAll((elements, candidateId) => {
    for (let itemIndex = elements.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const element = elements[itemIndex];
      const identity = [
        element.getAttribute('href'),
        element.getAttribute('data-resume-id'),
        element.getAttribute('data-candidate-id'),
        element.getAttribute('data-talent-id'),
      ].filter(Boolean).join(' ');
      if (identity.includes(String(candidateId))) {
        return itemIndex;
      }
    }
    return -1;
  }, lastCandidate.candidateId).catch(() => -1);
  if (index < 0) {
    return false;
  }

  await waitPlatformActionPace(page, 'zhilian');
  await anchors.nth(index).scrollIntoViewIfNeeded({ timeout: remainingMs(deadline) });
  return true;
}

export async function readZhilianCurrentCandidateBatch(
  page: Page,
  options: SearchWaitOptions,
): Promise<CandidateResultBatch> {
  if (options.deadline !== undefined) {
    remainingMs(options.deadline);
  }
  const { candidates } = await extractZhilianCandidateList(page, options);
  const batchNumber = await readZhilianBatchNumber(page);
  const nextControl = candidates.length > 0 ? await findZhilianNextBatchControl(page) : undefined;
  const terminalEvidence = await hasExplicitZhilianEmptyResult(page)
    ? 'explicit-empty-result' as const
    : await hasZhilianSearchResultBoundary(page) || Boolean(nextControl && await isDisabled(nextControl))
      ? 'explicit-pagination-end' as const
      : 'not-terminal' as const;
  return {
    candidates,
    batchIdentity: buildCandidateBatchIdentity('zhilian', candidates, batchNumber),
    batchNumber,
    endReached: terminalEvidence !== 'not-terminal',
    terminalEvidence,
  };
}

export async function advanceZhilianToNextCandidateBatch(
  page: Page,
  input: AdvanceCandidateBatchInput,
): Promise<AdvanceCandidateBatchResult> {
  remainingMs(input.deadline);
  const current = await readZhilianCurrentCandidateBatch(page, { deadline: input.deadline });
  if (current.batchIdentity !== input.expectedCurrentBatchIdentity) {
    throw new Error(`Zhilian candidate batch changed before advance: expected ${input.expectedCurrentBatchIdentity}, got ${current.batchIdentity}`);
  }
  if (current.endReached) {
    return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
  }

  const nextControl = await findZhilianNextBatchControl(page);
  if (nextControl) {
    if (await isDisabled(nextControl)) {
      return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
    }
    await waitPlatformActionPace(page, 'zhilian');
    await clickPlatformLocator(nextControl, page, 'zhilian', remainingMs(input.deadline), { pace: false });
  } else if (!await scrollZhilianVirtualCandidateBatch(page, current.candidates, input.deadline)) {
    throw new Error('Zhilian candidate batch end cannot be established and no virtual-list advance target is available');
  }

  while (Date.now() < input.deadline) {
    const next = await readZhilianCurrentCandidateBatch(page, { deadline: input.deadline });
    if (next.batchIdentity !== current.batchIdentity) {
      return { status: 'advanced', batch: next };
    }
    if (next.endReached) {
      return { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' };
    }
    await page.waitForTimeout(Math.min(150, remainingMs(input.deadline))).catch(() => undefined);
  }

  throw new Error(`Zhilian next candidate batch did not change from ${current.batchIdentity}`);
}
