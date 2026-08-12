import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import {
  clickPlatformLocator,
  reloadPlatformPage,
} from '../../../browser/pacing.js';
import {
  parseSearchResultTotalFromText,
  saveSearchConditionByCommonDialog,
} from '../../../search/page-actions.js';
import type {
  CoreSavedSearchVerificationRequest,
  ExistingSavedSearchInspection,
  SearchWaitOptions,
} from '../../types.js';
import type {
  CoreSavedSearchTarget,
  PlatformSavedSearchOpenEvidence,
  ZhilianNativeSavedSearchTarget,
} from '../../../types/job.js';
import {
  assertCoreSavedSearchTarget,
  buildZhilianNativeSavedSearchOpenEvidence,
  buildZhilianNativeSavedSearchTarget,
} from '../../../search/saved-search-target.js';
import {
  attachZhilianCandidateApiObserver,
  clearObservedZhilianCandidateApi,
} from './candidate-actions.js';
import {
  createZhilianSearchDeadline as createSearchDeadline,
  remainingZhilianActionMs as remainingTime,
} from './context.js';
import {
  isAbortNavigationError,
  isZhilianSearchUrl,
  openZhilianRecruiterHome,
  waitForZhilianRecruiterShell,
} from './navigation-actions.js';

const zhilianUnviewedFilterSelector = [
  '.km-checkbox:has-text("未看过")',
  '[class*="checkbox"]:has-text("未看过")',
  '[role="checkbox"]:has-text("未看过")',
  'label:has-text("未看过")',
].join(', ');
const zhilianViewedFilterSettleMs = 1000;
const zhilianViewedFilterPollMs = 100;
const zhilianViewedFilterMaxWaitMs = 8000;
const zhilianSearchStatePollMs = 100;
const zhilianPlatform = 'zhilian';
const zhilianQuickSearchTagSelectors = [
  '.search-quick-search-new__content-item',
  '.search-quick-search__content-item',
  '[class*="quick-search"][class*="content-item"]',
  '[class*="quick-search"][class*="item"]',
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function canonicalizeZhilianConditionValue(value: unknown, path = 'conditions'): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Zhilian native quick-search ${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeZhilianConditionValue(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`Zhilian native quick-search ${path} contains a non-JSON value.`);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalizeZhilianConditionValue(item, `${path}.${key}`)]));
}

export function fingerprintZhilianNativeQuickSearchConditions(conditions: unknown): string {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new Error('Zhilian native quick-search conditions must be an object.');
  }
  const canonical = canonicalizeZhilianConditionValue(conditions);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function readZhilianNativeQuickSearchKeyword(conditions: unknown): string {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new Error('Zhilian native quick-search conditions must be an object.');
  }
  const keywordTagList = (conditions as Record<string, unknown>).keywordTagList;
  const tags = Array.isArray(keywordTagList) ? keywordTagList : [keywordTagList];
  const values = new Set<string>();
  for (const tag of tags) {
    if (typeof tag === 'string') {
      const normalized = normalizeText(tag.normalize('NFKC'));
      if (normalized) values.add(normalized);
      continue;
    }
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) continue;
    const tagRecord = tag as Record<string, unknown>;
    for (const key of ['value', 'keyword', 'label', 'name', 'text']) {
      if (typeof tagRecord[key] !== 'string') continue;
      const normalized = normalizeText((tagRecord[key] as string).normalize('NFKC'));
      if (normalized) values.add(normalized);
    }
  }
  if (values.size !== 1) {
    throw new Error(`Zhilian native quick-search conditions require exactly one keyword; found ${values.size}.`);
  }
  return [...values][0]!;
}

export interface ZhilianNativeQuickSearchSnapshot {
  nativeConditionId: unknown;
  conditions: unknown;
  cardSummary: unknown;
  componentIndex: unknown;
  domIndex: unknown;
}

export interface ZhilianNativeQuickSearchCandidate {
  nativeConditionId: string;
  expectedKeyword: string;
  conditionFingerprint: string;
  cardSummary: string;
  componentIndex: number;
  domIndex: number;
}

