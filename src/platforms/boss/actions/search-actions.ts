import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { moveMouseContinuously, typeBossLocatorSequentially } from '../../../browser/pacing.js';
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
} from '../../../types/job.js';
import type { CandidatePostOpenActions, SearchWaitOptions } from '../../types.js';
import { parseBossResumeData } from './resume-actions.js';
import {
  clickBossControl as clickBossLocator,
  clickBossControlWithDomEvent,
  runBossAction as runBossPageAction,
  runBossFrameAction,
} from './context.js';
import {
  closeExistingBossResumeDialog,
  forwardBossResume,
  parseBossResumeDetail,
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

function bossDirectSearchActionUnits(condition: SearchCondition): number {
  if (!isApplicationFilterCondition(condition)) return 1;
  if (condition.fieldId === 'city') return 4;
  if (condition.fieldId === 'education' || condition.fieldId === 'work_years') return 4;
  if (condition.fieldId === 'age') return 3;
  if (condition.fieldId === 'job_scope') return 2;
  return 2;
}

function createBossDirectSearchDeadline(
  conditions: SearchCondition[],
  options?: SearchWaitOptions,
): number {
  if (options?.deadline !== undefined) return options.deadline;
  const pacingUpperBound = Math.max(config.playwright.actionDelayMaxMsByPlatform.boss, 1);
  // One bounded search deadline must cover intentional pacing as well as page
  // readiness. A direct search with custom sliders has several paced pointer
  // operations; the ordinary 30s list-read budget is not sufficient for it.
  const estimatedMs = 24_000 + (12 + conditions.reduce((total, condition) => total + bossDirectSearchActionUnits(condition), 0)) * pacingUpperBound;
  const boundedMs = Math.min(120_000, estimatedMs);
  return Date.now() + Math.max(config.playwright.searchPageTimeoutMs, boundedMs);
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
      return inputValue === expectedKeyword;
    },
    normalizedKeyword,
    { timeout: remainingTime(deadline), polling: 250 },
  );
  await waitForBossSearchResults(frame, deadline);
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
  const deadline = createBossDirectSearchDeadline(conditions, options);
  const searchPage = await prepareBossSearchConditionPage(page, keyword, { ...options, deadline });
  await resetBossSearchFilters(searchPage, deadline);
  await selectBossUnrestrictedJob(searchPage, deadline);
  const jobScopeConditions = conditions.filter((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'job_scope'
  ));
  const cityConditions = conditions.filter((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'city'
  ));
  const remainingConditions = conditions.filter((condition) => (
    !jobScopeConditions.includes(condition) && !cityConditions.includes(condition)
  ));
  for (const condition of jobScopeConditions) {
    const result = await applyBossSearchCondition(searchPage, condition, deadline);
    if (result.status !== 'applied') {
      const fieldLabel = condition.kind === 'applicationFilter' && typeof condition.fieldId === 'string'
        ? ` ${condition.fieldId}`
        : '';
      throw new Error(`Boss direct search condition ${condition.kind}${fieldLabel} failed: ${result.message ?? result.status}`);
    }
  }
  await applyBossSearchKeyword(searchPage, keyword, deadline);
  for (const condition of cityConditions) {
    const result = await applyBossSearchCondition(searchPage, condition, deadline);
    if (result.status !== 'applied') {
      const fieldLabel = condition.kind === 'applicationFilter' && typeof condition.fieldId === 'string'
        ? ` ${condition.fieldId}`
        : '';
      throw new Error(`Boss direct search condition ${condition.kind}${fieldLabel} failed: ${result.message ?? result.status}`);
    }
  }
  for (const condition of remainingConditions) {
    const result = await applyBossSearchCondition(searchPage, condition, deadline);
    if (result.status !== 'applied') {
      const fieldLabel = condition.kind === 'applicationFilter' && typeof condition.fieldId === 'string'
        ? ` ${condition.fieldId}`
        : '';
      throw new Error(`Boss direct search condition ${condition.kind}${fieldLabel} failed: ${result.message ?? result.status}`);
    }
  }

  await assertBossDirectSearchPostcondition(searchPage, keyword, conditions, deadline);

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
  await moveMouseContinuously(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
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
    await moveMouseContinuously(page, target);
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

async function applyBossCityApplicationFilter(
  page: Page,
  frame: Frame,
  values: string[],
  deadline: number,
): Promise<void> {
  const desired = new Set(values);
  if (desired.size === 0 || desired.has('不限')) {
    throw new Error('Boss city application filter requires one or more explicit city options.');
  }
  await runBossPageAction(page, () => page.keyboard.press('Escape')).catch(() => undefined);
  const trigger = frame.locator('.city-wrap .city, .city-wrap .square').first();
  const cityBox = frame.locator('.city-wrap .city-box').first();
  await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
  try {
    await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
  } catch {
    // The panel occasionally misses the first pointer event while a reset is
    // settling. Retry its one semantic open action; do not continue without a
    // visible, inspectable panel.
    await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
    await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
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
}

async function readBossSelectedCityApplicationFilter(
  page: Page,
  frame: Frame,
  deadline: number,
): Promise<string[]> {
  const trigger = frame.locator('.city-wrap .city, .city-wrap .square').first();
  const cityBox = frame.locator('.city-wrap .city-box').first();
  const initiallyVisible = await cityBox.isVisible().catch(() => false);
  if (!initiallyVisible) {
    await clickBossLocator(trigger, page, Math.min(remainingTime(deadline), 5000));
    await cityBox.waitFor({ state: 'visible', timeout: Math.min(remainingTime(deadline), 5000) });
    await frame.waitForTimeout(Math.min(500, remainingTime(deadline))).catch(() => undefined);
  }
  try {
    return await cityBox.locator('.dropdown-province > li').evaluateAll((elements) => elements.flatMap((element) => {
      const item = element as HTMLElement;
      const checkbox = item.querySelector<HTMLElement>('.city-checkbox, .mul-checkbox-ui');
      const selected = /status1|checked|active/.test(checkbox?.className ?? '') || Boolean(item.querySelector<HTMLInputElement>('input')?.checked);
      const label = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
      return selected && label ? [label] : [];
    }));
  } finally {
    // The live city panel does not reliably close for Escape or outside clicks.
    // Re-submit its already verified selection through the native confirmation
    // button so a direct-search action always returns a stable, collapsed page.
    const confirmationIndex = await cityBox.locator('button').evaluateAll((buttons) => buttons.findIndex((button) => /确定|确认|完成/.test((button.textContent ?? '').replace(/\s+/g, ' ').trim())));
    if (confirmationIndex < 0) {
      throw new Error('Boss city selector confirmation button is unavailable during postcondition verification.');
    }
    await clickBossLocator(cityBox.locator('button').nth(confirmationIndex), page, Math.min(remainingTime(deadline), 5000));
    await waitForBossFilterSettle(frame, deadline);
    await cityBox.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) });
  }
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
  return snapshot;
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

