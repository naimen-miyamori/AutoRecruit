import type { Frame, Locator, Page } from 'playwright';

import { config } from '../../../config.js';
import type {
  SavedSearchConditionIdentity,
  SavedSearchReference,
  SearchCondition,
  SearchConditionApplyResult,
  SearchConditionPlan,
  SearchConditionPlanExecutionResult,
  SearchConditionSaveResult,
} from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  applyBossDirectSearch,
  applyBossSearchSortPolicy,
  applyBossViewedCandidatePolicy,
  prepareBossSearchConditionPage,
  snapshotBossSearchFilterState,
  submitBossPreparedSearch,
  waitForBossSearchFrame,
} from './search-actions.js';
import { clickBossControlNatively, waitBossActionPaceWithinDeadline } from './context.js';
import { typeBossLocatorSequentially } from '../../../browser/pacing.js';
import {
  canonicalizeSavedSearchIdentityValue,
  fingerprintSavedSearchConditionIdentity,
  normalizeBossSavedSearchIdentity,
} from '../saved-search-identity.js';

const subscriptionCardSelector = '.subscribe-card-right [ka="search_change_subscribe_card"]';
const subscriptionRegionSelector = '.subscribe-card-right';
const subscriptionEditSelector = '.edit-btn, [ka="search_edit_subscribe_card"]';
const subscriptionCreateSelector = '[ka="search_subscribe_card"]';

type BossSearchDocument = Page | Frame;
type BossSearchFilterState = Awaited<ReturnType<typeof snapshotBossSearchFilterState>>;

export interface BossSavedSubscriptionCard {
  index: number;
  name: string;
  expectedKeyword: string;
  nativeId?: string;
  nativeJobId?: string;
  expectedJobScope?: string;
  labels: string[];
  summary: string;
  /** Platform-provided authoritative condition identity evidence, when exposed. */
  conditionFingerprint?: string;
}

interface InternalBossSavedSubscriptionCard extends BossSavedSubscriptionCard {
  /** Ephemeral in-page identity used only during one save mutation. */
  trackingToken?: string;
  /** Keyed labels exposed by the native Boss subscription component. */
  conditionLabels?: Record<string, string>;
  /** Conflicting DOM/native identity evidence must never authorize a click. */
  identityConflict?: boolean;
}

let subscriptionTrackingCounter = 0;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function bossSavedConditionIdentityFromState(state: BossSearchFilterState): SavedSearchConditionIdentity {
  return normalizeBossSavedSearchIdentity({
    jobScope: normalizeText(state.jobScope),
    city: normalizeText(state.city) || undefined,
    cityOptions: (state.cityOptions ?? []).map(normalizeText).filter(Boolean),
    company: normalizeText(state.company) || undefined,
    inline: Object.fromEntries(Object.entries(state.inline).map(([key, values]) => [
      key,
      values.map(normalizeText).filter(Boolean),
    ])),
    more: Object.fromEntries(Object.entries(state.more)
      .map(([key, value]) => [normalizeText(key), normalizeText(value)] as const)
      .filter(([key, value]) => Boolean(key && value))),
    toggles: Object.fromEntries(Object.entries(state.toggles)
      .map(([key, value]) => [normalizeText(key), Boolean(value)] as const)),
  });
}

export function fingerprintBossSavedConditions(identity: SavedSearchConditionIdentity | BossSearchFilterState): string {
  const normalized = 'keyword' in identity
    ? bossSavedConditionIdentityFromState(identity)
    : identity;
  return fingerprintSavedSearchConditionIdentity(normalized);
}

