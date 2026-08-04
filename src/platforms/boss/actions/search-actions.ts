import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import {
  moveMouseContinuously,
  typeBossLocatorSequentially,
} from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import {
  buildSearchFilterDiscoveryStats,
  createEmptySearchFilterCatalog,
  type SearchFilterCatalog,
  type SearchFilterControlType,
  type SearchFilterDefinition,
  type SearchFilterDiscoveryRunOptions,
  type SearchFilterDiscoveryStatus,
  type SearchFilterOption,
  type SearchFilterOptionInputSpec,
  type SearchFilterValueShape,
} from '../../../search/filter-catalog.js';
import type {
  CandidateListItem,
  SearchCondition,
  SearchConditionApplyResult,
  SearchSortPolicy,
} from '../../../types/job.js';
import type { CandidatePostOpenActions, CandidateProfileDetailOptions, SearchWaitOptions } from '../../types.js';
import { parseBossResumeData } from './resume-actions.js';
import {
  clickBossControl as clickBossLocator,
  clickBossControlWithDomEvent,
  clickBossControlNatively,
  runBossAction as runBossPageAction,
  runBossFrameAction,
  waitBossActionPaceWithinDeadline,
} from './context.js';
import {
  assertNoBossPurchaseChatDialog,
  BossUnexpectedContactDialogError,
  BossResumeDetailCloseError,
  closeBossResumeDetailStrict,
  closeExistingBossResumeDialog,
  forwardBossResume,
  isBossResumeDetailVisible,
  parseBossResumeDetail,
  verifyBossResumeDetailIdentity,
  waitForBossResumeDetailOrPurchase,
  waitForBossResumeDetailReady,
} from './resume-detail-actions.js';

const bossLoginUrl = 'https://www.zhipin.com/web/user/?ka=header-login';
const bossAuthenticatedHomeUrl = 'https://www.zhipin.com/web/user/';
const bossChatSearchUrl = 'https://www.zhipin.com/web/chat/search';
const bossUnrestrictedJobName = '不限职位';

type BossCandidateCardSnapshot = {
  text: string;
  html: string;
  href: string;
  dataJid: string;
  dataExpect: string;
  dataLid: string;
  dataContact: string;
  dataEliteGeek: string;
  dataItemId: string;
  searchResultIndex: number;
};

/**
 * The capture workflow is intentionally bounded by the raw visible card
 * window.  Keep this limit next to the card extraction action so parsing or
 * deduplication can never make a later card move into the allowed window.
 */
export const BOSS_RAW_CANDIDATE_CARD_LIMIT = 20;

type BossStaticFilterSnapshot = {
  key: string;
  label: string;
  selector: string;
  containerText: string;
  options: Array<{
    label: string;
    value: string;
    selected: boolean;
    disabled: boolean;
  }>;
  customRangeMaximum?: number;
};

type BossStaticFilterConfig = {
  key: string;
  label: string;
  selector: string;
  controlType: SearchFilterControlType;
  valueShape: SearchFilterValueShape;
  statusWhenEmpty?: SearchFilterDiscoveryStatus;
  customInputSpec?: SearchFilterOptionInputSpec;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeText(value) || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? normalizeOptionalText(value[key]) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeOptionalText(value)).filter((value): value is string => Boolean(value)))];
}

function isBossLoginEntryUrl(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/user\/?(?:[?#].*)?$/i.test(url)
    && /(?:[?&]ka=header-login|[?#].*login)/i.test(url);
}

function isBossLoginText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /扫码登录|验证码登录|密码登录|登录\/注册|欢迎登录|手机号|获取验证码/.test(normalizedText)
    && !/职位管理|招聘管理|我的职位|账号设置/.test(normalizedText);
}

function isBossAuthenticatedText(text: string): boolean {
  const normalizedText = normalizeText(text);
  return /职位管理|招聘管理|沟通|牛人|简历|直豆|我的职位|我的客服|账号设置/.test(normalizedText);
}

function hasBossAuthenticatedCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => /^(?:wt2|wbg|boss_login_mode|identity|zp_token)$/i.test(name));
}

async function readBossCookieNames(page: Page): Promise<string[]> {
  const cookies = await page.context().cookies('https://www.zhipin.com').catch(() => []);
  return cookies.map((cookie) => cookie.name);
}

async function readBodyText(page: Page): Promise<string> {
  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: 15000 });
  return body.innerText();
}

async function assertBossAuthenticated(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  const currentUrl = page.url();
  const bodyText = await readBodyText(page).catch(() => '');
  const cookieNames = await readBossCookieNames(page);
  const hasAuthenticatedCookie = hasBossAuthenticatedCookie(cookieNames);

  if (isBossLoginText(bodyText)) {
    throw new Error('Boss authenticated page is not available because the session has fallen back to the login screen.');
  }

  if (isBossLoginEntryUrl(currentUrl) && !hasAuthenticatedCookie) {
    throw new Error('Boss authenticated page is not available because the session is still on the login screen.');
  }

  if (hasAuthenticatedCookie && bodyText.trim().length === 0) {
    return;
  }

  if (hasAuthenticatedCookie && /^https:\/\/(?:www\.)?zhipin\.com(?:[/?#].*)?$/i.test(currentUrl)) {
    return;
  }

  if (!hasAuthenticatedCookie && !isBossAuthenticatedText(bodyText)) {
    throw new Error('Boss authenticated page is not available because the authenticated shell is not ready.');
  }
}

async function openBossAuthenticatedHome(page: Page): Promise<Page> {
  const currentUrl = page.url();
  if (isBossLoginEntryUrl(currentUrl)) {
    const bodyText = await readBodyText(page).catch(() => '');
    if (isBossLoginText(bodyText)) {
      throw new Error('Boss login is not complete yet.');
    }
    const cookieNames = await readBossCookieNames(page);
    if (!hasBossAuthenticatedCookie(cookieNames)) {
      throw new Error('Boss login is not complete yet.');
    }
  }

  if (!/^https:\/\/(?:www\.)?zhipin\.com\/web\//i.test(currentUrl)) {
    await runBossPageAction(page, () => page.goto(bossAuthenticatedHomeUrl, { waitUntil: 'domcontentloaded' }));
  }

  await assertBossAuthenticated(page);
  return page;
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function throwIfBossSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Boss search condition application was cancelled.');
  }
}

function bossDirectSearchActionUnits(condition: SearchCondition): number {
  if (!isApplicationFilterCondition(condition)) return 1;
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

function createBossDirectSearchDeadline(
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): number {
  if (options?.deadline !== undefined) return options.deadline;
  return Date.now() + estimateBossDirectSearchTimeoutMs({
    conditions,
    includeViewedCandidates: options?.includeViewedCandidates,
  });
}

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
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

async function readBossSelectedJob(page: Page, deadline: number): Promise<string> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return normalizeText(await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().innerText({
    timeout: remainingTime(deadline),
  }));
}

type BossActiveJobScopeOption = {
  label: string;
  value: string;
};

async function readBossActiveJobScopeOption(frame: Frame): Promise<BossActiveJobScopeOption | undefined> {
  return frame.locator('.search-job-list-C .ui-dropmenu-list li').evaluateAll((options) => {
    const active = options.find((element) => /\bactive\b/.test(element.className));
    if (!active) return undefined;
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const label = normalize(active.textContent);
    const value = normalize(active.getAttribute('data-id'))
      || normalize(active.getAttribute('data-value'))
      || normalize(active.getAttribute('ka'))
      || label;
    return label ? { label, value } : undefined;
  });
}

function bossActiveJobScopeMatchesValue(
  active: BossActiveJobScopeOption | undefined,
  expected: string,
): boolean {
  return Boolean(active && (active.label === expected || active.value === expected));
}

async function selectBossUnrestrictedJob(page: Page, deadline: number): Promise<void> {
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

async function readBossSearchKeyword(page: Page, deadline: number): Promise<string> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return normalizeText(await frame.locator('input.search-input, .search-input').first().inputValue({
    timeout: remainingTime(deadline),
  }).catch(async () => frame.locator('input.search-input, .search-input').first().innerText({
    timeout: remainingTime(deadline),
  }).catch(() => '')));
}

async function waitForBossSearchResults(frame: Frame, deadline: number): Promise<void> {
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

async function applyBossSearchKeyword(page: Page, keyword: string, deadline: number): Promise<void> {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return;
  }

  const frame = await waitForBossSearchFrame(page, deadline);
  const currentKeyword = await readBossSearchKeyword(page, deadline);
  if (currentKeyword === normalizedKeyword) {
    return;
  }

  const keywordInput = frame.locator('input.search-input, .search-input').first();
  await typeBossLocatorSequentially(keywordInput, page, normalizedKeyword, remainingTime(deadline), {
    replaceExisting: true,
  });

  await frame.waitForFunction(
    (expectedKeyword) => {
      const input = document.querySelector<HTMLInputElement>('input.search-input, .search-input');
      const inputValue = (input?.value ?? input?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return inputValue === expectedKeyword;
    },
    normalizedKeyword,
    { timeout: remainingTime(deadline), polling: 250 },
  );
}

export type BossSearchSubmissionEvidence = 'result-mutation' | 'loading-cycle' | 'search-resource';

export interface BossSearchSubmissionReceipt {
  submitted: true;
  evidence: BossSearchSubmissionEvidence;
}

type BossSearchSubmissionObserverState = {
  token: string;
  target: Element;
  clickedAt: number;
  resultMutation: boolean;
  loadingSeen: boolean;
  observer: MutationObserver;
  clickHandler: (event: Event) => void;
};

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
      if (!state.clickedAt) return;
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
}

async function waitForBossSearchSubmission(
  frame: Frame,
  token: string,
  deadline: number,
): Promise<BossSearchSubmissionReceipt> {
  try {
    const observed = await frame.waitForFunction((expectedToken) => {
      type ObserverState = {
        token: string;
        clickedAt: number;
        resultMutation: boolean;
        loadingSeen: boolean;
      };
      const host = window as Window & { __autorecruitBossSearchSubmission?: ObserverState };
      const state = host.__autorecruitBossSearchSubmission;
      if (!state || state.token !== expectedToken || !state.clickedAt) return undefined;

      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (/数据加载异常/.test(bodyText)) {
        return { status: 'error', message: 'Boss search reported a data-loading error after the explicit search submit.' };
      }
      const isLoading = /(?:加载中|正在加载|加载资料)/.test(bodyText);
      state.loadingSeen ||= isLoading;
      const hasCards = document.querySelectorAll('.geek-info-card').length > 0;
      const hasExplicitEmpty = /暂无|没有|未找到|无相关|搜索使用方法/.test(bodyText) && !isLoading;
      if ((!hasCards && !hasExplicitEmpty) || isLoading) return undefined;

      const hasSearchResource = performance.getEntriesByType('resource').some((entry) => (
        entry.startTime >= state.clickedAt
        && /\/(?:wapi|api)\/.*(?:search|geek)/i.test(entry.name)
      ));
      if (state.resultMutation) return { status: 'ready', evidence: 'result-mutation' };
      if (state.loadingSeen) return { status: 'ready', evidence: 'loading-cycle' };
      if (hasSearchResource) return { status: 'ready', evidence: 'search-resource' };
      return undefined;
    }, token, { timeout: remainingTime(deadline), polling: 100 });
    const result = await observed.jsonValue() as { status: 'ready' | 'error'; evidence?: BossSearchSubmissionEvidence; message?: string };
    if (result.status === 'error') {
      throw new Error(result.message ?? 'Boss search submit failed.');
    }
    if (!result.evidence) {
      throw new Error('Boss search submit produced no result-cycle evidence.');
    }
    return { submitted: true, evidence: result.evidence };
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
  deadline: number,
  signal?: AbortSignal,
): Promise<BossSearchSubmissionReceipt> {
  throwIfBossSearchAborted(signal);
  const frame = await waitForBossSearchFrame(page, deadline);
  const control = await locateBossSearchSubmitControl(frame, deadline);
  const token = bossSearchSubmissionToken();
  const marker = `${token}-marker`;
  await control.evaluate((element, expectedMarker) => {
    element.setAttribute('data-autorecruit-boss-submit-marker', expectedMarker);
  }, marker);
  try {
    await armBossSearchSubmissionObserver(control, token);
    await assertBossSearchSubmitControlStillCurrent(frame, control, marker, deadline);
    throwIfBossSearchAborted(signal);
    await clickBossControlNatively(page, control, remainingTime(deadline), {
      pace: false,
      beforeClick: () => assertBossSearchSubmitControlStillCurrent(frame, control, marker, deadline),
    });
    throwIfBossSearchAborted(signal);
    return await waitForBossSearchSubmission(frame, token, deadline);
  } catch (error) {
    await clearBossSearchSubmissionObserver(frame, token);
    throw error;
  } finally {
    await control.evaluate((element, expectedMarker) => {
      if (element.getAttribute('data-autorecruit-boss-submit-marker') === expectedMarker) {
        element.removeAttribute('data-autorecruit-boss-submit-marker');
      }
    }, marker).catch(() => undefined);
  }
}

async function prepareBossSearchPage(page: Page, keyword: string, deadline: number): Promise<Page> {
  await openBossSearchMenu(page, deadline);
  await closeExistingBossResumeDialog(page, deadline);
  await waitForBossSearchFrame(page, deadline);
  await selectBossUnrestrictedJob(page, deadline);
  await applyBossSearchKeyword(page, keyword, deadline);
  return page;
}

async function assertBossSavedSearchState(
  page: Page,
  keyword: string,
  expectedRecentViewed: boolean | undefined,
  deadline: number,
): Promise<void> {
  const state = await snapshotBossSearchFilterState(page, deadline);
  const expectedKeyword = normalizeText(keyword);
  if (state.keyword !== expectedKeyword) {
    throw new Error(`Boss saved search keyword was not ready before submit: expected ${expectedKeyword}, observed ${state.keyword || '(empty)'}.`);
  }
  if (state.jobScope !== bossUnrestrictedJobName) {
    throw new Error(`Boss saved search job scope was not ready before submit: expected ${bossUnrestrictedJobName}, observed ${state.jobScope || '(empty)'}.`);
  }
  if (expectedRecentViewed !== undefined && state.toggles.filter_recent_viewed !== expectedRecentViewed) {
    throw new Error(`Boss saved search viewed policy was not ready before submit: expected ${String(expectedRecentViewed)}, observed ${String(state.toggles.filter_recent_viewed)}.`);
  }
}

async function openBossSubscribeSearch(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);
  const searchPage = await prepareBossSearchPage(page, keyword, deadline);
  if (options?.includeViewedCandidates !== undefined) {
    await applyBossViewedCandidatePolicy(searchPage, options.includeViewedCandidates, deadline);
  }
  throwIfBossSearchAborted(options?.signal);
  await waitBossActionPaceWithinDeadline(searchPage, deadline);
  await assertBossSavedSearchState(
    searchPage,
    keyword,
    options?.includeViewedCandidates === undefined ? undefined : !options.includeViewedCandidates,
    deadline,
  );
  await submitBossPreparedSearch(searchPage, deadline, options?.signal);
  await assertBossSavedSearchState(
    searchPage,
    keyword,
    options?.includeViewedCandidates === undefined ? undefined : !options.includeViewedCandidates,
    deadline,
  );
  return searchPage;
}

async function prepareBossSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
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

export interface BossDirectSearchApplyResult {
  page: Page;
  verification: BossDirectSearchVerificationSummary;
  submission?: BossSearchSubmissionReceipt;
  /** Fields that required a UI mutation during this replay. */
  changedFields?: string[];
  /** Fields whose semantic target was already present on the page. */
  alreadySatisfiedFields?: string[];
  /** Present only when a whole-page reset was the sole safe recovery path. */
  resetReason?: string;
}

export async function applyBossDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<BossDirectSearchApplyResult> {
  throwIfBossSearchAborted(options?.signal);
  const deadline = createBossDirectSearchDeadline(conditions, options);
  const resolvedViewedPolicy = resolveBossDirectRecentViewedPolicy(conditions, options?.includeViewedCandidates);
  const searchPage = await prepareBossSearchConditionPage(page, keyword, { ...options, deadline });
  throwIfBossSearchAborted(options?.signal);
  const effectiveConditions = resolvedViewedPolicy.conditions;
  const changedFields: string[] = [];
  const alreadySatisfiedFields: string[] = [];

  // Resetting every run made an otherwise correct province look as though it
  // had been selected repeatedly. Prefer field-local repair and reserve reset
  // for residual state that the action cannot clear safely and exactly.
  let initialState = await snapshotBossSearchFilterState(searchPage, deadline);
  const resetReason = bossDirectSearchResetReason(
    initialState,
    effectiveConditions,
  );
  if (resetReason) {
    await resetBossSearchFilters(searchPage, deadline);
    changedFields.push('reset');
    initialState = await snapshotBossSearchFilterState(searchPage, deadline);
  }

  const jobScopeConditions = effectiveConditions.filter((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'job_scope'
  ));
  const cityConditions = effectiveConditions.filter((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'city'
  ));
  const remainingConditions = effectiveConditions.filter((condition) => (
    !jobScopeConditions.includes(condition) && !cityConditions.includes(condition)
  ));

  if (jobScopeConditions.length === 0) {
    if (initialState.jobScope === bossUnrestrictedJobName) {
      alreadySatisfiedFields.push('job_scope');
    } else {
      await selectBossUnrestrictedJob(searchPage, deadline);
      changedFields.push('job_scope');
    }
  }

  for (const condition of jobScopeConditions) {
    throwIfBossSearchAborted(options?.signal);
    await applyBossDirectSearchConditionIfNeeded(
      searchPage,
      condition,
      deadline,
      changedFields,
      alreadySatisfiedFields,
    );
  }

  // A job change can make the iframe redraw its city control.
  // Read the closed state again immediately before deciding whether the city
  // requires its one allowed open/select/confirm chain.
  const stateBeforeCity = await snapshotBossSearchFilterState(searchPage, deadline);
  for (const condition of cityConditions) {
    throwIfBossSearchAborted(options?.signal);
    await applyBossDirectSearchConditionIfNeeded(
      searchPage,
      condition,
      deadline,
      changedFields,
      alreadySatisfiedFields,
    );
  }
  if (cityConditions.length === 0 && (stateBeforeCity.city || stateBeforeCity.cityOptions?.length)) {
    const frame = await waitForBossSearchFrame(searchPage, deadline);
    await clearBossResidualCityApplicationFilter(searchPage, frame, deadline);
    changedFields.push('city');
  } else if (cityConditions.length === 0) {
    alreadySatisfiedFields.push('city');
  }
  for (const condition of remainingConditions) {
    throwIfBossSearchAborted(options?.signal);
    await applyBossDirectSearchConditionIfNeeded(
      searchPage,
      condition,
      deadline,
      changedFields,
      alreadySatisfiedFields,
    );
  }

  if (resolvedViewedPolicy.desiredChecked !== undefined) {
    throwIfBossSearchAborted(options?.signal);
    const stateBeforeViewedPolicy = await snapshotBossSearchFilterState(searchPage, deadline);
    if (stateBeforeViewedPolicy.toggles.filter_recent_viewed === resolvedViewedPolicy.desiredChecked) {
      alreadySatisfiedFields.push('filter_recent_viewed');
    } else {
      await applyBossViewedCandidatePolicy(searchPage, !resolvedViewedPolicy.desiredChecked, deadline);
      changedFields.push('filter_recent_viewed');
    }
  } else if (!effectiveConditions.some((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'filter_recent_viewed'
  ))) {
    const stateBeforeViewedPolicy = await snapshotBossSearchFilterState(searchPage, deadline);
    if (stateBeforeViewedPolicy.toggles.filter_recent_viewed) {
      await applyBossViewedCandidatePolicy(searchPage, true, deadline);
      changedFields.push('filter_recent_viewed');
    } else {
      alreadySatisfiedFields.push('filter_recent_viewed');
    }
  }

  if (!effectiveConditions.some((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'no_colleague_resume_exchange'
  ))) {
    const stateBeforeExchangePolicy = await snapshotBossSearchFilterState(searchPage, deadline);
    if (stateBeforeExchangePolicy.toggles.no_colleague_resume_exchange) {
      const frame = await waitForBossSearchFrame(searchPage, deadline);
      await applyBossToggleApplicationFilter(searchPage, frame, 'no_colleague_resume_exchange', false, deadline);
      changedFields.push('no_colleague_resume_exchange');
    } else {
      alreadySatisfiedFields.push('no_colleague_resume_exchange');
    }
  }

  // Boss may replace a short keyword with its first autocomplete suggestion
  // while later filters refresh the iframe (for example, 铝 → 铝模). Enter the
  // keyword only after every other filter is stable so one write is both the
  // first input and the final value submitted by the mandatory search click.
  throwIfBossSearchAborted(options?.signal);
  const keywordBeforeSubmit = await readBossSearchKeyword(searchPage, deadline);
  if (keywordBeforeSubmit === normalizeText(keyword)) {
    alreadySatisfiedFields.push('keyword');
  } else {
    await applyBossSearchKeyword(searchPage, keyword, deadline);
    changedFields.push('keyword');
  }

  if (options?.sortPolicy) {
    const sortResult = await applyBossSearchSortPolicy(searchPage, options.sortPolicy, deadline);
    if (sortResult.changed) changedFields.push('sort_policy');
    else alreadySatisfiedFields.push('sort_policy');
  }

  throwIfBossSearchAborted(options?.signal);
  await waitBossActionPaceWithinDeadline(searchPage, deadline);
  const preSubmissionVerification = await readBossDirectSearchVerificationSummary(
    searchPage,
    keyword,
    effectiveConditions,
    deadline,
    resolvedViewedPolicy.desiredChecked,
    { includeResult: false },
  );
  const preSubmissionFailure = preSubmissionVerification.conditions.find((entry) => !entry.verified);
  if (preSubmissionFailure) {
    throw new Error(preSubmissionFailure.message ?? `Boss direct-search condition was not ready before submit for ${preSubmissionFailure.fieldId}.`);
  }
  const submission = await submitBossPreparedSearch(searchPage, deadline, options?.signal);
  if (options?.sortPolicy === 'match-priority') {
    const finalSortFrame = await waitForBossSearchFrame(searchPage, deadline);
    const activeSortLabels = await finalSortFrame.locator('.search-label').evaluateAll((elements) => elements
      .filter((element) => /\bactive\b|\bselected\b/.test(element.className))
      .map((element) => normalizeText(element.textContent ?? '')));
    if (activeSortLabels.length !== 1 || activeSortLabels[0] !== '匹配度优先') {
      throw new Error('Boss sort-postcondition-failed: match-priority was not retained after the final search cycle.');
    }
  }
  const verification = await assertBossDirectSearchPostcondition(
    searchPage,
    keyword,
    effectiveConditions,
    deadline,
    resolvedViewedPolicy.desiredChecked,
  );

  return {
    page: searchPage,
    verification,
    submission,
    changedFields: uniqueStrings(changedFields),
    alreadySatisfiedFields: uniqueStrings(alreadySatisfiedFields)
      .filter((fieldId) => !changedFields.includes(fieldId)),
    ...(resetReason ? { resetReason } : {}),
  };
}

async function openBossDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<Page> {
  return (await applyBossDirectSearch(page, keyword, conditions, options)).page;
}

const bossSelectRangeInputSpecByLabel: Record<string, SearchFilterOptionInputSpec> = {
  学历要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低学历' },
      { key: 'max', valueType: 'string', label: '最高学历' },
    ],
  },
  经验要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低经验' },
      { key: 'max', valueType: 'string', label: '最高经验' },
    ],
  },
};

