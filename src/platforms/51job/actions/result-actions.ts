import { createHash } from 'node:crypto';
import type { Locator, Page, Request, Response } from 'playwright';
import { config } from '../../../config.js';
import { clickPlatformLocator, waitPlatformActionPace } from '../../../browser/pacing.js';
import { validateCandidateListExtraction } from '../../../extraction/extractor.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  extract51jobCandidateId,
  fiftyOneJobCandidateAnchorSelector,
  fiftyOneJobCandidateContainerSelector,
  fiftyOneJobRecommendationBoundaryText,
  parse51jobCandidateCards,
  type FiftyOneJobCandidateSourceCard,
} from '../parsing/candidate-list.js';

const platform = '51job';
const viewedFilterSelector = 'label.el-checkbox:has-text("我已看"), label:has-text("我已看")';
const resultContainerSelector = '.virtual_list';
const recommendationBoundarySelector = '.recall_tip_wrapper';
const loadingSelectors = ['.base-page-loading', '.el-loading-mask'];
const primaryResultRequestPath = '/resume/search/talent_hunt_resume_list';
const resultPollIntervalMs = 100;
const directSearchSubmitSelectors = [
  '.talent_search_keywords_input ~ button.search-btn',
  '.talent_search_keywords_input ~ .search-btn',
  '.talent-search-header button.search-btn',
  'button.search-btn',
  'button.btn-search',
  'button.search_button',
  'button[class*="search-btn"]',
  'button[class*="btn-search"]',
];
const explicitEmptyResultPattern = /没有搜索到相关的人才|暂无(?:符合条件的)?人才|暂无搜索结果|暂无.*人才|暂无.*结果|没有搜索到.*人才|没有找到.*人才|没有.*结果|未找到.*人才|无结果/;
const explicitEmptyResultSelectors = [
  '.el-empty',
  '.empty',
  '.no-result',
  '[class*="empty"]',
  '[class*="no-result"]',
];

export type FiftyOneJobResultState = 'candidates' | 'explicit-empty';

export interface FiftyOneJobViewedCandidatePolicyInput {
  includeViewedCandidates?: boolean;
  deadline: number;
  signal?: AbortSignal;
}

export interface FiftyOneJobViewedCandidatePolicyResult {
  status: 'already-satisfied' | 'applied';
  resultState: FiftyOneJobResultState;
  candidateCount: number;
}

export interface FiftyOneJobDirectSearchSubmissionInput {
  deadline: number;
  includeViewedCandidates?: boolean;
  signal?: AbortSignal;
}

interface Stable51jobResultSnapshot {
  resultState: FiftyOneJobResultState;
  candidateCount: number;
  candidateAnchorIds: string[];
  fingerprint: string;
  mutationVersion: number;
  mutationObservedDuringRead: boolean;
}

interface Read51jobResultSnapshot extends Stable51jobResultSnapshot {
  loadingVisible: boolean;
  resultContainerVisible: boolean;
  explicitEmpty: boolean;
}

interface Primary51jobResultContainer {
  index: number;
  candidateAnchorIds: string[];
  visible: boolean;
}

type FiftyOneJobResultStage =
  | 'filter-locate'
  | 'filter-toggle'
  | 'refresh-start'
  | 'refresh-response'
  | 'result-render'
  | 'result-stability'
  | 'candidate-snapshot'
  | 'direct-search-submit';

interface PrimaryResultRefreshTransaction {
  markClickStarted(): void;
  hasRequest(): boolean;
  responseState(): 'pending' | 'success' | 'failed';
  dispose(): void;
}

interface ResultMutationObserver {
  token: string;
  clear(): Promise<void>;
}

function remainingMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 0);
}

export function resolve51jobSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + config.playwright.searchPageTimeoutMs;
}

function actionFailure(action: string, stage: FiftyOneJobResultStage, deadline: number, reason: string): Error {
  return new Error(
    `51job ${action} failed at ${stage}: ${reason} (remaining-search-budget-ms=${remainingMs(deadline)}).`,
  );
}

function assertActionCanContinue(
  action: string,
  stage: FiftyOneJobResultStage,
  deadline: number,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw actionFailure(action, stage, deadline, 'the caller cancelled the search action');
  }
  if (remainingMs(deadline) <= 0) {
    throw actionFailure(action, stage, deadline, 'the shared search deadline is exhausted');
  }
}

