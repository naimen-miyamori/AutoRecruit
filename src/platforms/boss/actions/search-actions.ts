import type { Frame, Locator, Page, Request } from 'playwright';
import { typeBossLocatorSequentially } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import type { SearchCondition } from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  clickBossControl as clickBossLocator,
  clickBossControlNatively,
} from './context.js';
import { closeExistingBossResumeDialog } from './resume-detail-actions.js';
import {
  openBossAuthenticatedHome,
} from './navigation-actions.js';

const bossUnrestrictedJobName = '不限职位';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function assertBossSubmittableSearchKeyword(keyword: string): void {
  if (!normalizeText(keyword)) {
    throw new Error('Boss search requires a non-empty keyword before final submit.');
  }
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function throwIfBossSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Boss search condition application was cancelled.');
  }
}

function bossDirectSearchActionUnits(condition: { kind: string; fieldId?: string }): number {
  if (condition.kind !== 'applicationFilter') return 1;
  if (condition.fieldId === 'city') return 4;
  if (condition.fieldId === 'education' || condition.fieldId === 'work_years') return 4;
  if (condition.fieldId === 'age') return 3;
  if (condition.fieldId === 'job_scope') return 2;
  return 2;
}

export function estimateBossDirectSearchTimeoutMs(input: {
  conditions: readonly SearchCondition[];
  includeViewedCandidates?: boolean;
}): number {
  const { conditions, includeViewedCandidates } = input;
  const pacingUpperBound = Math.max(config.playwright.actionDelayMaxMsByPlatform.boss, 1);
  // One bounded search deadline must cover intentional pacing as well as page
  // readiness. A direct search with custom sliders has several paced pointer
  // operations; the ordinary list-read budget is not sufficient for it.
  const viewedPolicyActionUnits = includeViewedCandidates === undefined ? 0 : 2;
  const estimatedMs = 24_000 + (14 + viewedPolicyActionUnits + conditions.reduce((total, condition) => total + bossDirectSearchActionUnits(condition), 0)) * pacingUpperBound;
  return Math.min(120_000, Math.max(config.playwright.searchPageTimeoutMs, estimatedMs));
}