export function parseZhilianNativeQuickSearchSnapshots(
  snapshots: readonly ZhilianNativeQuickSearchSnapshot[],
): ZhilianNativeQuickSearchCandidate[] {
  const parsed = snapshots.map((snapshot, index): ZhilianNativeQuickSearchCandidate => {
    const nativeConditionId = typeof snapshot.nativeConditionId === 'number'
      && Number.isSafeInteger(snapshot.nativeConditionId)
      && snapshot.nativeConditionId > 0
      ? String(snapshot.nativeConditionId)
      : typeof snapshot.nativeConditionId === 'string'
        && /^\d+$/u.test(snapshot.nativeConditionId)
        ? snapshot.nativeConditionId
        : undefined;
    if (!nativeConditionId) {
      throw new Error(`Zhilian native quick-search snapshot ${index} has an invalid native condition id.`);
    }
    const componentIndex = snapshot.componentIndex;
    const domIndex = snapshot.domIndex;
    if (!Number.isSafeInteger(componentIndex) || (componentIndex as number) < 0
      || !Number.isSafeInteger(domIndex) || (domIndex as number) < 0
      || componentIndex !== domIndex) {
      throw new Error(`Zhilian native quick-search snapshot ${index} does not preserve component/DOM order.`);
    }
    const cardSummary = typeof snapshot.cardSummary === 'string'
      ? normalizeText(snapshot.cardSummary.normalize('NFKC'))
      : '';
    if (!cardSummary) throw new Error(`Zhilian native quick-search snapshot ${index} has no visible card summary.`);
    return {
      nativeConditionId,
      expectedKeyword: readZhilianNativeQuickSearchKeyword(snapshot.conditions),
      conditionFingerprint: fingerprintZhilianNativeQuickSearchConditions(snapshot.conditions),
      cardSummary,
      componentIndex: componentIndex as number,
      domIndex: domIndex as number,
    };
  });
  const ids = parsed.map((candidate) => candidate.nativeConditionId);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length > 0) {
    throw new Error(`Zhilian native quick-search inventory contains duplicate native condition id(s): ${duplicateIds.join(', ')}.`);
  }
  return parsed;
}

export async function readZhilianNativeQuickSearchInventory(
  page: Page,
): Promise<ZhilianNativeQuickSearchCandidate[]> {
  const snapshots = await page.locator(zhilianQuickSearchTagSelectors.join(', ')).evaluateAll((elements) => {
    type UnknownRecord = Record<string, unknown>;
    const visibleCards = elements.filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    });
    if (visibleCards.length === 0) return [];

    const isRecord = (value: unknown): value is UnknownRecord =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const componentName = (component: UnknownRecord): string | undefined => {
      const type = isRecord(component.type) ? component.type : undefined;
      const options = isRecord(component.$options) ? component.$options : undefined;
      const name = type?.name ?? options?.name;
      return typeof name === 'string' ? name : undefined;
    };
    const components: UnknownRecord[] = [];
    const seenComponents = new Set<unknown>();
    const visitComponentChain = (start: unknown): void => {
      let current = start;
      for (let depth = 0; depth < 12 && isRecord(current); depth += 1) {
        if (seenComponents.has(current)) break;
        seenComponents.add(current);
        if (componentName(current) === 'SearchQuickSearch') components.push(current);
        current = current.parent ?? current.$parent;
      }
    };
    for (const card of visibleCards) {
      let current: Element | null = card;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const element = current as Element & {
          __vue__?: unknown;
          __vueParentComponent?: unknown;
        };
        visitComponentChain(element.__vueParentComponent);
        visitComponentChain(element.__vue__);
        current = current.parentElement;
      }
    }
    const uniqueComponents = [...new Set(components)];
    if (uniqueComponents.length !== 1) {
      throw new Error(`Zhilian quick-search inventory requires one SearchQuickSearch component; found ${uniqueComponents.length}.`);
    }
    const component = uniqueComponents[0]!;
    const proxy = isRecord(component.proxy) ? component.proxy : undefined;
    const setupState = isRecord(component.setupState) ? component.setupState : undefined;
    const data = isRecord(component.data) ? component.data : undefined;
    const props = isRecord(component.props) ? component.props : undefined;
    const ctx = isRecord(component.ctx) ? component.ctx : undefined;
    const vueData = isRecord(component.$data) ? component.$data : undefined;
    const unwrap = (value: unknown): unknown => isRecord(value) && value.__v_isRef === true
      ? value.value
      : value;
    const possibleLists = [
      proxy?.quickSearchConditions,
      setupState?.quickSearchConditions,
      data?.quickSearchConditions,
      props?.quickSearchConditions,
      ctx?.quickSearchConditions,
      component.quickSearchConditions,
      vueData?.quickSearchConditions,
    ].map(unwrap).filter(Array.isArray) as unknown[][];
    const listsByJson = new Map<string, unknown[]>();
    for (const list of possibleLists) {
      let serialized: string;
      try {
        serialized = JSON.stringify(list);
      } catch {
        throw new Error('Zhilian quick-search component conditions are not JSON-safe.');
      }
      listsByJson.set(serialized, list);
    }
    if (listsByJson.size !== 1) {
      throw new Error(`Zhilian quick-search inventory requires one component condition list; found ${listsByJson.size}.`);
    }
    const list = [...listsByJson.values()][0]!;
    if (list.length !== visibleCards.length) {
      throw new Error(`Zhilian quick-search component/DOM cardinality mismatch: ${list.length} condition(s), ${visibleCards.length} visible card(s).`);
    }
    return list.map((rawItem, index) => {
      if (!isRecord(rawItem)) throw new Error(`Zhilian quick-search component item ${index} is malformed.`);
      const idValues = ['id', 'conditionId', 'quickSearchId', 'nativeId']
        .map((key) => rawItem[key])
        .filter((value) => typeof value === 'string' || typeof value === 'number')
        .map(String)
        .filter(Boolean);
      const distinctIds = [...new Set(idValues)];
      if (distinctIds.length !== 1) {
        throw new Error(`Zhilian quick-search component item ${index} requires one native ID; found ${distinctIds.length}.`);
      }
      if (!isRecord(rawItem.conditionObj)) {
        throw new Error(`Zhilian quick-search component item ${index} has no complete conditionObj object.`);
      }
      let conditions: unknown;
      try {
        conditions = JSON.parse(JSON.stringify(rawItem.conditionObj));
      } catch {
        throw new Error(`Zhilian quick-search component item ${index} conditions are not JSON-safe.`);
      }
      return {
        nativeConditionId: distinctIds[0],
        conditions,
        cardSummary: visibleCards[index]?.textContent ?? '',
        componentIndex: index,
        domIndex: index,
      };
    });
  });
  return parseZhilianNativeQuickSearchSnapshots(snapshots);
}

