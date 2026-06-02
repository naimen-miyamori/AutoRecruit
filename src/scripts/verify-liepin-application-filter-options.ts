import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { ensureAuthenticatedBrowserSession, closeBrowserSession, type BrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { SearchWaitOptions } from '../platforms/types.js';
import {
  buildApplicationFilterConditions,
} from '../search/search-subscription.js';
import type {
  ApplicationFilterField,
  ApplicationFilterOptions,
  ApplicationFilterTextInputField,
} from '../search/filter-application-options.js';
import type { SearchFilterTextInputPoolNode } from '../search/filter-input-pool.js';
import type { SearchConditionApplyResult } from '../types/job.js';

export interface VerifyLiepinApplicationFilterOptionsCliInput {
  keyword?: string;
  optionsPath?: string;
  outputPath?: string;
  run: boolean;
  offset: number;
  limit?: number;
  fieldIds?: string[];
  includeDefaults: boolean;
  includeRangeCombinations: boolean;
  includePolicySkips: boolean;
  stopOnFailure: boolean;
  freeTextSamples: Record<string, string>;
}

export interface LiepinApplicationFilterOptionVerificationCase {
  caseId: string;
  fieldId: string;
  label: string;
  fieldKind: ApplicationFilterField['kind'];
  valueLabel: string;
  applicationFilterInput: Record<string, unknown>;
  runnable: boolean;
  skipReason?: string;
}

export interface LiepinApplicationFilterOptionVerificationRecord {
  caseId: string;
  fieldId: string;
  label: string;
  fieldKind: ApplicationFilterField['kind'];
  valueLabel: string;
  applicationFilterInput: Record<string, unknown>;
  status: SearchConditionApplyResult['status'] | 'planned';
  resultTotal?: number;
  resultTotalSource?: 'page' | 'api';
  message?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface VerifyLiepinApplicationFilterOptionsSummary {
  platform: 'liepin';
  keyword: string;
  optionsPath: string;
  outputPath: string;
  run: boolean;
  totalCases: number;
  selectedCases: number;
  plannedCases: number;
  applied: number;
  skipped: number;
  failed: number;
  offset: number;
  limit?: number;
  fieldIds?: string[];
}

const supportedLiepinApplicationFilterFieldIds = new Set([
  'work_years',
  'education',
  'school_nature',
  'recent_activity_time',
  'gender',
  'language',
  'living_location',
  'expected_location',
  'expected_salary',
  'current_salary',
  'job_hopping_count',
  'job_status',
  'resume_language',
  'overseas_work_experience',
  'management_experience',
  'age',
  'engaged_industry',
  'engaged_function',
  'expected_industry',
  'expected_function',
  'company_name',
  'school_name',
  'major',
]);

const policySkipReasonsByFieldId: Record<string, string> = {
  keyword_title: '`keyword_title` is controlled by the search-subscription keyword input, not replayed as applicationFilter.',
  recruitment_type: '`recruitment_type` currently only exposes the default unlimited value on Liepin.',
};

const liepinIndustryCategoryLabels = new Set([
  'AI/互联网/IT',
  '消费品',
  '生活服务',
  '交通/物流/贸易/零售',
]);

const defaultFreeTextSamples: Record<string, string> = {
  keyword_title: '店长',
  company_name: '迅销',
  school_name: '辽宁大学',
  major: '新闻学',
};

function parseBoolean(value: string | undefined, argumentName: string): boolean {
  if (value === undefined) {
    return true;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${argumentName} must be true or false`);
}

function parseNonNegativeInteger(value: string | undefined, argumentName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${argumentName} must be a non-negative integer`);
  }

  return parsed;
}

function parseStringMap(value: string | undefined, argumentName: string): Record<string, string> {
  if (value === undefined || value.trim() === '') {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${argumentName} must be a JSON object`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${argumentName}.${key} must be a non-empty string`);
    }
    result[key] = item.trim();
  }

  return result;
}

function parseFieldIds(value: string | undefined): string[] | undefined {
  const fieldIds = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fieldIds && fieldIds.length > 0 ? fieldIds : undefined;
}