const bossStaticFilterConfigs: BossStaticFilterConfig[] = [
  {
    key: 'boss-city',
    label: '城市',
    selector: '.city-wrap',
    controlType: 'multiSelect',
    valueShape: 'string[]',
  },
  {
    key: 'boss-job-scope',
    label: '职位范围',
    selector: '.search-job-list-C',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-company',
    label: '公司',
    selector: 'input.input-text[placeholder*="公司"]',
    controlType: 'textInput',
    valueShape: 'string',
    statusWhenEmpty: 'inspected',
  },
  {
    key: 'boss-education',
    label: '学历要求',
    selector: '.degree-ui',
    controlType: 'singleSelect',
    valueShape: 'string',
    customInputSpec: bossSelectRangeInputSpecByLabel.学历要求,
  },
  {
    key: 'boss-school-nature',
    label: '院校要求',
    selector: '.school-ui',
    controlType: 'multiSelect',
    valueShape: 'string[]',
  },
  {
    key: 'boss-work-years',
    label: '经验要求',
    selector: '.experience-select',
    controlType: 'singleSelect',
    valueShape: 'string',
    customInputSpec: bossSelectRangeInputSpecByLabel.经验要求,
  },
  {
    key: 'boss-age',
    label: '年龄要求',
    selector: '.age-select',
    controlType: 'rangeInput',
    valueShape: 'range',
  },
  {
    key: 'boss-gender',
    label: '性别',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-expected-salary',
    label: '薪资区间',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'rangeInput',
    valueShape: 'range',
  },
  {
    key: 'boss-recent-activity-time',
    label: '牛人活跃度',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-job-hopping-count',
    label: '跳槽频率',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-job-status',
    label: '求职状态',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-expected-function',
    label: '牛人职位要求',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'singleSelect',
    valueShape: 'string',
  },
  {
    key: 'boss-major',
    label: '专业',
    selector: '.more-filter-container .filter-2-item',
    controlType: 'textInput',
    valueShape: 'string',
    statusWhenEmpty: 'inspected',
  },
  {
    key: 'boss-filter-recent-viewed',
    label: '过滤近14天查看',
    selector: '.high_search_checkbox[ka="search_change_view_resume"]',
    controlType: 'toggle',
    valueShape: 'boolean',
  },
  {
    key: 'boss-no-colleague-resume-exchange',
    label: '近30天未和同事交换简历',
    selector: '.high_search_checkbox[ka="search_change_exchange_resume"]',
    controlType: 'toggle',
    valueShape: 'boolean',
  },
];

const bossExpandableMoreFilterKeys = new Set([
  'boss-gender',
  'boss-expected-salary',
  'boss-recent-activity-time',
  'boss-job-hopping-count',
  'boss-job-status',
  'boss-expected-function',
]);

const bossInlineApplicationFiltersByFieldId: Record<string, {
  rootSelector: string;
  optionSelector: string;
}> = {
  education: {
    rootSelector: '.degree-ui',
    optionSelector: '.degree-item, .degree-select-custom-label',
  },
  school_nature: {
    rootSelector: '.school-ui',
    optionSelector: '.degree-item, .checkbox-text',
  },
  work_years: {
    rootSelector: '.experience-select',
    optionSelector: '.exp-item, .custom',
  },
};

const bossMoreApplicationFilterLabelByFieldId: Record<string, string> = {
  gender: '性别',
  recent_activity_time: '牛人活跃度',
  job_hopping_count: '跳槽频率',
  job_status: '求职状态',
  candidate_position_requirement: '牛人职位要求',
};

const bossToggleApplicationFilterSelectorByFieldId: Record<string, string> = {
  filter_recent_viewed: '.high_search_checkbox[ka="search_change_view_resume"]',
  no_colleague_resume_exchange: '.high_search_checkbox[ka="search_change_exchange_resume"]',
};

const bossMoreApplicationFilterLabelsInOrder = [
  '性别',
  '薪资区间',
  '牛人活跃度',
  '跳槽频率',
  '求职状态',
  '牛人职位要求',
  '专业',
];

const bossMoreApplicationFilterIndexByLabel = new Map(
  bossMoreApplicationFilterLabelsInOrder.map((label, index) => [label, index]),
);

const bossSupportedApplicationFilterFieldIds = new Set([
  ...Object.keys(bossInlineApplicationFiltersByFieldId),
  ...Object.keys(bossMoreApplicationFilterLabelByFieldId),
  'age',
  'expected_salary',
  'filter_recent_viewed',
  'no_colleague_resume_exchange',
  'city',
  'job_scope',
  'company',
  'major',
]);

type BossCustomSliderRange = {
  min: number;
  max: number;
  minLabel: string;
  maxLabel: string;
};

type BossCustomSliderScaleValue = {
  raw: number;
  label: string;
};

type BossCustomSliderConfig = {
  rootSelector: string;
  triggerSelector: string;
  sliderSelector: string;
  visibleValueSelector: string;
  maximum: number;
  values: BossCustomSliderScaleValue[];
};

const bossCustomSliderConfigByFieldId: Record<string, BossCustomSliderConfig> = {
  education: {
    rootSelector: '.degree-ui',
    triggerSelector: '.degree-select-custom-label',
    sliderSelector: '.degree-select-custom-slider .ui-slider',
    visibleValueSelector: '.degree-select-custom-content',
    maximum: 7,
    values: [
      { raw: 2, label: '中专/中技' },
      { raw: 3, label: '高中' },
      { raw: 4, label: '大专' },
      { raw: 5, label: '本科' },
      { raw: 6, label: '硕士' },
      { raw: 7, label: '博士' },
    ],
  },
  work_years: {
    rootSelector: '.experience-select',
    triggerSelector: '.custom',
    sliderSelector: '.ui-slider',
    visibleValueSelector: '.experience-select-custom-content',
    maximum: 12,
    values: [
      { raw: 1, label: '在校/应届' },
      { raw: 2, label: '1年' },
      { raw: 3, label: '2年' },
      { raw: 4, label: '3年' },
      { raw: 5, label: '4年' },
      { raw: 6, label: '5年' },
      { raw: 7, label: '6年' },
      { raw: 8, label: '7年' },
      { raw: 9, label: '8年' },
      { raw: 10, label: '9年' },
      { raw: 11, label: '10年' },
      { raw: 12, label: '10年以上' },
    ],
  },
};

const bossCustomSliderFieldIdByLabel: Record<string, keyof typeof bossCustomSliderConfigByFieldId> = {
  学历要求: 'education',
  经验要求: 'work_years',
};

const bossAgePresetLabels = new Set(['不限', '20-25', '25-30', '30-35', '35-40', '40-50', '50以上']);

function bossMoreFilterItemLocator(frame: Frame, label: string) {
  const index = bossMoreApplicationFilterIndexByLabel.get(label);
  if (index !== undefined) {
    return frame.locator('.more-filter-container .filter-2-item').nth(index);
  }

  return frame.locator('.more-filter-container .filter-2-item').filter({ hasText: label }).first();
}

function addBossCustomInputSpec(
  options: SearchFilterOption[],
  customInputSpec: SearchFilterOptionInputSpec | undefined,
  customSliderFieldId?: keyof typeof bossCustomSliderConfigByFieldId,
): SearchFilterOption[] {
  if (!customInputSpec) {
    return options;
  }

  const customSlider = customSliderFieldId
    ? bossCustomSliderConfigByFieldId[customSliderFieldId]
    : undefined;

  return options.map((option) => {
    if (option.label !== '自定义' && option.value !== '自定义') {
      return option;
    }

    return {
      ...option,
      inputSpec: {
        ...customInputSpec,
        fields: customInputSpec.fields.map((field) => ({
          ...field,
          options: customSlider && (field.key === 'min' || field.key === 'max')
            ? customSlider.values.map((entry) => entry.label)
            : field.options,
        })),
      },
    };
  });
}

function buildBossFilterDefinition(
  configItem: BossStaticFilterConfig,
  snapshot: BossStaticFilterSnapshot | undefined,
): SearchFilterDefinition {
  const options = addBossCustomInputSpec(
    (snapshot?.options ?? []).map((option) => ({
      label: option.label,
      value: option.value || option.label,
      depth: 0,
      disabled: option.disabled,
      selected: option.selected,
    })),
    configItem.customInputSpec,
    bossCustomSliderFieldIdByLabel[configItem.label],
  );
  const status: SearchFilterDiscoveryStatus = options.length > 0
    ? 'optionsExtracted'
    : configItem.statusWhenEmpty ?? 'inspected';

  return {
    key: configItem.key,
    label: configItem.label,
    controlType: configItem.controlType,
    valueShape: configItem.valueShape,
    status,
    options: options.length > 0 ? options : undefined,
    selectorHints: [
      { kind: 'cssPath', value: configItem.selector },
      { kind: 'text', value: configItem.label },
      ...(snapshot?.containerText ? [{ kind: 'containerText' as const, value: snapshot.containerText.slice(0, 160) }] : []),
    ],
    message: options.length > 0
      ? 'Static Boss search filter options collected from the search iframe.'
      : 'Boss filter shell discovered; option expansion will be handled in a later replay/discovery step.',
  };
}

async function collectBossStaticFilterSnapshots(
  page: Page,
  deadline: number,
  expandableFilterKeys?: ReadonlySet<string>,
): Promise<BossStaticFilterSnapshot[]> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const shouldCollect = (key: string): boolean => !expandableFilterKeys || expandableFilterKeys.has(key);

  const staticSnapshots = await frame.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isElementVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readSelected = (element: HTMLElement): boolean => {
      if ('checked' in element) {
        return Boolean((element as HTMLInputElement).checked);
      }
      const input = element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
      return Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(element.className);
    };
    const readDisabled = (element: HTMLElement): boolean => {
      if ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) {
        return true;
      }
      const input = element.querySelector<HTMLInputElement>('input');
      return Boolean(input?.disabled) || /\b(disabled)\b/i.test(element.className);
    };
    const uniqueOptions = (elements: HTMLElement[]) => {
      const seen = new Set<string>();
      return elements
        .map((element) => {
          const label = normalize(element.textContent || element.getAttribute('placeholder'));
          const value = normalize(element.getAttribute('data-value'))
            || normalize(element.getAttribute('value'))
            || label;
          return {
            label,
            value,
            selected: readSelected(element),
            disabled: readDisabled(element),
          };
        })
        .filter((option) => {
          if (!option.label || seen.has(option.label)) {
            return false;
          }
          seen.add(option.label);
          return true;
        });
    };
    const buildSnapshot = (
      key: string,
      label: string,
      selector: string,
      optionSelector: string,
    ): BossStaticFilterSnapshot | undefined => {
      const root = document.querySelector(selector);
      if (!root) {
        return undefined;
      }
      const options = uniqueOptions(Array.from(root.querySelectorAll(optionSelector)).filter(isElementVisible));
      const customRangeValue = normalize(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value);
      const customRangeBoundaries = customRangeValue.split(',').map((value) => Number.parseInt(value.trim(), 10));
      return {
        key,
        label,
        selector,
        containerText: normalize(root.textContent),
        options,
        customRangeMaximum: customRangeBoundaries.length === 2
          && customRangeBoundaries.every((value) => Number.isInteger(value) && value > 0)
          ? Math.max(...customRangeBoundaries)
          : undefined,
      };
    };
    const readMoreFilterLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
      ? '薪资区间'
      : normalize(
        element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
        || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
        || element.querySelector<HTMLElement>('.defalut-select')?.textContent
        || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
        || element.querySelector<HTMLElement>('.ipt')?.textContent
        || element.textContent,
      );
    const moreFilterSnapshot = (key: string, label: string): BossStaticFilterSnapshot | undefined => {
      const item = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'))
        .filter(isElementVisible)
        .find((element) => readMoreFilterLabel(element) === label);
      if (!item) {
        return undefined;
      }
      return {
        key,
        label,
        selector: '.more-filter-container .filter-2-item',
        containerText: normalize(item.textContent),
        options: [],
      };
    };
    const toggleSnapshot = (key: string, label: string, selector: string): BossStaticFilterSnapshot | undefined => {
      const root = document.querySelector<HTMLElement>(selector);
      const input = root?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!root || !input || !isElementVisible(root)) {
        return undefined;
      }
      return {
        key,
        label,
        selector,
        containerText: normalize(root.textContent),
        options: [{
          label: 'enabled',
          value: 'true',
          selected: input.checked,
          disabled: input.disabled || /\bdisabled\b/i.test(root.className),
        }],
      };
    };

    return [
      buildSnapshot('boss-education', '学历要求', '.degree-ui', '.degree-item, .degree-select-custom-label'),
      buildSnapshot('boss-school-nature', '院校要求', '.school-ui', '.degree-item, .checkbox-text'),
      buildSnapshot('boss-work-years', '经验要求', '.experience-select', '.exp-item, .custom'),
      buildSnapshot('boss-age', '年龄要求', '.age-select', '.age-item, .custom'),
      moreFilterSnapshot('boss-gender', '性别'),
      moreFilterSnapshot('boss-expected-salary', '薪资区间'),
      moreFilterSnapshot('boss-recent-activity-time', '牛人活跃度'),
      moreFilterSnapshot('boss-job-hopping-count', '跳槽频率'),
      moreFilterSnapshot('boss-job-status', '求职状态'),
      moreFilterSnapshot('boss-expected-function', '牛人职位要求'),
      moreFilterSnapshot('boss-major', '专业'),
      toggleSnapshot('boss-filter-recent-viewed', '过滤近14天查看', '.high_search_checkbox[ka="search_change_view_resume"]'),
      toggleSnapshot('boss-no-colleague-resume-exchange', '近30天未和同事交换简历', '.high_search_checkbox[ka="search_change_exchange_resume"]'),
    ].filter((snapshot): snapshot is BossStaticFilterSnapshot => Boolean(snapshot));
  });

  const snapshotsByKey = new Map(staticSnapshots.map((snapshot) => [snapshot.key, snapshot]));
  for (const configItem of bossStaticFilterConfigs) {
    if (!bossExpandableMoreFilterKeys.has(configItem.key)
      || (expandableFilterKeys && !expandableFilterKeys.has(configItem.key))) {
      continue;
    }

    const filterItem = bossMoreFilterItemLocator(frame, configItem.label);
    const itemText = normalizeText(await filterItem.innerText({ timeout: Math.min(remainingTime(deadline), 1500) }).catch(() => ''));
    if (!itemText.includes(configItem.label)) {
      continue;
    }

    const expandedSnapshot = await collectBossExpandedMoreFilterSnapshot(page, frame, configItem, deadline).catch(() => undefined);
    if (expandedSnapshot) {
      snapshotsByKey.set(expandedSnapshot.key, expandedSnapshot);
    }
  }

  if (shouldCollect('boss-city')) {
    const citySnapshot = await collectBossCityFilterSnapshot(page, frame, deadline).catch(() => undefined);
    if (citySnapshot) {
      snapshotsByKey.set(citySnapshot.key, citySnapshot);
    }
  }
  if (shouldCollect('boss-job-scope')) {
    const jobScopeSnapshot = await collectBossJobScopeFilterSnapshot(frame, deadline).catch(() => undefined);
    if (jobScopeSnapshot) {
      snapshotsByKey.set(jobScopeSnapshot.key, jobScopeSnapshot);
    }
  }
  if (shouldCollect('boss-major')) {
    const tokenSnapshot = await collectBossTokenFilterSnapshot(page, frame, deadline).catch(() => undefined);
    if (tokenSnapshot) {
      snapshotsByKey.set(tokenSnapshot.key, tokenSnapshot);
    }
  }

  return Array.from(snapshotsByKey.values());
}

async function collectBossCityFilterSnapshot(
  page: Page,
  frame: Frame,
  deadline: number,
): Promise<BossStaticFilterSnapshot | undefined> {
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  const trigger = frame.locator('.city-wrap .city, .city-wrap .square').first();
  await trigger.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 3000) });
  await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
  await frame.locator('.city-wrap .city-box').first().waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const snapshot = await frame.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const items = Array.from(document.querySelectorAll<HTMLElement>('.city-wrap .dropdown-province > li')).filter(isVisible);
    return {
      options: items.map((item) => {
        const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
        return {
          label: normalize(item.textContent),
          value: normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('data-id')) || normalize(item.textContent),
          selected: /status1|checked|active/.test(checkbox?.className ?? '') || Boolean(item.querySelector<HTMLInputElement>('input')?.checked),
          disabled: /disabled/.test(item.className) || Boolean(item.querySelector<HTMLInputElement>('input')?.disabled),
        };
      }).filter((item) => item.label),
    };
  });
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  return snapshot.options.length === 0 ? undefined : {
    key: 'boss-city',
    label: '城市',
    selector: '.city-wrap',
    containerText: 'city-selection',
    options: snapshot.options,
  };
}

async function collectBossJobScopeFilterSnapshot(
  frame: Frame,
  deadline: number,
): Promise<BossStaticFilterSnapshot | undefined> {
  await frame.locator('.search-job-list-C').first().waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 3000) });
  const snapshot = await frame.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const options = Array.from(document.querySelectorAll<HTMLElement>('.search-job-list-C .ui-dropmenu-list li')).map((item) => ({
      label: normalize(item.textContent),
      value: normalize(item.getAttribute('data-id')) || normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('ka')) || normalize(item.textContent),
      selected: /\bactive\b/.test(item.className),
      disabled: /\bdisabled\b/.test(item.className),
    })).filter((item) => item.label);
    const valueCounts = new Map<string, number>();
    for (const option of options) {
      valueCounts.set(option.value, (valueCounts.get(option.value) ?? 0) + 1);
    }
    return options.map((option) => ({
      ...option,
      // The live control can assign its shared telemetry value to every job option.
      // Only retain an attribute value when it uniquely identifies a selectable option.
      value: (valueCounts.get(option.value) ?? 0) === 1 ? option.value : option.label,
    }));
  });
  return snapshot.length === 0 ? undefined : {
    key: 'boss-job-scope',
    label: '职位范围',
    selector: '.search-job-list-C',
    containerText: 'job-scope',
    options: snapshot,
  };
}