export async function waitForZhilianNativeQuickSearchInventory(
  page: Page,
  deadline: number,
): Promise<ZhilianNativeQuickSearchCandidate[]> {
  const visibleCards = page.locator(zhilianQuickSearchTagSelectors.join(', ')).filter({ visible: true });
  try {
    await visibleCards.first().waitFor({
      state: 'visible',
      timeout: remainingTime(deadline),
    });
  } catch (error) {
    throw new Error(
      'Zhilian native quick-search inventory did not become ready before the shared search deadline; absence is not proven.',
      { cause: error },
    );
  }
  const inventory = await readZhilianNativeQuickSearchInventory(page);
  if (inventory.length === 0) {
    throw new Error('Zhilian native quick-search inventory became empty after readiness; absence is not proven.');
  }
  return inventory;
}

export function resolveZhilianNativeQuickSearchCandidate(
  inventory: readonly ZhilianNativeQuickSearchCandidate[],
  target: ZhilianNativeSavedSearchTarget,
): ZhilianNativeQuickSearchCandidate {
  const matches = inventory.filter((candidate) => candidate.nativeConditionId === target.nativeConditionId);
  if (matches.length !== 1) {
    throw new Error(`Zhilian native saved search ${target.nativeConditionId} requires one component match; found ${matches.length}.`);
  }
  const candidate = matches[0]!;
  if (candidate.expectedKeyword !== target.expectedKeyword) {
    throw new Error(`Zhilian native saved search ${target.nativeConditionId} keyword drifted from "${target.expectedKeyword}" to "${candidate.expectedKeyword}".`);
  }
  if (candidate.conditionFingerprint !== target.conditionFingerprint) {
    throw new Error(`Zhilian native saved search ${target.nativeConditionId} condition fingerprint drifted before opening.`);
  }
  return candidate;
}

async function reloadZhilianSearchPage(page: Page, deadline: number): Promise<void> {
  const reload = (page as Partial<Pick<Page, 'reload'>>).reload?.bind(page);
  if (!reload) {
    return;
  }

  clearObservedZhilianCandidateApi(page);
  try {
    await reloadPlatformPage(page, zhilianPlatform, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });
  } catch (error) {
    if (!isAbortNavigationError(error) || !isZhilianSearchUrl(page.url())) {
      throw error;
    }
  }

  await waitForZhilianRecruiterShell(page, { deadline });
  clearObservedZhilianCandidateApi(page);
}