export function buildBossSavedSearchReference(
  name: string,
  state: BossSearchFilterState,
  nativeId?: string,
): SavedSearchReference {
  const conditionIdentity = bossSavedConditionIdentityFromState(state);
  return {
    version: 1,
    platform: 'boss',
    name: normalizeText(name),
    ...(nativeId ? { nativeId } : {}),
    expectedKeyword: normalizeText(state.keyword),
    conditionIdentity,
    conditionFingerprint: fingerprintBossSavedConditions(conditionIdentity),
  };
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function resolveDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function assertCompleteBossReference(target: SavedSearchReference): void {
  if (target.version !== 1 || target.platform !== 'boss') {
    throw new Error('Boss saved-reference-required: expected a versioned Boss saved-search reference.');
  }
  if (!normalizeText(target.name) || !normalizeText(target.expectedKeyword) || !normalizeText(target.conditionIdentity?.jobScope)) {
    throw new Error('Boss saved-reference-required: name, keyword, job scope, and complete condition identity are required.');
  }
  const derived = fingerprintBossSavedConditions(target.conditionIdentity);
  if (!target.conditionFingerprint || target.conditionFingerprint !== derived) {
    throw new Error('Boss saved-reference-invalid: condition fingerprint does not match the canonical condition identity.');
  }
}

async function locateSubscriptionRoot(page: Page, deadline: number): Promise<BossSearchDocument> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const candidates = [frame, page] as BossSearchDocument[];
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.locator(subscriptionRegionSelector).count().catch(() => 0)) return candidate;
    }
    await page.waitForTimeout(Math.min(100, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error('Boss subscription-list-not-ready: the native subscription region did not hydrate before the deadline.');
}

async function readCardSnapshot(card: Locator, index: number): Promise<InternalBossSavedSubscriptionCard> {
  return card.evaluate((element, cardIndex) => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const text = (selector: string): string => normalize(element.querySelector<HTMLElement>(selector)?.textContent);
    const asRecord = (value: unknown): Record<string, unknown> | undefined => (
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
    );
    const vueInfo = asRecord((element as HTMLElement & {
      __vue__?: { $props?: { info?: unknown } };
    }).__vue__?.$props?.info);
    const nativeConditions = asRecord(vueInfo?.conditions);
    const nativeLabelEntries = Array.isArray(vueInfo?.searchLabelEntries)
      ? vueInfo.searchLabelEntries.flatMap((entry) => {
        const record = asRecord(entry);
        const key = normalize(typeof record?.key === 'string' ? record.key : '');
        const label = normalize(typeof record?.label === 'string' ? record.label : '');
        return key && label ? [[key, label] as const] : [];
      })
      : [];
    const conditionLabels = Object.fromEntries(nativeLabelEntries);
    const labels = Array.from(element.querySelectorAll<HTMLElement>('.info-labels-item, .info-label'))
      .map((item) => normalize(item.textContent))
      .filter(Boolean);
    const domNativeId = ['data-subscribe-id', 'data-subscription-id', 'data-id', 'data-key', 'data-value']
      .map((attribute) => normalize(element.getAttribute(attribute)))
      .find(Boolean);
    const componentNativeId = normalize(typeof vueInfo?.encryptId === 'string' ? vueInfo.encryptId : '');
    const nativeIds = [...new Set([domNativeId, componentNativeId].filter(Boolean))];
    const nativeId = nativeIds[0];
    const nativeJobId = normalize(typeof vueInfo?.encryptJobId === 'string' ? vueInfo.encryptJobId : '');
    const expectedJobScope = normalize(typeof vueInfo?.jobName === 'string' ? vueInfo.jobName : '');
    const domName = text('.title-text, .subscribe-title');
    const componentName = normalize(typeof vueInfo?.subName === 'string' ? vueInfo.subName : '');
    const domKeyword = text('.keywords-text, .keyword-text');
    const componentKeyword = normalize(
      typeof nativeConditions?.keywords === 'string'
        ? nativeConditions.keywords
        : conditionLabels.keywords,
    );
    const identityConflict = nativeIds.length > 1
      || Boolean(domName && componentName && domName !== componentName)
      || Boolean(domKeyword && componentKeyword && domKeyword !== componentKeyword);
    const conditionFingerprint = normalize(
      element.getAttribute('data-condition-fingerprint')
        || element.getAttribute('data-search-condition-fingerprint')
        || element.getAttribute('data-fingerprint'),
    ) || undefined;
    const trackingToken = normalize((element as HTMLElement & {
      __autoRecruitSubscriptionTrackingToken?: string;
    }).__autoRecruitSubscriptionTrackingToken) || undefined;
    return {
      index: cardIndex,
      name: domName || componentName,
      expectedKeyword: domKeyword || componentKeyword,
      ...(nativeId ? { nativeId } : {}),
      ...(nativeJobId ? { nativeJobId } : {}),
      ...(expectedJobScope ? { expectedJobScope } : {}),
      labels,
      summary: normalize(element.textContent),
      ...(conditionFingerprint ? { conditionFingerprint } : {}),
      ...(trackingToken ? { trackingToken } : {}),
      ...(Object.keys(conditionLabels).length > 0 ? { conditionLabels } : {}),
      ...(identityConflict ? { identityConflict: true } : {}),
    };
  }, index);
}

async function readVisibleCardIndexes(root: BossSearchDocument): Promise<number[]> {
  return root.locator(subscriptionCardSelector).evaluateAll((elements) => elements.flatMap((element, index) => {
    if (!(element instanceof HTMLElement)) return [];
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 ? [index] : [];
  }));
}

async function readCardsFromRoot(root: BossSearchDocument): Promise<InternalBossSavedSubscriptionCard[]> {
  const cards = root.locator(subscriptionCardSelector);
  const indexes = await readVisibleCardIndexes(root);
  const snapshots: InternalBossSavedSubscriptionCard[] = [];
  for (const index of indexes) snapshots.push(await readCardSnapshot(cards.nth(index), index));
  return snapshots;
}

export async function readBossSavedSubscriptions(page: Page, options?: SearchWaitOptions): Promise<BossSavedSubscriptionCard[]> {
  const deadline = resolveDeadline(options);
  await prepareBossSearchConditionPage(page, '', { ...options, deadline });
  return (await readCardsFromRoot(await locateSubscriptionRoot(page, deadline))).map(({
    trackingToken: _trackingToken,
    conditionLabels: _conditionLabels,
    identityConflict: _identityConflict,
    ...card
  }) => card);
}

async function markCardsForMutation(
  root: BossSearchDocument,
): Promise<{ prefix: string; cards: InternalBossSavedSubscriptionCard[] }> {
  const prefix = `autorecruit-${Date.now()}-${subscriptionTrackingCounter += 1}`;
  await root.locator(subscriptionCardSelector).evaluateAll((elements, trackingPrefix) => {
    for (const [index, element] of elements.entries()) {
      (element as HTMLElement & {
        __autoRecruitSubscriptionTrackingToken?: string;
      }).__autoRecruitSubscriptionTrackingToken = `${trackingPrefix}:${index}`;
    }
  }, prefix);
  return { prefix, cards: await readCardsFromRoot(root) };
}