async function assertBossDirectSearchPostcondition(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  deadline: number,
): Promise<void> {
  const state = await snapshotBossSearchFilterState(page, deadline);
  const expectedKeyword = normalizeText(keyword);
  if (state.keyword !== expectedKeyword) {
    throw new Error(`Boss direct search postcondition mismatch for keyword: expected ${expectedKeyword}, observed ${state.keyword || '(empty)'}.`);
  }

  const frame = await waitForBossSearchFrame(page, deadline);
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
      if (!active || (expected !== active.label && expected !== active.value)) {
        throw new Error(`Boss direct search postcondition mismatch for job_scope: expected ${expected}, observed ${active?.label ?? '(empty)'}.`);
      }
      continue;
    }

    if (condition.fieldId === 'city') {
      const expected = readBossApplicationFilterMultiValues(condition).sort();
      const actual = (await readBossSelectedCityApplicationFilter(page, frame, deadline)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Boss direct search postcondition mismatch for city: expected ${expected.join(', ')}, observed ${actual.join(', ') || '(empty)'}.`);
      }
      continue;
    }

    if (condition.fieldId === 'education' || condition.fieldId === 'work_years') {
      const customRange = readBossCustomSliderRange(condition);
      const actual = state.inline[condition.fieldId];
      if (customRange) {
        const expected = `custom:${customRange.minLabel}-${customRange.maxLabel}`;
        if (!actual.includes(expected)) {
          throw new Error(`Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected}, observed ${actual.join(', ') || '(empty)'}.`);
        }
      } else {
        const expected = readBossApplicationFilterSingleValue(condition);
        if (!actual.includes(expected)) {
          throw new Error(`Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected}, observed ${actual.join(', ') || '(empty)'}.`);
        }
      }
      continue;
    }

    if (condition.fieldId === 'school_nature') {
      const expected = readBossApplicationFilterMultiValues(condition).sort();
      const actual = [...state.inline.school_nature].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Boss direct search postcondition mismatch for school_nature: expected ${expected.join(', ')}, observed ${actual.join(', ') || '(empty)'}.`);
      }
      continue;
    }

    if (condition.fieldId === 'age') {
      const expectedRange = readBossAgeRangeInput(condition);
      const expectedPreset = buildBossAgePresetLabel(expectedRange);
      const expected = expectedPreset ?? `custom:${expectedRange.min ?? ''}-${expectedRange.max ?? ''}`;
      if (!state.inline.age.includes(expected)) {
        throw new Error(`Boss direct search postcondition mismatch for age: expected ${expected}, observed ${state.inline.age.join(', ') || '(empty)'}.`);
      }
      continue;
    }

    if (condition.fieldId === 'filter_recent_viewed' || condition.fieldId === 'no_colleague_resume_exchange') {
      const expected = readBossApplicationFilterToggleValue(condition);
      if (state.toggles[condition.fieldId] !== expected) {
        throw new Error(`Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${String(expected)}, observed ${String(state.toggles[condition.fieldId])}.`);
      }
      continue;
    }

    if (condition.fieldId === 'company') {
      const expected = readBossTextApplicationFilterValues(condition).join(' ');
      if (state.company !== expected) {
        throw new Error(`Boss direct search postcondition mismatch for company: expected ${expected}, observed ${state.company || '(empty)'}.`);
      }
      continue;
    }

    const label = bossMoreApplicationFilterLabelByFieldId[condition.fieldId];
    if (label) {
      const expected = readBossApplicationFilterSingleValue(condition);
      if (state.more[label] !== expected) {
        throw new Error(`Boss direct search postcondition mismatch for ${condition.fieldId}: expected ${expected}, observed ${state.more[label] ?? '(unselected)'}.`);
      }
    }
  }

  const candidatePositionRequested = conditions.some((condition) => (
    isApplicationFilterCondition(condition) && condition.fieldId === 'candidate_position_requirement'
  ));
  if (!candidatePositionRequested && state.more['牛人职位要求'] !== undefined) {
    throw new Error(`Boss direct search postcondition mismatch for candidate_position_requirement: expected unselected, observed ${state.more['牛人职位要求']}.`);
  }
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
  const snapshots = await collectBossCandidateSnapshots(page, deadline);
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