export async function listVisibleZhilianQuickSearchTags(page: Page): Promise<string[]> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const quickSearchSectionMatch = bodyText.match(/(?:快捷搜索|猜你想搜：?)([\s\S]{0,600})/);
  const quickSearchSection = normalizeText(quickSearchSectionMatch?.[1] ?? bodyText);
  return quickSearchSection
    .split(/\s{2,}|[,\n]/)
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => !/^(快捷搜索|猜你想搜：?|清空筛选|使用高级搜索|搜索|搜 索)$/.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordToLoosePattern(keyword: string): RegExp {
  const segments = keyword
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => escapeRegExp(segment));

  const pattern = segments.length > 0 ? segments.join('\\s*') : escapeRegExp(keyword);
  return new RegExp(pattern, 'i');
}


export function hasAppliedZhilianQuickSearchKeyword(bodyText: string, keyword: string): boolean {
  const normalizedText = normalizeText(bodyText);
  const keywordPattern = keywordToLoosePattern(keyword);
  const appliedKeywordMatch = normalizedText.match(/关键词[:：]\s*([^:：]*?)(?:\s+(?:学历要求|经验要求|年龄要求|期望月薪|活跃日期|期望职位|从事职业|从事行业|期望行业|现居住地|户口所在地|语言能力|性别要求|求职状态|人才类型|人才照片|简历语言|跳槽频率|保存为快捷搜索|今日搜索聊剩|综合排序|未看过|未聊过|近一段工作相关|其他过滤条件)|$)/);
  return keywordPattern.test(appliedKeywordMatch?.[1] ?? '');
}

export function parseExactlyAppliedZhilianQuickSearchKeyword(bodyText: string): string | undefined {
  const normalizedText = normalizeText(bodyText);
  const appliedKeywordMatch = normalizedText.match(/关键词[:：]\s*([^:：]*?)(?:\s+(?:学历要求|经验要求|年龄要求|期望月薪|活跃日期|期望职位|从事职业|从事行业|期望行业|现居住地|户口所在地|语言能力|性别要求|求职状态|人才类型|人才照片|简历语言|跳槽频率|保存为快捷搜索|今日搜索聊剩|综合排序|未看过|未聊过|近一段工作相关|其他过滤条件)|$)/);
  return normalizeText(appliedKeywordMatch?.[1]) || undefined;
}

export function hasExactlyAppliedZhilianQuickSearchKeyword(bodyText: string, keyword: string): boolean {
  return parseExactlyAppliedZhilianQuickSearchKeyword(bodyText) === normalizeText(keyword);
}

export async function isZhilianQuickSearchApplied(page: Page, keyword: string): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return hasAppliedZhilianQuickSearchKeyword(bodyText, keyword);
}