async function clearMutationCardMarkers(root: BossSearchDocument, prefix: string): Promise<void> {
  await root.locator(subscriptionCardSelector).evaluateAll((elements, trackingPrefix) => {
    for (const element of elements) {
      const tracked = element as HTMLElement & { __autoRecruitSubscriptionTrackingToken?: string };
      if (tracked.__autoRecruitSubscriptionTrackingToken?.startsWith(`${trackingPrefix}:`)) {
        delete tracked.__autoRecruitSubscriptionTrackingToken;
      }
    }
  }, prefix).catch(() => undefined);
}

function stableCardKey(card: BossSavedSubscriptionCard): string {
  if (card.nativeId) return `native:${card.nativeId}`;
  return `content:${JSON.stringify(canonicalizeSavedSearchIdentityValue({
    name: card.name,
    expectedKeyword: card.expectedKeyword,
    labels: card.labels,
    summary: card.summary,
  }))}`;
}

function sameMutationCard(
  expected: InternalBossSavedSubscriptionCard,
  actual: InternalBossSavedSubscriptionCard,
): boolean {
  if (expected.nativeId) return actual.nativeId === expected.nativeId;
  return Boolean(expected.trackingToken) && actual.trackingToken === expected.trackingToken;
}

function resolveMutationCard(
  cards: InternalBossSavedSubscriptionCard[],
  expected: InternalBossSavedSubscriptionCard,
): InternalBossSavedSubscriptionCard {
  const matches = cards.filter((card) => sameMutationCard(expected, card));
  if (matches.length !== 1) {
    throw new Error(`Boss subscription-stale-before-click: expected one stable mutation target, found ${matches.length}.`);
  }
  return matches[0]!;
}

function normalizeVisibleConditionValue(value: unknown): string {
  return normalizeText(value).replace(/^custom:(?:raw:)?/i, '');
}

function isUnrestrictedVisibleValue(value: string): boolean {
  return !value || value === '不限职位' || value === '不限';
}

function visibleConditionAlternatives(value: unknown, fieldId?: string): string[] {
  const normalized = normalizeVisibleConditionValue(value);
  if (!normalized) return [];
  if (fieldId === 'age') {
    const range = normalized.match(/^(\d+)\s*(?:岁)?\s*-\s*(\d+)\s*(?:岁)?$/u);
    if (range) {
      return [...new Set([
        normalized,
        `${range[1]}岁-${range[2]}岁`,
        `${range[1]}-${range[2]}岁`,
      ])];
    }
  }
  return [normalized];
}

function cardHasVisibleEvidence(
  card: InternalBossSavedSubscriptionCard,
  alternatives: readonly string[],
): boolean {
  const discrete = [
    ...card.labels,
    ...Object.values(card.conditionLabels ?? {}),
  ].map(normalizeText).filter(Boolean);
  const summary = normalizeText(card.summary);
  return alternatives.some((alternative) => {
    const normalized = normalizeText(alternative);
    return normalized && (discrete.some((value) => value === normalized || value.includes(normalized)) || summary.includes(normalized));
  });
}

function expectedValuesForNativeLabel(
  identity: SavedSearchConditionIdentity,
  key: string,
): { fieldId?: string; values: string[] } | undefined {
  switch (key) {
    case 'city':
      return { values: [identity.city, ...(identity.cityOptions ?? [])].map(normalizeVisibleConditionValue).filter(Boolean) };
    case 'degree':
      return { fieldId: 'education', values: (identity.inline.education ?? []).map(normalizeVisibleConditionValue).filter(Boolean) };
    case 'experience':
      return { fieldId: 'work_years', values: (identity.inline.work_years ?? []).map(normalizeVisibleConditionValue).filter(Boolean) };
    case 'age':
      return { fieldId: 'age', values: (identity.inline.age ?? []).map(normalizeVisibleConditionValue).filter(Boolean) };
    case 'schoolLevel':
      return { fieldId: 'school_nature', values: (identity.inline.school_nature ?? []).map(normalizeVisibleConditionValue).filter(Boolean) };
    case 'gender':
      return { values: [normalizeVisibleConditionValue(identity.more.性别)].filter(Boolean) };
    case 'salary':
      return { values: [normalizeVisibleConditionValue(identity.more.薪资区间)].filter(Boolean) };
    case 'activeTime':
      return { values: [normalizeVisibleConditionValue(identity.more.牛人活跃度)].filter(Boolean) };
    case 'switchFreq':
      return { values: [normalizeVisibleConditionValue(identity.more.跳槽频率)].filter(Boolean) };
    case 'applyStatus':
      return { values: [normalizeVisibleConditionValue(identity.more.求职状态)].filter(Boolean) };
    case 'geekJobRequirements':
      return { values: [normalizeVisibleConditionValue(identity.more.牛人职位要求)].filter(Boolean) };
    case 'major':
      return { values: [normalizeVisibleConditionValue(identity.more.专业)].filter(Boolean) };
    case 'viewResume':
      return { values: identity.toggles.filter_recent_viewed ? ['近14天没有看过'] : [] };
    case 'exchangeResume':
      return { values: identity.toggles.no_colleague_resume_exchange ? ['不交换简历'] : [] };
    default:
      return undefined;
  }
}

