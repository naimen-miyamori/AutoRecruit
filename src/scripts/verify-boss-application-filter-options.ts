import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import type { ApplicationFilterField, ApplicationFilterOptions } from '../search/filter-application-options.js';
import {
  applyBossSearchCondition,
  assertBossSearchFilterStateRestorable,
  readBossSearchConditionResultTotal,
  resetBossSearchFilters,
  restoreBossSearchFilterState,
  snapshotBossSearchFilterState,
} from '../platforms/boss/actions/filter-actions.js';
import type { SearchCondition } from '../types/job.js';

export interface VerifyBossApplicationFilterOptionsCliInput {
  optionsPath?: string;
  outputPath?: string;
  fieldIds?: string[];
  offset: number;
  limit?: number;
  includeDefaults: boolean;
  run: boolean;
  stopOnFailure?: boolean;
}

export interface BossApplicationFilterVerificationCase {
  caseId: string;
  fieldId: string;
  label: string;
  fieldKind: ApplicationFilterField['kind'];
  valueLabel: string;
  applicationFilterInput: Record<string, unknown>;
  runnable: boolean;
  skipReason?: string;
}

export interface VerifyBossApplicationFilterOptionsSummary {
  platform: 'boss';
  optionsPath: string;
  outputPath: string;
  run: boolean;
  totalCases: number;
  selectedCases: number;
  plannedCases: number;
  policyGaps: number;
  applied?: number;
  failed?: number;
  restored?: boolean;
  offset: number;
  limit?: number;
  fieldIds?: string[];
}

const runnableBossFieldIds = new Set([
  'education',
  'school_nature',
  'work_years',
  'gender',
  'recent_activity_time',
  'job_hopping_count',
  'job_status',
  'candidate_position_requirement',
  'age',
  'expected_salary',
  'filter_recent_viewed',
  'no_colleague_resume_exchange',
  'city',
  'job_scope',
  'company',
  'major',
]);