export function estimateBossSearchTimeoutMs(input: {
  source: 'saved' | 'direct';
  conditions: readonly SearchCondition[];
  includeViewedCandidates?: boolean;
}): number {
  if (input.source === 'direct') {
    return estimateBossDirectSearchTimeoutMs(input);
  }

  // Saved search only has keyword/result readiness plus the optional viewed
  // control. The final explicit search click has its own paced action and
  // result-cycle wait, even when every input was already ready.
  const pacingUpperBound = Math.max(config.playwright.actionDelayMaxMsByPlatform.boss, 1);
  const viewedPolicyActionUnits = input.includeViewedCandidates === undefined ? 0 : 2;
  return Math.min(120_000, Math.max(
    config.playwright.searchPageTimeoutMs,
    24_000 + (6 + viewedPolicyActionUnits) * pacingUpperBound,
  ));
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function isBossChatSearchUrl(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/chat\/search(?:[/?#].*)?$/i.test(url);
}

async function openBossSearchMenu(page: Page, deadline: number): Promise<void> {
  if (isBossChatSearchUrl(page.url())) {
    return;
  }

  await openBossAuthenticatedHome(page);
  if (isBossChatSearchUrl(page.url())) {
    return;
  }

  await clickBossLocator(
    page.locator('a[ka="menu-geek-search"], .menu-geeksearch a, .menu-geeksearch').first(),
    page,
    remainingTime(deadline),
  );
  await page.waitForURL((url) => isBossChatSearchUrl(url.toString()), { timeout: remainingTime(deadline) });
}

export async function waitForBossSearchFrame(page: Page, deadline: number) {
  await page.waitForFunction(
    () => Array.from(window.frames).some((frame) => {
      try {
        return /\/web\/frame\/search\//.test(frame.location.href);
      } catch {
        return false;
      }
    }),
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );

  const frame = page.frames().find((candidate) => /\/web\/frame\/search\//.test(candidate.url()))
    ?? page.frame({ name: 'searchFrame' });
  if (!frame) {
    throw new Error('Boss search frame did not become available.');
  }

  await frame.locator('.search-job-list-C').first().waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return frame;
}

export async function readBossSelectedJob(page: Page, deadline: number): Promise<string> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return normalizeText(await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().innerText({
    timeout: remainingTime(deadline),
  }));
}

export async function selectBossUnrestrictedJob(page: Page, deadline: number): Promise<void> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const currentJob = await readBossSelectedJob(page, deadline).catch(() => '');
  if (currentJob === bossUnrestrictedJobName) {
    return;
  }

  await clickBossLocator(
    frame.locator('.search-job-list-C .ui-dropmenu-label, .search-job-list-C .search-current-job').first(),
    page,
    remainingTime(deadline),
  );
  await clickBossLocator(
    frame.locator('.search-job-list-C .ui-dropmenu-list >> text=不限职位').first(),
    page,
    remainingTime(deadline),
  );
  await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().waitFor({
    timeout: remainingTime(deadline),
  });

  const selectedJob = await readBossSelectedJob(page, deadline);
  if (selectedJob !== bossUnrestrictedJobName) {
    throw new Error(`Boss search job selector did not switch to ${bossUnrestrictedJobName}; current value: ${selectedJob || '(empty)'}`);
  }
}

export async function readBossSearchKeyword(page: Page, deadline: number): Promise<string> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return normalizeText(await frame.locator('input.search-input, .search-input').first().inputValue({
    timeout: remainingTime(deadline),
  }).catch(async () => frame.locator('input.search-input, .search-input').first().innerText({
    timeout: remainingTime(deadline),
  }).catch(() => '')));
}

type BossSearchKeywordApplicationState = {
  inputValue: string;
  applicationValue?: string;
  applicationEvidence: 'vue-search-part' | 'unavailable';
  issue?: string;
};

async function readBossSearchKeywordApplicationState(frame: Frame): Promise<BossSearchKeywordApplicationState> {
  return frame.evaluate(() => {
    type SearchPartComponent = {
      $options?: { name?: unknown };
      searchText?: unknown;
    };
    const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
    const visibleInputs = [...document.querySelectorAll<HTMLInputElement>('input.search-input')]
      .filter((input) => {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
    if (visibleInputs.length !== 1) {
      return {
        inputValue: '',
        applicationEvidence: 'unavailable' as const,
        issue: `expected one visible keyword input, found ${visibleInputs.length}`,
      };
    }

    const input = visibleInputs[0]!;
    const components: SearchPartComponent[] = [];
    const seen = new Set<SearchPartComponent>();
    let current: Element | null = input;
    while (current) {
      const component = (current as Element & { __vue__?: SearchPartComponent }).__vue__;
      const name = component?.$options?.name;
      if (component && typeof name === 'string' && /^SearchPart(?:\d+)?$/u.test(name) && !seen.has(component)) {
        seen.add(component);
        components.push(component);
      }
      current = current.parentElement;
    }
    if (components.length > 1) {
      return {
        inputValue: normalize(input.value),
        applicationEvidence: 'unavailable' as const,
        issue: `found ${components.length} SearchPart component states for one keyword input`,
      };
    }
    if (components.length === 0) {
      return {
        inputValue: normalize(input.value),
        applicationEvidence: 'unavailable' as const,
      };
    }
    if (typeof components[0]!.searchText !== 'string') {
      return {
        inputValue: normalize(input.value),
        applicationEvidence: 'unavailable' as const,
        issue: 'SearchPart searchText is not a string',
      };
    }
    return {
      inputValue: normalize(input.value),
      applicationValue: normalize(components[0]!.searchText),
      applicationEvidence: 'vue-search-part' as const,
    };
  });
}

function bossSearchKeywordStateMatches(
  state: BossSearchKeywordApplicationState,
  expectedKeyword: string,
): boolean {
  return !state.issue
    && state.inputValue === expectedKeyword
    && (state.applicationEvidence === 'unavailable' || state.applicationValue === expectedKeyword);
}

async function assertBossSearchKeywordReadyForSubmit(
  frame: Frame,
  expectedKeyword: string,
): Promise<void> {
  const state = await readBossSearchKeywordApplicationState(frame);
  if (state.issue) {
    throw new Error(`Boss search keyword state is invalid before final submit: ${state.issue}.`);
  }
  if (state.inputValue !== expectedKeyword) {
    throw new Error(`Boss search keyword input changed before final submit: expected ${expectedKeyword}, observed ${state.inputValue || '(empty)'}.`);
  }
  if (state.applicationEvidence === 'vue-search-part' && state.applicationValue !== expectedKeyword) {
    throw new Error(`Boss search application keyword changed before final submit: expected ${expectedKeyword}, observed ${state.applicationValue || '(empty)'}.`);
  }
}

export async function waitForBossSearchResults(frame: Frame, deadline: number): Promise<void> {
  await frame.waitForFunction(
    () => {
      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const hasCards = document.querySelectorAll('.geek-info-card').length > 0;
      const hasExplicitEmpty = /暂无|没有|未找到|无相关|搜索使用方法/.test(bodyText);
      const hasLoadError = /数据加载异常/.test(bodyText);
      const isStillLoading = /(?:加载中|正在加载|加载资料)/.test(bodyText);
      return hasLoadError || hasCards || (hasExplicitEmpty && !isStillLoading);
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );

  const hasLoadError = await frame.evaluate(() => /数据加载异常/.test((document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()))
    .catch(() => false);
  if (hasLoadError) {
    throw new Error('Boss search reported a data-loading error.');
  }
}

export interface BossSearchKeywordApplyResult {
  changed: boolean;
  applicationStateVerified: boolean;
}

export async function applyBossSearchKeyword(
  page: Page,
  keyword: string,
  deadline: number,
): Promise<BossSearchKeywordApplyResult> {
  const normalizedKeyword = normalizeText(keyword);
  const frame = await waitForBossSearchFrame(page, deadline);
  const initialState = await readBossSearchKeywordApplicationState(frame);
  if (initialState.issue) {
    throw new Error(`Boss search keyword state is invalid before input: ${initialState.issue}.`);
  }
  if (bossSearchKeywordStateMatches(initialState, normalizedKeyword)) {
    return {
      changed: false,
      applicationStateVerified: initialState.applicationEvidence === 'vue-search-part',
    };
  }

  const keywordInput = frame.locator('input.search-input, .search-input').first();
  if (initialState.inputValue === normalizedKeyword
    && initialState.applicationEvidence === 'vue-search-part'
    && initialState.applicationValue !== normalizedKeyword) {
    if (normalizedKeyword) {
      await typeBossLocatorSequentially(keywordInput, page, '', remainingTime(deadline), {
        replaceExisting: true,
      });
    } else {
      await typeBossLocatorSequentially(keywordInput, page, 'x', remainingTime(deadline), {
        replaceExisting: true,
      });
    }
  }
  await typeBossLocatorSequentially(keywordInput, page, normalizedKeyword, remainingTime(deadline), {
    replaceExisting: true,
  });

  try {
    await frame.waitForFunction(
      (expectedKeyword) => {
        type SearchPartComponent = {
          $options?: { name?: unknown };
          searchText?: unknown;
        };
        const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
        const input = document.querySelector<HTMLInputElement>('input.search-input');
        if (!input || normalize(input.value) !== expectedKeyword) return false;
        const components: SearchPartComponent[] = [];
        const seen = new Set<SearchPartComponent>();
        let current: Element | null = input;
        while (current) {
          const component = (current as Element & { __vue__?: SearchPartComponent }).__vue__;
          const name = component?.$options?.name;
          if (component && typeof name === 'string' && /^SearchPart(?:\d+)?$/u.test(name) && !seen.has(component)) {
            seen.add(component);
            components.push(component);
          }
          current = current.parentElement;
        }
        return components.length === 0
          || (components.length === 1 && typeof components[0]!.searchText === 'string'
            && normalize(components[0]!.searchText) === expectedKeyword);
      },
      normalizedKeyword,
      { timeout: remainingTime(deadline), polling: 100 },
    );
  } catch {
    const finalState = await readBossSearchKeywordApplicationState(frame).catch(() => undefined);
    throw new Error(
      `Boss search keyword did not synchronize with the page application state: expected ${normalizedKeyword || '(empty)'}, input ${finalState?.inputValue || '(empty)'}, application ${finalState?.applicationValue || '(empty)'}.`,
    );
  }
  const finalState = await readBossSearchKeywordApplicationState(frame);
  return {
    changed: true,
    applicationStateVerified: finalState.applicationEvidence === 'vue-search-part',
  };
}

export type BossSearchSubmissionEvidence = 'result-mutation' | 'loading-cycle';

export interface BossSearchSubmissionReceipt {
  submitted: true;
  evidence: BossSearchSubmissionEvidence;
  keyword: string;
  requestPath: '/wapi/zpitem/web/boss/search/geeks.json';
  responseStatus: number;
}

type BossSearchSubmissionObserverState = {
  token: string;
  target: Element;
  clickedAt: number;
  requestObservedAt: number;
  resultMutation: boolean;
  loadingSeen: boolean;
  observer: MutationObserver;
  clickHandler: (event: Event) => void;
};

const bossSearchRequestPath = '/wapi/zpitem/web/boss/search/geeks.json' as const;

type BossSearchRequestInspection =
  | { kind: 'unrelated' }
  | { kind: 'candidate'; keyword: string; issue?: string };

function inspectBossSearchRequest(request: Request): BossSearchRequestInspection {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return { kind: 'unrelated' };
  }
  if (url.pathname !== bossSearchRequestPath) return { kind: 'unrelated' };
  if (url.origin !== 'https://www.zhipin.com') {
    return { kind: 'candidate', keyword: '', issue: 'unexpected request origin' };
  }
  if (request.method() !== 'GET') {
    return { kind: 'candidate', keyword: '', issue: `unexpected ${request.method()} method` };
  }
  const keywords = url.searchParams.getAll('keywords');
  if (keywords.length !== 1) {
    return {
      kind: 'candidate',
      keyword: keywords.map((value) => normalizeText(value)).filter(Boolean).join(' | '),
      issue: `expected one keywords parameter, found ${keywords.length}`,
    };
  }
  return { kind: 'candidate', keyword: normalizeText(keywords[0]!) };
}

type BossSearchRequestOutcome =
  | { status: 'matched'; request: Request; keyword: string }
  | { status: 'mismatch'; keyword: string; issue?: string };

type BossSearchRequestObserver = {
  markClickDispatch(): void;
  outcome: Promise<BossSearchRequestOutcome>;
  dispose(): void;
};

function armBossSearchRequestObserver(
  page: Page,
  frame: Frame,
  expectedKeyword: string,
): BossSearchRequestObserver {
  let clickDispatched = false;
  let settled = false;
  let resolveOutcome!: (outcome: BossSearchRequestOutcome) => void;
  const outcome = new Promise<BossSearchRequestOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const handleRequest = (request: Request): void => {
    if (!clickDispatched || settled) return;
    let belongsToSearchFrame = false;
    try {
      belongsToSearchFrame = request.frame() === frame;
    } catch {
      return;
    }
    if (!belongsToSearchFrame) return;
    const inspection = inspectBossSearchRequest(request);
    if (inspection.kind === 'unrelated') return;
    settled = true;
    if (!inspection.issue && inspection.keyword === expectedKeyword) {
      resolveOutcome({ status: 'matched', request, keyword: inspection.keyword });
      return;
    }
    resolveOutcome({
      status: 'mismatch',
      keyword: inspection.keyword,
      ...(inspection.issue ? { issue: inspection.issue } : {}),
    });
  };
  page.on('request', handleRequest);
  return {
    markClickDispatch: () => {
      clickDispatched = true;
    },
    outcome,
    dispose: () => {
      page.off('request', handleRequest);
    },
  };
}

async function waitForBossPromiseWithinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Boss search condition application was cancelled.');
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = (): void => finish(() => reject(
      signal?.reason instanceof Error ? signal.reason : new Error('Boss search condition application was cancelled.'),
    ));
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), remainingTime(deadline));
    signal?.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function bossSearchSubmissionToken(): string {
  return `boss-search-submit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function locateBossSearchSubmitControl(frame: Frame, deadline: number): Promise<Locator> {
  const preferredSelectors = [
    'button.search-btn, a.search-btn, [role="button"].search-btn, .btn-search',
    '[ka="search_submit"], [ka="search"]',
    '.search-input-wrap .icon-search, .search-box .icon-search, .search-btn .icon-search',
  ];
  const preferred = frame.locator(preferredSelectors.join(', '));
  const generic = frame.locator('button, a, [role="button"], input[type="submit"], [class*="search"]');
  const evaluateCandidates = async (controls: Locator): Promise<number[]> => controls.evaluateAll((elements) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const keywordInputs = [...document.querySelectorAll<HTMLInputElement>('input.search-input, .search-input')]
      .filter((input) => {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
    if (keywordInputs.length !== 1) return [];
    const keywordInput = keywordInputs[0]!;
    const inputParent = keywordInput?.parentElement;
    const inputForm = keywordInput?.closest('form');
    // The current Boss page nests the input one level below its clickable
    // icon: `.search-input-wrap > .input-warp > input` plus a sibling
    // `.icon-search`. Start from the parent so the input's own
    // `.search-input` class cannot masquerade as the shared container.
    const inputSearchAncestor = keywordInput?.parentElement?.closest('[class*="search"], [id*="search"]');
    const isVisibleAndEnabled = (element: Element): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0
        && !(('disabled' in element) && Boolean((element as HTMLButtonElement).disabled))
        && element.getAttribute('aria-disabled') !== 'true';
    };
    const isSearchControl = (element: Element): boolean => {
      const text = normalize(element.textContent)
        || normalize(element.getAttribute('aria-label'))
        || normalize(element.getAttribute('title'))
        || normalize(element.getAttribute('ka'))
        || normalize(element.className);
      if (!/(?:搜索|search)/i.test(text)) return false;
      const buttonLike = element instanceof HTMLButtonElement
        || element instanceof HTMLAnchorElement
        || element.getAttribute('role') === 'button'
        || element.matches('input[type="submit"]')
        || /(?:search-btn|btn-search|icon-search)/i.test(element.className);
      if (!buttonLike) return false;
      const sameForm = Boolean(inputForm && element.closest('form') === inputForm);
      const inputParentIsSearchContainer = Boolean(inputParent
        && /search/i.test(`${inputParent.className ?? ''} ${inputParent.id ?? ''}`));
      const explicitSubmitSemantic = /(?:search[_-]?submit|search-btn|btn-search)/i.test(
        `${element.getAttribute('ka') ?? ''} ${element.className ?? ''}`,
      );
      const sameParent = Boolean(
        inputParent
        && (inputParentIsSearchContainer || explicitSubmitSemantic)
        && (element.parentElement === inputParent || inputParent.contains(element)),
      );
      const elementSearchAncestor = element.parentElement?.closest('[class*="search"], [id*="search"]');
      const sameSearchAncestor = Boolean(inputSearchAncestor && elementSearchAncestor === inputSearchAncestor);
      return sameForm || sameParent || sameSearchAncestor;
    };
    const candidates = elements.filter((element) => isVisibleAndEnabled(element) && isSearchControl(element));
    return candidates
      .filter((element) => !candidates.some((other) => other !== element && other.contains(element)))
      .map((element) => elements.indexOf(element));
  });

  const preferredIndexes = await evaluateCandidates(preferred);
  const genericIndexes = preferredIndexes.length > 0 ? [] : await evaluateCandidates(generic);
  const controls = preferredIndexes.length > 0 ? preferred : generic;
  const indexes = preferredIndexes.length > 0 ? preferredIndexes : genericIndexes;
  if (indexes.length > 1) throw new Error('Boss search submit control is ambiguous near the keyword input.');
  if (indexes.length === 1) return controls.nth(indexes[0]!);

  throw new Error('Boss search submit control was not found near the keyword input.');
}

async function armBossSearchSubmissionObserver(control: Locator, token: string): Promise<void> {
  await control.evaluate((element, expectedToken) => {
    type ObserverState = BossSearchSubmissionObserverState;
    const resultText = (): string => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const isLoadingText = (text: string): boolean => /(?:加载中|正在加载|加载资料)/.test(text);
    const isResultRelatedNode = (node: Node | null): boolean => {
      const candidate = node?.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node?.parentElement;
      if (!candidate) return false;
      const relatedSelector = '.geek-info-card, [data-boss-search-result-version], .geek-list, .geek-info-list, .geek-list-wrap, .search-result-list';
      if (candidate.matches(relatedSelector) || Boolean(candidate.closest(relatedSelector))) return true;
      const className = candidate instanceof HTMLElement ? candidate.className : '';
      return typeof className === 'string'
        && /(?:geek|search).*(?:result|list|card)|(?:result|list|card).*(?:geek|search)/i.test(className);
    };
    const host = window as Window & { __autorecruitBossSearchSubmission?: ObserverState };
    const previous = host.__autorecruitBossSearchSubmission;
    if (previous) {
      previous.observer.disconnect();
      document.removeEventListener('click', previous.clickHandler, true);
    }

    const state = {} as ObserverState;
    state.token = expectedToken;
    state.target = element;
    state.clickedAt = 0;
    state.requestObservedAt = 0;
    state.resultMutation = false;
    state.loadingSeen = false;
    state.clickHandler = (event: Event) => {
      const eventTarget = event.target;
      if (eventTarget instanceof Node && !state.target.contains(eventTarget) && eventTarget !== state.target) {
        return;
      }
      state.clickedAt = performance.now();
    };
    state.observer = new MutationObserver((mutations) => {
      if (!state.clickedAt || !state.requestObservedAt) return;
      if (isLoadingText(resultText())) {
        state.loadingSeen = true;
      }
      for (const mutation of mutations) {
        if (isResultRelatedNode(mutation.target)
          || [...mutation.addedNodes, ...mutation.removedNodes].some(isResultRelatedNode)) {
          state.resultMutation = true;
          return;
        }
      }
    });
    document.addEventListener('click', state.clickHandler, true);
    state.observer.observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    host.__autorecruitBossSearchSubmission = state;
  }, token);
}

async function markBossSearchSubmissionRequest(frame: Frame, token: string): Promise<void> {
  await frame.evaluate((expectedToken) => {
    type ObserverState = BossSearchSubmissionObserverState;
    const host = window as Window & { __autorecruitBossSearchSubmission?: ObserverState };
    const state = host.__autorecruitBossSearchSubmission;
    if (!state || state.token !== expectedToken || !state.clickedAt) {
      throw new Error('Boss search request could not be linked to the dispatched final click.');
    }
    const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    state.requestObservedAt = performance.now();
    state.resultMutation = false;
    state.loadingSeen = /(?:加载中|正在加载|加载资料)/.test(bodyText);
  }, token);
}

async function clearBossSearchSubmissionObserver(frame: Frame, token: string): Promise<void> {
  await frame.evaluate((expectedToken) => {
    type ObserverState = BossSearchSubmissionObserverState;
    const host = window as Window & { __autorecruitBossSearchSubmission?: ObserverState };
    const state = host.__autorecruitBossSearchSubmission;
    if (!state || state.token !== expectedToken) return;
    state.observer.disconnect();
    document.removeEventListener('click', state.clickHandler, true);
    delete host.__autorecruitBossSearchSubmission;
  }, token).catch(() => undefined);
}

async function assertBossSearchSubmitControlStillCurrent(
  frame: Frame,
  control: Locator,
  marker: string,
  deadline: number,
  expectedKeyword: string,
): Promise<void> {
  const marked = frame.locator(`[data-autorecruit-boss-submit-marker="${marker}"]`);
  if (await marked.count() !== 1) {
    throw new Error('Boss search submit control was replaced after pre-click validation.');
  }
  const refreshed = await locateBossSearchSubmitControl(frame, deadline);
  if (await refreshed.count() !== 1 || await refreshed.getAttribute('data-autorecruit-boss-submit-marker') !== marker) {
    throw new Error('Boss search submit control identity changed before the final click.');
  }
  const visibleAndEnabled = await control.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0
      && !('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
      && element.getAttribute('aria-disabled') !== 'true';
  }).catch(() => false);
  if (!visibleAndEnabled) {
    throw new Error('Boss search submit control is no longer visible and enabled before the final click.');
  }
  await assertBossSearchKeywordReadyForSubmit(frame, expectedKeyword);
}

async function waitForBossSearchSubmission(
  frame: Frame,
  token: string,
  deadline: number,
): Promise<BossSearchSubmissionEvidence> {
  try {
    const observed = await frame.waitForFunction((expectedToken) => {
      type ObserverState = {
        token: string;
        clickedAt: number;
        requestObservedAt: number;
        resultMutation: boolean;
        loadingSeen: boolean;
      };
      const host = window as Window & { __autorecruitBossSearchSubmission?: ObserverState };
      const state = host.__autorecruitBossSearchSubmission;
      if (!state || state.token !== expectedToken || !state.clickedAt || !state.requestObservedAt) return undefined;

      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (/数据加载异常/.test(bodyText)) {
        return { status: 'error', message: 'Boss search reported a data-loading error after the explicit search submit.' };
      }
      const isLoading = /(?:加载中|正在加载|加载资料)/.test(bodyText);
      state.loadingSeen ||= isLoading;
      const hasCards = document.querySelectorAll('.geek-info-card').length > 0;
      const hasExplicitEmpty = /暂无|没有|未找到|无相关|搜索使用方法/.test(bodyText) && !isLoading;
      if ((!hasCards && !hasExplicitEmpty) || isLoading) return undefined;

      if (state.resultMutation) return { status: 'ready', evidence: 'result-mutation' };
      if (state.loadingSeen) return { status: 'ready', evidence: 'loading-cycle' };
      return undefined;
    }, token, { timeout: remainingTime(deadline), polling: 100 });
    const result = await observed.jsonValue() as { status: 'ready' | 'error'; evidence?: BossSearchSubmissionEvidence; message?: string };
    if (result.status === 'error') {
      throw new Error(result.message ?? 'Boss search submit failed.');
    }
    if (!result.evidence) {
      throw new Error('Boss search submit produced no result-cycle evidence.');
    }
    return result.evidence;
  } catch (error) {
    if (error instanceof Error && /data-loading error after the explicit search submit|no result-cycle evidence/.test(error.message)) {
      throw error;
    }
    throw new Error('Boss search submit produced no observable new result cycle before the search deadline.');
  } finally {
    await clearBossSearchSubmissionObserver(frame, token);
  }
}

export async function submitBossPreparedSearch(
  page: Page,
  keyword: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<BossSearchSubmissionReceipt> {
  throwIfBossSearchAborted(signal);
  assertBossSubmittableSearchKeyword(keyword);
  const expectedKeyword = normalizeText(keyword);
  const frame = await waitForBossSearchFrame(page, deadline);
  const control = await locateBossSearchSubmitControl(frame, deadline);
  const token = bossSearchSubmissionToken();
  const marker = `${token}-marker`;
  await control.evaluate((element, expectedMarker) => {
    element.setAttribute('data-autorecruit-boss-submit-marker', expectedMarker);
  }, marker);
  const requestObserver = armBossSearchRequestObserver(page, frame, expectedKeyword);
  try {
    await armBossSearchSubmissionObserver(control, token);
    await assertBossSearchSubmitControlStillCurrent(frame, control, marker, deadline, expectedKeyword);
    throwIfBossSearchAborted(signal);
    await clickBossControlNatively(page, control, remainingTime(deadline), {
      pace: false,
      beforeClick: async () => {
        await assertBossSearchSubmitControlStillCurrent(frame, control, marker, deadline, expectedKeyword);
        requestObserver.markClickDispatch();
      },
    });
    throwIfBossSearchAborted(signal);
    const requestOutcome = await waitForBossPromiseWithinDeadline(
      requestObserver.outcome,
      deadline,
      'Boss final search click did not dispatch a trusted Boss search request before the search deadline.',
      signal,
    );
    if (requestOutcome.status === 'mismatch') {
      throw new Error(
        `Boss search request keyword mismatch: expected ${expectedKeyword}, observed ${requestOutcome.keyword || '(empty)'}${requestOutcome.issue ? ` (${requestOutcome.issue})` : ''}.`,
      );
    }
    await markBossSearchSubmissionRequest(frame, token);
    const response = await waitForBossPromiseWithinDeadline(
      requestOutcome.request.response(),
      deadline,
      'Boss exact-keyword search request produced no response before the search deadline.',
      signal,
    );
    const requestFailure = await waitForBossPromiseWithinDeadline(
      response?.finished() ?? Promise.resolve(new Error('Boss exact-keyword search request produced no response.')),
      deadline,
      'Boss exact-keyword search request did not finish before the search deadline.',
      signal,
    );
    if (!response || requestFailure || !response.ok()) {
      throw new Error(`Boss exact-keyword search request did not complete successfully${response ? ` (HTTP ${response.status()})` : ''}.`);
    }
    const evidence = await waitForBossSearchSubmission(frame, token, deadline);
    return {
      submitted: true,
      evidence,
      keyword: requestOutcome.keyword,
      requestPath: bossSearchRequestPath,
      responseStatus: response.status(),
    };
  } catch (error) {
    await clearBossSearchSubmissionObserver(frame, token);
    throw error;
  } finally {
    requestObserver.dispose();
    await control.evaluate((element, expectedMarker) => {
      if (element.getAttribute('data-autorecruit-boss-submit-marker') === expectedMarker) {
        element.removeAttribute('data-autorecruit-boss-submit-marker');
      }
    }, marker).catch(() => undefined);
  }
}

export async function prepareBossSearchPage(page: Page, keyword: string, deadline: number): Promise<Page> {
  await openBossSearchMenu(page, deadline);
  await closeExistingBossResumeDialog(page, deadline);
  await waitForBossSearchFrame(page, deadline);
  await selectBossUnrestrictedJob(page, deadline);
  await applyBossSearchKeyword(page, keyword, deadline);
  return page;
}

export async function prepareBossSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  // Direct-condition replay must establish only the reusable search surface
  // before comparing the requested target with the current page. Selecting the
  // default job or re-submitting the keyword here would be a mutation before
  // the action has established that either value is actually different.
  void keyword;
  await openBossSearchMenu(page, deadline);
  await closeExistingBossResumeDialog(page, deadline);
  await waitForBossSearchFrame(page, deadline);
  return page;
}