async function waitForZhilianQuickSearchApplied(page: Page, keyword: string, deadline: number): Promise<boolean> {
  while (Date.now() <= deadline) {
    if (await isZhilianQuickSearchApplied(page, keyword)) {
      return true;
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  return false;
}

async function waitForExactZhilianQuickSearchApplied(page: Page, keyword: string, deadline: number): Promise<string | undefined> {
  const normalizedExpected = normalizeText(keyword);
  while (Date.now() <= deadline) {
    const bodyText = await page.locator('body').innerText({
      timeout: Math.min(1000, remainingTime(deadline)),
    }).catch(() => '');
    const observedKeyword = parseExactlyAppliedZhilianQuickSearchKeyword(bodyText);
    if (observedKeyword === normalizedExpected) return observedKeyword;
    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }
  return undefined;
}

async function clickSavedZhilianQuickSearchTag(
  page: Page,
  keyword: string,
  deadline: number,
  options: { force?: boolean; requireUniqueExact?: boolean } = {},
): Promise<string | undefined> {
  if (!options.force && await isZhilianQuickSearchApplied(page, keyword)) {
    return;
  }

  const keywordPattern = options.requireUniqueExact
    ? new RegExp(`^\\s*${escapeRegExp(normalizeText(keyword))}\\s*$`, 'u')
    : keywordToLoosePattern(keyword);
  let quickSearchTag: ReturnType<Page['locator']> | undefined;

  for (const selector of zhilianQuickSearchTagSelectors) {
    const candidates = page.locator(selector).filter({ hasText: keywordPattern });
    try {
      await candidates.first().waitFor({ state: 'visible', timeout: Math.min(2000, remainingTime(deadline)) });
      if (options.requireUniqueExact) {
        const visibleExact: ReturnType<Page['locator']>[] = [];
        for (let index = 0; index < await candidates.count(); index += 1) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible().catch(() => false)
            && normalizeText(await candidate.innerText().catch(() => '')) === normalizeText(keyword)) {
            visibleExact.push(candidate);
          }
        }
        if (visibleExact.length !== 1) {
          throw new Error(`Zhilian saved search "${keyword}" requires one visible exact match; found ${visibleExact.length}.`);
        }
        quickSearchTag = visibleExact[0];
      } else {
        quickSearchTag = candidates.first();
      }
      break;
    } catch (error) {
      if (options.requireUniqueExact && error instanceof Error && error.message.includes('requires one visible exact match')) {
        throw error;
      }
      continue;
    }
  }

  if (!quickSearchTag) {
    if (options.force && !options.requireUniqueExact && await isZhilianQuickSearchApplied(page, keyword)) {
      return undefined;
    }

    const visibleTags = await listVisibleZhilianQuickSearchTags(page);
    throw new Error(`Could not find a saved Zhilian quick-search tag containing keyword "${keyword}". Visible tags: ${visibleTags.join(', ') || '(none)'}.`);
  }

  const observedName = options.requireUniqueExact
    ? normalizeText(await quickSearchTag.innerText({
      timeout: Math.min(1000, remainingTime(deadline)),
    }))
    : undefined;
  if (options.requireUniqueExact && observedName !== normalizeText(keyword)) {
    throw new Error(`Zhilian saved-search tag changed before opening. Expected "${normalizeText(keyword)}", observed "${observedName || '(missing)'}".`);
  }

  clearObservedZhilianCandidateApi(page);
  await clickPlatformLocator(quickSearchTag, page, zhilianPlatform, remainingTime(deadline));
  await waitForZhilianRecruiterShell(page, { deadline });
  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search tag containing keyword "${keyword}" was clicked, but its search conditions did not become active before timeout.`);
  }
  return observedName;
}

async function countVisibleExactZhilianQuickSearchTags(page: Page, name: string): Promise<number> {
  const expected = normalizeText(name);
  return page.locator(zhilianQuickSearchTagSelectors.join(', ')).evaluateAll((elements, expectedName) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    return elements.filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && normalize(element.textContent) === expectedName;
    }).length;
  }, expected);
}

export function zhilianQuickSearchSummaryHasExactKeyword(summary: string, keyword: string): boolean {
  const expected = normalizeText(keyword);
  return normalizeText(summary)
    .split('|')
    .map((segment) => normalizeText(segment))
    .filter(Boolean)
    .includes(expected);
}

async function readVisibleZhilianQuickSearchSummaries(page: Page): Promise<string[]> {
  return page.locator(zhilianQuickSearchTagSelectors.join(', ')).evaluateAll((elements) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    return elements.flatMap((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return [];
      const summary = normalize(element.textContent);
      return summary ? [summary] : [];
    });
  });
}

async function ensureZhilianViewedFilterClearedForQuickSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await clearZhilianUnviewedFilter(page, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }

  if (!await isZhilianQuickSearchApplied(page, keyword)) {
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (await clearZhilianUnviewedFilter(page, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
  }

  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search conditions for keyword "${keyword}" were not active after clearing 未看过.`);
  }

  if (await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter remained checked after --include-viewed true.');
  }
}

async function ensureZhilianUnviewedFilterCheckedForQuickSearch(page: Page, keyword: string, deadline: number): Promise<void> {
  if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }

  if (!await isZhilianQuickSearchApplied(page, keyword)) {
    await clickSavedZhilianQuickSearchTag(page, keyword, deadline);
    if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
  }

  if (!await waitForZhilianQuickSearchApplied(page, keyword, deadline)) {
    throw new Error(`Saved Zhilian quick-search conditions for keyword "${keyword}" were not active after checking 未看过.`);
  }

  if (!await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter was not checked before extraction.');
  }
}