async function collectBossTokenFilterSnapshot(
  page: Page,
  frame: Frame,
  deadline: number,
): Promise<BossStaticFilterSnapshot | undefined> {
  const key = 'boss-major';
  const label = '专业';
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  const trigger = bossMoreFilterItemLocator(frame, label);
  await trigger.scrollIntoViewIfNeeded({ timeout: Math.min(remainingTime(deadline), 3000) });
  await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
  const dialog = frame.locator('.dialog-wrap:visible').last();
  await dialog.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const options = await dialog.locator('li').evaluateAll((elements) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const seen = new Set<string>();
    return elements.flatMap((element) => {
      if (!isVisible(element)) return [];
      const item = element as HTMLElement;
      const labelValue = normalize(item.textContent);
      if (!labelValue || labelValue.length > 80 || seen.has(labelValue)) return [];
      seen.add(labelValue);
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      return [{
        label: labelValue,
        value: normalize(item.getAttribute('data-id')) || normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('ka')) || labelValue,
        selected: /(?:selected|active|checked|status1)/.test(item.className) || /(?:selected|active|checked|status1)/.test(checkbox?.className ?? ''),
        disabled: /disabled/.test(item.className),
      }];
    });
  });
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  return options.length === 0 ? undefined : {
    key,
    label,
    selector: '.more-filter-container .filter-2-item',
    containerText: `${label}-dialog`,
    options,
  };
}

async function collectBossExpandedMoreFilterSnapshot(
  page: Page,
  frame: Frame,
  configItem: BossStaticFilterConfig,
  deadline: number,
): Promise<BossStaticFilterSnapshot | undefined> {
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);

  const filterItem = bossMoreFilterItemLocator(frame, configItem.label);
  await filterItem.scrollIntoViewIfNeeded({ timeout: Math.min(remainingTime(deadline), 3000) });
  await clickBossLocator(filterItem, page, Math.min(remainingTime(deadline), 3000));

  const targetIndex = bossMoreApplicationFilterIndexByLabel.get(configItem.label);
  await frame.waitForFunction(
    ({ label, index }) => {
      const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
      const isElementVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const readMoreFilterLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
        ? '薪资区间'
        : normalize(
          element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
          || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
          || element.querySelector<HTMLElement>('.defalut-select')?.textContent
          || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
          || element.querySelector<HTMLElement>('.ipt')?.textContent
          || element.textContent,
        );
      const items = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'))
        .filter(isElementVisible);
      const item = index === undefined
        ? items.find((element) => readMoreFilterLabel(element) === label)
        : items[index] ?? items.find((element) => readMoreFilterLabel(element) === label);
      return Boolean(item?.querySelector('.dropdown-menu, .options'));
    },
    { label: configItem.label, index: targetIndex },
    { timeout: Math.min(remainingTime(deadline), 3000), polling: 100 },
  ).catch(() => undefined);

  const snapshot = await frame.evaluate(({ key, label, selector, index }) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const isElementVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readMoreFilterLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
      ? '薪资区间'
      : normalize(
        element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
        || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
        || element.querySelector<HTMLElement>('.defalut-select')?.textContent
        || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
        || element.querySelector<HTMLElement>('.ipt')?.textContent
        || element.textContent,
      );
    const items = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'))
      .filter(isElementVisible);
    const item = index === undefined
      ? items.find((element) => readMoreFilterLabel(element) === label)
      : items[index] ?? items.find((element) => readMoreFilterLabel(element) === label);
    if (!item) {
      return undefined;
    }

    const seen = new Set<string>();
    const optionElements = Array.from(item.querySelectorAll<HTMLElement>('.dropdown-menu li, .options li, .dropdown-menu .checkbox-text, .dropdown-menu .radio-text'))
      .filter(isElementVisible);
    const options = optionElements
      .map((element) => {
        const optionLabel = normalize(element.textContent);
        return {
          label: optionLabel,
          value: normalize(element.getAttribute('data-value')) || normalize(element.getAttribute('value')) || optionLabel,
          selected: /\b(selected|active|checked)\b/i.test(element.className),
          disabled: /\b(disabled)\b/i.test(element.className),
        };
      })
      .filter((option) => {
        if (!option.label || option.label.length > 80 || seen.has(option.label)) {
          return false;
        }
        seen.add(option.label);
        return true;
      });

    return {
      key,
      label,
      selector,
      containerText: normalize(item.textContent),
      options,
    };
  }, {
    key: configItem.key,
    label: configItem.label,
    selector: configItem.selector,
    index: targetIndex,
  });

  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);
  await frame.waitForTimeout(100).catch(() => undefined);

  return snapshot && snapshot.options.length > 0 ? snapshot : undefined;
}

async function discoverBossSearchFilters(
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
): Promise<SearchFilterCatalog> {
  const deadline = options.deadline ?? Date.now() + Math.max(options.globalTimeoutMs ?? 0, config.playwright.searchPageTimeoutMs, 45000);
  const frame = await waitForBossSearchFrame(page, deadline);
  const snapshots = await collectBossStaticFilterSnapshots(
    page,
    deadline,
    options.filterKeys ? new Set(options.filterKeys) : undefined,
  );
  const snapshotsByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
  const filters = bossStaticFilterConfigs
    .map((configItem) => buildBossFilterDefinition(configItem, snapshotsByKey.get(configItem.key)));

  return {
    ...createEmptySearchFilterCatalog('boss', options.keyword, `${page.url()}#${frame.url()}`),
    filters,
    failures: [],
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}

function normalizeBossApplicationFilterValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'string') {
    return normalizeText(value);
  }
  return '';
}

function isApplicationFilterCondition(condition: SearchCondition): condition is Extract<SearchCondition, { kind: 'applicationFilter' }> {
  return condition.kind === 'applicationFilter'
    && typeof condition.fieldId === 'string'
    && typeof condition.label === 'string'
    && typeof condition.fieldKind === 'string';
}