async function openBossResumeDetail(_context: BrowserContext, searchPage: Page, candidate: CandidateListItem): Promise<Page> {
  const deadline = createResumeDetailDeadline();
  await closeExistingBossResumeDialog(searchPage, deadline);

  const frame = await waitForBossSearchFrame(searchPage, deadline);
  const targetIndex = await resolveBossCandidateAnchorIndex(searchPage, candidate, deadline);
  const candidateAnchor = frame.locator('a[ka="search_click_open_resume"], a[data-expect], a[data-jid], a[data-lid]').nth(targetIndex);
  const safeClickTarget = candidateAnchor.locator('.geek-info-detail, .search-geek-info, .card-inner').first();
  const clickable = await safeClickTarget.count().catch(() => 0) > 0 ? safeClickTarget : candidateAnchor;

  await clickBossLocator(clickable, searchPage, remainingTime(deadline), { position: { x: 24, y: 24 } });
  await waitForBossResumeDetailReady(searchPage, deadline);
  return searchPage;
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

export async function openBossLoginPage(page: Page): Promise<void> {
  await runBossPageAction(page, () => page.goto(bossLoginUrl, { waitUntil: 'domcontentloaded' }));
}

export async function closeBossResumeDetail(page: Page): Promise<void> {
  await closeExistingBossResumeDialog(page, createResumeDetailDeadline(), { pace: false });
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