function cardConditionEvidenceMatches(
  card: InternalBossSavedSubscriptionCard,
  identity: SavedSearchConditionIdentity,
): boolean {
  if (card.identityConflict) return false;
  const expectedJobScope = normalizeText(identity.jobScope);
  if (card.expectedJobScope) {
    if (normalizeText(card.expectedJobScope) !== expectedJobScope) return false;
  } else if (!isUnrestrictedVisibleValue(expectedJobScope)
    && !cardHasVisibleEvidence(card, [expectedJobScope, '牛人期望此职位'])) {
    return false;
  }

  for (const [key, label] of Object.entries(card.conditionLabels ?? {})) {
    if (key === 'keywords') continue;
    const expected = expectedValuesForNativeLabel(identity, key);
    if (!expected) continue;
    const values = expected.values.filter((value) => !isUnrestrictedVisibleValue(value));
    if (values.length === 0) return false;
    if (!values.some((value) => visibleConditionAlternatives(value, expected.fieldId).includes(normalizeText(label)))) {
      return false;
    }
  }

  const requirements: Array<{ fieldId?: string; value: string }> = [
    ...[identity.city, ...(identity.cityOptions ?? []), identity.company]
      .map(normalizeVisibleConditionValue)
      .filter((value) => !isUnrestrictedVisibleValue(value))
      .map((value) => ({ value })),
    ...Object.entries(identity.inline).flatMap(([fieldId, values]) => values
      .map(normalizeVisibleConditionValue)
      .filter((value) => !isUnrestrictedVisibleValue(value))
      .map((value) => ({ fieldId, value }))),
    ...Object.values(identity.more)
      .map(normalizeVisibleConditionValue)
      .filter((value) => !isUnrestrictedVisibleValue(value))
      .map((value) => ({ value })),
    ...(identity.toggles.filter_recent_viewed ? [{ value: '近14天没有看过' }] : []),
    ...(identity.toggles.no_colleague_resume_exchange ? [{ value: '不交换简历' }] : []),
  ];
  if (!identity.toggles.filter_recent_viewed && cardHasVisibleEvidence(card, ['近14天没有看过'])) return false;
  if (!identity.toggles.no_colleague_resume_exchange && cardHasVisibleEvidence(card, ['不交换简历'])) return false;
  return requirements.every(({ fieldId, value }) => cardHasVisibleEvidence(card, visibleConditionAlternatives(value, fieldId)));
}

function cardProvesCurrent(card: BossSavedSubscriptionCard, state: BossSearchFilterState): boolean {
  const identity = bossSavedConditionIdentityFromState(state);
  if (card.expectedKeyword !== normalizeText(state.keyword)) return false;
  if (card.conditionFingerprint !== undefined) {
    return card.conditionFingerprint === fingerprintBossSavedConditions(identity);
  }
  return cardConditionEvidenceMatches(card, identity);
}

function sameConditionIdentity(left: SavedSearchConditionIdentity, right: SavedSearchConditionIdentity): boolean {
  return JSON.stringify(canonicalizeSavedSearchIdentityValue(left))
    === JSON.stringify(canonicalizeSavedSearchIdentityValue(right));
}

function sameSearchState(left: BossSearchFilterState, right: BossSearchFilterState): boolean {
  return normalizeText(left.keyword) === normalizeText(right.keyword)
    && sameConditionIdentity(
      bossSavedConditionIdentityFromState(left),
      bossSavedConditionIdentityFromState(right),
    );
}

async function assertCurrentSearchStateUnchanged(
  page: Page,
  expected: BossSearchFilterState,
  deadline: number,
): Promise<void> {
  const fresh = await snapshotBossSearchFilterState(page, deadline);
  if (!sameSearchState(fresh, expected)) {
    throw new Error('Boss save-uncertain: current search condition changed before dispatch.');
  }
}

function referenceMatchesState(target: SavedSearchReference, state: BossSearchFilterState): boolean {
  const identity = bossSavedConditionIdentityFromState(state);
  return state.keyword === normalizeText(target.expectedKeyword)
    && JSON.stringify(canonicalizeSavedSearchIdentityValue(identity)) === JSON.stringify(canonicalizeSavedSearchIdentityValue(target.conditionIdentity))
    && fingerprintBossSavedConditions(identity) === target.conditionFingerprint;
}