async function isZhilianCheckboxFilterChecked(page: Page, selector: string): Promise<boolean> {
  const filter = page.locator(selector).filter({ visible: true }).first();
  const evaluate = (filter as Partial<Pick<typeof filter, 'evaluate'>>).evaluate?.bind(filter);
  if (!evaluate) {
    return false;
  }

  return evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const control = element.closest('[class*="checkbox"], label, [role="checkbox"]') ?? element;
    const checkbox = control.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const ariaChecked = control.getAttribute('aria-checked');
    return checkbox?.checked === true
      || ariaChecked === 'true'
      || /\b(km-checkbox--checked|ant-checkbox-checked|is-checked|checked)\b/.test(String(control.className ?? ''));
  }).catch(() => false);
}

async function isZhilianUnviewedFilterChecked(page: Page): Promise<boolean> {
  return isZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector);
}

export async function clearZhilianUnviewedFilter(page: Page, options?: SearchWaitOptions): Promise<boolean> {
  return setZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector, isZhilianUnviewedFilterChecked, false, options);
}

async function setZhilianUnviewedFilterChecked(page: Page, checked: boolean, options?: SearchWaitOptions): Promise<boolean> {
  return setZhilianCheckboxFilterChecked(page, zhilianUnviewedFilterSelector, isZhilianUnviewedFilterChecked, checked, options);
}

async function setZhilianCheckboxFilterChecked(
  page: Page,
  selector: string,
  isChecked: (page: Page) => Promise<boolean>,
  checked: boolean,
  options?: SearchWaitOptions,
): Promise<boolean> {
  const deadline = createSearchDeadline(options);
  const waitUntil = Math.min(deadline, Date.now() + zhilianViewedFilterMaxWaitMs);
  const filter = page.locator(selector).filter({ visible: true }).first();

  try {
    await filter.waitFor({ state: 'visible', timeout: Math.max(1, waitUntil - Date.now()) });
  } catch {
    return false;
  }

  let clicked = false;
  let stableSince: number | undefined;

  while (Date.now() < waitUntil) {
    const currentChecked = await isChecked(page);
    if (currentChecked !== checked) {
      stableSince = undefined;
      clearObservedZhilianCandidateApi(page);
      try {
        await clickPlatformLocator(
          filter,
          page,
          zhilianPlatform,
          Math.min(1000, Math.max(1, waitUntil - Date.now())),
        );
        clicked = true;
      } catch {
        // The search page renders hidden duplicates; retry until a visible control is stable.
      }
    } else {
      if (!clicked) {
        return false;
      }

      const now = Date.now();
      stableSince ??= now;
      if (now - stableSince >= zhilianViewedFilterSettleMs) {
        return clicked;
      }
    }

    await page.waitForTimeout(Math.min(zhilianViewedFilterPollMs, Math.max(1, waitUntil - Date.now()))).catch(() => undefined);
  }

  return clicked;
}


export async function prepareZhilianSearchSurface(
  page: Page,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  return page;
}

export async function prepareZhilianSavedQuickSearchPage(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  await prepareZhilianSearchSurface(page, { ...options, deadline });
  await clickSavedZhilianQuickSearchTag(page, keyword, deadline, { force: true });
  return page;
}

export async function applyZhilianViewedFilterForExtraction(
  page: Page,
  deadline: number,
  includeViewedCandidates?: boolean,
): Promise<void> {
  if (includeViewedCandidates) {
    if (await clearZhilianUnviewedFilter(page, { deadline })) {
      await waitForZhilianRecruiterShell(page, { deadline });
    }
    if (await isZhilianUnviewedFilterChecked(page)) {
      throw new Error('Zhilian 未看过 filter remained checked after --include-viewed true.');
    }
    return;
  }

  if (await setZhilianUnviewedFilterChecked(page, true, { deadline })) {
    await waitForZhilianRecruiterShell(page, { deadline });
  }
  if (!await isZhilianUnviewedFilterChecked(page)) {
    throw new Error('Zhilian 未看过 filter was not checked before extraction.');
  }
}

