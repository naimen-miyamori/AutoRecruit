import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { clickPlatformLocator, typeBossLocatorSequentially, waitPlatformActionPace } from '../browser/pacing.js';
import { config } from '../config.js';
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
} from '../search/filter-catalog.js';
import type {
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  ProjectExperience,
  SearchCondition,
  SearchConditionApplyResult,
  WorkExperience,
} from '../types/job.js';
import type { BossForwardMode, CandidatePostOpenActions, PlatformAdapter, SearchWaitOptions } from './types.js';

const bossLoginUrl = 'https://www.zhipin.com/web/user/?ka=header-login';
const bossAuthenticatedHomeUrl = 'https://www.zhipin.com/web/user/';
const bossChatSearchUrl = 'https://www.zhipin.com/web/chat/search';
const bossUnrestrictedJobName = '不限职位';

async function runBossPageAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await waitPlatformActionPace(page, 'boss');
  return action();
}

async function runBossFrameAction<T>(frame: Frame, action: () => Promise<T>): Promise<T> {
  return runBossPageAction(frame.page(), action);
}

async function clickBossLocator(
  locator: Locator,
  page: Page,
  timeoutMs: number,
  options: { force?: boolean; position?: { x: number; y: number } } = {},
): Promise<void> {
  await clickPlatformLocator(locator, page, 'boss', timeoutMs, options);
}

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

type BossResumeApiPayload = {
  code?: number;
  message?: string;
  zpData?: {
    expectId?: number | string;
    geekDetail?: Record<string, unknown>;
    geekDetailInfo?: Record<string, unknown>;
    showExpectPosition?: Record<string, unknown>;
  };
};

const bossResumePayloadCache = new WeakMap<Page, Map<string, BossResumeApiPayload>>();

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