function parseBoolean(value: string | undefined, argumentName: string): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${argumentName} must be true or false`);
}

function parseNonNegativeInteger(value: string | undefined, argumentName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${argumentName} must be a non-negative integer`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): VerifyBossApplicationFilterOptionsCliInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for argument --${key}`);
    values.set(key, value);
    index += 1;
  }
  const fieldIds = values.get('field')?.split(',').map((item) => item.trim()).filter(Boolean);
  return {
    optionsPath: values.get('options-path')?.trim() || undefined,
    outputPath: values.get('output')?.trim() || undefined,
    fieldIds: fieldIds && fieldIds.length > 0 ? fieldIds : undefined,
    offset: parseNonNegativeInteger(values.get('offset'), '--offset') ?? 0,
    limit: parseNonNegativeInteger(values.get('limit'), '--limit'),
    includeDefaults: values.has('include-defaults') ? parseBoolean(values.get('include-defaults'), '--include-defaults') : true,
    run: values.has('run') ? parseBoolean(values.get('run'), '--run') : false,
    stopOnFailure: values.has('stop-on-failure') ? parseBoolean(values.get('stop-on-failure'), '--stop-on-failure') : true,
  };
}

function isDefaultValue(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  return compact === '不限' || compact.includes('不限）') || compact.includes('(不限)') || compact.includes('（不限）');
}

function caseIdPart(value: string): string {
  return value.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'value';
}

function createCase(
  field: ApplicationFilterField,
  valueLabel: string,
  value: unknown,
  index: number,
  skipReason?: string,
): BossApplicationFilterVerificationCase {
  const supported = runnableBossFieldIds.has(field.fieldId);
  return {
    caseId: `${field.fieldId}-${String(index).padStart(3, '0')}-${caseIdPart(valueLabel)}`,
    fieldId: field.fieldId,
    label: field.label,
    fieldKind: field.kind,
    valueLabel,
    applicationFilterInput: { [field.fieldId]: value },
    runnable: supported && !skipReason,
    skipReason: skipReason ?? (supported ? undefined : `Boss application-filter replay is not implemented for ${field.fieldId}.`),
  };
}

function listSingleSelectCases(field: Extract<ApplicationFilterField, { kind: 'singleSelect' }>, input: VerifyBossApplicationFilterOptionsCliInput): BossApplicationFilterVerificationCase[] {
  const cases = field.options
    .filter((option) => !option.disabled)
    .filter((option) => input.includeDefaults || !isDefaultValue(option.value || option.label))
    .map((option, index) => createCase(
      field,
      option.label,
      option.value || option.label,
      index,
      option.inputSpec ? 'Custom option requires generated slider boundaries.' : undefined,
    ));
  let generatedCustomCases = false;
  for (const option of field.options.filter((item) => !item.disabled && item.inputSpec)) {
    const inputSpec = option.inputSpec;
    if (!inputSpec) continue;
    const minOptions = inputSpec.fields.find((item) => item.key === 'min')?.options ?? [];
    const maxOptions = inputSpec.fields.find((item) => item.key === 'max')?.options ?? [];
    if (minOptions.length === 0 || maxOptions.length === 0) continue;
    generatedCustomCases = true;
    const minimum = Number(minOptions[0]);
    const maximum = Number(maxOptions.at(-1));
    const boundaries = [...new Set([...minOptions, ...maxOptions])]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= minimum && value <= maximum)
      .sort((left, right) => left - right);
    for (const boundary of boundaries) {
      if (boundary !== minimum) {
        cases.push(createCase(field, `自定义:${boundary}-${maximum}`, {
          label: option.label,
          input: { min: String(boundary), max: String(maximum) },
        }, cases.length));
      }
      if (boundary !== minimum && boundary !== maximum) {
        cases.push(createCase(field, `自定义:${minimum}-${boundary}`, {
          label: option.label,
          input: { min: String(minimum), max: String(boundary) },
        }, cases.length));
      }
    }
  }
  return generatedCustomCases
    ? cases.filter((item) => item.skipReason !== 'Custom option requires generated slider boundaries.')
    : cases;
}

function listMultiSelectCases(field: Extract<ApplicationFilterField, { kind: 'multiSelect' }>, input: VerifyBossApplicationFilterOptionsCliInput): BossApplicationFilterVerificationCase[] {
  const values = field.allowedValues.filter((value) => input.includeDefaults || !isDefaultValue(value));
  const cases = values.map((value, index) => createCase(field, value, [value], index));
  const specific = values.filter((value) => !isDefaultValue(value));
  if (specific.length >= 2) cases.push(createCase(field, `${specific[0]} + ${specific[1]}`, [specific[0], specific[1]], cases.length));
  return cases;
}

function listToggleCases(field: Extract<ApplicationFilterField, { kind: 'toggle' }>): BossApplicationFilterVerificationCase[] {
  return [false, true].map((value, index) => createCase(field, String(value), value, index));
}

function listRangeCases(field: Extract<ApplicationFilterField, { kind: 'salaryRange' | 'numberRange' }>, input: VerifyBossApplicationFilterOptionsCliInput): BossApplicationFilterVerificationCase[] {
  if (field.kind === 'numberRange' && field.fieldId === 'age') {
    const numericValues = field.orderedValues
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    const pairs = [
      { min: '不限', max: '不限' },
      ...numericValues.slice(0, -1).map((value, index) => ({ min: String(value), max: String(numericValues[index + 1]!) })),
      ...(numericValues.length > 0 ? [{ min: String(numericValues.at(-1)!), max: '不限' }] : []),
    ];
    return pairs
      .filter((pair) => input.includeDefaults || pair.min !== '不限')
      .map((pair, index) => createCase(field, `${pair.min}-${pair.max}`, pair, index));
  }
  const values = [...new Set([...field.minOptions, ...field.maxOptions])]
    .filter((value) => input.includeDefaults || !isDefaultValue(value));
  return values.map((value, index) => createCase(field, `${value}-${value}`, { min: value, max: value }, index));
}

function listTextInputCases(field: Extract<ApplicationFilterField, { kind: 'textInput' }>): BossApplicationFilterVerificationCase[] {
  const values = [...new Set(field.allowedValues.map((value) => value.trim()).filter(Boolean))];
  if (values.length > 0) {
    return values.map((value, index) => createCase(field, value, value, index));
  }
  if (field.fieldId === 'company') {
    return [createCase(field, 'non-sensitive-seed', '测试公司', 0)];
  }
  return [createCase(field, 'dynamic-input', '', 0, 'Dynamic suggestion discovery did not expose a finite option set yet.')];
}

export function buildBossApplicationFilterOptionVerificationCases(
  options: ApplicationFilterOptions,
  input: VerifyBossApplicationFilterOptionsCliInput,
): BossApplicationFilterVerificationCase[] {
  if (options.platform !== 'boss') throw new Error(`Boss option verification requires boss application options, got ${options.platform}`);
  const cases: BossApplicationFilterVerificationCase[] = [];
  for (const fieldId of options.fieldIds) {
    if (input.fieldIds && !input.fieldIds.includes(fieldId)) continue;
    const field = options.fieldsById[fieldId];
    if (!field) continue;
    if (field.kind === 'singleSelect') cases.push(...listSingleSelectCases(field, input));
    else if (field.kind === 'multiSelect') cases.push(...listMultiSelectCases(field, input));
    else if (field.kind === 'toggle') cases.push(...listToggleCases(field));
    else if (field.kind === 'salaryRange' || field.kind === 'numberRange') cases.push(...listRangeCases(field, input));
    else if (field.kind === 'textInput') cases.push(...listTextInputCases(field));
    else cases.push(createCase(field, 'dynamic-input', '', 0, 'Dynamic suggestion/text verification requires a declared seed and complete restore-capable action.'));
  }
  return cases;
}

function defaultOptionsPath(): string {
  return path.join(config.dataDir, 'boss', 'filter-catalog', 'application-filter-options.latest.json');
}

function defaultOutputPath(): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(config.dataDir, 'boss', 'filter-catalog', 'option-verification', `${suffix}.plan.json`);
}

function defaultLiveOutputPath(): string {
  return path.join(config.dataDir, 'boss', 'filter-catalog', 'option-verification', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
}

function buildLiveCondition(testCase: BossApplicationFilterVerificationCase): SearchCondition {
  const value = testCase.applicationFilterInput[testCase.fieldId];
  const values = Array.isArray(value)
    ? value.map((item) => ({ value: String(item) }))
    : typeof value === 'boolean'
      ? [{ value: String(value) }]
      : value && typeof value === 'object'
        ? [
          { value: String((value as Record<string, unknown>).min ?? '') },
          { value: String((value as Record<string, unknown>).max ?? '') },
        ]
        : [{ value: String(value ?? '') }];
  return {
    kind: 'applicationFilter',
    fieldId: testCase.fieldId,
    label: testCase.label,
    fieldKind: testCase.fieldKind,
    value,
    values,
  };
}

function assertLiveCasePostcondition(
  field: ApplicationFilterField,
  value: unknown,
  state: Awaited<ReturnType<typeof snapshotBossSearchFilterState>>,
): void {
  if (field.kind === 'toggle') {
    const actual = state.toggles[field.fieldId as keyof typeof state.toggles];
    if (actual !== value) throw new Error(`${field.fieldId} toggle postcondition mismatch.`);
    return;
  }
  if (field.kind === 'multiSelect') {
    if (field.fieldId === 'city') {
      // The page clears the transient panel checkmarks immediately after the
      // confirmed selection. applyBossSearchCondition verifies the exact panel
      // set before confirmation; result-total reading below verifies the
      // confirmed search state without reopening and mutating the panel again.
      return;
    }
    const expected = Array.isArray(value)
      ? value.map((item) => {
        const raw = String(item);
        return field.options.find((option) => option.value === raw || option.label === raw)?.label ?? raw;
      }).sort()
      : [];
    const actual = field.fieldId === 'city'
      ? [...(state.cityOptions ?? [])].sort()
      : [...state.inline.school_nature].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${field.fieldId} multi-select postcondition mismatch.`);
    return;
  }
  if (field.kind === 'singleSelect') {
    if (typeof value === 'object' && value && !Array.isArray(value)) {
      const custom = value as { label?: unknown; input?: { min?: unknown; max?: unknown } };
      const min = String(custom.input?.min ?? '');
      const max = String(custom.input?.max ?? '');
      const actual = state.inline[field.fieldId as 'education' | 'work_years'];
      if (!actual?.includes(`custom:${min}-${max}`)) {
        throw new Error(`${field.fieldId} custom slider postcondition mismatch.`);
      }
      return;
    }
    const expected = String(value);
    if (field.fieldId === 'job_scope') {
      const expectedIndex = field.options.findIndex((option) => option.value === expected || option.label === expected);
      if (expectedIndex < 0 || state.jobScopeIndex !== expectedIndex) throw new Error('job_scope postcondition mismatch.');
      return;
    }
    if (field.fieldId === 'education' || field.fieldId === 'work_years') {
      const actual = state.inline[field.fieldId];
      if (!actual.includes(expected)) throw new Error(`${field.fieldId} inline postcondition mismatch.`);
      return;
    }
    const actual = state.more[field.label];
    const expectedDisplay = expected === '不限' ? field.label : expected;
    if (actual !== expectedDisplay) throw new Error(`${field.fieldId} dropdown postcondition mismatch.`);
    return;
  }
  if (field.kind === 'numberRange') {
    const input = value as { min?: unknown; max?: unknown };
    const min = String(input.min ?? '不限');
    const max = String(input.max ?? '不限');
    const expectedPreset = min === '不限' && max === '不限'
      ? '不限'
      : min === '50' && max === '不限'
        ? '50以上'
        : `${min}-${max}`;
    if (!state.inline.age.includes(expectedPreset) && !state.inline.age.includes(`custom:${min}-${max}`)) {
      throw new Error(`${field.fieldId} range postcondition mismatch.`);
    }
    return;
  }
  if (field.kind === 'salaryRange') {
    const input = value as { min?: unknown; max?: unknown };
    const min = String(input.min ?? '');
    const max = String(input.max ?? '');
    const actual = state.more['薪资区间'] ?? '';
    if (!actual.includes(min) || !actual.includes(max)) throw new Error(`${field.fieldId} salary postcondition mismatch.`);
    return;
  }
  if (field.kind === 'textInput') {
    const expected = String(value);
    if (field.fieldId === 'company') {
      if (state.company !== expected) throw new Error('company text postcondition mismatch.');
      return;
    }
    const actual = state.more[field.label] ?? '';
    if (!actual.includes(expected)) throw new Error(`${field.fieldId} token postcondition mismatch.`);
    return;
  }
  throw new Error('Boss live verification encountered an unsupported filter postcondition.');
}