export function parseArgs(argv: readonly string[]): VerifyLiepinApplicationFilterOptionsCliInput {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  return {
    keyword: values.get('keyword')?.trim() || undefined,
    optionsPath: values.get('options-path')?.trim() || undefined,
    outputPath: values.get('output')?.trim() || undefined,
    run: values.has('run') ? parseBoolean(values.get('run'), '--run') : false,
    offset: parseNonNegativeInteger(values.get('offset'), '--offset') ?? 0,
    limit: parseNonNegativeInteger(values.get('limit'), '--limit'),
    fieldIds: parseFieldIds(values.get('field')),
    includeDefaults: values.has('include-defaults')
      ? parseBoolean(values.get('include-defaults'), '--include-defaults')
      : true,
    includeRangeCombinations: values.has('include-range-combinations')
      ? parseBoolean(values.get('include-range-combinations'), '--include-range-combinations')
      : false,
    includePolicySkips: values.has('include-policy-skips')
      ? parseBoolean(values.get('include-policy-skips'), '--include-policy-skips')
      : true,
    stopOnFailure: values.has('stop-on-failure')
      ? parseBoolean(values.get('stop-on-failure'), '--stop-on-failure')
      : false,
    freeTextSamples: {
      ...defaultFreeTextSamples,
      ...parseStringMap(values.get('free-text-samples'), '--free-text-samples'),
    },
  };
}

function buildDefaultOptionsPath(): string {
  return path.join(config.dataDir, 'liepin', 'filter-catalog', 'application-filter-options.latest.json');
}