async function waitForBossSearchFrame(page: Page, deadline: number) {
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

async function countBossCandidateCards(page: Page, deadline: number): Promise<number> {
  const frame = await waitForBossSearchFrame(page, deadline);
  return frame.locator('.geek-info-card').count().catch(() => 0);
}

async function applyBossSearchKeyword(page: Page, keyword: string, deadline: number): Promise<void> {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return;
  }

  const frame = await waitForBossSearchFrame(page, deadline);
  const currentKeyword = await readBossSearchKeyword(page, deadline);
  const currentCardCount = await countBossCandidateCards(page, deadline);
  if (currentKeyword === normalizedKeyword && currentCardCount > 0) {
    return;
  }

  const keywordInput = frame.locator('input.search-input, .search-input').first();
  await typeBossLocatorSequentially(keywordInput, page, normalizedKeyword, remainingTime(deadline), {
    replaceExisting: true,
  });
  await runBossFrameAction(frame, () => keywordInput.press('Enter', { timeout: remainingTime(deadline) })).catch(async () => {
    await clickBossLocator(frame.locator('.icon-search').first(), page, remainingTime(deadline));
  });

  await frame.waitForFunction(
    (expectedKeyword) => {
      const input = document.querySelector<HTMLInputElement>('input.search-input, .search-input');
      const inputValue = (input?.value ?? input?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const hasCards = document.querySelectorAll('.geek-info-card').length > 0;
      const hasExplicitEmpty = /暂无|没有|未找到|无相关|搜索使用方法/.test(bodyText);
      return inputValue === expectedKeyword && (hasCards || hasExplicitEmpty);
    },
    normalizedKeyword,
    { timeout: remainingTime(deadline), polling: 250 },
  );
}

async function openBossSubscribeSearch(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = createSearchDeadline(options);

  await openBossSearchMenu(page, deadline);
  await closeExistingBossResumeDialog(page, deadline);
  await waitForBossSearchFrame(page, deadline);
  await selectBossUnrestrictedJob(page, deadline);
  await applyBossSearchKeyword(page, keyword, deadline);
  return page;
}

async function prepareBossSearchConditionPage(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page> {
  return openBossSubscribeSearch(page, keyword, options);
}

async function openBossDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): Promise<Page> {
  const deadline = createSearchDeadline(options);
  const searchPage = await prepareBossSearchConditionPage(page, keyword, { ...options, deadline });
  for (const condition of conditions) {
    const result = await applyBossSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      const fieldLabel = condition.kind === 'applicationFilter' && typeof condition.fieldId === 'string'
        ? ` ${condition.fieldId}`
        : '';
      throw new Error(`Boss direct search condition ${condition.kind}${fieldLabel} failed: ${result.message ?? result.status}`);
    }
  }

  return searchPage;
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
    controlType: 'singleSelect',
    valueShape: 'string',
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

const bossMoreApplicationFilterLabelsInOrder = [
  '性别',
  '薪资区间',
  '牛人活跃度',
  '跳槽频率',
  '求职状态',
  '牛人职位要求',
  '专业',
  '资格证书',
];

const bossMoreApplicationFilterIndexByLabel = new Map(
  bossMoreApplicationFilterLabelsInOrder.map((label, index) => [label, index]),
);

const bossSupportedApplicationFilterFieldIds = new Set([
  ...Object.keys(bossInlineApplicationFiltersByFieldId),
  ...Object.keys(bossMoreApplicationFilterLabelByFieldId),
  'age',
  'expected_salary',
]);

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
): SearchFilterOption[] {
  if (!customInputSpec) {
    return options;
  }

  return options.map((option) => {
    if (option.label !== '自定义' && option.value !== '自定义') {
      return option;
    }

    return {
      ...option,
      inputSpec: customInputSpec,
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

async function collectBossStaticFilterSnapshots(page: Page, deadline: number): Promise<BossStaticFilterSnapshot[]> {
  const frame = await waitForBossSearchFrame(page, deadline);

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
      return {
        key,
        label,
        selector,
        containerText: normalize(root.textContent),
        options,
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
    ].filter((snapshot): snapshot is BossStaticFilterSnapshot => Boolean(snapshot));
  });

  const snapshotsByKey = new Map(staticSnapshots.map((snapshot) => [snapshot.key, snapshot]));
  for (const configItem of bossStaticFilterConfigs) {
    if (!bossExpandableMoreFilterKeys.has(configItem.key)) {
      continue;
    }

    const expandedSnapshot = await collectBossExpandedMoreFilterSnapshot(page, frame, configItem, deadline).catch(() => undefined);
    if (expandedSnapshot) {
      snapshotsByKey.set(expandedSnapshot.key, expandedSnapshot);
    }
  }

  return Array.from(snapshotsByKey.values());
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
  const snapshots = await collectBossStaticFilterSnapshots(page, deadline);
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

  const hasLoadError = await frame.evaluate(() => /数据加载异常/.test((document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()))
    .catch(() => false);
  if (!hasLoadError || remainingTime(deadline) <= 1000) {
    return;
  }

  const keywordInput = frame.locator('input.search-input, .search-input').first();
  await runBossFrameAction(frame, () => keywordInput.press('Enter', { timeout: Math.min(remainingTime(deadline), 2000) })).catch(async () => {
    await clickBossLocator(frame.locator('.icon-search').first(), frame.page(), Math.min(remainingTime(deadline), 2000)).catch(() => undefined);
  });
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
}

async function clickBossExpectedSalaryBoundary(
  frame: Frame,
  label: string,
  value: string,
  boundaryIndex: 0 | 1,
): Promise<void> {
  const targetIndex = bossMoreApplicationFilterIndexByLabel.get(label);
  await waitPlatformActionPace(frame.page(), 'boss');
  const clicked = await frame.evaluate(({ targetLabel, targetValue, targetBoundaryIndex, index }) => {
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
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
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

    const option = Array.from(optionList.querySelectorAll<HTMLElement>('li, .option'))
      .filter(isVisible)
      .find((element) => normalize(element.textContent) === targetValue);
    if (!option) {
      throw new Error(`Boss salary option not found: ${targetValue}`);
    }
    if (/\b(disabled)\b/i.test(option.className)) {
      throw new Error(`Boss salary option is disabled: ${targetValue}`);
    }

    dispatchClick(option);
    return true;
  }, {
    targetLabel: label,
    targetValue: value,
    targetBoundaryIndex: boundaryIndex,
    index: targetIndex,
  });

  if (!clicked) {
    throw new Error(`Unable to select Boss salary option: ${value}`);
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
  await clickBossExpectedSalaryBoundary(frame, label, input.min, 0);
  await frame.waitForTimeout(Math.min(150, remainingTime(deadline))).catch(() => undefined);
  await openBossMoreFilterDropdown(page, frame, label, deadline);
  await clickBossExpectedSalaryBoundary(frame, label, input.max, 1);
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  await runBossFrameAction(frame, () => frame.press('body', 'Escape')).catch(() => undefined);
  await waitForBossFilterSettle(frame, deadline);
}

async function clickBossAgePreset(frame: Frame, value: string): Promise<boolean> {
  await waitPlatformActionPace(frame.page(), 'boss');
  return frame.evaluate((targetValue) => {
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
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const root = document.querySelector<HTMLElement>('.age-select');
    if (!root) {
      throw new Error('Boss age filter root not found.');
    }
    const option = Array.from(root.querySelectorAll<HTMLElement>('.age-item, .custom, span, li'))
      .filter(isVisible)
      .find((element) => normalize(element.textContent) === targetValue);
    if (!option) {
      return false;
    }

    dispatchClick(option);
    return true;
  }, value);
}

async function openBossAgeCustomDropdown(frame: Frame, deadline: number): Promise<void> {
  const clicked = await clickBossAgePreset(frame, '自定义');
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

  await waitPlatformActionPace(frame.page(), 'boss');
  const clicked = await frame.evaluate(({ targetBoundaryIndex, targetValue }) => {
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
    const dispatchClick = (element: HTMLElement): void => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const eventName of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
    };
    const dropdowns = Array.from(document.querySelectorAll<HTMLElement>('.age-custom .dropdown-wrap')).filter(isVisible);
    const dropdown = dropdowns[targetBoundaryIndex];
    if (!dropdown) {
      throw new Error(`Boss age ${targetBoundaryIndex === 0 ? 'min' : 'max'} dropdown not found.`);
    }

    const option = Array.from(dropdown.querySelectorAll<HTMLElement>('.dropdown-menu li, .options li, li'))
      .filter(isVisible)
      .find((element) => normalize(element.textContent) === targetValue);
    if (!option) {
      throw new Error(`Boss age option not found: ${targetValue}`);
    }
    if (/\b(disabled)\b/i.test(option.className)) {
      throw new Error(`Boss age option is disabled: ${targetValue}`);
    }

    dispatchClick(option);
    return true;
  }, {
    targetBoundaryIndex: boundaryIndex,
    targetValue: value,
  });

  if (!clicked) {
    throw new Error(`Unable to select Boss age option: ${value}`);
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
    const clicked = await clickBossAgePreset(frame, presetLabel);
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

async function applyBossSupportedApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<void> {
  if (!bossSupportedApplicationFilterFieldIds.has(condition.fieldId)) {
    throw new Error(`Unsupported Boss application filter: ${condition.fieldId}`);
  }

  const deadline = createSearchDeadline();
  const frame = await waitForBossSearchFrame(page, deadline);

  if (condition.fieldKind === 'salaryRange' || condition.fieldId === 'expected_salary') {
    await applyBossExpectedSalaryApplicationFilter(page, frame, condition, deadline);
    return;
  }

  if (condition.fieldKind === 'numberRange' || condition.fieldId === 'age') {
    await applyBossAgeApplicationFilter(page, frame, condition, deadline);
    return;
  }

  if (condition.fieldKind !== 'singleSelect') {
    throw new Error(`Boss application filter ${condition.fieldId} only supports singleSelect replay at this stage.`);
  }

  const value = readBossApplicationFilterSingleValue(condition);

  if (condition.fieldId in bossInlineApplicationFiltersByFieldId) {
    await clickBossInlineApplicationFilter(frame, condition.fieldId, value, deadline);
    return;
  }

  await clickBossMoreApplicationFilter(page, frame, condition.fieldId, value, deadline);
}

async function applyBossApplicationFilter(
  page: Page,
  condition: Extract<SearchCondition, { kind: 'applicationFilter' }>,
): Promise<SearchConditionApplyResult> {
  try {
    await applyBossSupportedApplicationFilter(page, condition);
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
): Promise<SearchConditionApplyResult> {
  if (!isApplicationFilterCondition(condition)) {
    return {
      platform: 'boss',
      condition,
      status: 'skipped',
      message: `Search condition kind "${condition.kind}" is not implemented for boss yet.`,
    };
  }

  return applyBossApplicationFilter(page, condition);
}

async function readBossSearchConditionResultTotal(page: Page, options?: SearchWaitOptions): Promise<{
  resultTotal: number;
  resultTotalSource: 'page';
}> {
  const deadline = createSearchDeadline(options);
  const frame = await waitForBossSearchFrame(page, deadline);
  await frame.locator('.geek-info-card').first().waitFor({
    state: 'visible',
    timeout: Math.min(remainingTime(deadline), 5000),
  }).catch(() => undefined);
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
  await frame.locator('.geek-info-card, a[ka="search_click_open_resume"]').first().waitFor({
    state: 'visible',
    timeout: remainingTime(deadline),
  }).catch(() => undefined);

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
  const snapshots = await collectBossCandidateSnapshots(page, deadline);
  return { candidates: parseBossCandidateSnapshots(snapshots) };
}

export async function closeExistingBossResumeDialog(page: Page, deadline: number): Promise<void> {
  const activeDialog = page.locator('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]), .dialog-wrap.active:has(.c-share-box)').first();
  if (await activeDialog.count().catch(() => 0) === 0) {
    return;
  }

  const closeButton = activeDialog.locator('.boss-popup__close, .close-btn, [ka="dialog_close"], .boss-dialog__close').first();
  await clickBossLocator(closeButton, page, Math.min(remainingTime(deadline), 3000)).catch(async () => {
    await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  });
  await activeDialog.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) }).catch(() => undefined);
}

export async function waitForBossResumeDetailReady(page: Page, deadline: number): Promise<void> {
  await page.locator('.dialog-wrap.active[data-type="boss-dialog"] iframe[src*="/web/frame/c-resume/"], .dialog-wrap.active iframe[src*="/web/frame/c-resume/"]').first().waitFor({
    state: 'visible',
    timeout: remainingTime(deadline),
  });

  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active');
      const frame = document.querySelector<HTMLIFrameElement>('.dialog-wrap.active iframe[src*="/web/frame/c-resume/"]');
      return Boolean(dialog && frame);
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );

  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) {
    throw new Error('Boss resume detail frame did not become available.');
  }

  await detailFrame.locator('canvas#resume, #resume canvas').first().waitFor({
    state: 'visible',
    timeout: remainingTime(deadline),
  });
}

async function resolveBossCandidateAnchorIndex(page: Page, candidate: CandidateListItem, deadline: number): Promise<number> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const anchors = frame.locator('a[ka="search_click_open_resume"]');
  const anchorCount = await anchors.count();
  if (anchorCount === 0) {
    throw new Error(`Could not open Boss resume detail for candidate ${candidate.candidateId}: no candidate cards are visible.`);
  }

  const matchedIndex = await anchors.evaluateAll((elements, target) => {
    const candidateId = target.candidateId;
    const searchResultIndex = typeof target.searchResultIndex === 'number' ? target.searchResultIndex : undefined;

    return elements.findIndex((element, index) => {
      const dataExpect = element.getAttribute('data-expect') ?? '';
      const dataJid = element.getAttribute('data-jid') ?? '';
      const dataLid = element.getAttribute('data-lid') ?? '';

      return dataExpect === candidateId
        || dataJid === candidateId
        || dataLid === candidateId
        || (dataJid && dataLid && `${dataJid}_${dataLid}` === candidateId)
        || searchResultIndex === index;
    });
  }, {
    candidateId: candidate.candidateId,
    searchResultIndex: candidate.searchResultIndex,
  });

  if (matchedIndex < 0) {
    throw new Error(`Could not find Boss candidate card for ${candidate.candidateId}.`);
  }

  return matchedIndex;
}