async function resolveSavedSubscriptionCard(
  page: Page,
  target: SavedSearchReference,
  deadline: number,
): Promise<{ root: BossSearchDocument; card: BossSavedSubscriptionCard }> {
  assertCompleteBossReference(target);
  const root = await locateSubscriptionRoot(page, deadline);
  const snapshots = await readCardsFromRoot(root);
  if (target.nativeId !== undefined) {
    const nativeMatches = snapshots.filter((card) => card.nativeId === target.nativeId);
    if (nativeMatches.some((card) => card.identityConflict
      || card.name !== normalizeText(target.name)
      || card.expectedKeyword !== normalizeText(target.expectedKeyword)
      || Boolean(card.expectedJobScope && normalizeText(card.expectedJobScope) !== normalizeText(target.conditionIdentity.jobScope)))) {
      throw new Error('Boss subscription-stale-before-click: native card identity evidence conflicts with the requested reference.');
    }
  }
  let matches = snapshots.filter((card) => card.name === normalizeText(target.name)
    && card.expectedKeyword === normalizeText(target.expectedKeyword)
    && !card.identityConflict
    && (target.nativeId === undefined || card.nativeId === target.nativeId));

  if (target.nativeId !== undefined && matches.some((card) => card.conditionFingerprint && card.conditionFingerprint !== target.conditionFingerprint)) {
    throw new Error('Boss subscription-stale-before-click: native card condition evidence conflicts with the requested reference.');
  }
  const authoritative = matches.filter((card) => card.conditionFingerprint === target.conditionFingerprint);
  if (authoritative.length > 0) matches = authoritative;
  else matches = matches.filter((card) => cardConditionEvidenceMatches(card, target.conditionIdentity));

  if (matches.length === 0) {
    throw new Error(`Boss subscription-not-found: no card proved name "${target.name}", keyword "${target.expectedKeyword}", and condition identity.`);
  }
  if (matches.length !== 1) {
    throw new Error(`Boss subscription-ambiguous: ${matches.length} cards matched the requested native identity.`);
  }
  return { root, card: matches[0]! };
}