function readBossApplicationFilterSingleValue(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string {
  const valueFromObject = isRecord(condition.value)
    ? normalizeBossApplicationFilterValue(condition.value.label)
    : normalizeBossApplicationFilterValue(condition.value);
  const conditionValue = valueFromObject || normalizeBossApplicationFilterValue(condition.values?.[0]?.value);
  if (!conditionValue) {
    throw new Error(`Missing value for Boss application filter: ${condition.fieldId}`);
  }
  if (conditionValue === '自定义') {
    throw new Error(`Boss application filter ${condition.fieldId} does not support custom input replay yet.`);
  }
  return conditionValue;
}

function resolveBossCustomSliderBoundary(
  fieldId: string,
  rawValue: unknown,
  boundaryName: 'min' | 'max',
): BossCustomSliderScaleValue {
  const configItem = bossCustomSliderConfigByFieldId[fieldId];
  if (!configItem) {
    throw new Error(`Boss application filter ${fieldId} does not expose a custom slider.`);
  }

  const value = normalizeBossApplicationFilterValue(rawValue);
  const semanticMatch = configItem.values.find((entry) => entry.label === value);
  if (semanticMatch) {
    return semanticMatch;
  }

  // Existing persisted direct-search conditions used the page's numeric slider
  // indexes. Preserve those records as an explicit compatibility input, but
  // resolve their visible meaning before operating the page.
  const legacyRaw = Number.parseInt(value, 10);
  if (/^\d+$/.test(value)) {
    const legacyMatch = configItem.values.find((entry) => entry.raw === legacyRaw);
    if (legacyMatch) {
      return legacyMatch;
    }
  }

  const supportedValues = configItem.values.map((entry) => entry.label).join('、');
  throw new Error(`Boss application filter ${fieldId} custom ${boundaryName} must use a semantic boundary (${supportedValues}); received ${value || '(empty)'}.`);
}

function readBossCustomSliderRange(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): BossCustomSliderRange | undefined {
  if (!isRecord(condition.value) || normalizeBossApplicationFilterValue(condition.value.label) !== '自定义') {
    return undefined;
  }
  const input = readRecord(condition.value, 'input');
  if (!input) {
    throw new Error(`Boss application filter ${condition.fieldId} custom selection requires input.min and input.max.`);
  }
  const min = resolveBossCustomSliderBoundary(condition.fieldId, input.min, 'min');
  const max = resolveBossCustomSliderBoundary(condition.fieldId, input.max, 'max');
  if (max.raw < min.raw) {
    throw new Error(`Boss application filter ${condition.fieldId} custom range minimum ${min.label} cannot exceed maximum ${max.label}.`);
  }
  return {
    min: min.raw,
    max: max.raw,
    minLabel: min.label,
    maxLabel: max.label,
  };
}

function readBossApplicationFilterMultiValues(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string[] {
  const rawValues = Array.isArray(condition.value)
    ? condition.value
    : condition.values?.map((entry) => entry.value) ?? [];
  const values = rawValues
    .map((value) => normalizeBossApplicationFilterValue(value))
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`Boss application filter ${condition.fieldId} requires at least one selected value.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`Boss application filter ${condition.fieldId} cannot select the same value more than once.`);
  }
  if (values.includes('不限') && values.length > 1) {
    throw new Error(`Boss application filter ${condition.fieldId} cannot combine 不限 with specific values.`);
  }
  return values;
}

function readBossApplicationFilterToggleValue(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): boolean {
  if (typeof condition.value === 'boolean') {
    return condition.value;
  }
  const fallback = normalizeBossApplicationFilterValue(condition.values?.[0]?.value).toLowerCase();
  if (fallback === 'true') {
    return true;
  }
  if (fallback === 'false') {
    return false;
  }
  throw new Error(`Boss application filter ${condition.fieldId} requires a boolean value.`);
}

type BossDirectRecentViewedPolicy = {
  conditions: SearchCondition[];
  desiredChecked?: boolean;
};

function resolveBossDirectRecentViewedPolicy(
  conditions: SearchCondition[],
  includeViewedCandidates: boolean | undefined,
): BossDirectRecentViewedPolicy {
  const recentViewedConditions = conditions.filter((condition): condition is Extract<SearchCondition, { kind: 'applicationFilter' }> => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'filter_recent_viewed'
  ));
  const requestedValues = recentViewedConditions.map((condition) => readBossApplicationFilterToggleValue(condition));
  const uniqueRequestedValues = [...new Set(requestedValues)];
  if (uniqueRequestedValues.length > 1) {
    throw new Error('Boss direct search received conflicting filter_recent_viewed conditions. Keep one value before opening the search page.');
  }

  if (includeViewedCandidates === undefined) {
    if (recentViewedConditions.length <= 1) {
      return { conditions };
    }
    // Repeating the exact same toggle has no business effect. Keep one so
    // normal direct-filter replay remains deterministic for compatibility callers.
    let retainedRecentViewedCondition = false;
    return {
      conditions: conditions.filter((condition) => {
        if (!isApplicationFilterCondition(condition) || condition.fieldId !== 'filter_recent_viewed') {
          return true;
        }
        if (retainedRecentViewedCondition) {
          return false;
        }
        retainedRecentViewedCondition = true;
        return true;
      }),
    };
  }

  const desiredChecked = !includeViewedCandidates;
  const explicitValue = uniqueRequestedValues[0];
  if (explicitValue !== undefined && explicitValue !== desiredChecked) {
    throw new Error(
      `Boss direct search filter_recent_viewed=${String(explicitValue)} conflicts with --include-viewed ${String(includeViewedCandidates)}. Remove filter_recent_viewed from the direct conditions or align the switch.`,
    );
  }

  return {
    // The public ordinary-capture switch owns the final state. An agreeing
    // explicit condition is accepted but intentionally replayed only once by
    // the semantic policy action below.
    conditions: conditions.filter((condition) => (
      !isApplicationFilterCondition(condition) || condition.fieldId !== 'filter_recent_viewed'
    )),
    desiredChecked,
  };
}

function readBossApplicationFilterRangeBoundary(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  key: 'min' | 'max',
): string {
  const valueFromObject = isRecord(condition.value)
    ? normalizeBossApplicationFilterValue(condition.value[key])
    : '';
  const valueIndex = key === 'min' ? 0 : 1;
  return valueFromObject || normalizeBossApplicationFilterValue(condition.values?.[valueIndex]?.value);
}

function normalizeBossSalaryBoundary(value: string, boundaryName: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new Error(`Boss expected salary application filter requires non-empty ${boundaryName}.`);
  }
  if (normalizedValue === '不限') {
    return normalizedValue;
  }

  const uppercaseValue = normalizedValue.toUpperCase();
  const kMatch = uppercaseValue.match(/^(\d+(?:\.\d+)?)\s*K$/);
  const thousandMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)\s*(?:千|k|K)$/);
  const wanMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)\s*万$/);
  const plainNumberMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)$/);
  const numericValue = kMatch?.[1]
    ?? thousandMatch?.[1]
    ?? (wanMatch ? String(Number.parseFloat(wanMatch[1]) * 10) : undefined)
    ?? plainNumberMatch?.[1];
  if (!numericValue) {
    return uppercaseValue;
  }

  const salaryNumber = Number.parseFloat(numericValue);
  if (!Number.isFinite(salaryNumber) || !Number.isInteger(salaryNumber)) {
    throw new Error(`Boss expected salary ${boundaryName} must match a collected K option: ${normalizedValue}`);
  }

  return `${salaryNumber}K`;
}

function readBossExpectedSalaryRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): { min: string; max: string } {
  if (!isRecord(condition.value) && (!condition.values || condition.values.length < 2)) {
    throw new Error('Boss expected salary application filter requires { min, max } value.');
  }

  const min = normalizeBossSalaryBoundary(readBossApplicationFilterRangeBoundary(condition, 'min'), 'min');
  const max = normalizeBossSalaryBoundary(readBossApplicationFilterRangeBoundary(condition, 'max'), 'max');
  return { min, max };
}

function parseBossAgeBoundaryNumber(value: string): number | undefined {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue || normalizedValue === '不限') {
    return undefined;
  }

  const numberMatch = normalizedValue.match(/\d{1,3}/);
  if (!numberMatch) {
    throw new Error(`Boss age boundary must be a number or 不限: ${normalizedValue}`);
  }

  const age = Number.parseInt(numberMatch[0], 10);
  if (!Number.isFinite(age)) {
    throw new Error(`Boss age boundary must be a finite number: ${normalizedValue}`);
  }

  return age;
}

function readBossAgeRangeInput(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): { min?: number; max?: number; minRaw: string; maxRaw: string } {
  if (!isRecord(condition.value) && (!condition.values || condition.values.length === 0)) {
    throw new Error('Boss age application filter requires at least one boundary.');
  }

  const minRaw = readBossApplicationFilterRangeBoundary(condition, 'min');
  const maxRaw = readBossApplicationFilterRangeBoundary(condition, 'max');
  const min = parseBossAgeBoundaryNumber(minRaw);
  const max = parseBossAgeBoundaryNumber(maxRaw);
  if (min === undefined && max === undefined && minRaw !== '不限' && maxRaw !== '不限') {
    throw new Error('Boss age application filter requires at least one non-empty boundary.');
  }

  if (min !== undefined && max !== undefined && max < min) {
    throw new Error('Boss age application filter max boundary cannot be lower than min boundary.');
  }

  return { min, max, minRaw, maxRaw };
}

function buildBossAgePresetLabel(input: { min?: number; max?: number; minRaw: string; maxRaw: string }): string | undefined {
  if (input.min === undefined && input.max === undefined) {
    return '不限';
  }

  if (input.min === 50 && input.max === undefined) {
    return '50以上';
  }

  if (input.min !== undefined && input.max !== undefined) {
    const preset = `${input.min}-${input.max}`;
    return bossAgePresetLabels.has(preset) ? preset : undefined;
  }

  return undefined;
}

function normalizeBossAgeDropdownBoundary(value: string, age: number | undefined, boundaryName: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue || normalizedValue === '不限') {
    return '不限';
  }

  if (age === undefined) {
    throw new Error(`Boss age ${boundaryName} boundary must be a number or 不限: ${normalizedValue}`);
  }

  if (/46\s*岁?\s*\+|46\s*岁?\s*以上/.test(normalizedValue)) {
    return '46岁+';
  }

  if (age < 16 || age > 46) {
    throw new Error(`Boss age ${boundaryName} boundary is not available in the custom dropdown: ${normalizedValue}`);
  }

  return `${age}岁`;
}

async function waitForBossFilterSettle(frame: Frame, deadline: number): Promise<void> {
  await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
  await frame.waitForFunction(
    () => document.querySelectorAll('.geek-info-card').length > 0
      || /暂无|没有|未找到|无相关|搜索使用方法/.test((document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()),
    undefined,
    { timeout: Math.min(remainingTime(deadline), 5000), polling: 250 },
  ).catch(() => undefined);
}

async function clickBossInlineApplicationFilter(
  frame: Frame,
  fieldId: string,
  value: string,
  deadline: number,
): Promise<void> {
  const filterConfig = bossInlineApplicationFiltersByFieldId[fieldId];
  if (!filterConfig) {
    throw new Error(`Unsupported Boss inline application filter: ${fieldId}`);
  }

  await frame.locator(filterConfig.rootSelector).first().waitFor({
    state: 'visible',
    timeout: Math.min(remainingTime(deadline), 5000),
  });

  const root = frame.locator(filterConfig.rootSelector).first();
  const options = root.locator(filterConfig.optionSelector);
  const matches = await options.evaluateAll((elements, targetValue) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    return elements.flatMap((element, index) => {
      if (normalize(element.textContent) !== targetValue) return [];
      const option = element as HTMLElement;
      const input = option.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
        ?? option.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
      return [{
        index,
        selected: Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(option.className),
      }];
    });
  }, value);
  if (matches.length !== 1) {
    throw new Error(`Boss filter option ${value} matched ${matches.length} controls.`);
  }
  if (matches[0]!.selected) return;

  await clickBossLocator(options.nth(matches[0]!.index), frame.page(), Math.min(remainingTime(deadline), 5000));
  await waitForBossFilterSettle(frame, deadline);

  const selected = await options.nth(matches[0]!.index).evaluate((element) => {
    const option = element as HTMLElement;
    const input = option.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
      ?? option.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
    return Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(option.className);
  });
  if (!selected) {
    throw new Error(`Boss filter option did not become selected: ${fieldId}=${value}`);
  }
}

async function readBossCustomSliderState(
  frame: Frame,
  fieldId: string,
  deadline: number,
): Promise<{
  min: number;
  max: number;
  maximum: number;
  visibleValue?: string;
  visibleValuePresent: boolean;
  box: { x: number; y: number; width: number; height: number };
}> {
  const configItem = bossCustomSliderConfigByFieldId[fieldId];
  if (!configItem) {
    throw new Error(`Boss custom slider is not configured for ${fieldId}.`);
  }
  const root = frame.locator(configItem.rootSelector).first();
  const slider = root.locator(configItem.sliderSelector).first();
  await slider.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const rawValue = await root.locator('input[type="hidden"]').first().inputValue({ timeout: Math.min(remainingTime(deadline), 3000) });
  const values = rawValue.split(',').map((item) => Number.parseInt(item.trim(), 10));
  if (values.length !== 2 || values.some((value) => !Number.isInteger(value) || value < 1 || value > configItem.maximum)) {
    throw new Error(`Boss custom slider ${fieldId} does not expose two positive integer boundaries.`);
  }
  const [min, max] = values as [number, number];
  const visibleValueLocator = root.locator(configItem.visibleValueSelector).first();
  const visibleValuePresent = await visibleValueLocator.count() > 0;
  const visibleValue = visibleValuePresent
    ? normalizeText(await visibleValueLocator.innerText({ timeout: Math.min(remainingTime(deadline), 3000) }).catch(() => '')) || undefined
    : undefined;
  const box = await slider.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`Boss custom slider ${fieldId} is not measurable.`);
  }
  const primaryHandles = slider.locator('.ui-slider-button');
  const handles = await primaryHandles.count() === 2 ? primaryHandles : slider.locator('.ui-slider-button-wrap');
  if (await handles.count() !== 2) {
    throw new Error(`Boss custom slider ${fieldId} does not expose two handles.`);
  }
  return {
    min,
    max,
    maximum: configItem.maximum,
    visibleValue,
    visibleValuePresent,
    box,
  };
}

async function dragBossCustomSliderHandle(
  page: Page,
  handle: Locator,
  target: { x: number; y: number },
  deadline: number,
  domFallback = false,
  targetRatio = 0.5,
): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error('Boss custom slider handle is not measurable.');
  }
  await runBossPageAction(page, async () => undefined);
  await moveMouseContinuously(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { deadline },
  );
  if (domFallback) {
    await runBossPageAction(page, () => handle.evaluate((element, ratio) => {
      const slider = element.closest<HTMLElement>('.ui-slider');
      const start = element.getBoundingClientRect();
      const sliderRect = slider?.getBoundingClientRect();
      if (!sliderRect) throw new Error('Boss custom slider fallback cannot locate its root.');
      const clientX = sliderRect.left + Math.max(0, Math.min(1, ratio)) * sliderRect.width;
      const clientY = sliderRect.top + sliderRect.height / 2;
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: start.left + start.width / 2, clientY: start.top + start.height / 2, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY, buttons: 1 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY, button: 0 }));
    }, targetRatio));
  } else {
    await page.mouse.down();
    await moveMouseContinuously(page, target, { deadline });
    await page.mouse.up();
  }
  if (remainingTime(deadline) <= 1) {
    throw new Error('Boss custom slider deadline exhausted.');
  }
}

async function applyBossCustomSliderApplicationFilter(
  page: Page,
  frame: Frame,
  fieldId: string,
  input: BossCustomSliderRange,
  deadline: number,
): Promise<void> {
  const configItem = bossCustomSliderConfigByFieldId[fieldId];
  if (!configItem) {
    throw new Error(`Boss custom slider is not configured for ${fieldId}.`);
  }
  const root = frame.locator(configItem.rootSelector).first();
  const trigger = root.locator(configItem.triggerSelector).first();
  await trigger.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
  const initial = await readBossCustomSliderState(frame, fieldId, deadline);
  if (input.max > initial.maximum) {
    throw new Error(`Boss custom slider ${fieldId} maximum is ${initial.maximum}, requested ${input.max}.`);
  }
  const ratioFor = (value: number) => Math.max(0, Math.min(1, (value - 1) / Math.max(initial.maximum - 1, 1)));
  const targetPoint = (value: number) => ({
    x: initial.box.x + ratioFor(value) * initial.box.width,
    y: initial.box.y + initial.box.height / 2,
  });
  const slider = root.locator(configItem.sliderSelector).first();
  const primaryHandles = slider.locator('.ui-slider-button');
  const handles = await primaryHandles.count() === 2 ? primaryHandles : slider.locator('.ui-slider-button-wrap');
  const moveLower = async (domFallback = false, fallbackRatio = ratioFor(input.min)) => {
    await dragBossCustomSliderHandle(page, handles.nth(0), targetPoint(input.min), deadline, domFallback, fallbackRatio);
  };
  const moveUpper = async (domFallback = false, fallbackRatio = ratioFor(input.max)) => {
    await dragBossCustomSliderHandle(page, handles.nth(1), targetPoint(input.max), deadline, domFallback, fallbackRatio);
  };
  // Expand/shrink the non-blocking side first. This is required when the two
  // handles currently overlap: dragging the lower handle upward first would
  // otherwise be clamped by the upper handle, and vice versa.
  if (input.min > initial.max) {
    await moveUpper();
    await moveLower();
  } else if (input.max < initial.min) {
    await moveLower();
    await moveUpper();
  } else {
    await moveLower();
    await moveUpper();
  }
  await waitForBossFilterSettle(frame, deadline);
  let after = await readBossCustomSliderState(frame, fieldId, deadline);
  if (after.min !== input.min || after.max !== input.max) {
    // Some live slider variants snap a low boundary only after the pointer enters
    // the centre of its next segment. Try bounded, pointer-preserving alternatives
    // before declaring the exact range unavailable.
    const fallbackRatios = [
      (value: number) => Math.max(0, Math.min(1, (value - 0.5) / Math.max(initial.maximum - 1, 1))),
      (value: number) => Math.max(0, Math.min(1, value / initial.maximum)),
    ];
    for (const fallbackRatioFor of fallbackRatios) {
      const fallbackTargetPoint = (value: number) => ({ x: initial.box.x + fallbackRatioFor(value) * initial.box.width, y: initial.box.y + initial.box.height / 2 });
      const moveFallbackLower = async () => dragBossCustomSliderHandle(page, handles.nth(0), fallbackTargetPoint(input.min), deadline, true, fallbackRatioFor(input.min));
      const moveFallbackUpper = async () => dragBossCustomSliderHandle(page, handles.nth(1), fallbackTargetPoint(input.max), deadline, true, fallbackRatioFor(input.max));
      if (input.min > after.max) {
        await moveFallbackUpper();
        await moveFallbackLower();
      } else if (input.max < after.min) {
        await moveFallbackLower();
        await moveFallbackUpper();
      } else {
        await moveFallbackLower();
        await moveFallbackUpper();
      }
      await waitForBossFilterSettle(frame, deadline);
      after = await readBossCustomSliderState(frame, fieldId, deadline);
      if (after.min === input.min && after.max === input.max) {
        break;
      }
    }
  }
  if (after.min !== input.min || after.max !== input.max) {
    throw new Error(`Boss custom slider ${fieldId} did not match ${input.min},${input.max}; observed ${after.min},${after.max}.`);
  }
  const expectedVisibleValue = `${input.minLabel}-${input.maxLabel}`;
  if (after.visibleValuePresent && after.visibleValue !== expectedVisibleValue) {
    throw new Error(`Boss custom slider ${fieldId} visible value did not match ${expectedVisibleValue}; observed ${after.visibleValue ?? '(empty)'}.`);
  }
}

type BossProvinceOption = {
  label: string;
  value: string;
};

type BossProvinceSelectionState = {
  /** Province selections; 全国 is normalized to the unrestricted empty set. */
  provinces: string[];
  /** Selected province labels paired with their stable option values. */
  provinceOptions: BossProvinceOption[];
  /** All province label/value aliases still present in the hidden picker DOM. */
  provinceAliases: BossProvinceOption[];
  /** The visible city summary, normalized so placeholders and 全国 are empty. */
  summary: string;
  panelVisible: boolean;
  /** A contradiction between the closed summary and the province checkmarks. */
  evidenceConflict: boolean;
};

type BossCityApplicationFilterResult = {
  status: 'applied' | 'alreadySatisfied';
  provinces: string[];
  subdivisionPolicy: 'all';
};

function sameBossStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function bossProvinceSelectionMatchesValues(
  provinceOptions: readonly BossProvinceOption[],
  desiredValues: readonly string[],
): boolean {
  if (provinceOptions.length !== desiredValues.length) {
    return false;
  }
  const unmatched = [...provinceOptions];
  for (const desired of desiredValues) {
    const index = unmatched.findIndex((option) => option.label === desired || option.value === desired);
    if (index < 0) {
      return false;
    }
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function bossProvinceSummaryMatchesLabels(summary: string, labels: readonly string[]): boolean {
  if (labels.length === 0) {
    return !summary;
  }
  if (!summary) {
    return false;
  }
  const summarizedLabels = summary.split(/[、,，]/u).map((entry) => normalizeText(entry)).filter(Boolean);
  return sameBossStringSet(summarizedLabels, labels);
}

function bossProvinceSummaryMatchesValues(
  selection: BossProvinceSelectionState,
  desiredValues: readonly string[],
): boolean {
  if (desiredValues.length === 0) return !selection.summary;
  if (!selection.summary) return false;
  const summaryValues = selection.summary.split(/[、,，]/u).map((entry) => normalizeText(entry)).filter(Boolean);
  if (summaryValues.length !== desiredValues.length) return false;

  const desiredAliases = desiredValues.map((desired) => selection.provinceAliases.find((option) =>
    option.label === desired || option.value === desired));
  if (desiredAliases.some((option) => !option)) {
    return bossProvinceSummaryMatchesLabels(selection.summary, desiredValues);
  }
  const unmatched = [...summaryValues];
  for (const alias of desiredAliases) {
    const index = unmatched.findIndex((summary) => summary === alias!.label || summary === alias!.value);
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function bossProvinceSelectionStateMatchesValues(
  selection: BossProvinceSelectionState,
  desiredValues: readonly string[],
): boolean {
  return selection.provinceOptions.length > 0
    ? bossProvinceSelectionMatchesValues(selection.provinceOptions, desiredValues)
    : bossProvinceSummaryMatchesValues(selection, desiredValues);
}

/**
 * Read province selections from the existing city DOM without opening or
 * confirming the picker. A selected province always means all of its child
 * cities; this action deliberately never reads or clicks the child list.
 */
async function readBossProvinceSelectionState(frame: Frame): Promise<BossProvinceSelectionState> {
  return frame.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const cityBox = document.querySelector<HTMLElement>('.city-wrap .city-box');
    const citySummary = document.querySelector<HTMLElement>('.city-wrap .city');
    const cityInput = document.querySelector<HTMLInputElement>('.city-wrap .search-city-kw input');
    const isVisible = (element: HTMLElement | null): boolean => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const allOptions = Array.from(document.querySelectorAll<HTMLElement>('.city-wrap .dropdown-province > li')).flatMap((item) => {
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      const label = normalize(item.textContent);
      const value = normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('data-id')) || label;
      return label ? [{
        label,
        value,
        selected: /status1|checked|active/.test(checkbox?.className ?? '')
          || Boolean(item.querySelector<HTMLInputElement>('input')?.checked),
      }] : [];
    });
    const selectedOptions = allOptions
      .filter((option) => option.selected)
      .map(({ label, value }) => ({ label, value }));
    const selected = selectedOptions.map((option) => option.label);
    if (new Set(selected).size !== selected.length) {
      throw new Error('Boss city selector contains duplicate selected province labels.');
    }
    const hasNational = selected.includes('全国');
    if (hasNational && selected.length > 1) {
      throw new Error('Boss city selector selected 全国 together with a province.');
    }
    const provinces = hasNational ? [] : selected;
    const rawSummary = normalize(citySummary?.textContent) || normalize(cityInput?.value);
    const summary = /^(?:城市|请选择|全国)$/.test(rawSummary) ? '' : rawSummary;
    // The summary is cross-check evidence only. Multi-province summaries vary
    // between live page versions, while a single different province is an
    // actionable contradiction that must not be papered over by reopening.
    // Some live page versions discard the hidden checkbox state as the panel
    // closes while retaining the committed province summary. In that closed
    // summary-only state the summary is the read-only fallback evidence; it is
    // not a contradiction. A populated option set with a different summary is.
    const evidenceConflict = (provinces.length === 1 && Boolean(summary)
        && !summary.includes(provinces[0]!) && !provinces[0]!.includes(summary));
    return {
      provinces,
      provinceOptions: hasNational ? [] : selectedOptions,
      provinceAliases: allOptions.map(({ label, value }) => ({ label, value })),
      summary,
      panelVisible: isVisible(cityBox),
      evidenceConflict,
    };
  });
}

/**
 * Wait for Boss to commit the city summary after closing the picker. Some
 * live page versions hide the panel first and hydrate the closed summary a
 * little later, so reading once immediately after the close would falsely
 * report an empty selection. Keep the check bounded and require the same
 * semantic evidence used by the normal postcondition.
 */
async function waitForBossProvinceSelectionState(
  frame: Frame,
  desiredValues: readonly string[],
  deadline: number,
): Promise<BossProvinceSelectionState> {
  const waitUntil = Math.min(deadline, Date.now() + 5000);
  let state = await readBossProvinceSelectionState(frame);
  while (Date.now() < waitUntil) {
    if (!state.panelVisible
      && !state.evidenceConflict
      && bossProvinceSelectionStateMatchesValues(state, desiredValues)) {
      return state;
    }
    await frame.waitForTimeout(Math.min(100, remainingTime(waitUntil))).catch(() => undefined);
    state = await readBossProvinceSelectionState(frame);
  }
  return state;
}

async function applyBossCityApplicationFilter(
  page: Page,
  frame: Frame,
  values: string[],
  deadline: number,
): Promise<BossCityApplicationFilterResult> {
  const desiredValues = uniqueStrings(values);
  const desired = new Set(desiredValues);
  if (desired.size === 0 || desired.has('不限')) {
    throw new Error('Boss city application filter requires one or more explicit city options.');
  }
  if (desired.has('全国')) {
    throw new Error('Boss city application filter uses province selections only; omit 全国 for the unrestricted baseline.');
  }

  const closedState = await readBossProvinceSelectionState(frame);
  if (closedState.evidenceConflict) {
    throw new Error(`Boss closed city state has conflicting summary and province evidence (summary: ${closedState.summary || '(empty)'}, provinces: ${closedState.provinces.join('、') || '(none)'}).`);
  }
  if (bossProvinceSelectionStateMatchesValues(closedState, desiredValues)) {
    return {
      status: 'alreadySatisfied',
      provinces: [...closedState.provinces].sort(),
      subdivisionPolicy: 'all',
    };
  }

  const trigger = frame.locator('.city-wrap .city, .city-wrap .square').first();
  const cityBox = frame.locator('.city-wrap .city-box').first();
  if (!closedState.panelVisible) {
    await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
    try {
      await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
    } catch {
      // A narrow compatibility retry is allowed only after the required panel
      // postcondition failed. It is never used for an already-satisfied city.
      await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
      await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
    }
  }
  // Confirmed selections are hydrated into the panel asynchronously after it
  // opens. Read the settled state so a prior city is removed before applying
  // the next exact set.
  await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
  const items = cityBox.locator('.dropdown-province > li');
  const states = await items.evaluateAll((elements) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    return elements.map((element, index) => {
      const item = element as HTMLElement;
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      return {
        index,
        label: normalize(item.textContent),
        value: normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('data-id')) || normalize(item.textContent),
        selected: /status1|checked|active/.test(checkbox?.className ?? '') || Boolean(item.querySelector<HTMLInputElement>('input')?.checked),
        disabled: /disabled/.test(item.className) || Boolean(item.querySelector<HTMLInputElement>('input')?.disabled),
      };
    }).filter((item) => item.label);
  });
  const desiredIndexes = new Set<number>();
  for (const value of desired) {
    const matches = states.filter((item) => item.label === value || item.value === value);
    if (matches.length !== 1) {
      throw new Error(`Boss city option ${value} matched ${matches.length} controls.`);
    }
    if (matches[0]!.disabled) {
      throw new Error(`Boss city option is disabled: ${value}`);
    }
    desiredIndexes.add(matches[0]!.index);
  }
  for (const option of states) {
    const shouldSelect = desired.has(option.label) || desired.has(option.value);
    if (option.selected !== shouldSelect) {
      await clickBossLocator(items.nth(option.index), page, Math.min(remainingTime(deadline), 5000));
    }
  }
  await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
  const readSelectedIndexes = () => items.evaluateAll((elements) => elements.flatMap((element, index) => {
    const item = element as HTMLElement;
    const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
    const selected = /status1|checked|active/.test(checkbox?.className ?? '') || Boolean(item.querySelector<HTMLInputElement>('input')?.checked);
    return selected ? [index] : [];
  }));
  let selectedIndexes = await readSelectedIndexes();
  if (selectedIndexes.length !== desiredIndexes.size || selectedIndexes.some((index) => !desiredIndexes.has(index))) {
    const selectedSet = new Set(selectedIndexes);
    for (const option of states) {
      const shouldSelect = desiredIndexes.has(option.index);
      if (selectedSet.has(option.index) !== shouldSelect) {
        await clickBossLocator(items.nth(option.index), page, Math.min(remainingTime(deadline), 5000));
      }
    }
    await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
    selectedIndexes = await readSelectedIndexes();
  }
  if (selectedIndexes.length !== desiredIndexes.size || selectedIndexes.some((index) => !desiredIndexes.has(index))) {
    const selectedSet = new Set(selectedIndexes);
    for (const option of states) {
      const shouldSelect = desiredIndexes.has(option.index);
      if (selectedSet.has(option.index) !== shouldSelect) {
        await clickBossControlWithDomEvent(page, items.nth(option.index), Math.min(remainingTime(deadline), 5000));
      }
    }
    await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
    selectedIndexes = await readSelectedIndexes();
  }
  if (selectedIndexes.length !== desiredIndexes.size || selectedIndexes.some((index) => !desiredIndexes.has(index))) {
    throw new Error(`Boss city selection did not match the requested set before confirmation (expected indexes: ${[...desiredIndexes].join(',')}; selected indexes: ${selectedIndexes.join(',')}).`);
  }
  const confirmIndex = await cityBox.locator('button').evaluateAll((buttons) => buttons.findIndex((button) => /确定|确认|完成/.test((button.textContent ?? '').replace(/\s+/g, ' ').trim())));
  if (confirmIndex < 0) {
    throw new Error('Boss city selector confirmation button is unavailable.');
  }
  await clickBossLocator(cityBox.locator('button').nth(confirmIndex), page, Math.min(remainingTime(deadline), 5000));
  await waitForBossFilterSettle(frame, deadline);
  await cityBox.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) });
  const confirmed = await waitForBossProvinceSelectionState(frame, desiredValues, deadline);
  if (confirmed.panelVisible || confirmed.evidenceConflict || !bossProvinceSelectionStateMatchesValues(confirmed, desiredValues)) {
    throw new Error(`Boss city selection did not match the requested province set after confirmation (expected: ${desiredValues.join('、')}; observed: ${confirmed.provinces.join('、') || '(none)'}).`);
  }
  return {
    status: 'applied',
    provinces: [...confirmed.provinces].sort(),
    subdivisionPolicy: 'all',
  };
}

async function clearBossResidualCityApplicationFilter(
  page: Page,
  frame: Frame,
  deadline: number,
): Promise<void> {
  const trigger = frame.locator('.city-wrap .city, .city-wrap .square').first();
  const cityBox = frame.locator('.city-wrap .city-box').first();
  if (!await cityBox.isVisible().catch(() => false)) {
    await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
    try {
      await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
    } catch {
      // Immediately after the page-level reset, the first pointer interaction
      // can be consumed while the city picker hydrates. Retry the same narrow
      // open action once; continuing without an inspectable panel is unsafe.
      await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
      await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
    }
  }

  // The page's “清除” action can clear its internal checkmarks while leaving a
  // stale province summary open. Selecting the native “全国” baseline instead
  // both removes the geographic restriction and reliably commits/closes it.
  const options = cityBox.locator('.dropdown-province > li');
  const nationalIndexes = await options.evaluateAll((items) => items.flatMap((item, index) => (
    (item.textContent ?? '').replace(/\s+/g, ' ').trim() === '全国' ? [index] : []
  )));
  if (nationalIndexes.length !== 1) {
    throw new Error(`Boss city selector must expose exactly one 全国 baseline option while resetting filters; found ${nationalIndexes.length}.`);
  }
  await clickBossLocator(options.nth(nationalIndexes[0]!), page, Math.min(remainingTime(deadline), 5000));
  await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);

  const nationalSelected = await options.evaluateAll((elements, nationalIndex) => elements.some((element, index) => {
    const item = element as HTMLElement;
    const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
    return index === nationalIndex && (/status1|checked|active/.test(checkbox?.className ?? '')
      || Boolean(item.querySelector<HTMLInputElement>('input')?.checked));
  }), nationalIndexes[0]!);
  if (!nationalSelected) {
    throw new Error('Boss city selector did not select 全国 while resetting filters.');
  }

  const confirmIndexes = await cityBox.locator('button').evaluateAll((buttons) => buttons.flatMap((button, index) => (
    /确定|确认|完成/.test((button.textContent ?? '').replace(/\s+/g, ' ').trim()) ? [index] : []
  )));
  if (confirmIndexes.length !== 1) {
    throw new Error(`Boss city selector must expose exactly one confirmation control while resetting filters; found ${confirmIndexes.length}.`);
  }
  await clickBossLocator(cityBox.locator('button').nth(confirmIndexes[0]!), page, Math.min(remainingTime(deadline), 5000));
  await cityBox.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) });
  await waitForBossFilterSettle(frame, deadline);
}

async function applyBossJobScopeApplicationFilter(
  page: Page,
  frame: Frame,
  value: string,
  deadline: number,
): Promise<void> {
  const current = await readBossSelectedJob(page, deadline).catch(() => '');
  const selector = frame.locator('.search-job-list-C .ui-dropmenu-label, .search-job-list-C .search-current-job').first();
  await clickBossLocator(selector, page, Math.min(remainingTime(deadline), 5000));
  const options = frame.locator('.search-job-list-C .ui-dropmenu-list li');
  const matches = await options.evaluateAll((elements, target) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    return elements.flatMap((element, index) => {
      const item = element as HTMLElement;
      const label = normalize(item.textContent);
      const optionValue = normalize(item.getAttribute('data-id')) || normalize(item.getAttribute('data-value')) || normalize(item.getAttribute('ka')) || label;
      return label === target || optionValue === target ? [{ index, label, selected: /\bactive\b/.test(item.className), disabled: /\bdisabled\b/.test(item.className) }] : [];
    });
  }, value);
  if (matches.length !== 1) {
    throw new Error(`Boss job scope ${value} matched ${matches.length} controls.`);
  }
  const target = matches[0]!;
  if (target.disabled) {
    throw new Error(`Boss job scope is disabled: ${value}`);
  }
  if (!target.selected || current !== target.label) {
    await clickBossLocator(options.nth(target.index), page, Math.min(remainingTime(deadline), 5000));
  } else {
    await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  }
  const selected = await options.nth(target.index).evaluate((element) => /\bactive\b/.test(element.className));
  if (!selected) {
    throw new Error('Boss job scope target option did not become selected.');
  }
}

function readBossTextApplicationFilterValues(
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): string[] {
  const rawValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  const values = rawValues.map((item) => isRecord(item)
    ? normalizeBossApplicationFilterValue(item.value)
    : normalizeBossApplicationFilterValue(item)).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`Boss application filter ${condition.fieldId} requires unique non-empty text values.`);
  }
  return values;
}

async function applyBossCompanyApplicationFilter(
  page: Page,
  frame: Frame,
  values: string[],
  deadline: number,
): Promise<void> {
  const input = frame.locator('input.input-text[placeholder*="公司"]').first();
  await input.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const expected = values.join(' ');
  await typeBossLocatorSequentially(input, page, expected, remainingTime(deadline), { replaceExisting: true });
  const actual = normalizeText(await input.inputValue({ timeout: Math.min(remainingTime(deadline), 3000) }));
  if (actual !== expected) {
    throw new Error('Boss company filter did not retain the requested text.');
  }
  await runBossFrameAction(frame, () => input.press('Enter', { timeout: Math.min(remainingTime(deadline), 3000) })).catch(() => undefined);
  await waitForBossFilterSettle(frame, deadline);
}

async function applyBossTokenDialogApplicationFilter(
  page: Page,
  frame: Frame,
  values: string[],
  deadline: number,
): Promise<void> {
  const fieldId = 'major';
  const label = '专业';
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  const trigger = bossMoreFilterItemLocator(frame, label);
  await trigger.scrollIntoViewIfNeeded({ timeout: Math.min(remainingTime(deadline), 3000) });
  await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
  const dialog = frame.locator('.dialog-wrap:visible').last();
  await dialog.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const input = dialog.locator('input.ipt, input[placeholder*="名称"], input[placeholder*="证书"]').first();
  await input.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });

  for (const value of values) {
    await typeBossLocatorSequentially(input, page, value, remainingTime(deadline), { replaceExisting: true });
    await frame.waitForTimeout(Math.min(250, remainingTime(deadline))).catch(() => undefined);
    const matches = await dialog.locator('li').evaluateAll((elements, target) => {
      const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return elements.flatMap((element, index) => isVisible(element) && normalize(element.textContent) === target ? [index] : []);
    }, value);
    if (matches.length !== 1) {
      throw new Error(`Boss ${fieldId} option ${value} matched ${matches.length} dialog entries.`);
    }
    const target = dialog.locator('li').nth(matches[0]!);
    await clickBossLocator(target, page, Math.min(remainingTime(deadline), 5000));
    const selected = await target.evaluate((element) => {
      const item = element as HTMLElement;
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      return /(?:selected|active|checked|status1)/.test(item.className)
        || /(?:selected|active|checked|status1)/.test(checkbox?.className ?? '')
        || Boolean(item.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')?.checked);
    });
    if (!selected) {
      throw new Error(`Boss ${fieldId} dialog entry did not become selected: ${value}`);
    }
  }

  const confirmIndex = await dialog.locator('button').evaluateAll((buttons) => buttons.findIndex((button) => {
    const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    return !/取消|关闭/.test(text) && /确定|确认|完成/.test(text);
  }));
  if (confirmIndex < 0) {
    throw new Error(`Boss ${fieldId} dialog confirmation button is unavailable.`);
  }
  await clickBossLocator(dialog.locator('button').nth(confirmIndex), page, Math.min(remainingTime(deadline), 5000));
  await dialog.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) });
  await waitForBossFilterSettle(frame, deadline);
}

async function applyBossSchoolNatureApplicationFilter(
  frame: Frame,
  values: string[],
  deadline: number,
): Promise<void> {
  const config = bossInlineApplicationFiltersByFieldId.school_nature;
  if (!config) {
    throw new Error('Boss school nature filter configuration is unavailable.');
  }

  const root = frame.locator(config.rootSelector).first();
  await root.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const options = root.locator(config.optionSelector);
  const optionStates = await options.evaluateAll((elements) => elements.map((element, index) => {
    const option = element as HTMLElement;
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const input = option.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
      ?? option.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
    return {
      index,
      label: normalize(option.textContent),
      selected: Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(option.className),
      disabled: Boolean(input?.disabled) || /\bdisabled\b/i.test(option.className),
    };
  }).filter((item) => item.label));
  const labels = optionStates.map((option) => option.label);
  if (new Set(labels).size !== labels.length) {
    throw new Error('Boss school nature filter contains duplicate visible option labels.');
  }

  const desired = new Set(values);
  for (const value of desired) {
    const option = optionStates.find((item) => item.label === value);
    if (!option) {
      throw new Error(`Boss school nature option is not available: ${value}`);
    }
    if (option.disabled) {
      throw new Error(`Boss school nature option is disabled: ${value}`);
    }
  }

  const defaultOption = optionStates.find((item) => item.label === '不限');
  if (desired.has('不限')) {
    if (!defaultOption) {
      throw new Error('Boss school nature default option 不限 is unavailable.');
    }
    if (!defaultOption.selected || optionStates.some((item) => item.label !== '不限' && item.selected)) {
      await clickBossLocator(options.nth(defaultOption.index), frame.page(), Math.min(remainingTime(deadline), 5000));
    }
  } else {
    if (defaultOption?.selected) {
      await clickBossLocator(options.nth(defaultOption.index), frame.page(), Math.min(remainingTime(deadline), 5000));
    }
    for (const option of optionStates) {
      if (option.label === '不限') {
        continue;
      }
      const mustSelect = desired.has(option.label);
      if (option.selected !== mustSelect) {
        await clickBossLocator(options.nth(option.index), frame.page(), Math.min(remainingTime(deadline), 5000));
      }
    }
  }

  await waitForBossFilterSettle(frame, deadline);
  const actual = await options.evaluateAll((elements) => elements.flatMap((element) => {
    const option = element as HTMLElement;
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const input = option.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
      ?? option.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
    const selected = Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(option.className);
    return selected ? [normalize(option.textContent)] : [];
  }).filter(Boolean));
  const actualSet = new Set(actual);
  const matches = actualSet.size === desired.size && [...desired].every((value) => actualSet.has(value));
  if (!matches) {
    throw new Error(`Boss school nature filter did not match the requested set. Expected ${values.join('、')}; observed ${actual.join('、') || '(none)'}.`);
  }
}

async function applyBossToggleApplicationFilter(
  page: Page,
  frame: Frame,
  fieldId: string,
  value: boolean,
  deadline: number,
): Promise<void> {
  const selector = bossToggleApplicationFilterSelectorByFieldId[fieldId];
  if (!selector) {
    throw new Error(`Unsupported Boss toggle application filter: ${fieldId}`);
  }

  const root = frame.locator(selector).first();
  await root.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  const current = await root.evaluate((element) => {
    const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) {
      throw new Error('Boss toggle checkbox is missing.');
    }
    return { checked: input.checked, disabled: input.disabled };
  });
  if (current.disabled) {
    throw new Error(`Boss toggle application filter is disabled: ${fieldId}`);
  }
  if (current.checked === value) {
    return;
  }

  await clickBossLocator(root, page, Math.min(remainingTime(deadline), 5000));
  await frame.waitForFunction(
    ({ targetSelector, expected }) => document.querySelector<HTMLInputElement>(`${targetSelector} input[type="checkbox"]`)?.checked === expected,
    { targetSelector: selector, expected: value },
    { timeout: Math.min(remainingTime(deadline), 5000), polling: 100 },
  );
  await waitForBossFilterSettle(frame, deadline);
}

export interface BossViewedCandidatePolicyResult {
  desiredChecked: boolean;
  changed: boolean;
}

async function locateBossRecentViewedToggle(
  frame: Frame,
  deadline: number,
): Promise<{ root: Locator; checked: boolean }> {
  const selector = bossToggleApplicationFilterSelectorByFieldId.filter_recent_viewed;
  const roots = frame.locator(selector);
  const visibleControls = await roots.evaluateAll((elements) => {
    const isVisible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    return elements.flatMap((element, index) => {
      if (!isVisible(element)) return [];
      const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!input) {
        throw new Error('Boss recent-viewed filter checkbox is missing.');
      }
      return [{ index, checked: input.checked, disabled: input.disabled }];
    });
  });
  if (visibleControls.length !== 1) {
    throw new Error(`Boss recent-viewed filter must expose exactly one visible control; found ${visibleControls.length}.`);
  }
  const control = visibleControls[0]!;
  if (control.disabled) {
    throw new Error('Boss recent-viewed filter is disabled.');
  }
  const root = roots.nth(control.index);
  await root.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  return { root, checked: control.checked };
}

async function armBossRecentViewedSearchRefresh(frame: Frame): Promise<string> {
  const token = `boss-recent-viewed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await frame.evaluate((nextToken) => {
    type RefreshState = {
      token: string;
      resultMutation: boolean;
      loadingSeen: boolean;
      observer: MutationObserver;
    };
    const host = window as Window & { __autorecruitBossRecentViewedRefresh?: RefreshState };
    host.__autorecruitBossRecentViewedRefresh?.observer.disconnect();

    const isRelatedToResults = (node: Node): boolean => {
      const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
      if (!element) return false;
      const relatedSelector = '.geek-info-card, [data-boss-search-result-version], .geek-list, .geek-info-list, .geek-list-wrap, .search-result-list';
      if (element.matches(relatedSelector) || element.closest(relatedSelector)) return true;
      const className = element instanceof HTMLElement ? element.className : '';
      return typeof className === 'string'
        && /(?:geek|search).*(?:result|list|card)|(?:result|list|card).*(?:geek|search)/i.test(className);
    };

    const state: RefreshState = {
      token: nextToken,
      resultMutation: false,
      loadingSeen: false,
      observer: new MutationObserver((mutations) => {
        if (state.resultMutation) return;
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'data-boss-search-result-version') {
            state.resultMutation = true;
            return;
          }
          if (isRelatedToResults(mutation.target)
            || [...mutation.addedNodes, ...mutation.removedNodes].some(isRelatedToResults)) {
            state.resultMutation = true;
            return;
          }
        }
      }),
    };
    state.observer.observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    host.__autorecruitBossRecentViewedRefresh = state;
  }, token);
  return token;
}