async function openBossResumeDetail(_context: BrowserContext, searchPage: Page, candidate: CandidateListItem): Promise<Page> {
  const deadline = createResumeDetailDeadline();
  await closeExistingBossResumeDialog(searchPage, deadline);

  const frame = await waitForBossSearchFrame(searchPage, deadline);
  const targetIndex = await resolveBossCandidateAnchorIndex(searchPage, candidate, deadline);
  const candidateAnchor = frame.locator('a[ka="search_click_open_resume"]').nth(targetIndex);
  const safeClickTarget = candidateAnchor.locator('.geek-info-detail, .search-geek-info, .card-inner').first();
  const clickable = await safeClickTarget.count().catch(() => 0) > 0 ? safeClickTarget : candidateAnchor;

  await clickBossLocator(clickable, searchPage, remainingTime(deadline), { position: { x: 24, y: 24 } });
  await waitForBossResumeDetailReady(searchPage, deadline);
  return searchPage;
}

async function readBossResumeApiPayload(page: Page, deadline: number): Promise<BossResumeApiPayload> {
  await waitForBossResumeDetailReady(page, deadline);

  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) {
    throw new Error('Boss resume detail frame did not become available for parsing.');
  }

  return detailFrame.evaluate(async () => {
    const apiUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .reverse()
      .find((url) => /\/wapi\/(?:zpitem\/web\/boss\/search\/geek\/info|zpjob\/view\/geek\/info\/v2)\?/.test(url));
    if (!apiUrl) {
      throw new Error('Boss resume detail API resource was not found in the detail frame.');
    }

    const response = await fetch(apiUrl, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Boss resume detail API returned HTTP ${response.status}.`);
    }

    return response.json();
  }) as Promise<BossResumeApiPayload>;
}

function cacheBossResumePayload(page: Page, candidateId: string, payload: BossResumeApiPayload): void {
  const pageCache = bossResumePayloadCache.get(page) ?? new Map<string, BossResumeApiPayload>();
  pageCache.set(candidateId, payload);
  bossResumePayloadCache.set(page, pageCache);
}

function takeCachedBossResumePayload(page: Page, candidateId: string): BossResumeApiPayload | undefined {
  const pageCache = bossResumePayloadCache.get(page);
  const payload = pageCache?.get(candidateId);
  pageCache?.delete(candidateId);
  return payload;
}

async function waitForBossForwardDialog(page: Page, deadline: number): Promise<Locator> {
  const dialog = page.locator('.dialog-wrap.active .c-share-box').first();
  await dialog.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return dialog;
}

async function openBossForwardDialog(page: Page, deadline: number): Promise<Locator> {
  await waitForBossResumeDetailReady(page, deadline);
  const action = page.locator('.dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]) .btn-coop-forward');
  const actionCount = await action.count();
  if (actionCount !== 1) {
    throw new Error(`Expected one visible Boss resume forward action, found ${actionCount}.`);
  }

  await clickBossLocator(action, page, remainingTime(deadline));
  return waitForBossForwardDialog(page, deadline);
}

function bossForwardModeLabel(mode: BossForwardMode): string {
  return mode === 'colleague' ? '站内同事' : '邮件转发';
}

async function selectBossForwardMode(dialog: Locator, mode: BossForwardMode, deadline: number): Promise<Locator> {
  const label = bossForwardModeLabel(mode);
  const tab = dialog.locator('.nav-list .item').filter({ hasText: label });
  const tabCount = await tab.count();
  if (tabCount !== 1) {
    throw new Error(`Expected one Boss forward mode tab "${label}", found ${tabCount}.`);
  }

  if (!normalizeText(await tab.getAttribute('class') ?? '').split(' ').includes('cur')) {
    await clickBossLocator(tab, dialog.page(), remainingTime(deadline));
  }

  const placeholder = mode === 'colleague' ? '姓名、职位、邮箱' : '请输入收件人邮箱';
  const input = dialog.locator(`input[placeholder="${placeholder}"]`);
  await input.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return input;
}

async function selectBossForwardColleague(dialog: Locator, input: Locator, recipient: string, deadline: number): Promise<void> {
  await runBossPageAction(dialog.page(), () => input.fill(recipient, { timeout: remainingTime(deadline) }));
  const options = dialog.locator('.check-list li, .selector [class*="option"], .selector [class*="result-item"]');
  await options.first().waitFor({ state: 'visible', timeout: remainingTime(deadline) });

  const matches = await options.evaluateAll((elements, target) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const normalizedTarget = normalize(target);
    return elements
      .map((element, index) => ({
        index,
        text: normalize(element.textContent),
        visible: element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      }))
      .filter((item) => item.visible && (item.text === normalizedTarget || item.text.startsWith(normalizedTarget)));
  }, recipient);

  if (matches.length !== 1) {
    const optionTexts = await options.evaluateAll((elements) => elements
      .filter((element) => element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean));
    throw new Error(`Boss colleague forward recipient "${recipient}" matched ${matches.length} options. Visible options: ${optionTexts.slice(0, 10).join(' | ') || '(none)'}`);
  }

  await clickBossLocator(options.nth(matches[0]!.index), dialog.page(), remainingTime(deadline));
}

async function fillBossForwardForm(
  dialog: Locator,
  mode: BossForwardMode,
  recipient: string,
  candidateId: string,
  deadline: number,
): Promise<void> {
  const input = await selectBossForwardMode(dialog, mode, deadline);
  if (mode === 'colleague') {
    await selectBossForwardColleague(dialog, input, recipient, deadline);
  } else {
    await runBossPageAction(dialog.page(), () => input.fill(recipient, { timeout: remainingTime(deadline) }));
  }

  const message = dialog.locator('textarea[placeholder="请输入留言"]');
  await runBossPageAction(dialog.page(), () => message.fill(candidateId, { timeout: remainingTime(deadline) }));
  const actualMessage = await message.inputValue();
  if (actualMessage !== candidateId) {
    throw new Error(`Boss forward message did not retain candidate ID ${candidateId}.`);
  }
}

async function confirmBossForward(dialog: Locator, candidateId: string, deadline: number): Promise<void> {
  const forwardButton = dialog.locator('a[ka="geek_coop_forward"]');
  const buttonCount = await forwardButton.count();
  if (buttonCount !== 1) {
    throw new Error(`Expected one Boss forward confirmation button for candidate ${candidateId}, found ${buttonCount}.`);
  }

  await clickBossLocator(forwardButton, dialog.page(), remainingTime(deadline));
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) }).catch(async () => {
    const dialogText = await dialog.innerText().catch(() => '');
    throw new Error(`Boss resume forward did not complete for candidate ${candidateId}. Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  });
}