async function waitForSavedSubscriptionHydration(
  page: Page,
  target: SavedSearchReference,
  deadline: number,
): Promise<BossSearchFilterState> {
  let lastObserved = '';
  while (Date.now() < deadline) {
    try {
      const state = await snapshotBossSearchFilterState(page, deadline);
      lastObserved = JSON.stringify({ keyword: state.keyword, fingerprint: fingerprintBossSavedConditions(state) });
      if (referenceMatchesState(target, state)) return state;
    } catch {
      // A redraw during hydration is expected; keep polling without another card click.
    }
    await page.waitForTimeout(Math.min(200, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error(`Boss subscription-hydration-failed: complete condition identity did not hydrate before the deadline; last=${lastObserved || '(unavailable)'}.`);
}

async function assertSavedCardStillCurrent(
  page: Page,
  target: SavedSearchReference,
  expected: BossSavedSubscriptionCard,
  deadline: number,
): Promise<void> {
  const resolved = await resolveSavedSubscriptionCard(page, target, deadline);
  if (resolved.card.index !== expected.index || stableCardKey(resolved.card) !== stableCardKey(expected)) {
    throw new Error('Boss subscription-stale-before-click: the card changed or moved before dispatch.');
  }
}

function withViewedOverride(identity: SavedSearchConditionIdentity, includeViewedCandidates?: boolean): SavedSearchConditionIdentity {
  if (includeViewedCandidates === undefined) return identity;
  return {
    ...identity,
    toggles: { ...identity.toggles, filter_recent_viewed: !includeViewedCandidates },
  };
}

function sameIdentityExceptViewed(left: SavedSearchConditionIdentity, right: SavedSearchConditionIdentity): boolean {
  const leftWithoutViewed = { ...left, toggles: { ...left.toggles, filter_recent_viewed: undefined } };
  const rightWithoutViewed = { ...right, toggles: { ...right.toggles, filter_recent_viewed: undefined } };
  return JSON.stringify(canonicalizeSavedSearchIdentityValue(leftWithoutViewed)) === JSON.stringify(canonicalizeSavedSearchIdentityValue(rightWithoutViewed));
}

async function assertSavedSearchSortPolicy(
  page: Page,
  policy: NonNullable<SearchWaitOptions['sortPolicy']>,
  deadline: number,
): Promise<void> {
  if (policy === 'platform-default') return;
  const frame = await waitForBossSearchFrame(page, deadline);
  const active = await frame.locator('.search-label').evaluateAll((elements) => elements
    .filter((element) => /\bactive\b|\bselected\b/.test(element.className))
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()));
  if (active.length !== 1 || active[0] !== '匹配度优先') {
    throw new Error('Boss sort-postcondition-failed: match-priority was not retained before or after final submit.');
  }
}

function assertSavedRuntimeIdentity(
  actual: BossSearchFilterState,
  target: SavedSearchReference,
  expectedIdentity: SavedSearchConditionIdentity,
  includeViewedCandidates: boolean | undefined,
  stage: 'before-submit' | 'after-submit',
): void {
  const actualIdentity = bossSavedConditionIdentityFromState(actual);
  if (normalizeText(actual.keyword) !== normalizeText(target.expectedKeyword)
    || !sameIdentityExceptViewed(actualIdentity, expectedIdentity)) {
    throw new Error(`Boss ${stage === 'before-submit' ? 'subscription-hydration' : 'search-submit-postcondition'}-failed: saved condition identity changed ${stage === 'before-submit' ? 'before' : 'after'} final submit.`);
  }
  if (actualIdentity.toggles.filter_recent_viewed !== expectedIdentity.toggles.filter_recent_viewed) {
    throw new Error(`Boss viewed-policy-failed: recent-viewed policy changed ${stage === 'before-submit' ? 'before' : 'after'} final submit.`);
  }
  if (includeViewedCandidates === undefined
    && fingerprintBossSavedConditions(actualIdentity) !== target.conditionFingerprint) {
    throw new Error(`Boss ${stage === 'before-submit' ? 'subscription-hydration' : 'search-submit-postcondition'}-failed: saved condition fingerprint changed ${stage === 'before-submit' ? 'before' : 'after'} final submit.`);
  }
}

export async function openBossSavedSubscriptionSearch(
  page: Page,
  target: SavedSearchReference,
  options?: SearchWaitOptions,
): Promise<Page> {
  assertCompleteBossReference(target);
  const deadline = resolveDeadline(options);
  const searchPage = await prepareBossSearchConditionPage(page, target.expectedKeyword, { ...options, deadline });
  const resolved = await resolveSavedSubscriptionCard(searchPage, target, deadline);
  const cardLocator = resolved.root.locator(subscriptionCardSelector).nth(resolved.card.index);
  await clickBossControlNatively(searchPage, cardLocator, remainingTime(deadline), {
    deadline,
    beforeClick: () => assertSavedCardStillCurrent(searchPage, target, resolved.card, deadline),
  });

  await waitForSavedSubscriptionHydration(searchPage, target, deadline);
  const sortPolicy = options?.sortPolicy ?? 'match-priority';
  await applyBossSearchSortPolicy(searchPage, sortPolicy, deadline);
  if (options?.includeViewedCandidates !== undefined) {
    await applyBossViewedCandidatePolicy(searchPage, options.includeViewedCandidates, deadline);
  }

  const expectedFinalIdentity = withViewedOverride(target.conditionIdentity, options?.includeViewedCandidates);
  const finalState = await snapshotBossSearchFilterState(searchPage, deadline);
  assertSavedRuntimeIdentity(finalState, target, expectedFinalIdentity, options?.includeViewedCandidates, 'before-submit');
  await assertSavedSearchSortPolicy(searchPage, sortPolicy, deadline);

  await waitBossActionPaceWithinDeadline(searchPage, deadline);
  await submitBossPreparedSearch(searchPage, deadline, options?.signal);
  const afterSubmit = await snapshotBossSearchFilterState(searchPage, deadline);
  assertSavedRuntimeIdentity(afterSubmit, target, expectedFinalIdentity, options?.includeViewedCandidates, 'after-submit');
  await assertSavedSearchSortPolicy(searchPage, sortPolicy, deadline);
  return searchPage;
}

async function findVisibleControl(root: BossSearchDocument | Locator, selector: string, exactText?: string): Promise<Locator | undefined> {
  const controls = root.locator(selector);
  const matches: Locator[] = [];
  for (let index = 0; index < await controls.count().catch(() => 0); index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    if (exactText !== undefined && normalizeText(await control.innerText().catch(() => '')) !== exactText) continue;
    matches.push(control);
  }
  if (matches.length > 1) throw new Error(`Boss save control is ambiguous: ${selector} has ${matches.length} visible matches.`);
  return matches[0];
}

async function renameBossSubscriptionCard(
  page: Page,
  root: BossSearchDocument,
  card: InternalBossSavedSubscriptionCard,
  requestedName: string,
  expectedState: BossSearchFilterState,
  deadline: number,
): Promise<InternalBossSavedSubscriptionCard> {
  const current = resolveMutationCard(await readCardsFromRoot(root), card);
  const cardLocator = root.locator(subscriptionCardSelector).nth(current.index);
  const edit = await findVisibleControl(cardLocator, subscriptionEditSelector);
  if (!edit) throw new Error('Boss save-name-conflict: target card has no unique edit control.');
  await clickBossControlNatively(page, edit, remainingTime(deadline), {
    deadline,
    beforeClick: async () => {
      await assertCurrentSearchStateUnchanged(page, expectedState, deadline);
      const fresh = resolveMutationCard(await readCardsFromRoot(root), current);
      if (fresh.index !== current.index
        || fresh.name !== current.name
        || fresh.expectedKeyword !== current.expectedKeyword) {
        throw new Error('Boss subscription-stale-before-click: edit target changed.');
      }
    },
  });

  const dialogs = page.locator('.dialog-wrap:visible, [role="dialog"]:visible');
  await dialogs.first().waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  if (await dialogs.count() !== 1) throw new Error('Boss rename-uncertain: expected one rename dialog.');
  const dialog = dialogs.first();
  const inputs = dialog.locator('input');
  if (await inputs.count() !== 1) throw new Error('Boss rename-uncertain: expected one rename input.');
  await typeBossLocatorSequentially(inputs.first(), page, requestedName, remainingTime(deadline), { replaceExisting: true });
  const confirm = await findVisibleControl(dialog, 'button, [role="button"]', '确定')
    ?? await findVisibleControl(dialog, 'button, [role="button"]', '保存')
    ?? await findVisibleControl(dialog, 'button, [role="button"]', '确认');
  if (!confirm) throw new Error('Boss rename-uncertain: rename confirmation is missing or ambiguous.');
  const confirmText = normalizeText(await confirm.innerText().catch(() => ''));
  await clickBossControlNatively(page, confirm, remainingTime(deadline), {
    deadline,
    beforeClick: async () => {
      await assertCurrentSearchStateUnchanged(page, expectedState, deadline);
      const freshCards = await readCardsFromRoot(await locateSubscriptionRoot(page, deadline));
      const freshCard = resolveMutationCard(freshCards, current);
      if (freshCard.name !== current.name || freshCard.expectedKeyword !== current.expectedKeyword) {
        throw new Error('Boss rename-uncertain: target card changed before confirmation.');
      }
      const freshDialogs = page.locator('.dialog-wrap:visible, [role="dialog"]:visible');
      if (await freshDialogs.count() !== 1) throw new Error('Boss rename-uncertain: rename dialog changed before confirmation.');
      const freshInputs = freshDialogs.first().locator('input');
      if (await freshInputs.count() !== 1 || normalizeText(await freshInputs.first().inputValue().catch(() => '')) !== requestedName) {
        throw new Error('Boss rename-uncertain: requested name was not retained before confirmation.');
      }
      if (!await confirm.isVisible().catch(() => false)
        || normalizeText(await confirm.innerText().catch(() => '')) !== confirmText) {
        throw new Error('Boss rename-uncertain: confirmation target changed before dispatch.');
      }
    },
  });

  while (Date.now() < deadline) {
    const afterRoot = await locateSubscriptionRoot(page, deadline);
    const cards = await readCardsFromRoot(afterRoot).catch(() => [] as InternalBossSavedSubscriptionCard[]);
    const matches = cards.filter((candidate) => sameMutationCard(current, candidate));
    if (matches.length > 1) throw new Error('Boss rename-uncertain: more than one card retained the mutation identity.');
    if (matches.length === 1
      && matches[0]!.name === requestedName
      && matches[0]!.expectedKeyword === expectedState.keyword) {
      await assertCurrentSearchStateUnchanged(page, expectedState, deadline);
      if (current.conditionFingerprint !== undefined
        && matches[0]!.conditionFingerprint !== current.conditionFingerprint) {
        throw new Error('Boss rename-uncertain: target condition fingerprint changed during rename.');
      }
      return matches[0]!;
    }
    await page.waitForTimeout(Math.min(200, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error('Boss rename-uncertain: the same card did not retain the requested name and condition identity.');
}

function findNewCards(
  before: InternalBossSavedSubscriptionCard[],
  after: InternalBossSavedSubscriptionCard[],
): InternalBossSavedSubscriptionCard[] {
  const beforeNativeIds = new Set(before.flatMap((card) => card.nativeId ? [card.nativeId] : []));
  const requiredTrackingTokens = before.flatMap((card) => !card.nativeId && card.trackingToken ? [card.trackingToken] : []);
  const afterTrackingTokens = new Set(after.flatMap((card) => card.trackingToken ? [card.trackingToken] : []));
  if (requiredTrackingTokens.some((token) => !afterTrackingTokens.has(token))) {
    throw new Error('Boss save-new-card-unproven: a pre-existing no-ID card was replaced or hidden after save dispatch.');
  }
  return after.filter((card) => card.nativeId
    ? !beforeNativeIds.has(card.nativeId)
    : !card.trackingToken);
}

async function giveCardMutationIdentity(
  root: BossSearchDocument,
  card: InternalBossSavedSubscriptionCard,
  prefix: string,
): Promise<InternalBossSavedSubscriptionCard> {
  if (card.nativeId || card.trackingToken) return card;
  const locator = root.locator(subscriptionCardSelector).nth(card.index);
  const fresh = await readCardSnapshot(locator, card.index);
  if (stableCardKey(fresh) !== stableCardKey(card)) {
    throw new Error('Boss save-new-card-unproven: the new no-ID card changed before identity binding.');
  }
  const trackingToken = `${prefix}:new:${subscriptionTrackingCounter += 1}`;
  await locator.evaluate((element, token) => {
    (element as HTMLElement & {
      __autoRecruitSubscriptionTrackingToken?: string;
    }).__autoRecruitSubscriptionTrackingToken = token;
  }, trackingToken);
  const tracked = await readCardSnapshot(locator, card.index);
  if (tracked.trackingToken !== trackingToken) {
    throw new Error('Boss save-new-card-unproven: the new no-ID card could not retain a stable mutation identity.');
  }
  return tracked;
}

async function proveExistingCardMatchesCurrent(
  page: Page,
  root: BossSearchDocument,
  card: InternalBossSavedSubscriptionCard,
  state: BossSearchFilterState,
  deadline: number,
): Promise<InternalBossSavedSubscriptionCard> {
  if (card.conditionFingerprint !== undefined) {
    if (!cardProvesCurrent(card, state)) {
      throw new Error('Boss save-name-conflict: authoritative card condition evidence differs from the current condition.');
    }
    return card;
  }

  const current = resolveMutationCard(await readCardsFromRoot(root), card);
  const locator = root.locator(subscriptionCardSelector).nth(current.index);
  await clickBossControlNatively(page, locator, remainingTime(deadline), {
    deadline,
    beforeClick: async () => {
      await assertCurrentSearchStateUnchanged(page, state, deadline);
      const fresh = resolveMutationCard(await readCardsFromRoot(root), current);
      if (fresh.index !== current.index
        || fresh.name !== current.name
        || fresh.expectedKeyword !== current.expectedKeyword) {
        throw new Error('Boss subscription-stale-before-click: existing save target changed.');
      }
    },
  });
  const target = buildBossSavedSearchReference(current.name, state, current.nativeId);
  await waitForSavedSubscriptionHydration(page, target, deadline);
  await assertCurrentSearchStateUnchanged(page, state, deadline);
  return resolveMutationCard(
    await readCardsFromRoot(await locateSubscriptionRoot(page, deadline)),
    current,
  );
}

export async function saveBossSearchCondition(
  page: Page,
  savedSearchName: string,
  options?: SearchWaitOptions,
): Promise<SearchConditionSaveResult> {
  const deadline = resolveDeadline(options);
  const name = normalizeText(savedSearchName);
  if (!name) throw new Error('Boss saved search name must not be empty.');
  const state = await snapshotBossSearchFilterState(page, deadline);
  const referenceFor = (nativeId?: string): SavedSearchReference => buildBossSavedSearchReference(name, state, nativeId);
  const root = await locateSubscriptionRoot(page, deadline);
  const marked = await markCardsForMutation(root);
  const before = marked.cards;
  const currentFingerprint = fingerprintBossSavedConditions(state);
  const currentIdentity = bossSavedConditionIdentityFromState(state);
  const isPossibleCurrentCard = (card: InternalBossSavedSubscriptionCard): boolean => (
    card.expectedKeyword === state.keyword
    && (card.conditionFingerprint !== undefined
      ? card.conditionFingerprint === currentFingerprint
      : cardConditionEvidenceMatches(card, currentIdentity))
  );

  try {
    const namedCards = before.filter((card) => card.name === name);
    if (namedCards.length > 0) {
      if (namedCards.length !== 1 || !isPossibleCurrentCard(namedCards[0]!)) {
        throw new Error(`Boss save-name-conflict: subscription name "${name}" is not proven to represent the current keyword and condition.`);
      }
      const existing = await proveExistingCardMatchesCurrent(page, root, namedCards[0]!, state, deadline);
      return { outcome: 'already-saved', savedSearch: referenceFor(existing.nativeId) };
    }

    const possibleCurrentCards = before.filter(isPossibleCurrentCard);
    if (possibleCurrentCards.length > 1) {
      throw new Error('Boss save-name-conflict: more than one existing card may match the current keyword and condition.');
    }
    if (possibleCurrentCards.length === 1) {
      const existing = await proveExistingCardMatchesCurrent(page, root, possibleCurrentCards[0]!, state, deadline);
      const renamed = await renameBossSubscriptionCard(page, await locateSubscriptionRoot(page, deadline), existing, name, state, deadline);
      return { outcome: 'renamed', savedSearch: referenceFor(renamed.nativeId) };
    }

    const create = await findVisibleControl(root, subscriptionCreateSelector, '订阅');
    if (!create) throw new Error('Boss save-uncertain: no unique visible subscribe control was available.');
    await clickBossControlNatively(page, create, remainingTime(deadline), {
      deadline,
      beforeClick: async () => {
        await assertCurrentSearchStateUnchanged(page, state, deadline);
        const freshCreate = await findVisibleControl(root, subscriptionCreateSelector, '订阅');
        if (!freshCreate
          || !await create.isVisible().catch(() => false)
          || normalizeText(await create.innerText().catch(() => '')) !== '订阅') {
          throw new Error('Boss save-uncertain: subscribe control changed before dispatch.');
        }
        const freshCards = await readCardsFromRoot(root);
        for (const card of before) resolveMutationCard(freshCards, card);
      },
    });

    while (Date.now() < deadline) {
      const afterRoot = await locateSubscriptionRoot(page, deadline);
      const after = await readCardsFromRoot(afterRoot).catch(() => [] as InternalBossSavedSubscriptionCard[]);
      const newCards = findNewCards(before, after);
      if (newCards.length > 1) throw new Error('Boss save-new-card-unproven: more than one new card appeared.');
      if (newCards.length === 1) {
        if (newCards[0]!.expectedKeyword !== state.keyword) {
          throw new Error('Boss save-new-card-unproven: the only new card has another keyword.');
        }
        await assertCurrentSearchStateUnchanged(page, state, deadline);
        if (!cardProvesCurrent(newCards[0]!, state)) {
          throw new Error('Boss save-new-card-unproven: new card does not prove the current condition.');
        }
        const created = await giveCardMutationIdentity(afterRoot, newCards[0]!, marked.prefix);
        if (created.name === name) return { outcome: 'saved', savedSearch: referenceFor(created.nativeId) };
        const renamed = await renameBossSubscriptionCard(page, afterRoot, created, name, state, deadline);
        return { outcome: 'renamed', savedSearch: referenceFor(renamed.nativeId) };
      }
      await page.waitForTimeout(Math.min(200, remainingTime(deadline))).catch(() => undefined);
    }
    throw new Error('Boss save-new-card-unproven: subscribe click dispatched but no new card was proven.');
  } finally {
    await clearMutationCardMarkers(root, marked.prefix);
  }
}

export async function executeBossSearchConditionPlan(
  page: Page,
  plan: SearchConditionPlan,
  options?: SearchWaitOptions,
): Promise<SearchConditionPlanExecutionResult> {
  const unsupported = plan.conditions.filter((condition) => condition.kind !== 'applicationFilter');
  if (unsupported.length > 0) {
    throw new Error(`Boss search subscription contains unsupported condition kind(s): ${[...new Set(unsupported.map((condition) => condition.kind))].join(', ')}`);
  }
  const result = await applyBossDirectSearch(page, plan.keyword, plan.conditions, options);
  const conditionResults: SearchConditionApplyResult[] = plan.conditions.map((condition: SearchCondition) => ({
    platform: 'boss',
    condition,
    status: 'applied',
  }));
  return {
    page: result.page,
    conditionResults,
    resultTotal: result.verification.resultTotal,
    resultTotalSource: result.verification.resultTotalSource,
  };
}