async function clearBossRecentViewedSearchRefresh(frame: Frame, token: string): Promise<void> {
  await frame.evaluate((expectedToken) => {
    type RefreshState = { token: string; observer: MutationObserver };
    const host = window as Window & { __autorecruitBossRecentViewedRefresh?: RefreshState };
    if (host.__autorecruitBossRecentViewedRefresh?.token === expectedToken) {
      host.__autorecruitBossRecentViewedRefresh.observer.disconnect();
      delete host.__autorecruitBossRecentViewedRefresh;
    }
  }, token).catch(() => undefined);
}

async function waitForBossRecentViewedSearchRefresh(
  frame: Frame,
  token: string,
  deadline: number,
): Promise<void> {
  try {
    const observed = await frame.waitForFunction((expectedToken) => {
      type RefreshState = {
        token: string;
        resultMutation: boolean;
        loadingSeen: boolean;
      };
      const host = window as Window & { __autorecruitBossRecentViewedRefresh?: RefreshState };
      const state = host.__autorecruitBossRecentViewedRefresh;
      if (!state || state.token !== expectedToken) return undefined;

      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const isLoading = /(?:加载中|正在加载|加载资料)/.test(bodyText);
      state.loadingSeen ||= isLoading;
      const hasLoadError = /数据加载异常/.test(bodyText);
      const hasCards = document.querySelectorAll('.geek-info-card').length > 0;
      const hasExplicitEmpty = /暂无|没有|未找到|无相关|搜索使用方法/.test(bodyText) && !isLoading;
      if (hasLoadError) return { hasLoadError: true };
      if (!hasCards && !hasExplicitEmpty) return undefined;
      return state.resultMutation || (state.loadingSeen && !isLoading)
        ? { hasLoadError: false }
        : undefined;
    }, token, { timeout: remainingTime(deadline), polling: 100 });
    const result = await observed.jsonValue() as { hasLoadError: boolean };
    if (result.hasLoadError) {
      throw new Error('Boss search reported a data-loading error after changing the recent-viewed filter.');
    }
  } catch (error) {
    if (error instanceof Error && /Boss search reported a data-loading error/.test(error.message)) {
      throw error;
    }
    throw new Error('Boss recent-viewed filter changed, but no new search-result refresh was observed before the search deadline.');
  } finally {
    await clearBossRecentViewedSearchRefresh(frame, token);
  }
}

export async function applyBossViewedCandidatePolicy(
  page: Page,
  includeViewedCandidates: boolean,
  deadline = createSearchDeadline(),
): Promise<BossViewedCandidatePolicyResult> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const desiredChecked = !includeViewedCandidates;
  const control = await locateBossRecentViewedToggle(frame, deadline);
  if (control.checked === desiredChecked) {
    return { desiredChecked, changed: false };
  }

  // Arm immediately before the pointer click. The pace remains part of this
  // action, but is performed before observation so background page activity
  // during the human-like delay cannot be mistaken for this filter refresh.
  await waitBossActionPaceWithinDeadline(page, deadline);
  const refreshToken = await armBossRecentViewedSearchRefresh(frame);
  try {
    await clickBossLocator(control.root, page, Math.min(remainingTime(deadline), 5000), { pace: false });
    await frame.waitForFunction(
      ({ expected }) => document.querySelector<HTMLInputElement>('.high_search_checkbox[ka="search_change_view_resume"] input[type="checkbox"]')?.checked === expected,
      { expected: desiredChecked },
      { timeout: Math.min(remainingTime(deadline), 5000), polling: 100 },
    );
    await waitForBossRecentViewedSearchRefresh(frame, refreshToken, deadline);
  } catch (error) {
    await clearBossRecentViewedSearchRefresh(frame, refreshToken);
    throw error;
  }

  const after = await locateBossRecentViewedToggle(frame, deadline);
  if (after.checked !== desiredChecked) {
    throw new Error(`Boss recent-viewed filter did not reach the requested state: ${String(desiredChecked)}.`);
  }
  return { desiredChecked, changed: true };
}

export async function applyBossSearchSortPolicy(
  page: Page,
  policy: SearchSortPolicy,
  deadline = createSearchDeadline(),
): Promise<{ policy: SearchSortPolicy; changed: boolean }> {
  if (policy === 'platform-default') return { policy, changed: false };

  const frame = await waitForBossSearchFrame(page, deadline);
  const labels = frame.locator('.search-label');
  const matches: Locator[] = [];
  const count = await labels.count();
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (!await label.isVisible().catch(() => false)) continue;
    if (normalizeText(await label.innerText().catch(() => '')) === '匹配度优先') matches.push(label);
  }
  if (matches.length !== 1) {
    throw new Error(`Boss sort-postcondition-failed: expected one visible "匹配度优先" control, found ${matches.length}.`);
  }

  const target = matches[0]!;
  const activeBefore = /\bactive\b|\bselected\b/.test(await target.getAttribute('class').catch(() => '') ?? '');
  if (activeBefore) return { policy, changed: false };

  await clickBossControlNatively(page, target, remainingTime(deadline), {
    deadline,
    beforeClick: async () => {
      const freshFrame = await waitForBossSearchFrame(page, deadline);
      const freshLabels = freshFrame.locator('.search-label');
      const freshMatches: Locator[] = [];
      const freshCount = await freshLabels.count();
      for (let index = 0; index < freshCount; index += 1) {
        const label = freshLabels.nth(index);
        if (await label.isVisible().catch(() => false)
          && normalizeText(await label.innerText().catch(() => '')) === '匹配度优先') {
          freshMatches.push(label);
        }
      }
      if (freshMatches.length !== 1) throw new Error('Boss sort target changed before click.');
    },
  });

  await frame.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.search-label'))
    .filter((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === '匹配度优先')
    .some((element) => /\bactive\b|\bselected\b/.test(element.className)), undefined, {
      timeout: remainingTime(deadline),
      polling: 100,
    });
  const activeLabels = await frame.locator('.search-label').evaluateAll((elements) => elements
    .filter((element) => /\bactive\b|\bselected\b/.test(element.className))
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()));
  if (activeLabels.length !== 1 || activeLabels[0] !== '匹配度优先') {
    throw new Error('Boss sort-postcondition-failed: 匹配度优先 did not become active.');
  }
  return { policy, changed: true };
}

async function clickBossMoreApplicationFilter(
  page: Page,
  frame: Frame,
  fieldId: string,
  value: string,
  deadline: number,
): Promise<void> {
  const label = bossMoreApplicationFilterLabelByFieldId[fieldId];
  if (!label) {
    throw new Error(`Unsupported Boss dropdown application filter: ${fieldId}`);
  }

  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);

  const filterItem = bossMoreFilterItemLocator(frame, label);
  await filterItem.scrollIntoViewIfNeeded({ timeout: Math.min(remainingTime(deadline), 3000) });
  if (value === '不限') {
    const alreadyDefault = await filterItem.evaluate((element, targetLabel) => {
      const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
      const visibleText = normalize(element.textContent);
      const placeholder = normalize(element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder'));
      const hiddenValue = normalize(element.querySelector<HTMLInputElement>('input[type="hidden"]')?.value);
      const defaultSelectText = normalize(element.querySelector<HTMLElement>('.defalut-select')?.textContent);
      return visibleText === targetLabel
        || defaultSelectText === targetLabel
        || (placeholder === targetLabel && (hiddenValue === '' || hiddenValue === '-1' || hiddenValue === '0'));
    }, label).catch(() => false);
    if (alreadyDefault) {
      return;
    }
  }

  await clickBossLocator(filterItem, page, Math.min(remainingTime(deadline), 5000));
  const targetIndex = bossMoreApplicationFilterIndexByLabel.get(label);
  await frame.waitForFunction(
    ({ targetLabel, index }) => {
      const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const readLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
        ? '薪资区间'
        : normalize(
          element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
          || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
          || element.querySelector<HTMLElement>('.defalut-select')?.textContent
          || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
          || element.querySelector<HTMLElement>('.ipt')?.textContent
          || element.textContent,
        );
      const items = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'))
        .filter(isVisible);
      const item = index === undefined
        ? items.find((element) => readLabel(element) === targetLabel)
        : items[index] ?? items.find((element) => readLabel(element) === targetLabel);
      return Boolean(item?.querySelector('.dropdown-menu, .options'));
    },
    { targetLabel: label, index: targetIndex },
    { timeout: Math.min(remainingTime(deadline), 5000), polling: 100 },
  );

  const target = await frame.evaluate(({ targetLabel, targetValue, index }) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
      ? '薪资区间'
      : normalize(
        element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
        || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
        || element.querySelector<HTMLElement>('.defalut-select')?.textContent
        || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
        || element.querySelector<HTMLElement>('.ipt')?.textContent
        || element.textContent,
      );
    const allItems = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'));
    const items = allItems.filter(isVisible);
    const item = index === undefined
      ? items.find((element) => readLabel(element) === targetLabel)
      : items[index] ?? items.find((element) => readLabel(element) === targetLabel);
    if (!item) {
      throw new Error(`Boss filter item not found: ${targetLabel}`);
    }

    const allOptions = Array.from(item.querySelectorAll<HTMLElement>('.dropdown-menu li, .options li'));
    const optionIndex = allOptions.findIndex((element) => isVisible(element) && normalize(element.textContent) === targetValue);
    if (optionIndex < 0) {
      throw new Error(`Boss filter option not found: ${targetLabel}=${targetValue}`);
    }
    const option = allOptions[optionIndex]!;

    if (/\b(selected|active|checked)\b/i.test(option.className)) {
      return { selected: true, itemIndex: allItems.indexOf(item), optionIndex };
    }

    return { selected: false, itemIndex: allItems.indexOf(item), optionIndex };
  }, {
    targetLabel: label,
    targetValue: value,
    index: targetIndex,
  });

  if (!target.selected) {
    const option = frame.locator('.more-filter-container .filter-2-item')
      .nth(target.itemIndex)
      .locator('.dropdown-menu li, .options li')
      .nth(target.optionIndex);
    await clickBossLocator(option, page, Math.min(remainingTime(deadline), 5000));
  }

  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);

  if (!target.selected) {
    await waitForBossFilterSettle(frame, deadline);
  }
}