export async function verifyBossApplicationFilterOptions(
  input: VerifyBossApplicationFilterOptionsCliInput,
): Promise<VerifyBossApplicationFilterOptionsSummary> {
  const optionsPath = path.resolve(input.optionsPath ?? defaultOptionsPath());
  const outputPath = path.resolve(input.outputPath ?? (input.run ? defaultLiveOutputPath() : defaultOutputPath()));
  const options = JSON.parse(await fs.readFile(optionsPath, 'utf8')) as ApplicationFilterOptions;
  const allCases = buildBossApplicationFilterOptionVerificationCases(options, input);
  const selectedCases = allCases.slice(input.offset, input.limit === undefined ? undefined : input.offset + input.limit);
  if (input.run) {
    const session = await ensureAuthenticatedBrowserSession('boss');
    const rehearsalDeadline = Date.now() + Math.max(config.playwright.searchPageTimeoutMs * 3, 90_000);
    const perCaseTimeoutMs = Math.max(config.playwright.searchPageTimeoutMs * 2, 60_000);
    const records: Array<Record<string, unknown>> = [];
    let entryState: Awaited<ReturnType<typeof snapshotBossSearchFilterState>> | undefined;
    let restored = false;
    try {
      entryState = await snapshotBossSearchFilterState(session.page, rehearsalDeadline);
      assertBossSearchFilterStateRestorable(entryState);
      await resetBossSearchFilters(session.page, rehearsalDeadline);
      await restoreBossSearchFilterState(session.page, entryState, rehearsalDeadline);

      for (const testCase of selectedCases) {
        const startedAt = new Date();
        const field = options.fieldsById[testCase.fieldId];
        if (!field || !testCase.runnable) {
          records.push({
            caseId: testCase.caseId,
            fieldId: testCase.fieldId,
            status: 'skipped',
            reason: testCase.skipReason ?? 'field unavailable',
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          });
          continue;
        }
        try {
          const caseDeadline = Date.now() + perCaseTimeoutMs;
          await resetBossSearchFilters(session.page, caseDeadline);
          const condition = buildLiveCondition(testCase);
          const result = await applyBossSearchCondition(session.page, condition, caseDeadline);
          if (result.status !== 'applied') throw new Error(result.message ?? `${testCase.fieldId} ${result.status}`);
          const state = await snapshotBossSearchFilterState(session.page, caseDeadline);
          assertLiveCasePostcondition(field, testCase.applicationFilterInput[testCase.fieldId], state);
          await readBossSearchConditionResultTotal(session.page, { deadline: caseDeadline });
          await resetBossSearchFilters(session.page, caseDeadline);
          records.push({
            caseId: testCase.caseId,
            fieldId: testCase.fieldId,
            status: 'applied',
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          });
        } catch (error) {
          records.push({
            caseId: testCase.caseId,
            fieldId: testCase.fieldId,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          });
          if (input.stopOnFailure ?? true) break;
        }
      }
    } finally {
      if (entryState) {
        const restoreDeadline = Date.now() + Math.max(config.playwright.searchPageTimeoutMs * 3, 90_000);
        await restoreBossSearchFilterState(session.page, entryState, restoreDeadline);
        restored = true;
      }
      await closeBrowserSession(session);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    return {
      platform: 'boss', optionsPath, outputPath, run: true,
      totalCases: allCases.length,
      selectedCases: selectedCases.length,
      plannedCases: selectedCases.filter((item) => item.runnable).length,
      policyGaps: selectedCases.filter((item) => !item.runnable).length,
      applied: records.filter((record) => record.status === 'applied').length,
      failed: records.filter((record) => record.status === 'failed').length,
      restored,
      offset: input.offset,
      limit: input.limit,
      fieldIds: input.fieldIds,
    };
  }
  const summary: VerifyBossApplicationFilterOptionsSummary = {
    platform: 'boss', optionsPath, outputPath, run: false,
    totalCases: allCases.length,
    selectedCases: selectedCases.length,
    plannedCases: selectedCases.filter((item) => item.runnable).length,
    policyGaps: selectedCases.filter((item) => !item.runnable).length,
    offset: input.offset,
    limit: input.limit,
    fieldIds: input.fieldIds,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({ summary, cases: selectedCases }, null, 2)}\n`, 'utf8');
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  console.log(JSON.stringify(await verifyBossApplicationFilterOptions(parseArgs(argv)), null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