export async function forwardBossResume(
  page: Page,
  candidate: CandidateListItem,
  mode: BossForwardMode,
  recipient: string,
  actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']> = 'confirm',
): Promise<void> {
  const normalizedRecipient = normalizeText(recipient);
  if (!normalizedRecipient) {
    throw new Error('Boss forward recipient must be a non-empty string.');
  }

  const deadline = createResumeDetailDeadline();
  const payload = await readBossResumeApiPayload(page, deadline);
  cacheBossResumePayload(page, candidate.candidateId, payload);
  const dialog = await openBossForwardDialog(page, deadline);
  await fillBossForwardForm(dialog, mode, normalizedRecipient, candidate.candidateId, deadline);
  if (actionMode === 'prepare-only') {
    return;
  }

  await confirmBossForward(dialog, candidate.candidateId, deadline);
}

async function runBossPostOpenActions(page: Page, candidate: CandidateListItem, actions: CandidatePostOpenActions): Promise<void> {
  const hasMode = actions.bossForwardMode !== undefined;
  const hasRecipient = actions.bossForwardRecipient !== undefined;
  if (hasMode !== hasRecipient) {
    throw new Error('Boss forward mode and recipient must be provided together.');
  }

  if (actions.bossForwardMode && actions.bossForwardRecipient) {
    await forwardBossResume(
      page,
      candidate,
      actions.bossForwardMode,
      actions.bossForwardRecipient,
      actions.bossForwardActionMode,
    );
  }
}