async function openBossMoreFilterDropdown(
  page: Page,
  frame: Frame,
  label: string,
  deadline: number,
): Promise<void> {
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);

  const filterItem = bossMoreFilterItemLocator(frame, label);
  await filterItem.scrollIntoViewIfNeeded({ timeout: Math.min(remainingTime(deadline), 3000) });
  const menu = filterItem.locator('.dropdown-menu, .options').first();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clickBossLocator(filterItem, page, Math.min(remainingTime(deadline), 5000));
    try {
      await menu.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
      return;
    } catch (error) {
      lastError = error;
      await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
    }
  }
  throw lastError instanceof Error
    ? new Error(`Boss filter dropdown did not open: ${label}. ${lastError.message}`)
    : new Error(`Boss filter dropdown did not open: ${label}.`);
}

async function clickBossExpectedSalaryBoundary(
  frame: Frame,
  label: string,
  value: string,
  boundaryIndex: 0 | 1,
  deadline: number,
): Promise<void> {
  const targetIndex = bossMoreApplicationFilterIndexByLabel.get(label);
  const target = await frame.evaluate(({ targetLabel, targetValue, targetBoundaryIndex, index }) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const readLabel = (element: HTMLElement): string => element.querySelector('.salary-container')
      ? '薪资区间'
      : normalize(
        element.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder')
        || element.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent
        || element.querySelector<HTMLElement>('.defalut-select')?.textContent
        || element.querySelector<HTMLElement>('.major-input-ui')?.textContent
        || element.querySelector<HTMLElement>('.ipt')?.textContent
        || element.textContent,
      );
    const items = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'))
      .filter(isVisible);
    const item = index === undefined
      ? items.find((element) => readLabel(element) === targetLabel)
      : items[index] ?? items.find((element) => readLabel(element) === targetLabel);
    if (!item) {
      throw new Error(`Boss salary filter item not found: ${targetLabel}`);
    }

    const optionLists = Array.from(item.querySelectorAll<HTMLElement>('ul.options, .dropdown-menu ul'))
      .filter(isVisible);
    const optionList = optionLists[targetBoundaryIndex];
    if (!optionList) {
      throw new Error(`Boss salary ${targetBoundaryIndex === 0 ? 'min' : 'max'} option list not found.`);
    }

    const options = Array.from(optionList.querySelectorAll<HTMLElement>('li, .option')).filter(isVisible);
    const optionIndex = options.findIndex((element) => normalize(element.textContent) === targetValue);
    if (optionIndex < 0) {
      throw new Error(`Boss salary option not found: ${targetValue}`);
    }
    const option = options[optionIndex]!;
    if (/\b(disabled)\b/i.test(option.className)) {
      throw new Error(`Boss salary option is disabled: ${targetValue}`);
    }

    return {
      itemIndex: Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item')).indexOf(item),
      optionListIndex: targetBoundaryIndex,
      optionIndex: Array.from(optionList.querySelectorAll<HTMLElement>('li, .option')).indexOf(option),
    };
  }, {
    targetLabel: label,
    targetValue: value,
    targetBoundaryIndex: boundaryIndex,
    index: targetIndex,
  });
  const option = frame.locator('.more-filter-container .filter-2-item')
    .nth(target.itemIndex)
    .locator('ul.options, .dropdown-menu ul')
    .nth(target.optionListIndex)
    .locator('li, .option')
    .nth(target.optionIndex);
  try {
    await clickBossLocator(option, frame.page(), Math.min(remainingTime(deadline), 5000));
  } catch {
    await clickBossControlWithDomEvent(frame.page(), option, Math.min(remainingTime(deadline), 5000));
  }
}

async function applyBossExpectedSalaryApplicationFilter(
  page: Page,
  frame: Frame,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  deadline: number,
): Promise<void> {
  const input = readBossExpectedSalaryRangeInput(condition);
  const label = '薪资区间';

  await openBossMoreFilterDropdown(page, frame, label, deadline);
  await clickBossExpectedSalaryBoundary(frame, label, input.min, 0, deadline);
  await frame.waitForTimeout(Math.min(150, remainingTime(deadline))).catch(() => undefined);
  await clickBossExpectedSalaryBoundary(frame, label, input.max, 1, deadline);
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);
  await waitForBossFilterSettle(frame, deadline);
}

async function clickBossAgePreset(frame: Frame, value: string, deadline: number): Promise<boolean> {
  const root = frame.locator('.age-select').first();
  const options = root.locator('.age-item, .custom');
  const matches = await options.evaluateAll((elements, targetValue) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return elements.flatMap((element, index) => isVisible(element) && normalize(element.textContent) === targetValue ? [index] : []);
  }, value);
  if (matches.length === 0) return false;
  if (matches.length > 1) throw new Error(`Boss age preset ${value} matched ${matches.length} controls.`);
  await clickBossLocator(options.nth(matches[0]!), frame.page(), Math.min(remainingTime(deadline), 5000));
  return true;
}

async function openBossAgeCustomDropdown(frame: Frame, deadline: number): Promise<void> {
  const clicked = await clickBossAgePreset(frame, '自定义', deadline);
  if (!clicked) {
    throw new Error('Boss age custom trigger not found.');
  }

  await frame.waitForFunction(
    () => {
      const root = document.querySelector<HTMLElement>('.age-custom');
      if (!root) {
        return false;
      }
      const style = window.getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0
        && root.querySelectorAll('.dropdown-wrap').length >= 2;
    },
    undefined,
    { timeout: Math.min(remainingTime(deadline), 3000), polling: 100 },
  );
}

async function clickBossAgeCustomBoundary(
  frame: Frame,
  value: string,
  boundaryIndex: 0 | 1,
  deadline: number,
): Promise<void> {
  const dropdown = frame.locator('.age-custom .dropdown-wrap').nth(boundaryIndex);
  await clickBossLocator(dropdown, frame.page(), Math.min(remainingTime(deadline), 3000));
  await frame.waitForFunction(
    (targetBoundaryIndex) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const dropdowns = Array.from(document.querySelectorAll<HTMLElement>('.age-custom .dropdown-wrap')).filter(isVisible);
      return Boolean(dropdowns[targetBoundaryIndex]?.querySelector('.dropdown-menu, .options'));
    },
    boundaryIndex,
    { timeout: Math.min(remainingTime(deadline), 3000), polling: 100 },
  );

  const target = await frame.evaluate(({ targetBoundaryIndex, targetValue }) => {
    const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const dropdowns = Array.from(document.querySelectorAll<HTMLElement>('.age-custom .dropdown-wrap')).filter(isVisible);
    const dropdown = dropdowns[targetBoundaryIndex];
    if (!dropdown) {
      throw new Error(`Boss age ${targetBoundaryIndex === 0 ? 'min' : 'max'} dropdown not found.`);
    }

    const options = Array.from(dropdown.querySelectorAll<HTMLElement>('.dropdown-menu li, .options li, li')).filter(isVisible);
    const optionIndex = options.findIndex((element) => normalize(element.textContent) === targetValue);
    if (optionIndex < 0) {
      throw new Error(`Boss age option not found: ${targetValue}`);
    }
    const option = options[optionIndex]!;
    if (/\b(disabled)\b/i.test(option.className)) {
      throw new Error(`Boss age option is disabled: ${targetValue}`);
    }

    return Array.from(dropdown.querySelectorAll<HTMLElement>('.dropdown-menu li, .options li, li')).indexOf(option);
  }, {
    targetBoundaryIndex: boundaryIndex,
    targetValue: value,
  });
  const option = dropdown.locator('.dropdown-menu li, .options li, li').nth(target);
  try {
    await clickBossLocator(option, frame.page(), Math.min(remainingTime(deadline), 3000));
  } catch {
    await clickBossControlWithDomEvent(frame.page(), option, Math.min(remainingTime(deadline), 3000));
  }
}

async function applyBossAgeApplicationFilter(
  page: Page,
  frame: Frame,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  deadline: number,
): Promise<void> {
  const input = readBossAgeRangeInput(condition);
  const presetLabel = buildBossAgePresetLabel(input);
  if (presetLabel) {
    const clicked = await clickBossAgePreset(frame, presetLabel, deadline);
    if (!clicked) {
      throw new Error(`Boss age preset option not found: ${presetLabel}`);
    }
    await waitForBossFilterSettle(frame, deadline);
    return;
  }

  const min = normalizeBossAgeDropdownBoundary(input.minRaw, input.min, 'min');
  const max = normalizeBossAgeDropdownBoundary(input.maxRaw, input.max, 'max');
  await openBossAgeCustomDropdown(frame, deadline);
  await clickBossAgeCustomBoundary(frame, min, 0, deadline);
  await frame.waitForTimeout(Math.min(150, remainingTime(deadline))).catch(() => undefined);
  await clickBossAgeCustomBoundary(frame, max, 1, deadline);
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);
  await waitForBossFilterSettle(frame, deadline);
}

export interface BossSearchFilterState {
  keyword: string;
  jobScope: string;
  jobScopeIndex: number;
  city: string;
  cityOptions?: string[];
  company: string;
  inline: Record<'education' | 'school_nature' | 'work_years' | 'age', string[]>;
  more: Record<string, string>;
  toggles: Record<'filter_recent_viewed' | 'no_colleague_resume_exchange', boolean>;
}

async function snapshotBossSearchFilterState(
  page: Page,
  deadline = createSearchDeadline(),
): Promise<BossSearchFilterState> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const customSliderLabels = Object.fromEntries(Object.entries(bossCustomSliderConfigByFieldId).map(([fieldId, configItem]) => [
    fieldId,
    Object.fromEntries(configItem.values.map((entry) => [String(entry.raw), entry.label])),
  ]));
  const snapshot = await frame.evaluate(({ moreLabels, customSliderLabels: sliderLabels }) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const selectedLabels = (rootSelector: string, optionSelector: string): string[] => {
      const root = document.querySelector<HTMLElement>(rootSelector);
      if (!root) {
        return [];
      }
      return Array.from(root.querySelectorAll<HTMLElement>(optionSelector)).flatMap((option) => {
        const input = option.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
          ?? option.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
        const selected = Boolean(input?.checked) || /\b(active|selected|checked)\b/i.test(option.className);
        const label = normalize(option.textContent);
        return selected && label ? [label] : [];
      });
    };
    const more: Record<string, string> = {};
    const moreItems = Array.from(document.querySelectorAll<HTMLElement>('.more-filter-container .filter-2-item'));
    for (const [index, item] of moreItems.entries()) {
      const label = moreLabels[index]
        ?? normalize(item.querySelector<HTMLInputElement>('input[placeholder]')?.getAttribute('placeholder') || item.textContent);
      const selectedValue = item.querySelector('.salary-container')
        ? normalize(item.querySelector<HTMLElement>('.double-select-gray-inner-flip')?.textContent)
        : normalize(
          item.querySelector<HTMLElement>('.dropdown-select span.ipt, .defalut-select, .major-input-ui, .input-inner-container > span')?.textContent
          || item.querySelector<HTMLInputElement>('input[type="hidden"]')?.value,
        );
      if (label && selectedValue && selectedValue !== label) more[label] = selectedValue;
    }
    const readToggle = (selector: string): boolean => Boolean(document.querySelector<HTMLInputElement>(`${selector} input[type="checkbox"]`)?.checked);
    const selectedAgeLabels = selectedLabels('.age-select', '.age-item, .custom');
    const customSliderRange = (rootSelector: string, fieldId: 'education' | 'work_years'): string | undefined => {
      const root = document.querySelector<HTMLElement>(rootSelector);
      const slider = root?.querySelector<HTMLElement>('.ui-slider');
      const raw = normalize(root?.querySelector<HTMLInputElement>('input[type="hidden"]')?.value);
      const values = raw.split(',').map((value) => Number.parseInt(value.trim(), 10));
      if (!slider || values.length !== 2 || values.some((value) => !Number.isInteger(value) || value < 1)) return undefined;
      const customActive = /(?:active|selected)/.test(root?.querySelector<HTMLElement>('.degree-select-custom-label, .custom')?.className ?? '')
        || !/custom-slider-disabled/.test(slider.className);
      if (!customActive && values[0] === 1) return undefined;
      const labels = values.map((value) => sliderLabels[fieldId]?.[String(value)]);
      return labels.every(Boolean)
        ? `custom:${labels.join('-')}`
        : `custom:raw:${values[0]}-${values[1]}`;
    };
    const ageCustom = document.querySelector<HTMLElement>('.age-select .age-custom');
    const ageCustomVisible = Boolean(ageCustom) && (() => {
      const style = window.getComputedStyle(ageCustom!);
      const rect = ageCustom!.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })();
    const ageCustomValues = Array.from(ageCustom?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') ?? [])
      .map((input) => normalize(input.value))
      .filter(Boolean);
    const keywordInput = document.querySelector<HTMLInputElement>('input.search-input, .search-input');
    const jobScope = document.querySelector<HTMLElement>('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label');
    const jobOptions = Array.from(document.querySelectorAll<HTMLElement>('.search-job-list-C .ui-dropmenu-list li'));
    const activeJobScopeIndex = jobOptions.findIndex((option) => /\bactive\b/i.test(option.className));
    const cityInput = document.querySelector<HTMLInputElement>('.city-wrap .search-city-kw input');
    const citySummary = document.querySelector<HTMLElement>('.city-wrap .city');
    const cityOptions = Array.from(document.querySelectorAll<HTMLElement>('.city-wrap .dropdown-province > li')).flatMap((item) => {
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      const selected = /status1|checked|active/.test(checkbox?.className ?? '') || Boolean(item.querySelector<HTMLInputElement>('input')?.checked);
      return selected ? [normalize(item.textContent)] : [];
    }).filter(Boolean);
    const companyInput = document.querySelector<HTMLInputElement>('input.input-text[placeholder*="公司"]');
    return {
      keyword: normalize(keywordInput?.value || keywordInput?.textContent),
      jobScope: normalize(jobScope?.textContent),
      jobScopeIndex: activeJobScopeIndex,
      city: (() => {
        const summary = normalize(citySummary?.textContent);
        return /^(?:城市|请选择|全国)$/.test(summary) ? normalize(cityInput?.value) : summary || normalize(cityInput?.value);
      })(),
      cityOptions,
      company: normalize(companyInput?.value),
      inline: {
        education: customSliderRange('.degree-ui', 'education') ? [customSliderRange('.degree-ui', 'education')!] : selectedLabels('.degree-ui', '.degree-item, .degree-select-custom-label'),
        school_nature: selectedLabels('.school-ui', '.degree-item, .checkbox-text'),
        work_years: customSliderRange('.experience-select', 'work_years') ? [customSliderRange('.experience-select', 'work_years')!] : selectedLabels('.experience-select', '.exp-item, .custom'),
        age: ageCustomVisible && ageCustomValues.length >= 2
          ? [`custom:${ageCustomValues.join('-')}`]
          : selectedAgeLabels,
      },
      more,
      toggles: {
        filter_recent_viewed: readToggle('.high_search_checkbox[ka="search_change_view_resume"]'),
        no_colleague_resume_exchange: readToggle('.high_search_checkbox[ka="search_change_exchange_resume"]'),
      },
    };
  }, { moreLabels: bossMoreApplicationFilterLabelsInOrder, customSliderLabels });
  const provinceSelection = await readBossProvinceSelectionState(frame);
  return {
    ...snapshot,
    city: provinceSelection.summary,
    cityOptions: provinceSelection.provinces,
  };
}

function isBossSearchFilterBaseline(state: BossSearchFilterState): boolean {
  const isUnlimited = (values: string[]) => values.length === 0 || (values.length === 1 && values[0] === '不限');
  const moreValues = Object.values(state.more);
  return isUnlimited(state.inline.education)
    && isUnlimited(state.inline.school_nature)
    && isUnlimited(state.inline.work_years)
    && isUnlimited(state.inline.age)
    && !state.toggles.filter_recent_viewed
    && !state.toggles.no_colleague_resume_exchange
    && !state.city
    && (state.cityOptions?.length ?? 0) === 0
    && !state.company
    && moreValues.every((value) => value === '不限');
}

function isBossUnlimitedFilterValue(values: readonly string[]): boolean {
  return values.length === 0 || (values.length === 1 && values[0] === '不限');
}

function bossRequestedApplicationFilterFieldIds(conditions: readonly SearchCondition[]): Set<string> {
  return new Set(conditions.flatMap((condition) => (
    isApplicationFilterCondition(condition) ? [condition.fieldId] : []
  )));
}

/**
 * Return a reason only for residual state that cannot be removed through the
 * typed, field-local actions. Job scope, province selection, and toggles have
 * safe incremental clear paths and therefore never force a reset themselves.
 */
function bossDirectSearchResetReason(
  state: BossSearchFilterState,
  conditions: readonly SearchCondition[],
): string | undefined {
  const requested = bossRequestedApplicationFilterFieldIds(conditions);
  if (!requested.has('company') && state.company) {
    return 'unrequested company text cannot be cleared safely by a field-local Boss action';
  }

  for (const fieldId of ['education', 'school_nature', 'work_years', 'age'] as const) {
    if (!requested.has(fieldId) && !isBossUnlimitedFilterValue(state.inline[fieldId])) {
      return `unrequested ${fieldId} filter is not at its unrestricted baseline`;
    }
  }

  const requestedMoreLabels = new Set(
    [...requested]
      .map((fieldId) => bossMoreApplicationFilterLabelByFieldId[fieldId])
      .filter((label): label is string => Boolean(label)),
  );
  for (const [label, value] of Object.entries(state.more)) {
    if (!requestedMoreLabels.has(label) && value && value !== '不限') {
      return `unrequested ${label} filter cannot be cleared safely by a field-local Boss action`;
    }
  }

  return undefined;
}

function isBossApplicationFilterSatisfiedByState(
  state: BossSearchFilterState,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): boolean {
  if (condition.fieldId === 'job_scope') {
    return state.jobScope === readBossApplicationFilterSingleValue(condition);
  }
  if (condition.fieldId === 'city') {
    return sameBossStringSet(state.cityOptions ?? [], readBossApplicationFilterMultiValues(condition));
  }
  if (condition.fieldId === 'education' || condition.fieldId === 'work_years') {
    const customRange = readBossCustomSliderRange(condition);
    if (customRange) {
      const actual = state.inline[condition.fieldId]
        .find((entry) => entry.startsWith('custom:'))
        ?.slice('custom:'.length)
        .split('-');
      return actual?.length === 2
        && actual[0] === customRange.minLabel
        && actual[1] === customRange.maxLabel;
    }
    return sameBossStringSet(state.inline[condition.fieldId], [readBossApplicationFilterSingleValue(condition)]);
  }
  if (condition.fieldId === 'school_nature') {
    return sameBossStringSet(state.inline.school_nature, readBossApplicationFilterMultiValues(condition));
  }
  if (condition.fieldId === 'age') {
    const input = readBossAgeRangeInput(condition);
    const expected = {
      ...(input.min === undefined ? {} : { min: input.min }),
      ...(input.max === undefined ? {} : { max: input.max }),
    };
    return sameBossSearchValue(expected, readBossSemanticAge(state.inline.age));
  }
  if (condition.fieldId === 'filter_recent_viewed' || condition.fieldId === 'no_colleague_resume_exchange') {
    return state.toggles[condition.fieldId] === readBossApplicationFilterToggleValue(condition);
  }
  if (condition.fieldId === 'company') {
    return state.company === readBossTextApplicationFilterValues(condition).join(' ');
  }

  const label = bossMoreApplicationFilterLabelByFieldId[condition.fieldId];
  if (!label) {
    return false;
  }
  if (condition.fieldId === 'expected_salary') {
    const expected = readBossExpectedSalaryRangeInput(condition);
    const actual = normalizeText(state.more[label]).replace(/\s+/g, '');
    const normalizedExpected = `${expected.min}-${expected.max}`.replace(/\s+/g, '');
    return actual === normalizedExpected;
  }
  if (condition.fieldId === 'major') {
    return state.more[label] === readBossTextApplicationFilterValues(condition).join(' ');
  }
  return state.more[label] === readBossApplicationFilterSingleValue(condition);
}