function assertInteractionBudget(
  action: string,
  stage: FiftyOneJobResultStage,
  deadline: number,
  signal?: AbortSignal,
): void {
  assertActionCanContinue(action, stage, deadline, signal);
  const requiredBudgetMs = config.playwright.actionDelayMaxMsByPlatform[platform] + 1;
  if (remainingMs(deadline) < requiredBudgetMs) {
    throw actionFailure(
      action,
      stage,
      deadline,
      'the remaining budget cannot accommodate the required paced pointer action',
    );
  }
}

async function waitForPoll(page: Page, deadline: number): Promise<void> {
  const timeoutMs = Math.min(resultPollIntervalMs, remainingMs(deadline));
  if (timeoutMs <= 0) {
    return;
  }

  const waitForTimeout = (page as Partial<Pick<Page, 'waitForTimeout'>>).waitForTimeout?.bind(page);
  if (waitForTimeout) {
    await waitForTimeout(timeoutMs).catch(() => undefined);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function locatorIsVisible(locator: Locator): Promise<boolean> {
  const visibility = (locator as Partial<Pick<Locator, 'isVisible'>>).isVisible;
  if (visibility) {
    return visibility.call(locator, { timeout: 1 }).catch(() => false);
  }

  return locator.waitFor({ state: 'visible', timeout: 1 }).then(() => true).catch(() => false);
}

async function isAny51jobLoadingVisible(page: Page): Promise<boolean> {
  for (const selector of loadingSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locatorIsVisible(locator.nth(index))) {
        return true;
      }
    }
  }

  return false;
}

async function visibleLocatorIndexes(locator: Locator): Promise<number[]> {
  const count = await locator.count().catch(() => 0);
  const indexes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (await locatorIsVisible(locator.nth(index))) {
      indexes.push(index);
    }
  }
  return indexes;
}

async function findUniqueVisibleLocator(
  page: Page,
  selector: string,
  action: string,
  stage: FiftyOneJobResultStage,
  deadline: number,
): Promise<Locator> {
  const locator = page.locator(selector);
  while (remainingMs(deadline) > 0) {
    const visibleIndexes = await visibleLocatorIndexes(locator);
    if (visibleIndexes.length === 1) {
      return locator.nth(visibleIndexes[0]!);
    }
    if (visibleIndexes.length > 1) {
      throw actionFailure(action, stage, deadline, 'the required visible control is ambiguous');
    }
    await waitForPoll(page, deadline);
  }

  throw actionFailure(action, stage, deadline, 'the required visible control was not found');
}

async function readViewedFilterChecked(
  locator: Locator,
  action: string,
  deadline: number,
): Promise<boolean> {
  const checked = await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return undefined;
    }

    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox) {
      return checkbox.checked;
    }

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true') return true;
    if (ariaChecked === 'false') return false;
    if (element.classList.contains('is-checked')) return true;
    if (element.classList.contains('is-unchecked')) return false;
    return undefined;
  }).catch(() => undefined);

  if (typeof checked !== 'boolean') {
    throw actionFailure(action, 'filter-locate', deadline, 'the viewed-candidate control state is unreadable');
  }

  return checked;
}

async function assertViewedFilterEnabled(
  locator: Locator,
  action: string,
  deadline: number,
): Promise<void> {
  const disabled = await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return true;
    }

    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    return checkbox?.disabled === true
      || element.matches('[disabled]')
      || element.getAttribute('aria-disabled') === 'true'
      || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(element.className);
  }).catch(() => true);

  if (disabled) {
    throw actionFailure(action, 'filter-locate', deadline, 'the viewed-candidate control is disabled');
  }
}

async function find51jobViewedFilter(
  page: Page,
  action: string,
  deadline: number,
): Promise<Locator> {
  const locator = await findUniqueVisibleLocator(page, viewedFilterSelector, action, 'filter-locate', deadline);
  await assertViewedFilterEnabled(locator, action, deadline);
  await readViewedFilterChecked(locator, action, deadline);
  return locator;
}