function parseBossAge(ageDesc?: string): number | undefined {
  const age = ageDesc?.match(/(\d{1,3})/)?.[1];
  return age ? Number.parseInt(age, 10) : undefined;
}

function readBossTextList(value: unknown): string[] {
  if (typeof value === 'string') {
    return uniqueStrings([value]);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => readBossTextList(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  return uniqueStrings([
    readString(value, 'content'),
    readString(value, 'text'),
    readString(value, 'desc'),
    readString(value, 'description'),
    readString(value, 'name'),
    readString(value, 'certName'),
    readString(value, 'certificateName'),
    readString(value, 'skillName'),
    readString(value, 'label'),
    readString(value, 'value'),
  ]);
}

function parseBossWorkExperiences(geekDetail: Record<string, unknown>, candidate: CandidateListItem): WorkExperience[] {
  const workExperiences = readArray(geekDetail, 'geekWorkExpList')
    .filter(isRecord)
    .map((entry) => {
      const responsibility = readString(entry, 'responsibility');
      const workPerformance = readString(entry, 'workPerformance');
      const department = readString(entry, 'department');
      const workYearDesc = readString(entry, 'workYearDesc');
      const workEmphasis = readBossTextList(entry.workEmphasisList);
      return {
        company: readString(entry, 'company'),
        title: readString(entry, 'positionName') ?? readString(entry, 'positionTitle'),
        start: readString(entry, 'startYearMonStr'),
        end: readString(entry, 'endYearMonStr'),
        details: uniqueStrings([
          department ? `部门：${department}` : undefined,
          workYearDesc ? `工作时长：${workYearDesc}` : undefined,
          responsibility,
          workPerformance,
          ...workEmphasis,
        ]),
      };
    })
    .filter((entry) => entry.company || entry.title || entry.details.length > 0);

  if (workExperiences.length > 0) {
    return workExperiences;
  }

  if (candidate.currentCompany || candidate.currentTitle) {
    return [{
      company: candidate.currentCompany,
      title: candidate.currentTitle,
      details: [],
    }];
  }

  return [];
}

function parseBossProjectExperiences(geekDetail: Record<string, unknown>): ProjectExperience[] {
  return readArray(geekDetail, 'geekProjExpList')
    .filter(isRecord)
    .map((entry) => ({
      name: readString(entry, 'projectName') ?? readString(entry, 'name'),
      company: readString(entry, 'company') ?? readString(entry, 'companyName'),
      start: readString(entry, 'startYearMonStr') ?? readString(entry, 'startDate'),
      end: readString(entry, 'endYearMonStr') ?? readString(entry, 'endDate'),
      details: uniqueStrings([
        readString(entry, 'projectDescription'),
        readString(entry, 'responsibility'),
        readString(entry, 'performance'),
        ...readBossTextList(entry.projectEmphasisList),
      ]),
    }))
    .filter((entry) => entry.name || entry.company || entry.details.length > 0);
}

function parseBossEducationExperiences(geekDetail: Record<string, unknown>, fallbackEducation?: string): EducationExperience[] {
  const educationExperiences = readArray(geekDetail, 'geekEduExpList')
    .filter(isRecord)
    .map((entry) => ({
      school: readString(entry, 'school'),
      degree: readString(entry, 'degreeName') ?? fallbackEducation,
      major: readString(entry, 'major'),
      start: readString(entry, 'startYearStr'),
      end: readString(entry, 'endYearStr'),
      details: uniqueStrings([
        readString(entry, 'eduDescription'),
        readString(entry, 'majorRankingDesc'),
        readString(entry, 'thesisTitle'),
        readString(entry, 'thesisDesc'),
        ...readBossTextList(entry.courseDesc),
      ]),
    }))
    .filter((entry) => entry.school || entry.degree || entry.major || entry.details.length > 0);

  if (educationExperiences.length > 0) {
    return educationExperiences;
  }

  const highestEduExp = readRecord(geekDetail, 'highestEduExp');
  if (highestEduExp) {
    return [{
      school: readString(highestEduExp, 'school'),
      degree: readString(highestEduExp, 'degreeName') ?? fallbackEducation,
      major: readString(highestEduExp, 'major'),
      start: readString(highestEduExp, 'startYearStr'),
      end: readString(highestEduExp, 'endYearStr'),
      details: uniqueStrings([readString(highestEduExp, 'eduDescription')]),
    }];
  }

  return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
}

function parseBossCertificates(geekDetail: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...readBossTextList(geekDetail.geekCertificationList),
    ...readBossTextList(geekDetail.certList),
    ...readBossTextList(geekDetail.professionalSkill),
  ]);
}