async function isBossApplicationFilterSatisfied(
  page: Page,
  state: BossSearchFilterState,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  deadline: number,
): Promise<boolean> {
  if (condition.fieldId === 'job_scope') {
    const frame = await waitForBossSearchFrame(page, deadline);
    return bossActiveJobScopeMatchesValue(
      await readBossActiveJobScopeOption(frame),
      readBossApplicationFilterSingleValue(condition),
    );
  }
  if (condition.fieldId !== 'city') {
    return isBossApplicationFilterSatisfiedByState(state, condition);
  }
  const frame = await waitForBossSearchFrame(page, deadline);
  const selection = await readBossProvinceSelectionState(frame);
  if (selection.evidenceConflict) {
    throw new Error(`Boss closed city state has conflicting summary and province evidence (summary: ${selection.summary || '(empty)'}, provinces: ${selection.provinces.join('、') || '(none)'}).`);
  }
  return bossProvinceSelectionStateMatchesValues(
    selection,
    readBossApplicationFilterMultiValues(condition),
  );
}

async function applyBossDirectSearchConditionIfNeeded(
  page: Page,
  condition: SearchCondition,
  deadline: number,
  changedFields: string[],
  alreadySatisfiedFields: string[],
): Promise<void> {
  const fieldId = isApplicationFilterCondition(condition) ? condition.fieldId : condition.kind;
  if (isApplicationFilterCondition(condition)) {
    const before = await snapshotBossSearchFilterState(page, deadline);
    if (await isBossApplicationFilterSatisfied(page, before, condition, deadline)) {
      alreadySatisfiedFields.push(fieldId);
      return;
    }
  }

  const result = await applyBossSearchCondition(page, condition, deadline);
  if (result.status !== 'applied') {
    const fieldLabel = isApplicationFilterCondition(condition) ? ` ${condition.fieldId}` : '';
    throw new Error(`Boss direct search condition ${condition.kind}${fieldLabel} failed: ${result.message ?? result.status}`);
  }

  if (isApplicationFilterCondition(condition)) {
    const after = await snapshotBossSearchFilterState(page, deadline);
    if (!await isBossApplicationFilterSatisfied(page, after, condition, deadline)) {
      throw new Error(`Boss direct search condition ${condition.fieldId} did not reach its requested postcondition.`);
    }
  }
  changedFields.push(fieldId);
}

export function assertBossSearchFilterStateRestorable(state: BossSearchFilterState): void {
  if (state.city || state.company) {
    throw new Error('Boss live verification cannot safely restore a pre-existing city or company filter yet. Clear it manually before running verification.');
  }
  if (!isBossSearchFilterBaseline({
    ...state,
    keyword: '',
    jobScope: bossUnrestrictedJobName,
    jobScopeIndex: 0,
  })) {
    throw new Error('Boss live verification cannot safely restore a pre-existing non-baseline search filter yet. Clear filters manually before running verification.');
  }
}

async function selectBossJobScopeBySnapshot(
  page: Page,
  state: Pick<BossSearchFilterState, 'jobScope' | 'jobScopeIndex'>,
  deadline: number,
): Promise<void> {
  const frame = await waitForBossSearchFrame(page, deadline);
  if (state.jobScopeIndex < 0) {
    throw new Error('Boss search job scope does not expose a unique active option for restore.');
  }
  const current = await readBossSelectedJob(page, deadline);
  if (current === state.jobScope) {
    return;
  }

  const label = frame.locator('.search-job-list-C .ui-dropmenu-label, .search-job-list-C .search-current-job').first();
  await clickBossLocator(label, page, Math.min(remainingTime(deadline), 5000));
  const options = frame.locator('.search-job-list-C .ui-dropmenu-list li');
  const optionCount = await options.count();
  if (state.jobScopeIndex >= optionCount) {
    throw new Error('Boss search job scope options changed before restore.');
  }
  await clickBossLocator(options.nth(state.jobScopeIndex), page, Math.min(remainingTime(deadline), 5000));
  const restored = await readBossSelectedJob(page, deadline);
  if (restored !== state.jobScope) {
    throw new Error('Boss search job scope did not restore to the original value.');
  }
}

function assertBossEquivalentSearchFilterState(
  expected: BossSearchFilterState,
  actual: BossSearchFilterState,
): void {
  const normalizeValues = (values: string[]) => [...values].sort();
  const sameInline = (Object.keys(expected.inline) as Array<keyof BossSearchFilterState['inline']>)
    .every((key) => JSON.stringify(normalizeValues(expected.inline[key])) === JSON.stringify(normalizeValues(actual.inline[key])));
  const sameMore = JSON.stringify(expected.more) === JSON.stringify(actual.more);
  const sameToggles = expected.toggles.filter_recent_viewed === actual.toggles.filter_recent_viewed
    && expected.toggles.no_colleague_resume_exchange === actual.toggles.no_colleague_resume_exchange;
  if (
    expected.keyword !== actual.keyword
    || expected.jobScope !== actual.jobScope
    || expected.jobScopeIndex !== actual.jobScopeIndex
    || expected.city !== actual.city
    || JSON.stringify([...(expected.cityOptions ?? [])].sort()) !== JSON.stringify([...(actual.cityOptions ?? [])].sort())
    || expected.company !== actual.company
    || !sameInline
    || !sameMore
    || !sameToggles
  ) {
    throw new Error('Boss search filters did not restore to the exact entry state.');
  }
}

export interface BossSearchConditionVerification {
  fieldId: string;
  expected: unknown;
  actual: unknown;
  verified: boolean;
  evidence: 'keyword-input' | 'active-job-option' | 'selected-city-options' | 'custom-slider' | 'selected-option' | 'age-range' | 'toggle' | 'text-input' | 'unselected';
  message?: string;
}

export interface BossDirectSearchVerificationSummary {
  keyword: string;
  conditions: BossSearchConditionVerification[];
  conditionsVerified: number;
  resultTotal: number;
  resultTotalSource: 'page';
}

function sameBossSearchValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readBossSemanticAge(value: string[]): { min?: number; max?: number } | undefined {
  const raw = value.find((entry) => entry.startsWith('custom:'))?.slice('custom:'.length) ?? value[0];
  if (!raw || raw === '不限') return {};
  const numbers = raw.match(/\d+/g)?.map((entry) => Number.parseInt(entry, 10)) ?? [];
  if (numbers.length < 2 || numbers.some((entry) => !Number.isFinite(entry))) return undefined;
  return { min: numbers[0], max: numbers[1] };
}

function verificationEntry(
  fieldId: string,
  expected: unknown,
  actual: unknown,
  evidence: BossSearchConditionVerification['evidence'],
  message: string,
): BossSearchConditionVerification {
  const verified = sameBossSearchValue(expected, actual);
  return { fieldId, expected, actual, verified, evidence, ...(verified ? {} : { message }) };
}

/**
 * Read the page's direct-search state as business values. This intentionally
 * does not expose transient UI tokens such as `custom:35-45` in its result.
 */
export async function readBossDirectSearchVerificationSummary(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  deadline: number,
  expectedRecentViewed?: boolean,
  options: { includeResult?: boolean } = {},
): Promise<BossDirectSearchVerificationSummary> {
  const state = await snapshotBossSearchFilterState(page, deadline);
  const entries: BossSearchConditionVerification[] = [];
  const expectedKeyword = normalizeText(keyword);
  entries.push(verificationEntry(
    'keyword', expectedKeyword, state.keyword, 'keyword-input',
    `Boss direct search postcondition mismatch for keyword: expected ${expectedKeyword}, observed ${state.keyword || '(empty)'}.`,
  ));
  if (expectedRecentViewed !== undefined && state.toggles.filter_recent_viewed !== expectedRecentViewed) {
    entries.push(verificationEntry(
      'filter_recent_viewed', expectedRecentViewed, state.toggles.filter_recent_viewed, 'toggle',
      `Boss direct search postcondition mismatch for filter_recent_viewed: expected ${String(expectedRecentViewed)}, observed ${String(state.toggles.filter_recent_viewed)}.`,
    ));
  } else if (expectedRecentViewed !== undefined) {
    entries.push(verificationEntry('filter_recent_viewed', expectedRecentViewed, state.toggles.filter_recent_viewed, 'toggle', ''));
  }

  const frame = await waitForBossSearchFrame(page, deadline);
  const provinceSelection = await readBossProvinceSelectionState(frame);
  if (provinceSelection.evidenceConflict) {
    throw new Error(`Boss direct-search verification found conflicting city summary and province evidence (summary: ${provinceSelection.summary || '(empty)'}, provinces: ${provinceSelection.provinces.join('、') || '(none)'}).`);
  }
  if (provinceSelection.panelVisible) {
    throw new Error('Boss direct-search verification requires the city panel to remain collapsed.');
  }
  for (const condition of conditions) {
    if (!isApplicationFilterCondition(condition)) continue;

    if (condition.fieldId === 'job_scope') {
      const expected = readBossApplicationFilterSingleValue(condition);
      const active = await frame.locator('.search-job-list-C .ui-dropmenu-list li').evaluateAll((options) => {
        const option = options.find((element) => /\bactive\b/.test(element.className));
        if (!option) return undefined;
        const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
        return {
          label: normalize(option.textContent),
          value: normalize(option.getAttribute('data-id')) || normalize(option.getAttribute('data-value')) || normalize(option.getAttribute('ka')),
        };
      });
      const actual = active && (expected === active.value ? active.value : active.label);
      entries.push(verificationEntry(
        condition.fieldId, expected, actual, 'active-job-option',
        `Boss direct search postcondition mismatch for job_scope: expected ${expected}, observed ${active?.label ?? '(empty)'}.`,
      ));
      continue;
    }

    if (condition.fieldId === 'city') {
      const expected = readBossApplicationFilterMultiValues(condition).sort();
      const actual = bossProvinceSelectionStateMatchesValues(provinceSelection, expected)
        ? expected
        : [...provinceSelection.provinces].sort();
      entries.push(verificationEntry(
        condition.fieldId, expected, actual, 'selected-city-options',
        `Boss direct search postcondition mismatch for city: expected ${expected.join(', ')}, observed ${actual.join(', ') || '(empty)'}.`,
      ));
      continue;
    }

    if (condition.fieldId === 'education' || condition.fieldId === 'work_years') {
      const customRange = readBossCustomSliderRange(condition);
      const rawActual = state.inline[condition.fieldId];
      if (customRange) {
        const expected = { min: customRange.minLabel, max: customRange.maxLabel };
        const customActual = rawActual.find((entry) => entry.startsWith('custom:'))?.slice('custom:'.length).split('-');
        const actual = customActual && customActual.length === 2
          ? { min: customActual[0], max: customActual[1] }
          : rawActual[0];
        entries.push(verificationEntry(
          condition.fieldId, expected, actual, 'custom-slider',
          `Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected.min}-${expected.max}, observed ${rawActual.join(', ') || '(empty)'}.`,
        ));
      } else {
        const expected = readBossApplicationFilterSingleValue(condition);
        const actual = rawActual.includes(expected) ? expected : rawActual[0];
        entries.push(verificationEntry(
          condition.fieldId, expected, actual, 'selected-option',
          `Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected}, observed ${rawActual.join(', ') || '(empty)'}.`,
        ));
      }
      continue;
    }

    if (condition.fieldId === 'school_nature') {
      const expected = readBossApplicationFilterMultiValues(condition).sort();
      const actual = [...state.inline.school_nature].sort();
      entries.push(verificationEntry(
        condition.fieldId, expected, actual, 'selected-option',
        `Boss direct search postcondition mismatch for school_nature: expected ${expected.join(', ')}, observed ${actual.join(', ') || '(empty)'}.`,
      ));
      continue;
    }

    if (condition.fieldId === 'age') {
      const expectedRange = readBossAgeRangeInput(condition);
      const expected = {
        ...(expectedRange.min === undefined ? {} : { min: expectedRange.min }),
        ...(expectedRange.max === undefined ? {} : { max: expectedRange.max }),
      };
      const actual = readBossSemanticAge(state.inline.age);
      entries.push(verificationEntry(
        condition.fieldId, expected, actual, 'age-range',
        `Boss direct search postcondition mismatch for age: expected ${JSON.stringify(expected)}, observed ${state.inline.age.join(', ') || '(empty)'}.`,
      ));
      continue;
    }

    if (condition.fieldId === 'filter_recent_viewed' || condition.fieldId === 'no_colleague_resume_exchange') {
      const expected = readBossApplicationFilterToggleValue(condition);
      entries.push(verificationEntry(
        condition.fieldId, expected, state.toggles[condition.fieldId], 'toggle',
        `Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${String(expected)}, observed ${String(state.toggles[condition.fieldId])}.`,
      ));
      continue;
    }

    if (condition.fieldId === 'company') {
      const expected = readBossTextApplicationFilterValues(condition).join(' ');
      entries.push(verificationEntry(
        condition.fieldId, expected, state.company, 'text-input',
        `Boss direct search postcondition mismatch for company: expected ${expected}, observed ${state.company || '(empty)'}.`,
      ));
      continue;
    }

    const label = bossMoreApplicationFilterLabelByFieldId[condition.fieldId];
    if (label) {
      const expected = readBossApplicationFilterSingleValue(condition);
      entries.push(verificationEntry(
        condition.fieldId, expected, state.more[label], 'selected-option',
        `Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected}, observed ${state.more[label] ?? '(unselected)'}.`,
      ));
    }
  }

  const candidatePositionRequested = conditions.some((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'candidate_position_requirement'
  ));
  if (!candidatePositionRequested) {
    entries.push(verificationEntry(
      'candidate_position_requirement', undefined, state.more['牛人职位要求'], 'unselected',
      `Boss direct search postcondition mismatch for candidate_position_requirement: expected unselected, observed ${state.more['牛人职位要求']}.`,
    ));
  }

  const result = options.includeResult === false
    ? { resultTotal: 0, resultTotalSource: 'page' as const }
    : await readBossSearchConditionResultTotal(page, { deadline });
  return {
    keyword: expectedKeyword,
    conditions: entries,
    conditionsVerified: entries.filter((entry) => entry.verified).length,
    resultTotal: result.resultTotal,
    resultTotalSource: result.resultTotalSource,
  };
}

async function assertBossDirectSearchPostcondition(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  deadline: number,
  expectedRecentViewed?: boolean,
): Promise<BossDirectSearchVerificationSummary> {
  const summary = await readBossDirectSearchVerificationSummary(
    page,
    keyword,
    conditions,
    deadline,
    expectedRecentViewed,
  );
  const failed = summary.conditions.find((entry) => !entry.verified);
  if (failed) {
    throw new Error(failed.message ?? `Boss direct search postcondition mismatch for ${failed.fieldId}.`);
  }
  return summary;
}

async function resetBossSearchFilters(
  page: Page,
  deadline = createSearchDeadline(),
): Promise<void> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const reset = frame.locator('.reset-btn[ka="search_reset_search_params"], .reset-btn').first();
  await reset.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  await clickBossLocator(reset, page, Math.min(remainingTime(deadline), 5000));
  await waitForBossFilterSettle(frame, deadline);

  let after = await snapshotBossSearchFilterState(page, deadline);
  if (after.inline.education[0]?.startsWith('custom:') || after.inline.work_years[0]?.startsWith('custom:')) {
    for (const selector of ['.degree-ui .degree-item', '.experience-select .exp-item']) {
      const options = frame.locator(selector);
      const defaultIndex = await options.evaluateAll((elements) => elements.findIndex((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === '不限'));
      if (defaultIndex >= 0) {
        await clickBossLocator(options.nth(defaultIndex), page, Math.min(remainingTime(deadline), 5000));
      }
    }
    await waitForBossFilterSettle(frame, deadline);
    after = await snapshotBossSearchFilterState(page, deadline);
  }
  if (after.city || (after.cityOptions?.length ?? 0) > 0) {
    await clearBossResidualCityApplicationFilter(page, frame, deadline);
    after = await snapshotBossSearchFilterState(page, deadline);
  }
  if (!isBossSearchFilterBaseline(after)) {
    throw new Error('Boss reset filters did not restore the search-filter baseline.');
  }
}

async function restoreBossSearchFilterState(
  page: Page,
  state: BossSearchFilterState,
  deadline = createSearchDeadline(),
): Promise<void> {
  assertBossSearchFilterStateRestorable(state);
  await resetBossSearchFilters(page, deadline);
  await selectBossJobScopeBySnapshot(page, state, deadline);
  await applyBossSearchKeyword(page, state.keyword, deadline);
  const restored = await snapshotBossSearchFilterState(page, deadline);
  assertBossEquivalentSearchFilterState(state, restored);
}

async function applyBossSupportedApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  deadline: number,
): Promise<void> {
  if (!bossSupportedApplicationFilterFieldIds.has(condition.fieldId)) {
    throw new Error(`Unsupported Boss application filter: ${condition.fieldId}`);
  }

  const frame = await waitForBossSearchFrame(page, deadline);

  if (condition.fieldKind === 'salaryRange' || condition.fieldId === 'expected_salary') {
    await applyBossExpectedSalaryApplicationFilter(page, frame, condition, deadline);
    return;
  }

  if (condition.fieldKind === 'numberRange' || condition.fieldId === 'age') {
    await applyBossAgeApplicationFilter(page, frame, condition, deadline);
    return;
  }

  if (condition.fieldKind === 'multiSelect') {
    const values = readBossApplicationFilterMultiValues(condition);
    if (condition.fieldId === 'school_nature') {
      await applyBossSchoolNatureApplicationFilter(frame, values, deadline);
      return;
    }
    if (condition.fieldId === 'city') {
      await applyBossCityApplicationFilter(page, frame, values, deadline);
      return;
    }
    throw new Error(`Boss multi-select application filter is not implemented for ${condition.fieldId}.`);
  }

  if (condition.fieldKind === 'toggle') {
    await applyBossToggleApplicationFilter(page, frame, condition.fieldId, readBossApplicationFilterToggleValue(condition), deadline);
    return;
  }

  if (condition.fieldKind !== 'singleSelect') {
    if (condition.fieldKind === 'textInput') {
      const values = readBossTextApplicationFilterValues(condition);
      if (condition.fieldId === 'company') {
        await applyBossCompanyApplicationFilter(page, frame, values, deadline);
        return;
      }
      if (condition.fieldId === 'major') {
        await applyBossTokenDialogApplicationFilter(page, frame, values, deadline);
        return;
      }
    }
    throw new Error(`Boss application filter ${condition.fieldId} does not support ${condition.fieldKind} replay.`);
  }

  const customRange = readBossCustomSliderRange(condition);
  if (customRange) {
    await applyBossCustomSliderApplicationFilter(page, frame, condition.fieldId, customRange, deadline);
    return;
  }

  const value = readBossApplicationFilterSingleValue(condition);

  if (condition.fieldId in bossInlineApplicationFiltersByFieldId) {
    await clickBossInlineApplicationFilter(frame, condition.fieldId, value, deadline);
    return;
  }

  if (condition.fieldId === 'job_scope') {
    await applyBossJobScopeApplicationFilter(page, frame, value, deadline);
    return;
  }

  await clickBossMoreApplicationFilter(page, frame, condition.fieldId, value, deadline);
}