export async function readZhilianSearchConditionResultTotal(
  page: Page,
  options?: SearchWaitOptions,
): Promise<{ resultTotal: number; resultTotalSource: 'page' }> {
  const deadline = createSearchDeadline(options);

  while (Date.now() <= deadline) {
    const bodyText = await page.locator('body').innerText();
    const resultTotal = parseSearchResultTotalFromText(bodyText);
    if (resultTotal !== undefined) {
      return {
        resultTotal,
        resultTotalSource: 'page',
      };
    }

    if (/没有符合条件的人才|没有搜索到相关的人才|暂无符合条件|暂无数据|未搜索到相关/.test(bodyText)) {
      return {
        resultTotal: 0,
        resultTotalSource: 'page',
      };
    }

    await page.waitForTimeout(Math.min(zhilianSearchStatePollMs, remainingTime(deadline))).catch(() => undefined);
  }

  throw new Error('Search subscription on zhilian could not read the page result total.');
}


export async function openZhilianSubscribeSearch(
  page: Page,
  keyword: string,
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await reloadZhilianSearchPage(page, deadline);
  await clickSavedZhilianQuickSearchTag(page, keyword, deadline, { force: true });
  if (options?.includeViewedCandidates) {
    await ensureZhilianViewedFilterClearedForQuickSearch(page, keyword, deadline);
  } else {
    await ensureZhilianUnviewedFilterCheckedForQuickSearch(page, keyword, deadline);
  }
  return page;
}

async function openVerifiedZhilianNativeQuickSearch(
  page: Page,
  target: ZhilianNativeSavedSearchTarget,
  deadline: number,
  includeViewedCandidates?: boolean,
): Promise<{ page: Page; evidence: PlatformSavedSearchOpenEvidence }> {
  const inventory = await waitForZhilianNativeQuickSearchInventory(page, deadline);
  const candidate = resolveZhilianNativeQuickSearchCandidate(inventory, target);

  const visibleCards = page.locator(zhilianQuickSearchTagSelectors.join(', ')).filter({ visible: true });
  if (await visibleCards.count() !== inventory.length) {
    throw new Error('Zhilian native saved-search DOM cardinality changed before opening.');
  }
  const card = visibleCards.nth(candidate.domIndex);
  const observedSummary = normalizeText(await card.innerText({
    timeout: Math.min(1000, remainingTime(deadline)),
  }));
  if (observedSummary !== candidate.cardSummary) {
    throw new Error('Zhilian native saved-search DOM order or summary changed before opening.');
  }

  clearObservedZhilianCandidateApi(page);
  await clickPlatformLocator(card, page, zhilianPlatform, remainingTime(deadline));
  await waitForZhilianRecruiterShell(page, { deadline });
  if (!await waitForExactZhilianQuickSearchApplied(page, target.expectedKeyword, deadline)) {
    throw new Error(`Zhilian native saved search did not prove exact page keyword "${target.expectedKeyword}".`);
  }
  await applyZhilianViewedFilterForExtraction(page, deadline, includeViewedCandidates);
  const observedKeyword = await waitForExactZhilianQuickSearchApplied(page, target.expectedKeyword, deadline);
  if (!observedKeyword) {
    throw new Error(`Zhilian native saved search lost exact page keyword "${target.expectedKeyword}" after viewed-policy application.`);
  }
  return {
    page,
    evidence: buildZhilianNativeSavedSearchOpenEvidence(target, {
      boundJobKey: target.boundJobKey,
      observedNativeConditionId: candidate.nativeConditionId,
      observedKeyword,
      observedConditionFingerprint: candidate.conditionFingerprint,
    }),
  };
}

export async function verifyZhilianSavedSearchTarget(
  page: Page,
  request: CoreSavedSearchVerificationRequest,
  options: SearchWaitOptions & { boundJobKey: string },
): Promise<{ page: Page; target: CoreSavedSearchTarget; evidence: PlatformSavedSearchOpenEvidence }> {
  if (request.platform !== 'zhilian' || request.boundJobKey !== options.boundJobKey) {
    throw new Error('Zhilian saved-search verification request does not belong to this platform and job.');
  }
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await reloadZhilianSearchPage(page, deadline);
  const inventory = await waitForZhilianNativeQuickSearchInventory(page, deadline);
  const normalizedKeyword = normalizeText(request.expectedKeyword.normalize('NFKC'));
  const matches = inventory.filter((candidate) => candidate.expectedKeyword === normalizedKeyword);
  if (matches.length !== 1) {
    throw new Error(
      `Zhilian saved-search verification requires one native condition with exact keyword "${normalizedKeyword}"; found ${matches.length}.`,
    );
  }
  const candidate = matches[0]!;
  const target = buildZhilianNativeSavedSearchTarget({
    boundJobKey: request.boundJobKey,
    bindingRevision: request.bindingRevision,
    name: request.name,
    nativeConditionId: candidate.nativeConditionId,
    expectedKeyword: candidate.expectedKeyword,
    conditionFingerprint: candidate.conditionFingerprint,
  });
  const opened = await openVerifiedZhilianNativeQuickSearch(
    page,
    target,
    deadline,
    options.includeViewedCandidates,
  );
  return { page: opened.page, target, evidence: opened.evidence };
}