function buildDefaultOutputPath(run: boolean): string {
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.${run ? 'jsonl' : 'plan.json'}`;
  return path.join(config.dataDir, 'liepin', 'filter-catalog', 'option-verification', fileName);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function normalizeValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isDefaultOption(value: string): boolean {
  const normalizedValue = value.replace(/\s+/g, '');
  return normalizedValue === '不限'
    || normalizedValue.includes('不限）')
    || normalizedValue.includes('(不限)')
    || normalizedValue.includes('（不限）');
}

function sanitizeCaseIdPart(value: string): string {
  return value
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'value';
}

function createCase(
  field: ApplicationFilterField,
  valueLabel: string,
  value: unknown,
  index: number,
  options: Pick<VerifyLiepinApplicationFilterOptionsCliInput, 'includePolicySkips'>,
): LiepinApplicationFilterOptionVerificationCase | undefined {
  const policySkipReason = policySkipReasonsByFieldId[field.fieldId];
  const normalizedValueLabel = normalizeValue(valueLabel);
  const valueSkipReason = (field.fieldId === 'engaged_industry' || field.fieldId === 'expected_industry')
    && liepinIndustryCategoryLabels.has(normalizedValueLabel)
    ? `Liepin industry category "${normalizedValueLabel}" is a parent label in historical catalogs and is not confirmed as a directly selectable replay value.`
    : undefined;
  const supported = supportedLiepinApplicationFilterFieldIds.has(field.fieldId);
  const runnable = supported && !policySkipReason && !valueSkipReason;
  const skipReason = policySkipReason
    ?? valueSkipReason
    ?? (supported ? undefined : `Liepin applicationFilter replay is not implemented for ${field.fieldId}.`);

  if (!runnable && !options.includePolicySkips) {
    return undefined;
  }

  return {
    caseId: `${field.fieldId}-${String(index).padStart(3, '0')}-${sanitizeCaseIdPart(valueLabel)}`,
    fieldId: field.fieldId,
    label: field.label,
    fieldKind: field.kind,
    valueLabel,
    applicationFilterInput: {
      [field.fieldId]: value,
    },
    runnable,
    skipReason,
  };
}

function isLiepinIndustryTextInputField(
  field: Extract<ApplicationFilterField, { kind: 'textInput' }>,
): field is ApplicationFilterTextInputField {
  return field.fieldId === 'engaged_industry' || field.fieldId === 'expected_industry';
}

function listTextInputLeafNodes(
  nodes: readonly SearchFilterTextInputPoolNode[],
): SearchFilterTextInputPoolNode[] {
  const leafNodes: SearchFilterTextInputPoolNode[] = [];
  const visit = (node: SearchFilterTextInputPoolNode) => {
    if (node.children.length === 0) {
      leafNodes.push(node);
      return;
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return leafNodes;
}

function listIndustryPathTextInputCases(
  field: ApplicationFilterTextInputField,
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] | undefined {
  const leafNodes = listTextInputLeafNodes(field.tree)
    .filter((node) => node.pathLabels.length > 1)
    .filter((node) => input.includeDefaults || !isDefaultOption(node.label));

  if (leafNodes.length === 0) {
    return undefined;
  }

  return leafNodes
    .map((node, index) => createCase(
      field,
      node.pathLabels.join(' > '),
      {
        value: node.label,
        pathLabels: node.pathLabels,
      },
      index,
      input,
    ))
    .filter((item): item is LiepinApplicationFilterOptionVerificationCase => Boolean(item));
}

function listSingleSelectCases(
  field: Extract<ApplicationFilterField, { kind: 'singleSelect' }>,
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] {
  return field.allowedValues
    .filter((value) => input.includeDefaults || !isDefaultOption(value))
    .map((value, index) => createCase(field, value, value, index, input))
    .filter((item): item is LiepinApplicationFilterOptionVerificationCase => Boolean(item));
}

function listTextInputCases(
  field: Extract<ApplicationFilterField, { kind: 'textInput' }>,
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] {
  if (isLiepinIndustryTextInputField(field)) {
    const industryPathCases = listIndustryPathTextInputCases(field, input);
    if (industryPathCases) {
      return industryPathCases;
    }
  }

  const values = field.restrictInput
    ? field.allowedValues.filter((value) => input.includeDefaults || !isDefaultOption(value))
    : [input.freeTextSamples[field.fieldId] ?? field.allowedValues.find((value) => !/^请输入/.test(value)) ?? field.allowedValues[0]];

  return values
    .map(normalizeValue)
    .filter(Boolean)
    .map((value, index) => createCase(field, value, value, index, input))
    .filter((item): item is LiepinApplicationFilterOptionVerificationCase => Boolean(item));
}

function parseOrderedBoundaryValue(value: string): number | undefined {
  if (value === '不限') {
    return 0;
  }

  const matched = value.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)/);
  if (!matched) {
    return undefined;
  }

  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidOrderedRange(min: string, max: string): boolean {
  const minValue = parseOrderedBoundaryValue(min);
  const maxValue = parseOrderedBoundaryValue(max);
  return minValue !== undefined && maxValue !== undefined && maxValue >= minValue;
}

function buildRepresentativeRangePairs(values: string[]): Array<{ min: string; max: string }> {
  const pairs: Array<{ min: string; max: string }> = [];
  const seen = new Set<string>();
  const addPair = (min: string, max: string) => {
    if (!isValidOrderedRange(min, max)) {
      return;
    }

    const key = `${min}\u0000${max}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    pairs.push({ min, max });
  };

  if (values.length === 0) {
    return pairs;
  }

  addPair(values[0], values[0]);
  for (let index = 0; index < values.length; index += 1) {
    addPair(values[index], values[Math.min(index + 1, values.length - 1)]);
  }

  return pairs;
}

function buildRangePairs(
  minOptions: string[],
  maxOptions: string[],
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): Array<{ min: string; max: string }> {
  const filteredMinOptions = minOptions.filter((value) => input.includeDefaults || !isDefaultOption(value));
  const filteredMaxOptions = maxOptions.filter((value) => input.includeDefaults || !isDefaultOption(value));

  if (!input.includeRangeCombinations) {
    return buildRepresentativeRangePairs(filteredMinOptions.length > 0 ? filteredMinOptions : filteredMaxOptions);
  }

  const pairs: Array<{ min: string; max: string }> = [];
  for (const min of filteredMinOptions) {
    for (const max of filteredMaxOptions) {
      if (isValidOrderedRange(min, max)) {
        pairs.push({ min, max });
      }
    }
  }

  return pairs;
}

function listRangeCases(
  field: Extract<ApplicationFilterField, { kind: 'salaryRange' | 'numberRange' }>,
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] {
  const pairs = buildRangePairs(field.minOptions, field.maxOptions, input);
  return pairs
    .map((pair, index) => createCase(field, `${pair.min}-${pair.max}`, pair, index, input))
    .filter((item): item is LiepinApplicationFilterOptionVerificationCase => Boolean(item));
}