function parseBossResumeFromApi(payload: BossResumeApiPayload, page: Page, candidate: CandidateListItem): CandidateResume {
  const zpData = payload.zpData ?? {};
  const geekDetail = isRecord(zpData.geekDetail)
    ? zpData.geekDetail
    : (isRecord(zpData.geekDetailInfo) ? zpData.geekDetailInfo : {});
  const baseInfo = readRecord(geekDetail, 'geekBaseInfo') ?? {};
  const highestEduExp = readRecord(geekDetail, 'highestEduExp');
  const showExpectPosition = readRecord(geekDetail, 'showExpectPosition') ?? (isRecord(zpData.showExpectPosition) ? zpData.showExpectPosition : undefined);
  const expectList = readArray(geekDetail, 'geekExpectList').filter(isRecord);
  const nativePlaceRecord = readRecord(baseInfo, 'hometown')
    ?? readRecord(baseInfo, 'nativePlace')
    ?? readRecord(baseInfo, 'householdRegistration');
  const nativePlace = readString(baseInfo, 'hometownName')
    ?? readString(baseInfo, 'hometown')
    ?? readString(baseInfo, 'nativePlaceName')
    ?? readString(baseInfo, 'nativePlace')
    ?? readString(baseInfo, 'householdRegistration')
    ?? readString(nativePlaceRecord, 'name')
    ?? readString(nativePlaceRecord, 'cityName')
    ?? readString(nativePlaceRecord, 'label')
    ?? readString(geekDetail, 'hometownName')
    ?? readString(geekDetail, 'nativePlace');
  const education = readString(baseInfo, 'degreeCategory')
    ?? readString(highestEduExp, 'degreeName')
    ?? candidate.cardText?.match(/博士|硕士|本科|大专|中专\/中技|中专|高中/)?.[0];

  return {
    candidateId: candidate.candidateId || String(zpData.expectId ?? ''),
    resumeUrl: candidate.resumeUrl ?? page.url(),
    name: readString(baseInfo, 'name') ?? candidate.name,
    age: parseBossAge(readString(baseInfo, 'ageDesc')),
    nativePlace,
    education,
    regions: uniqueStrings([
      readString(showExpectPosition, 'locationName'),
      ...expectList.map((entry) => readString(entry, 'locationName')),
    ]),
    pr: uniqueStrings([
      readString(baseInfo, 'userDescription'),
      readString(baseInfo, 'userDesc'),
      ...readBossTextList(geekDetail.resumeSummary),
    ]),
    workExperiences: parseBossWorkExperiences(geekDetail, candidate),
    projectExperiences: parseBossProjectExperiences(geekDetail),
    educationExperiences: parseBossEducationExperiences(geekDetail, education),
    skill: [],
    certificates: parseBossCertificates(geekDetail),
  };
}