function buildMutationObserverToken(): string {
  return `51job-result-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function arm51jobResultMutationObserver(page: Page): Promise<ResultMutationObserver> {
  const token = buildMutationObserverToken();
  const relatedSelector = [
    resultContainerSelector,
    fiftyOneJobCandidateAnchorSelector,
    ...loadingSelectors,
    recommendationBoundarySelector,
    '.el-empty',
    '.empty',
    '.no-result',
    '[class*="empty"]',
    '[class*="no-result"]',
  ].join(', ');

  await page.evaluate(({ expectedToken, selector }) => {
    type InPageResultObserverState = {
      token: string;
      mutations: number;
      observer: MutationObserver;
    };
    const host = window as Window & { __autorecruit51jobResultObserver?: InPageResultObserverState };
    host.__autorecruit51jobResultObserver?.observer.disconnect();

    const isRelated = (node: Node | null): boolean => {
      const element = node?.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node?.parentElement;
      return Boolean(element && (element.matches(selector) || element.closest(selector)));
    };
    const state: InPageResultObserverState = {
      token: expectedToken,
      mutations: 0,
      observer: new MutationObserver((mutations) => {
        if (mutations.some((mutation) => (
          isRelated(mutation.target)
          || [...mutation.addedNodes, ...mutation.removedNodes].some(isRelated)
        ))) {
          state.mutations += 1;
        }
      }),
    };
    state.observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    host.__autorecruit51jobResultObserver = state;
  }, { expectedToken: token, selector: relatedSelector });

  return {
    token,
    clear: async () => {
      await page.evaluate((expectedToken) => {
        type InPageResultObserverState = {
          token: string;
          observer: MutationObserver;
        };
        const host = window as Window & { __autorecruit51jobResultObserver?: InPageResultObserverState };
        const state = host.__autorecruit51jobResultObserver;
        if (!state || state.token !== expectedToken) {
          return;
        }
        state.observer.disconnect();
        delete host.__autorecruit51jobResultObserver;
      }, token).catch(() => undefined);
    },
  };
}

async function readMutationVersion(page: Page, observer: ResultMutationObserver): Promise<number> {
  const mutationVersion = await page.evaluate((expectedToken) => {
    type InPageResultObserverState = { token: string; mutations: number };
    const host = window as Window & { __autorecruit51jobResultObserver?: InPageResultObserverState };
    const state = host.__autorecruit51jobResultObserver;
    return state?.token === expectedToken ? state.mutations : undefined;
  }, observer.token).catch(() => undefined);

  if (typeof mutationVersion !== 'number') {
    throw new Error('51job result mutation observer is unavailable');
  }

  return mutationVersion;
}

function resultFingerprint(candidateAnchorIds: string[], resultState: FiftyOneJobResultState): string {
  return createHash('sha256')
    .update(JSON.stringify({ candidateAnchorIds, resultState }))
    .digest('hex');
}

async function hasExplicit51jobEmptyResult(page: Page): Promise<boolean> {
  // Do not infer a zero-result state from arbitrary page text: an unrelated
  // empty panel or a temporarily cleared result container is not evidence
  // that the current talent search completed with zero candidates.
  for (const selector of explicitEmptyResultSelectors) {
    const locator = page.locator(selector);
    for (const index of await visibleLocatorIndexes(locator)) {
      const text = await locator.nth(index).innerText().catch(() => '');
      if (explicitEmptyResultPattern.test(text)) {
        return true;
      }
    }
  }
  return false;
}

async function readPrimary51jobResultContainer(page: Page): Promise<Primary51jobResultContainer | undefined> {
  const resultContainers = page.locator(resultContainerSelector);
  const resultContainerCount = await resultContainers.count().catch(() => 0);
  if (resultContainerCount === 0) {
    return undefined;
  }
  const primaryIndex = 0;
  const primaryResult = resultContainers.nth(primaryIndex);
  const precededByRecommendationBoundary = await primaryResult.evaluate((element, input) => {
    const isVisible = (candidate: Element): boolean => {
      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (isVisible(sibling)) {
        return sibling.matches(input.recommendationBoundarySelector)
          && (sibling.textContent ?? '').replace(/\s+/g, '').includes(input.recommendationBoundaryText);
      }
      sibling = sibling.previousElementSibling;
    }
    return false;
  }, {
    recommendationBoundarySelector,
    recommendationBoundaryText: fiftyOneJobRecommendationBoundaryText,
  }).catch(() => true);
  if (precededByRecommendationBoundary) {
    return undefined;
  }

  const visible = await locatorIsVisible(primaryResult);
  const candidateAnchorIds = await primaryResult.locator(fiftyOneJobCandidateAnchorSelector)
    .evaluateAll((elements) => elements.map((element) => element.id || ''))
    .catch(() => [] as string[]);
  return {
    index: primaryIndex,
    candidateAnchorIds,
    visible,
  };
}

async function has51jobRecommendationBoundaryAfterPrimaryResult(
  page: Page,
  primaryResultIndex: number,
): Promise<boolean> {
  const resultContainers = page.locator(resultContainerSelector);
  return resultContainers.evaluateAll((containers, input) => {
    const primaryResult = containers[input.primaryResultIndex];
    if (!primaryResult) {
      return false;
    }
    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    let sibling = primaryResult.nextElementSibling;
    while (sibling) {
      if (isVisible(sibling)) {
        if (sibling.matches(input.recommendationBoundarySelector)) {
          return (sibling.textContent ?? '').replace(/\s+/g, '').includes(input.recommendationBoundaryText);
        }
        if (sibling.matches(input.resultContainerSelector)) {
          return false;
        }
      }
      sibling = sibling.nextElementSibling;
    }
    return false;
  }, {
    primaryResultIndex,
    recommendationBoundarySelector,
    recommendationBoundaryText: fiftyOneJobRecommendationBoundaryText,
    resultContainerSelector,
  }).catch(() => false);
}

async function hasExplicit51jobEmptyResultForPrimaryContainer(
  page: Page,
  primaryResultIndex: number,
): Promise<boolean> {
  if (await has51jobRecommendationBoundaryAfterPrimaryResult(page, primaryResultIndex)) {
    return true;
  }
  return hasExplicit51jobEmptyResult(page);
}

async function read51jobResultSnapshot(
  page: Page,
  observer: ResultMutationObserver,
): Promise<Read51jobResultSnapshot> {
  const mutationVersionBefore = await readMutationVersion(page, observer);
  const loadingVisible = await isAny51jobLoadingVisible(page);
  const primaryResultContainer = await readPrimary51jobResultContainer(page);
  const candidateAnchorIds = primaryResultContainer?.visible
    ? primaryResultContainer.candidateAnchorIds
    : [];
  const explicitEmpty = !loadingVisible
    && candidateAnchorIds.length === 0
    && primaryResultContainer !== undefined
    && await hasExplicit51jobEmptyResultForPrimaryContainer(page, primaryResultContainer.index);
  const resultState: FiftyOneJobResultState = candidateAnchorIds.length > 0
    ? 'candidates'
    : 'explicit-empty';
  const mutationVersion = await readMutationVersion(page, observer);

  return {
    resultState,
    candidateCount: candidateAnchorIds.length,
    candidateAnchorIds,
    fingerprint: resultFingerprint(candidateAnchorIds, resultState),
    mutationVersion,
    mutationObservedDuringRead: mutationVersion !== mutationVersionBefore,
    loadingVisible,
    resultContainerVisible: primaryResultContainer?.visible === true,
    // An empty DOM is deliberately not promoted to explicit empty; callers
    // must see the platform's visible empty-result evidence.
    explicitEmpty,
  };
}

function resultSnapshotIsReady(snapshot: Read51jobResultSnapshot): boolean {
  if (snapshot.loadingVisible) {
    return false;
  }
  if (snapshot.candidateCount > 0) {
    return snapshot.resultContainerVisible;
  }
  return snapshot.explicitEmpty;
}

async function waitForStable51jobResult(
  page: Page,
  observer: ResultMutationObserver,
  deadline: number,
  signal: AbortSignal | undefined,
  action: string,
): Promise<Stable51jobResultSnapshot> {
  let stableSince: number | undefined;
  let previousFingerprint: string | undefined;
  let previousMutationVersion: number | undefined;
  let observedReadyState = false;

  while (remainingMs(deadline) > 0) {
    assertActionCanContinue(action, 'result-render', deadline, signal);
    let snapshot: Read51jobResultSnapshot;
    try {
      snapshot = await read51jobResultSnapshot(page, observer);
    } catch {
      throw actionFailure(action, 'result-render', deadline, 'the result container could not be read safely');
    }

    const ready = resultSnapshotIsReady(snapshot);
    if (!ready) {
      stableSince = undefined;
      previousFingerprint = undefined;
      previousMutationVersion = undefined;
      await waitForPoll(page, deadline);
      continue;
    }

    observedReadyState = true;
    const unchanged = !snapshot.mutationObservedDuringRead
      && snapshot.fingerprint === previousFingerprint
      && snapshot.mutationVersion === previousMutationVersion;
    const now = Date.now();
    if (!unchanged) {
      stableSince = now;
      previousFingerprint = snapshot.fingerprint;
      previousMutationVersion = snapshot.mutationVersion;
      await waitForPoll(page, deadline);
      continue;
    }

    if (now - (stableSince ?? now) >= config.playwright.emptyResultsStableMs) {
      return snapshot;
    }

    await waitForPoll(page, deadline);
  }

  throw actionFailure(
    action,
    observedReadyState ? 'result-stability' : 'result-render',
    deadline,
    observedReadyState
      ? 'the rendered candidate result did not remain unchanged for the configured stability window'
      : 'no candidate cards or visible explicit empty result rendered after loading completed',
  );
}

function isPrimary51jobResultRequest(request: Request): boolean {
  try {
    const url = new URL(request.url());
    return url.pathname === primaryResultRequestPath && request.method().toUpperCase() === 'POST';
  } catch {
    return false;
  }
}

function armPrimary51jobResultRefreshTransaction(page: Page): PrimaryResultRefreshTransaction {
  let clickStarted = false;
  let primaryRequest: Request | undefined;
  let responseState: 'pending' | 'success' | 'failed' = 'pending';

  const onRequest = (request: Request) => {
    if (!clickStarted || primaryRequest || !isPrimary51jobResultRequest(request)) {
      return;
    }
    primaryRequest = request;
  };
  const onResponse = (response: Response) => {
    if (!primaryRequest || response.request() !== primaryRequest) {
      return;
    }
    const status = response.status();
    responseState = status >= 200 && status < 300 ? 'success' : 'failed';
  };
  const onRequestFailed = (request: Request) => {
    if (primaryRequest && request === primaryRequest) {
      responseState = 'failed';
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    markClickStarted: () => {
      clickStarted = true;
    },
    hasRequest: () => primaryRequest !== undefined,
    responseState: () => responseState,
    dispose: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

async function waitForPrimaryRefreshRequest(
  page: Page,
  transaction: PrimaryResultRefreshTransaction,
  deadline: number,
  signal: AbortSignal | undefined,
  action: string,
): Promise<void> {
  while (remainingMs(deadline) > 0) {
    assertActionCanContinue(action, 'refresh-start', deadline, signal);
    if (transaction.hasRequest()) {
      return;
    }
    await waitForPoll(page, deadline);
  }
  throw actionFailure(action, 'refresh-start', deadline, 'the primary candidate-result request was not observed after the action click');
}

async function waitForPrimaryRefreshResponse(
  page: Page,
  transaction: PrimaryResultRefreshTransaction,
  deadline: number,
  signal: AbortSignal | undefined,
  action: string,
): Promise<void> {
  while (remainingMs(deadline) > 0) {
    assertActionCanContinue(action, 'refresh-response', deadline, signal);
    const state = transaction.responseState();
    if (state === 'success') {
      return;
    }
    if (state === 'failed') {
      throw actionFailure(action, 'refresh-response', deadline, 'the primary candidate-result request failed or returned a non-success response');
    }
    await waitForPoll(page, deadline);
  }
  throw actionFailure(action, 'refresh-response', deadline, 'the primary candidate-result request did not receive a successful response');
}

async function waitForViewedFilterState(
  page: Page,
  desiredChecked: boolean,
  deadline: number,
  signal: AbortSignal | undefined,
  action: string,
): Promise<void> {
  while (remainingMs(deadline) > 0) {
    assertActionCanContinue(action, 'filter-toggle', deadline, signal);
    const control = await find51jobViewedFilter(page, action, deadline);
    if (await readViewedFilterChecked(control, action, deadline) === desiredChecked) {
      return;
    }
    await waitForPoll(page, deadline);
  }
  throw actionFailure(action, 'filter-toggle', deadline, 'the viewed-candidate control did not converge to its requested state');
}

async function assertFinalViewedFilterState(
  page: Page,
  desiredChecked: boolean,
  deadline: number,
  action: string,
): Promise<void> {
  const control = await find51jobViewedFilter(page, action, deadline);
  if (await readViewedFilterChecked(control, action, deadline) !== desiredChecked) {
    throw actionFailure(action, 'filter-toggle', deadline, 'the viewed-candidate control changed after the result refresh');
  }
}

async function findViewedFilterThatStillNeedsToggle(
  page: Page,
  desiredChecked: boolean,
  deadline: number,
  action: string,
): Promise<Locator | undefined> {
  const control = await find51jobViewedFilter(page, action, deadline);
  return await readViewedFilterChecked(control, action, deadline) === desiredChecked
    ? undefined
    : control;
}

/**
 * Applies the 51job viewed-candidate policy as one verified business action.
 * A changed checkbox must cause its own primary result request; an idempotent
 * checkbox still waits for any in-progress render to settle before returning.
 */
export async function apply51jobViewedCandidatePolicy(
  page: Page,
  input: FiftyOneJobViewedCandidatePolicyInput,
): Promise<FiftyOneJobViewedCandidatePolicyResult> {
  const action = 'viewed-candidate-policy';
  const desiredChecked = input.includeViewedCandidates !== true;
  assertActionCanContinue(action, 'filter-locate', input.deadline, input.signal);

  let mutationObserver: ResultMutationObserver | undefined;
  let refreshTransaction: PrimaryResultRefreshTransaction | undefined;
  try {
    mutationObserver = await arm51jobResultMutationObserver(page).catch(() => {
      throw actionFailure(action, 'result-render', input.deadline, 'the result-stability observer could not be established');
    });
    const control = await find51jobViewedFilter(page, action, input.deadline);
    const alreadyChecked = await readViewedFilterChecked(control, action, input.deadline);

    if (alreadyChecked === desiredChecked) {
      const stable = await waitForStable51jobResult(page, mutationObserver, input.deadline, input.signal, action);
      await assertFinalViewedFilterState(page, desiredChecked, input.deadline, action);
      return {
        status: 'already-satisfied',
        resultState: stable.resultState,
        candidateCount: stable.candidateCount,
      };
    }

    assertInteractionBudget(action, 'filter-toggle', input.deadline, input.signal);
    refreshTransaction = armPrimary51jobResultRefreshTransaction(page);
    try {
      await waitPlatformActionPace(page, platform);
    } catch {
      throw actionFailure(action, 'filter-toggle', input.deadline, 'the required paced pointer action could not begin');
    }
    assertActionCanContinue(action, 'filter-toggle', input.deadline, input.signal);
    const currentControl = await findViewedFilterThatStillNeedsToggle(page, desiredChecked, input.deadline, action);
    if (!currentControl) {
      const stable = await waitForStable51jobResult(page, mutationObserver, input.deadline, input.signal, action);
      await assertFinalViewedFilterState(page, desiredChecked, input.deadline, action);
      return {
        status: 'already-satisfied',
        resultState: stable.resultState,
        candidateCount: stable.candidateCount,
      };
    }
    try {
      await clickPlatformLocator(currentControl, page, platform, remainingMs(input.deadline), {
        pace: false,
        beforeClick: async () => {
          const revalidatedControl = await findViewedFilterThatStillNeedsToggle(
            page,
            desiredChecked,
            input.deadline,
            action,
          );
          if (!revalidatedControl) {
            throw actionFailure(action, 'filter-toggle', input.deadline, 'the viewed-candidate target state changed before the click');
          }
          refreshTransaction?.markClickStarted();
        },
      });
    } catch {
      throw actionFailure(action, 'filter-toggle', input.deadline, 'the viewed-candidate control could not be clicked');
    }

    await waitForViewedFilterState(page, desiredChecked, input.deadline, input.signal, action);
    await waitForPrimaryRefreshRequest(page, refreshTransaction, input.deadline, input.signal, action);
    await waitForPrimaryRefreshResponse(page, refreshTransaction, input.deadline, input.signal, action);
    const stable = await waitForStable51jobResult(page, mutationObserver, input.deadline, input.signal, action);
    await assertFinalViewedFilterState(page, desiredChecked, input.deadline, action);
    return {
      status: 'applied',
      resultState: stable.resultState,
      candidateCount: stable.candidateCount,
    };
  } finally {
    refreshTransaction?.dispose();
    await mutationObserver?.clear();
  }
}

async function find51jobDirectSearchSubmitControl(page: Page, deadline: number): Promise<Locator> {
  while (remainingMs(deadline) > 0) {
    for (const selector of directSearchSubmitSelectors) {
      const locator = page.locator(selector);
      const indexes = await visibleLocatorIndexes(locator);
      if (indexes.length === 1) {
        return locator.nth(indexes[0]!);
      }
      if (indexes.length > 1) {
        throw actionFailure('direct-search-submit', 'direct-search-submit', deadline, 'the visible final search control is ambiguous');
      }
    }

    const roleLookup = (page as Partial<Pick<Page, 'getByRole'>>).getByRole?.bind(page);
    if (roleLookup) {
      const locator = roleLookup('button', { name: /^搜索$/ }).first();
      if (await locatorIsVisible(locator)) {
        return locator;
      }
    }
    await waitForPoll(page, deadline);
  }

  throw actionFailure('direct-search-submit', 'direct-search-submit', deadline, 'the final search control was not found');
}

/**
 * Performs 51job's final direct-search submit and proves the request/render
 * cycle it starts. This is deliberately separate from filter replay so a
 * checkbox-triggered refresh cannot be mistaken for the final direct search.
 */
export async function submit51jobDirectSearch(
  page: Page,
  input: FiftyOneJobDirectSearchSubmissionInput,
): Promise<{ resultState: FiftyOneJobResultState; candidateCount: number }> {
  const action = 'direct-search-submit';
  assertInteractionBudget(action, 'direct-search-submit', input.deadline, input.signal);
  let mutationObserver: ResultMutationObserver | undefined;
  let refreshTransaction: PrimaryResultRefreshTransaction | undefined;
  try {
    mutationObserver = await arm51jobResultMutationObserver(page).catch(() => {
      throw actionFailure(action, 'result-render', input.deadline, 'the result-stability observer could not be established');
    });
    await find51jobDirectSearchSubmitControl(page, input.deadline);
    refreshTransaction = armPrimary51jobResultRefreshTransaction(page);
    try {
      await waitPlatformActionPace(page, platform);
    } catch {
      throw actionFailure(action, 'direct-search-submit', input.deadline, 'the required paced pointer action could not begin');
    }
    assertActionCanContinue(action, 'direct-search-submit', input.deadline, input.signal);
    const currentControl = await find51jobDirectSearchSubmitControl(page, input.deadline);
    await assertFinalViewedFilterState(page, input.includeViewedCandidates !== true, input.deadline, action);
    try {
      await clickPlatformLocator(currentControl, page, platform, remainingMs(input.deadline), {
        pace: false,
        beforeClick: async () => {
          await find51jobDirectSearchSubmitControl(page, input.deadline);
          await assertFinalViewedFilterState(page, input.includeViewedCandidates !== true, input.deadline, action);
          refreshTransaction?.markClickStarted();
        },
      });
    } catch {
      throw actionFailure(action, 'direct-search-submit', input.deadline, 'the final search control could not be clicked');
    }

    await waitForPrimaryRefreshRequest(page, refreshTransaction, input.deadline, input.signal, action);
    await waitForPrimaryRefreshResponse(page, refreshTransaction, input.deadline, input.signal, action);
    const stable = await waitForStable51jobResult(page, mutationObserver, input.deadline, input.signal, action);
    await assertFinalViewedFilterState(page, input.includeViewedCandidates !== true, input.deadline, action);
    return { resultState: stable.resultState, candidateCount: stable.candidateCount };
  } finally {
    refreshTransaction?.dispose();
    await mutationObserver?.clear();
  }
}

export async function waitFor51jobCandidateResultsReady(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ resultState: FiftyOneJobResultState; candidateCount: number }> {
  const deadline = resolve51jobSearchDeadline(options);
  const action = 'candidate-results';
  assertActionCanContinue(action, 'result-render', deadline, options?.signal);
  const observer = await arm51jobResultMutationObserver(page).catch(() => {
    throw actionFailure(action, 'result-render', deadline, 'the result-stability observer could not be established');
  });
  try {
    const stable = await waitForStable51jobResult(page, observer, deadline, options?.signal, action);
    return { resultState: stable.resultState, candidateCount: stable.candidateCount };
  } finally {
    await observer.clear();
  }
}

async function readCandidateSourceCards(
  page: Page,
  deadline: number,
): Promise<FiftyOneJobCandidateSourceCard[]> {
  const resultContainers = page.locator(resultContainerSelector);
  while (remainingMs(deadline) > 0) {
    const primaryResultContainer = await readPrimary51jobResultContainer(page);
    if (primaryResultContainer?.visible && primaryResultContainer.candidateAnchorIds.length > 0) {
      return resultContainers.nth(primaryResultContainer.index).locator(fiftyOneJobCandidateAnchorSelector)
        .evaluateAll((elements, containerSelector) => (
          elements.map((element) => {
            const container = element.closest(containerSelector)
              ?? element.parentElement?.parentElement
              ?? element.parentElement;
            const linkElement = container?.querySelector('a[href]') as HTMLAnchorElement | null;
            const nameElement = container?.querySelector('[class*=name], [title]');
            return {
              elementId: element.id || undefined,
              html: container?.outerHTML ?? element.outerHTML,
              text: container?.textContent?.trim() ?? element.textContent?.trim() ?? '',
              resumeUrl: linkElement?.href,
              name: nameElement?.textContent?.trim() || undefined,
            };
          })
        ), fiftyOneJobCandidateContainerSelector).catch(() => {
          throw actionFailure('candidate-snapshot', 'candidate-snapshot', deadline, 'candidate cards could not be read from the stable primary result container');
        });
    }
    await waitForPoll(page, deadline);
  }
  throw actionFailure(
    'candidate-snapshot',
    'candidate-snapshot',
    deadline,
    'no visible result container exposed candidate anchors after readiness completed',
  );
}

function validateStableCandidateSources(
  cards: FiftyOneJobCandidateSourceCard[],
  expectedCount: number,
  deadline: number,
): CandidateListItem[] {
  if (cards.length !== expectedCount) {
    throw actionFailure('candidate-snapshot', 'candidate-snapshot', deadline, 'candidate-card count changed during the snapshot read');
  }

  const sourceIds = cards.map((card) => extract51jobCandidateId(`${card.elementId ?? ''} ${card.text ?? ''} ${card.html ?? ''}`));
  if (sourceIds.some((candidateId) => !candidateId)) {
    throw actionFailure('candidate-snapshot', 'candidate-snapshot', deadline, 'a candidate-card identity is missing');
  }
  const uniqueSourceIds = new Set(sourceIds as string[]);
  if (uniqueSourceIds.size !== sourceIds.length) {
    throw actionFailure('candidate-snapshot', 'candidate-snapshot', deadline, 'candidate-card identities are duplicated');
  }

  const candidates = parse51jobCandidateCards(cards);
  if (candidates.length !== sourceIds.length) {
    throw actionFailure('candidate-snapshot', 'candidate-snapshot', deadline, 'candidate-card identities could not be converted consistently');
  }
  return validateCandidateListExtraction({ candidates }).candidates;
}

/**
 * Reads one identity-consistent 51job candidate snapshot. A result redraw at
 * any point between the before/after fingerprints is retried within the
 * caller's original deadline; it never yields a mixed list to detail actions.
 */
export async function collectStable51jobCandidateList(
  page: Page,
  options?: SearchWaitOptions,
): Promise<CandidateListItem[]> {
  const deadline = resolve51jobSearchDeadline(options);
  const action = 'candidate-snapshot';
  assertActionCanContinue(action, 'candidate-snapshot', deadline, options?.signal);
  const observer = await arm51jobResultMutationObserver(page).catch(() => {
    throw actionFailure(action, 'candidate-snapshot', deadline, 'the result-stability observer could not be established');
  });

  try {
    while (remainingMs(deadline) > 0) {
      const before = await waitForStable51jobResult(page, observer, deadline, options?.signal, action);
      if (before.resultState === 'explicit-empty') {
        const after = await read51jobResultSnapshot(page, observer).catch(() => {
          throw actionFailure(action, 'candidate-snapshot', deadline, 'the explicit empty result could not be rechecked');
        });
        if (!after.loadingVisible
          && after.resultState === before.resultState
          && after.fingerprint === before.fingerprint
          && after.mutationVersion === before.mutationVersion
          && !after.mutationObservedDuringRead) {
          return [];
        }
        continue;
      }

      const cards = await readCandidateSourceCards(page, deadline);
      const candidates = validateStableCandidateSources(cards, before.candidateCount, deadline);
      const after = await read51jobResultSnapshot(page, observer).catch(() => {
        throw actionFailure(action, 'candidate-snapshot', deadline, 'the candidate result could not be rechecked after reading cards');
      });
      if (!after.loadingVisible
        && after.resultState === before.resultState
        && after.fingerprint === before.fingerprint
        && after.mutationVersion === before.mutationVersion
        && !after.mutationObservedDuringRead) {
        return candidates;
      }
    }

    throw actionFailure(action, 'candidate-snapshot', deadline, 'the result changed while the candidate snapshot was being read');
  } finally {
    await observer.clear();
  }
}