export function buildLiepinApplicationFilterOptionVerificationCases(
  applicationOptions: ApplicationFilterOptions,
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] {
  if (applicationOptions.platform !== 'liepin') {
    throw new Error(`Liepin option verification requires liepin application options, got ${applicationOptions.platform}`);
  }

  const cases: LiepinApplicationFilterOptionVerificationCase[] = [];
  for (const fieldId of applicationOptions.fieldIds) {
    if (input.fieldIds && !input.fieldIds.includes(fieldId)) {
      continue;
    }

    const field = applicationOptions.fieldsById[fieldId];
    if (!field) {
      continue;
    }

    if (field.kind === 'singleSelect') {
      cases.push(...listSingleSelectCases(field, input));
      continue;
    }

    if (field.kind === 'textInput') {
      cases.push(...listTextInputCases(field, input));
      continue;
    }

    cases.push(...listRangeCases(field, input));
  }

  return cases;
}

function sliceCases(
  cases: LiepinApplicationFilterOptionVerificationCase[],
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): LiepinApplicationFilterOptionVerificationCase[] {
  const start = Math.min(input.offset, cases.length);
  const end = input.limit === undefined ? cases.length : Math.min(start + input.limit, cases.length);
  return cases.slice(start, end);
}

async function writePlanFile(
  outputPath: string,
  summary: VerifyLiepinApplicationFilterOptionsSummary,
  cases: LiepinApplicationFilterOptionVerificationCase[],
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({ summary, cases }, null, 2)}\n`, 'utf8');
}

async function appendRecord(outputPath: string, record: LiepinApplicationFilterOptionVerificationRecord): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function countRecords(
  records: LiepinApplicationFilterOptionVerificationRecord[],
): Pick<VerifyLiepinApplicationFilterOptionsSummary, 'plannedCases' | 'applied' | 'skipped' | 'failed'> {
  return {
    plannedCases: records.filter((record) => record.status === 'planned').length,
    applied: records.filter((record) => record.status === 'applied').length,
    skipped: records.filter((record) => record.status === 'skipped').length,
    failed: records.filter((record) => record.status === 'failed').length,
  };
}

function createRecordBase(
  testCase: LiepinApplicationFilterOptionVerificationCase,
  startedAtDate: Date,
): Omit<LiepinApplicationFilterOptionVerificationRecord, 'status' | 'finishedAt' | 'durationMs'> {
  return {
    caseId: testCase.caseId,
    fieldId: testCase.fieldId,
    label: testCase.label,
    fieldKind: testCase.fieldKind,
    valueLabel: testCase.valueLabel,
    applicationFilterInput: testCase.applicationFilterInput,
    startedAt: startedAtDate.toISOString(),
  };
}

async function runSingleCase(
  testCase: LiepinApplicationFilterOptionVerificationCase,
  options: {
    keyword: string;
    optionsPath: string;
    outputPath: string;
    page: Page;
    adapter: ReturnType<typeof getPlatformAdapter>;
  },
): Promise<LiepinApplicationFilterOptionVerificationRecord> {
  const startedAtDate = new Date();
  const base = createRecordBase(testCase, startedAtDate);

  if (!testCase.runnable) {
    const finishedAtDate = new Date();
    const record = {
      ...base,
      status: 'skipped' as const,
      message: testCase.skipReason,
      finishedAt: finishedAtDate.toISOString(),
      durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    };
    await appendRecord(options.outputPath, record);
    return record;
  }

  try {
    const deadline = Date.now() + config.playwright.searchPageTimeoutMs;
    const searchOptions: SearchWaitOptions = { deadline };
    const searchPage = await options.adapter.prepareSearchConditionPage!(options.page, options.keyword, searchOptions);
    const [condition] = await buildApplicationFilterConditions('liepin', testCase.applicationFilterInput, {
      platform: 'liepin',
      applicationFilterOptionsPath: options.optionsPath,
    });
    if (!condition) {
      throw new Error(`No applicationFilter condition generated for ${testCase.caseId}`);
    }

    const conditionResult = await options.adapter.applySearchCondition!(searchPage, condition);
    let resultTotal: number | undefined;
    let resultTotalSource: 'page' | 'api' | undefined;
    if (conditionResult.status === 'applied') {
      const result = await options.adapter.readSearchConditionResultTotal!(searchPage, searchOptions);
      resultTotal = result.resultTotal;
      resultTotalSource = result.resultTotalSource;
    }

    const finishedAtDate = new Date();
    const record = {
      ...base,
      status: conditionResult.status,
      resultTotal,
      resultTotalSource,
      message: conditionResult.message,
      finishedAt: finishedAtDate.toISOString(),
      durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    };
    await appendRecord(options.outputPath, record);
    return record;
  } catch (error) {
    const finishedAtDate = new Date();
    const record = {
      ...base,
      status: 'failed' as const,
      message: error instanceof Error ? error.message : String(error),
      finishedAt: finishedAtDate.toISOString(),
      durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    };
    await appendRecord(options.outputPath, record);
    return record;
  }
}

function shouldRefreshSessionAfterRecord(
  session: BrowserSession,
  record: LiepinApplicationFilterOptionVerificationRecord,
): boolean {
  if (session.page.isClosed()) {
    return true;
  }

  return record.status === 'failed';
}

export async function verifyLiepinApplicationFilterOptions(
  input: VerifyLiepinApplicationFilterOptionsCliInput,
): Promise<VerifyLiepinApplicationFilterOptionsSummary> {
  const optionsPath = path.resolve(input.optionsPath ?? buildDefaultOptionsPath());
  const outputPath = path.resolve(input.outputPath ?? buildDefaultOutputPath(input.run));
  const applicationOptions = await readJsonFile<ApplicationFilterOptions>(optionsPath);
  const keyword = input.keyword ?? applicationOptions.keyword;
  const allCases = buildLiepinApplicationFilterOptionVerificationCases(applicationOptions, input);
  const selectedCases = sliceCases(allCases, input);

  if (!keyword.trim()) {
    throw new Error('Liepin option verification requires --keyword or applicationOptions.keyword.');
  }

  if (!input.run) {
    const plannedRecords = selectedCases.map((testCase) => {
      const now = new Date();
      return {
        ...createRecordBase(testCase, now),
        status: 'planned' as const,
        message: testCase.runnable ? undefined : testCase.skipReason,
        finishedAt: now.toISOString(),
        durationMs: 0,
      };
    });
    const summary: VerifyLiepinApplicationFilterOptionsSummary = {
      platform: 'liepin',
      keyword,
      optionsPath,
      outputPath,
      run: false,
      totalCases: allCases.length,
      selectedCases: selectedCases.length,
      offset: input.offset,
      limit: input.limit,
      fieldIds: input.fieldIds,
      ...countRecords(plannedRecords),
    };
    await writePlanFile(outputPath, summary, selectedCases);
    return summary;
  }

  const adapter = getPlatformAdapter('liepin');
  if (!adapter.prepareSearchConditionPage || !adapter.applySearchCondition || !adapter.readSearchConditionResultTotal) {
    throw new Error('Liepin adapter does not expose the search-condition verification contract.');
  }

  let session = await ensureAuthenticatedBrowserSession('liepin');
  const records: LiepinApplicationFilterOptionVerificationRecord[] = [];

  try {
    for (const testCase of selectedCases) {
      if (session.page.isClosed()) {
        await closeBrowserSession(session).catch(() => undefined);
        session = await ensureAuthenticatedBrowserSession('liepin');
      }

      const record = await runSingleCase(testCase, {
        keyword,
        optionsPath,
        outputPath,
        page: session.page,
        adapter,
      });
      records.push(record);

      if (shouldRefreshSessionAfterRecord(session, record) && !input.stopOnFailure) {
        await closeBrowserSession(session).catch(() => undefined);
        session = await ensureAuthenticatedBrowserSession('liepin');
      }

      if (input.stopOnFailure && record.status === 'failed') {
        break;
      }
    }
  } finally {
    await closeBrowserSession(session);
  }

  return {
    platform: 'liepin',
    keyword,
    optionsPath,
    outputPath,
    run: true,
    totalCases: allCases.length,
    selectedCases: records.length,
    offset: input.offset,
    limit: input.limit,
    fieldIds: input.fieldIds,
    ...countRecords(records),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await verifyLiepinApplicationFilterOptions(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