export async function openBoundZhilianSavedSearch(
  page: Page,
  rawTarget: CoreSavedSearchTarget,
  options: SearchWaitOptions & { boundJobKey: string },
): Promise<{ page: Page; evidence: PlatformSavedSearchOpenEvidence }> {
  const target = assertCoreSavedSearchTarget(rawTarget, {
    platform: 'zhilian',
    boundJobKey: options.boundJobKey,
    label: 'Zhilian native saved-search target',
  });
  if (target.targetKind !== 'zhilian-native-condition') {
    throw new Error('Zhilian saved-search target requires native-condition migration.');
  }
  if (target.boundJobKey !== options.boundJobKey) {
    throw new Error('Zhilian saved-search target does not belong to this platform and job.');
  }
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await reloadZhilianSearchPage(page, deadline);
  return openVerifiedZhilianNativeQuickSearch(
    page,
    target,
    deadline,
    options.includeViewedCandidates,
  );
}

export async function inspectExistingZhilianSavedSearch(
  page: Page,
  request: CoreSavedSearchVerificationRequest,
  options: SearchWaitOptions & { boundJobKey: string },
): Promise<ExistingSavedSearchInspection> {
  if (request.platform !== zhilianPlatform || request.boundJobKey !== options.boundJobKey) {
    throw new Error('Zhilian saved-search inspection target does not belong to this platform and job.');
  }
  const deadline = createSearchDeadline(options);
  clearObservedZhilianCandidateApi(page);
  attachZhilianCandidateApiObserver(page);
  await openZhilianRecruiterHome(page, { deadline });
  await reloadZhilianSearchPage(page, deadline);
  const normalizedKeyword = normalizeText(request.expectedKeyword.normalize('NFKC'));
  const inventory = await waitForZhilianNativeQuickSearchInventory(page, deadline);
  const nativeMatches = inventory.filter((candidate) => candidate.expectedKeyword === normalizedKeyword);
  if (nativeMatches.length > 0) {
    throw new Error(
      `Zhilian existing keyword "${normalizedKeyword}" maps to ${nativeMatches.length} native condition(s); verify and bind native-condition identity before save or capture.`,
    );
  }
  const exactCount = await countVisibleExactZhilianQuickSearchTags(page, request.name);
  const keywordSummaries = (await readVisibleZhilianQuickSearchSummaries(page))
    .filter((summary) => zhilianQuickSearchSummaryHasExactKeyword(summary, normalizedKeyword));
  if (exactCount > 0 || keywordSummaries.length > 0) {
    throw new Error(
      `Zhilian saved-search label "${request.name}" cannot authorize save: current page identity requires native-condition verification.`,
    );
  }
  return { status: 'absent', page };
}

export async function savePreparedZhilianSearchCondition(
  page: Page,
  savedSearchName: string,
  options?: SearchWaitOptions,
): Promise<Awaited<ReturnType<NonNullable<import('../../types.js').PlatformAdapter['saveSearchCondition']>>>> {
  await saveSearchConditionByCommonDialog(page, savedSearchName, {
    platformLabel: 'zhilian',
    platform: zhilianPlatform,
  });
  await waitForZhilianRecruiterShell(page);
  const context = options?.subscriptionMutationContext;
  if (!context) return undefined;
  const opened = await verifyZhilianSavedSearchTarget(page, {
    platform: 'zhilian',
    boundJobKey: `subscription-management:${context.conditionFingerprint}`,
    bindingRevision: 1,
    name: savedSearchName,
    expectedKeyword: context.expectedKeyword,
  }, {
    ...options,
    boundJobKey: `subscription-management:${context.conditionFingerprint}`,
  });
  return { outcome: 'saved', openEvidence: opened.evidence, workPage: opened.page };
}