export function parseBossResumeData(
  geekDetail: Record<string, unknown>,
  page: Page,
  candidate: CandidateListItem,
): CandidateResume {
  return parseBossResumeFromApi({ zpData: { geekDetail } }, page, candidate);
}

export async function parseBossResumeDetail(page: Page, candidate: CandidateListItem): Promise<CandidateResume> {
  const deadline = createResumeDetailDeadline();
  const payload = takeCachedBossResumePayload(page, candidate.candidateId)
    ?? await readBossResumeApiPayload(page, deadline);
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(`Boss resume detail API failed: ${payload.message ?? `code ${payload.code}`}`);
  }

  return parseBossResumeFromApi(payload, page, candidate);
}

function bossUnsupported(feature: string): never {
  throw new Error(`Boss platform currently supports manual login/session persistence, search-page preparation, direct search, candidate-list extraction, resume-detail opening, resume parsing, configured colleague/email resume forwarding, search-filter discovery, and application-filter replay for supported fields only; ${feature} is not implemented yet.`);
}

export const bossAdapter: PlatformAdapter = {
  platform: 'boss',
  displayName: 'Boss',
  subscribeSearchUrl: bossChatSearchUrl,
  loginUrl: bossLoginUrl,
  storageStateFileName: 'storage-state.boss.json',
  openLoginPage: async (page) => {
    await runBossPageAction(page, () => page.goto(bossLoginUrl, { waitUntil: 'domcontentloaded' }));
  },
  openAuthenticatedHome: openBossAuthenticatedHome,
  assertAuthenticated: assertBossAuthenticated,
  openSubscribeSearch: openBossSubscribeSearch,
  prepareSearchConditionPage: prepareBossSearchConditionPage,
  discoverSearchFilters: discoverBossSearchFilters,
  openDirectSearch: openBossDirectSearch,
  applySearchCondition: applyBossSearchCondition,
  readSearchConditionResultTotal: readBossSearchConditionResultTotal,
  extractCandidateList: extractBossCandidateList,
  openResumeDetail: openBossResumeDetail,
  afterResumeDetailOpened: runBossPostOpenActions,
  parseResumeDetail: parseBossResumeDetail,
};