async function applyBossApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
  deadline: number,
): Promise<SearchConditionApplyResult> {
  try {
    await applyBossSupportedApplicationFilter(page, condition, deadline);
    return {
      platform: 'boss',
      condition,
      status: 'applied',
    };
  } catch (error) {
    await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
    return {
      platform: 'boss',
      condition,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function applyBossSearchCondition(
  page: Page,
  condition: SearchCondition,
  deadline = createSearchDeadline(),
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: 'boss',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for boss yet.`,
    };
  }

  return applyBossApplicationFilter(page, condition, deadline);
}

async function readBossSearchConditionResultTotal(page: Page, options?: SearchWaitOptions): Promise<{
  resultTotal: number;
  resultTotalSource: 'page';
}> {
  const deadline = createSearchDeadline(options);
  const frame = await waitForBossSearchFrame(page, deadline);
  await waitForBossSearchResults(frame, deadline);
  return {
    resultTotal: await frame.locator('.geek-info-card').count().catch(() => 0),
    resultTotalSource: 'page',
  };
}

function hashBossCandidateText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function resolveBossCandidateId(snapshot: BossCandidateCardSnapshot): string {
  if (snapshot.dataExpect) {
    return snapshot.dataExpect;
  }

  if (snapshot.dataJid && snapshot.dataLid) {
    return `${snapshot.dataJid}_${snapshot.dataLid}`;
  }

  if (snapshot.dataJid) {
    return snapshot.dataJid;
  }

  if (snapshot.dataLid) {
    return snapshot.dataLid;
  }

  return `boss-card-${hashBossCandidateText(`${snapshot.href}\n${snapshot.text}\n${snapshot.html}`)}`;
}

function assertBossCandidateCardWindow(snapshots: BossCandidateCardSnapshot[]): void {
  const ids = snapshots.map((snapshot) => {
    if (!snapshot.dataExpect && !snapshot.dataJid && !snapshot.dataLid) {
      throw new Error(
        `Boss candidate card at visible index ${snapshot.searchResultIndex} has no stable candidate identity; refusing to parse or operate it.`,
      );
    }
    return resolveBossCandidateId(snapshot);
  });
  const duplicateIds = ids.filter((candidateId, index) => ids.indexOf(candidateId) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Boss candidate list contains duplicate stable IDs inside the first twenty: ${[...new Set(duplicateIds)].join(', ')}`,
    );
  }
}

function parseBossCandidateName(lines: string[]): string | undefined {
  const isNameLike = (line: string) => /^[\u4e00-\u9fa5A-Za-z·*]{1,24}$/.test(line)
    && !/热搜|刚刚活跃|活跃|联系|职位|期望|城市|院校|不感兴趣|收藏|转发|举报|不合适/.test(line);
  return lines.slice(0, 3).find(isNameLike) ?? lines.find(isNameLike);
}

function readBossLineAfterLabel(lines: string[], label: string, offset: number): string | undefined {
  const labelIndex = lines.findIndex((line) => line === label);
  if (labelIndex < 0) {
    return undefined;
  }

  const value = lines[labelIndex + offset];
  return value && !/^(期望城市|期望|职位|院校|联系Ta|不感兴趣)$/.test(value) ? value : undefined;
}

function parseBossCandidateTitle(lines: string[]): string | undefined {
  const firstPositionTitle = readBossLineAfterLabel(lines, '职位', 2);
  if (firstPositionTitle) {
    return firstPositionTitle;
  }

  const titleLine = lines.find((line) => /职位\s+/.test(line))
    ?? lines.find((line) => /电工|运维|维修|工程师|主管|经理|专员|技工|操作工|装配|弱电|强电/.test(line));
  return titleLine?.replace(/^职位\s*/, '').trim() || undefined;
}

function parseBossCandidateCompany(lines: string[]): string | undefined {
  const firstPositionCompany = readBossLineAfterLabel(lines, '职位', 1);
  if (firstPositionCompany) {
    return firstPositionCompany;
  }

  const companyLine = lines.find((line) => /公司|集团|科技|物业|管理|服务|工程|实业|商贸|股份|有限|酒店|医院|学校|工厂|厂/.test(line));
  return companyLine?.replace(/^职位\s*/, '').trim() || undefined;
}

function parseBossCandidateSnapshots(snapshots: BossCandidateCardSnapshot[]): CandidateListItem[] {
  const candidatesById = new Map<string, CandidateListItem>();

  for (const snapshot of snapshots) {
    const rawText = snapshot.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cardText = normalizeText(rawText);
    if (!cardText) {
      continue;
    }

    const candidateId = resolveBossCandidateId(snapshot);
    const lines = rawText
      .split(/\r?\n|[|｜]/)
      .map((line) => normalizeText(line))
      .filter(Boolean);

    candidatesById.set(candidateId, {
      candidateId,
      resumeUrl: snapshot.href && snapshot.href !== 'javascript:;' ? snapshot.href : undefined,
      name: parseBossCandidateName(lines),
      currentCompany: parseBossCandidateCompany(lines),
      currentTitle: parseBossCandidateTitle(lines),
      cardText,
      sourceText: [
        snapshot.href,
        snapshot.html,
        `data-jid=${snapshot.dataJid}`,
        `data-expect=${snapshot.dataExpect}`,
        `data-lid=${snapshot.dataLid}`,
        `data-contact=${snapshot.dataContact}`,
        `data-elitegeek=${snapshot.dataEliteGeek}`,
        `data-itemid=${snapshot.dataItemId}`,
      ].filter(Boolean).join(' '),
      searchResultIndex: snapshot.searchResultIndex,
    });
  }

  return Array.from(candidatesById.values())
    .sort((left, right) => (left.searchResultIndex ?? 0) - (right.searchResultIndex ?? 0));
}

async function collectBossCandidateSnapshots(page: Page, deadline: number): Promise<BossCandidateCardSnapshot[]> {
  const frame = await waitForBossSearchFrame(page, deadline);
  await waitForBossSearchResults(frame, deadline);

  return frame.locator('.geek-info-card').evaluateAll((cards) => cards.map((card, index) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const anchor = card.querySelector<HTMLAnchorElement>('a[ka="search_click_open_resume"]')
      ?? card.querySelector<HTMLAnchorElement>('a[data-expect], a[data-jid], a[data-lid]');
    const visibleText = card instanceof HTMLElement ? card.innerText : card.textContent;

    return {
      text: (visibleText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      html: card.outerHTML,
      href: anchor?.getAttribute('href') ?? anchor?.href ?? '',
      dataJid: normalize(anchor?.getAttribute('data-jid')),
      dataExpect: normalize(anchor?.getAttribute('data-expect')),
      dataLid: normalize(anchor?.getAttribute('data-lid')),
      dataContact: normalize(anchor?.getAttribute('data-contact')),
      dataEliteGeek: normalize(anchor?.getAttribute('data-elitegeek')),
      dataItemId: normalize(anchor?.getAttribute('data-itemid')),
      searchResultIndex: index,
    };
  }));
}

async function extractBossCandidateList(page: Page, options?: SearchWaitOptions): Promise<{ candidates: CandidateListItem[] }> {
  const deadline = createSearchDeadline(options);
  const rawSnapshots = await collectBossCandidateSnapshots(page, deadline);
  // Slice before parsing, filtering, or Map-based deduplication.  A malformed
  // or repeated card therefore fails closed and can never cause card 21+ to
  // be promoted into the operation window.
  const snapshots = rawSnapshots.slice(0, BOSS_RAW_CANDIDATE_CARD_LIMIT);
  assertBossCandidateCardWindow(snapshots);
  return { candidates: parseBossCandidateSnapshots(snapshots) };
}

async function resolveBossCandidateAnchorIndex(page: Page, candidate: CandidateListItem, deadline: number): Promise<number> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const anchors = frame.locator('a[ka="search_click_open_resume"], a[data-expect], a[data-jid], a[data-lid]');
  const anchorCount = await anchors.count();
  if (anchorCount === 0) {
    throw new Error(`Could not open Boss resume detail for candidate ${candidate.candidateId}: no candidate cards are visible.`);
  }

  if (candidate.candidateId.startsWith('boss-card-')) {
    throw new Error(`Could not open Boss resume detail for candidate ${candidate.candidateId}: card has no stable Boss identity.`);
  }

  const matchedIndexes = await anchors.evaluateAll((elements, candidateId) => {
    return elements.flatMap((element, index) => {
      const dataExpect = element.getAttribute('data-expect') ?? '';
      const dataJid = element.getAttribute('data-jid') ?? '';
      const dataLid = element.getAttribute('data-lid') ?? '';

      return (dataExpect === candidateId
        || dataJid === candidateId
        || dataLid === candidateId
        || (dataJid && dataLid && `${dataJid}_${dataLid}` === candidateId)) ? [index] : [];
    });
  }, candidate.candidateId);

  if (matchedIndexes.length !== 1) {
    throw new Error(`Could not uniquely find Boss candidate card for ${candidate.candidateId}; matched ${matchedIndexes.length}.`);
  }

  return matchedIndexes[0]!;
}

async function openBossResumeDetail(
  _context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<Page> {
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  if (options) {
    if (await isBossResumeDetailVisible(searchPage)) {
      await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
    }
  } else {
    await closeExistingBossResumeDialog(searchPage, deadline);
  }
  await assertNoBossPurchaseChatDialog(searchPage, deadline);

  const frame = await waitForBossSearchFrame(searchPage, deadline);
  const targetIndex = await resolveBossCandidateAnchorIndex(searchPage, candidate, deadline);
  const candidateAnchor = frame.locator('a[ka="search_click_open_resume"], a[data-expect], a[data-jid], a[data-lid]').nth(targetIndex);
  const marker = `boss-detail-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await candidateAnchor.evaluate((element, input) => {
    const identifiers = [
      element.getAttribute('data-expect'),
      element.getAttribute('data-jid'),
      element.getAttribute('data-lid'),
    ].filter((value): value is string => Boolean(value));
    if (!identifiers.includes(input.candidateId)
      && !(identifiers.includes(input.candidateId.split('_')[0] ?? '') && identifiers.includes(input.candidateId.split('_')[1] ?? ''))) {
      throw new Error(`Boss detail target was replaced before marking candidate ${input.candidateId}.`);
    }
    element.setAttribute('data-autorecruit-boss-detail-target', input.marker);
  }, { candidateId: candidate.candidateId, marker });
  const markedAnchor = frame.locator(`[data-autorecruit-boss-detail-target="${marker}"]`);
  const safeClickTargetCandidates = markedAnchor.locator('.geek-info-detail:visible, .search-geek-info:visible, .card-inner:visible');
  const findTopLevelSafeClickTargetIndexes = async (): Promise<number[]> => safeClickTargetCandidates.evaluateAll((elements) => {
    const visible = (element: Element): boolean => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      && window.getComputedStyle(element).visibility !== 'hidden';
    const visibleElements = elements.filter(visible);
    return visibleElements
      .filter((element) => !visibleElements.some((other) => other !== element && other.contains(element)))
      .map((element) => elements.indexOf(element));
  });
  const initialSafeClickTargetIndexes = await findTopLevelSafeClickTargetIndexes();
  if (initialSafeClickTargetIndexes.length !== 1) {
    throw new Error(
      `Could not uniquely find a safe Boss detail click target for candidate ${candidate.candidateId}; found ${initialSafeClickTargetIndexes.length}.`,
    );
  }
  const clickTargetMarker = `${marker}-click`;
  await safeClickTargetCandidates.nth(initialSafeClickTargetIndexes[0]!).evaluate((element, expectedMarker) => {
    element.setAttribute('data-autorecruit-boss-detail-click-target', expectedMarker);
  }, clickTargetMarker);
  const markedSafeClickTarget = markedAnchor.locator(`[data-autorecruit-boss-detail-click-target="${clickTargetMarker}"]`);
  const assertSafeClickTargetStillCurrent = async (): Promise<void> => {
    const markedCount = await markedAnchor.count().catch(() => 0);
    if (markedCount !== 1) {
      throw new Error(`Boss detail target for candidate ${candidate.candidateId} was replaced before click; found ${markedCount}.`);
    }
    const identityMatches = await markedAnchor.evaluate((element, candidateId) => {
      const identifiers = [
        element.getAttribute('data-expect'),
        element.getAttribute('data-jid'),
        element.getAttribute('data-lid'),
      ].filter((value): value is string => Boolean(value));
      return identifiers.includes(candidateId)
        || (candidateId.includes('_')
          && identifiers.includes(candidateId.split('_')[0] ?? '')
          && identifiers.includes(candidateId.split('_')[1] ?? ''));
    }, candidate.candidateId).catch(() => false);
    if (!identityMatches) {
      throw new Error(`Boss detail target identity changed before clicking candidate ${candidate.candidateId}.`);
    }
    const currentTargetIndexes = await findTopLevelSafeClickTargetIndexes();
    if (currentTargetIndexes.length !== 1) {
      throw new Error(
        `Could not uniquely find a safe Boss detail click target for candidate ${candidate.candidateId}; found ${currentTargetIndexes.length}.`,
      );
    }
    const currentTopLevelTarget = safeClickTargetCandidates.nth(currentTargetIndexes[0]!);
    if (await currentTopLevelTarget.getAttribute('data-autorecruit-boss-detail-click-target') !== clickTargetMarker) {
      throw new Error(`Boss detail click target changed before clicking candidate ${candidate.candidateId}.`);
    }
    if (await markedSafeClickTarget.count().catch(() => 0) !== 1) {
      throw new Error(`Boss detail click target marker was lost before clicking candidate ${candidate.candidateId}.`);
    }
  };

  try {
    await assertSafeClickTargetStillCurrent();
    await clickBossControlNatively(searchPage, markedSafeClickTarget, remainingTime(deadline), {
      deadline,
      cleanupReserveMs: options?.cleanupReserveMs ?? 0,
      beforeClick: assertSafeClickTargetStillCurrent,
    });
    await waitForBossResumeDetailOrPurchase(searchPage, deadline, options?.cleanupReserveMs ?? 0);
    return searchPage;
  } finally {
    await candidateAnchor.evaluate((element, expectedMarker) => {
      if (element.getAttribute('data-autorecruit-boss-detail-target') === expectedMarker) {
        element.removeAttribute('data-autorecruit-boss-detail-target');
      }
      for (const child of element.querySelectorAll('[data-autorecruit-boss-detail-click-target]')) {
        if (child.getAttribute('data-autorecruit-boss-detail-click-target') === `${expectedMarker}-click`) {
          child.removeAttribute('data-autorecruit-boss-detail-click-target');
        }
      }
    }, marker).catch(() => undefined);
  }
}

export type BossSeenCandidateDetailFailureStage = 'card-resolve' | 'detail-open' | 'identity-verify' | 'detail-close';

export class BossSeenCandidateDetailError extends Error {
  readonly stage: BossSeenCandidateDetailFailureStage;
  readonly detailOpened: boolean;
  readonly detailIdentityVerified: boolean;
  readonly detailClosed: boolean;
  readonly fatalCloseFailure: boolean;

  constructor(input: {
    message: string;
    stage: BossSeenCandidateDetailFailureStage;
    detailOpened: boolean;
    detailIdentityVerified: boolean;
    detailClosed: boolean;
    fatalCloseFailure: boolean;
  }) {
    super(input.message);
    this.name = 'BossSeenCandidateDetailError';
    this.stage = input.stage;
    this.detailOpened = input.detailOpened;
    this.detailIdentityVerified = input.detailIdentityVerified;
    this.detailClosed = input.detailClosed;
    this.fatalCloseFailure = input.fatalCloseFailure;
  }
}

export interface BossSeenCandidateDetailVisitReceipt {
  candidateId: string;
  detailOpened: true;
  detailIdentityVerified: true;
  detailClosed: true;
}

/**
 * Opens one already-seen search card, verifies the live detail identity, and
 * closes the detail again. This is intentionally a read-only history-view
 * action: it never parses/persists a resume and never invokes forwarding or
 * contact controls.
 */
async function visitBossSeenCandidateDetail(
  searchPage: Page,
  candidate: CandidateListItem,
  options: CandidateProfileDetailOptions = { deadline: createResumeDetailDeadline() },
): Promise<BossSeenCandidateDetailVisitReceipt> {
  const deadline = options.deadline;
  let detailOpened = false;
  let detailIdentityVerified = false;
  let detailClosed = false;
  let closeAttempted = false;

  try {
    await assertNoBossPurchaseChatDialog(searchPage, deadline);
    await openBossResumeDetail(searchPage.context(), searchPage, candidate, options);
    detailOpened = true;
    await waitBossActionPaceWithinDeadline(searchPage, deadline, options.cleanupReserveMs ?? 0);
  } catch (error) {
    let closeError: unknown;
    const detailVisible = await isBossResumeDetailVisible(searchPage).catch(() => false);
    if ((detailOpened || detailVisible) && !closeAttempted) {
      closeAttempted = true;
      try {
        await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
        detailClosed = true;
      } catch (cleanupError) {
        closeError = cleanupError;
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stage: BossSeenCandidateDetailFailureStage = /Could not (?:open|uniquely find) Boss candidate card|card has no stable Boss identity|no candidate cards are visible/.test(errorMessage)
      ? 'card-resolve'
      : 'detail-open';
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail open failed for candidate ${candidate.candidateId}: ${errorMessage}${closeError ? `; close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}` : ''}`,
      stage,
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: Boolean(closeError) || error instanceof BossUnexpectedContactDialogError,
    });
  }

  try {
    await verifyBossResumeDetailIdentity(searchPage, candidate, deadline, options.cleanupReserveMs ?? 0);
    detailIdentityVerified = true;
    await waitBossActionPaceWithinDeadline(searchPage, deadline, options.cleanupReserveMs ?? 0);
  } catch (error) {
    // Identity failures are retryable, but the modal must still be closed once
    // before the next card is considered. A failed close leaves the page for
    // inspection and stops orchestration rather than clicking again.
    let closeError: unknown;
    if (!closeAttempted) {
      closeAttempted = true;
      try {
        await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
        detailClosed = true;
      } catch (cleanupError) {
        closeError = cleanupError;
      }
    }
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail identity verification failed for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}${closeError ? `; close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}` : ''}`,
      stage: 'identity-verify',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: Boolean(closeError),
    });
  }

  closeAttempted = true;
  try {
    await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
    detailClosed = true;
  } catch (error) {
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail close failed for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}`,
      stage: 'detail-close',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: true,
    });
  }

  if (!detailOpened || !detailIdentityVerified || !detailClosed) {
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail lifecycle was incomplete for candidate ${candidate.candidateId}.`,
      stage: 'detail-close',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: true,
    });
  }
  return {
    candidateId: candidate.candidateId,
    detailOpened: true,
    detailIdentityVerified: true,
    detailClosed: true,
  };
}

async function runBossPostOpenActions(
  page: Page,
  candidate: CandidateListItem,
  actions: CandidatePostOpenActions,
  options?: CandidateProfileDetailOptions,
): Promise<void> {
  const hasMode = actions.bossForwardMode !== undefined;
  const hasRecipient = actions.bossForwardRecipient !== undefined;
  if (hasMode !== hasRecipient) {
    throw new Error('Boss forward mode and recipient must be provided together.');
  }
  if (actions.bossForwardCcEmails !== undefined && !hasMode) {
    throw new Error('Boss forward CC requires a Boss forward mode and recipient.');
  }

  // Normal capture may pass the configured target through this hook for
  // compatibility/observability, while the workflow itself owns the durable
  // per-recipient pre-capture transaction. Never issue a second external send.
  if (actions.bossForwardTransactionManaged) return;

  if (actions.bossForwardMode && actions.bossForwardRecipient) {
    await forwardBossResume(
      page,
      candidate,
      actions.bossForwardMode,
      actions.bossForwardRecipient,
      actions.bossForwardActionMode,
      actions.bossForwardCcEmails,
      true,
      options,
    );
  }
}

export async function openBossLoginPage(page: Page): Promise<void> {
  await runBossPageAction(page, () => page.goto(bossLoginUrl, { waitUntil: 'domcontentloaded' }));
}

export async function closeBossResumeDetail(
  page: Page,
  _detailPage?: Page,
  _candidate?: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<void> {
  // Lightweight orchestration doubles used by offline tests expose no DOM
  // locator API. Real Boss pages always do; keep the adapter seam compatible
  // without weakening the strict browser-side postcondition below.
  if (typeof (page as Partial<Page>).locator !== 'function') return;
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  try {
    await closeBossResumeDetailStrict(page, deadline, {
      pace: false,
      cleanupReserveMs: options?.cleanupReserveMs,
    });
  } catch (error) {
    if (error instanceof BossResumeDetailCloseError) throw error;
    throw new BossResumeDetailCloseError(
      `Boss resume detail close failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export {
  applyBossSearchCondition,
  assertBossAuthenticated,
  bossChatSearchUrl,
  bossLoginUrl,
  closeExistingBossResumeDialog,
  discoverBossSearchFilters,
  extractBossCandidateList,
  forwardBossResume,
  openBossAuthenticatedHome,
  openBossDirectSearch,
  openBossResumeDetail,
  visitBossSeenCandidateDetail,
  openBossSubscribeSearch,
  parseBossResumeData,
  parseBossResumeDetail,
  prepareBossSearchConditionPage,
  readBossSearchConditionResultTotal,
  resetBossSearchFilters,
  restoreBossSearchFilterState,
  runBossPostOpenActions,
  snapshotBossSearchFilterState,
  waitForBossResumeDetailReady,
};
