import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { config } from '../config.js';
import type { PlatformAdapter, SearchWaitOptions } from '../platforms/types.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  validateApplicationFilterInput,
  type ApplicationFilterField,
  type ApplicationFilterOptions,
  type ApplicationFilterTextInputValueWithPath,
} from './filter-application-options.js';
import type {
  SearchCondition,
  SearchConditionApplyResult,
  SearchConditionPlan,
  SearchSubscriptionSummary,
} from '../types/job.js';

interface LoadSearchConditionPlanFileOptions {
  platform?: SupportedPlatform;
  keywordOverride?: string;
  savedSearchNameOverride?: string;
  applicationFilterOptionsPath?: string;
}

interface RunSearchSubscriptionWorkflowOptions extends SearchWaitOptions {
  save: boolean;
  savedSearchName?: string;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function parseCondition(value: unknown, index: number): SearchCondition {
  assertPlainObject(value, `conditions[${index}]`);

  if (typeof value.kind !== 'string' || !value.kind.trim()) {
    throw new Error(`conditions[${index}].kind must be a non-empty string`);
  }

  return value as SearchCondition;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function buildDefaultApplicationFilterOptionsPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

function normalizeInputValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findTextInputPathLabels(field: Extract<ApplicationFilterField, { kind: 'textInput' }>, value: string): string[] | undefined {
  const stack = [...field.tree];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }

    if (node.label === value) {
      return [...node.pathLabels];
    }

    stack.push(...node.children);
  }

  return undefined;
}

function findTextInputPathMatches(field: Extract<ApplicationFilterField, { kind: 'textInput' }>, value: string): string[][] {
  const matches: string[][] = [];
  const stack = [...field.tree];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }

    if (node.label === value) {
      matches.push([...node.pathLabels]);
    }

    stack.push(...node.children);
  }

  return matches;
}

function isTextInputValueWithPath(value: unknown): value is ApplicationFilterTextInputValueWithPath {
  return isPlainObject(value)
    && typeof value.value === 'string'
    && Array.isArray(value.pathLabels);
}

function findSingleSelectPathLabels(
  field: Extract<ApplicationFilterField, { kind: 'singleSelect' }>,
  value: string,
): string[] | undefined {
  const option = field.options.find((item) =>
    !item.disabled
    && !item.inputSpec
    && (normalizeInputValue(item.value) === value || normalizeInputValue(item.label) === value)
    && (item.pathLabels?.length ?? 0) > 0,
  );

  return option?.pathLabels ? [...option.pathLabels] : undefined;
}

function toApplicationFilterCondition(
  field: ApplicationFilterField,
  value: unknown,
): SearchCondition {
  if (field.kind === 'textInput') {
    const rawValues = Array.isArray(value) ? value : [value];
    const values = rawValues.map((item) => {
      const normalizedValue = isTextInputValueWithPath(item)
        ? normalizeInputValue(item.value)
        : normalizeInputValue(item);
      const explicitPathLabels = isTextInputValueWithPath(item)
        ? item.pathLabels.map(normalizeInputValue).filter(Boolean)
        : undefined;
      const pathMatches = explicitPathLabels ? [] : findTextInputPathMatches(field, normalizedValue);
      return {
        value: normalizedValue,
        pathLabels: explicitPathLabels ?? pathMatches[0] ?? findTextInputPathLabels(field, normalizedValue),
        ambiguous: !explicitPathLabels && pathMatches.length > 1,
      };
    });

    return {
      kind: 'applicationFilter',
      fieldId: field.fieldId,
      label: field.label,
      fieldKind: field.kind,
      value,
      values,
    };
  }

  if (field.kind === 'salaryRange' && isPlainObject(value)) {
    return {
      kind: 'applicationFilter',
      fieldId: field.fieldId,
      label: field.label,
      fieldKind: field.kind,
      value,
      values: [
        { value: normalizeInputValue(value.min) },
        { value: normalizeInputValue(value.max) },
      ],
    };
  }

  const normalizedValue = isPlainObject(value) ? normalizeInputValue(value.label) : normalizeInputValue(value);
  return {
    kind: 'applicationFilter',
    fieldId: field.fieldId,
    label: field.label,
    fieldKind: field.kind,
    value,
    values: normalizedValue
      ? [{
        value: normalizedValue,
        pathLabels: field.kind === 'singleSelect' ? findSingleSelectPathLabels(field, normalizedValue) : undefined,
      }]
      : undefined,
  };
}

async function loadApplicationFilterInput(payload: Record<string, unknown>, sourceFilePath: string): Promise<Record<string, unknown> | undefined> {
  if (payload.applicationFilterInput !== undefined) {
    if (!isPlainObject(payload.applicationFilterInput)) {
      throw new Error('--search-subscription-file applicationFilterInput must be an object when provided');
    }

    return payload.applicationFilterInput;
  }

  if (payload.applicationFilterInputFile === undefined) {
    return undefined;
  }

  if (typeof payload.applicationFilterInputFile !== 'string' || !payload.applicationFilterInputFile.trim()) {
    throw new Error('--search-subscription-file applicationFilterInputFile must be a non-empty string when provided');
  }

  const inputPath = path.resolve(path.dirname(sourceFilePath), payload.applicationFilterInputFile);
  const applicationFilterInput = await readJsonFile<unknown>(inputPath);
  if (!isPlainObject(applicationFilterInput)) {
    throw new Error('--search-subscription-file applicationFilterInputFile must point to a JSON object');
  }

  return applicationFilterInput;
}

export async function buildApplicationFilterConditions(
  platform: SupportedPlatform,
  applicationFilterInput: Record<string, unknown>,
  options: LoadSearchConditionPlanFileOptions,
): Promise<SearchCondition[]> {
  const optionsPath = path.resolve(options.applicationFilterOptionsPath ?? buildDefaultApplicationFilterOptionsPath(platform));
  const applicationOptions = await readJsonFile<ApplicationFilterOptions>(optionsPath);
  if (applicationOptions.platform !== platform) {
    throw new Error(`Application filter options platform mismatch: expected ${platform}, got ${applicationOptions.platform}`);
  }

  const validation = validateApplicationFilterInput(applicationOptions, applicationFilterInput);
  if (!validation.ok) {
    throw new Error(`Invalid applicationFilterInput: ${validation.errors.map((error) => `${error.fieldId}:${error.code}`).join(', ')}`);
  }

  return Object.entries(applicationFilterInput).map(([fieldId, value]) => {
    const field = applicationOptions.fieldsById[fieldId];
    if (!field) {
      throw new Error(`Unknown application filter field: ${fieldId}`);
    }

    return toApplicationFilterCondition(field, value);
  });
}

export async function loadSearchConditionPlanFile(
  filePath: string,
  options: LoadSearchConditionPlanFileOptions = {},
): Promise<SearchConditionPlan> {
  const resolvedFilePath = path.resolve(filePath);
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(resolvedFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in --search-subscription-file ${filePath}: ${error.message}`);
    }

    throw error;
  }

  assertPlainObject(payload, '--search-subscription-file payload');

  const rawKeyword = options.keywordOverride ?? payload.keyword;
  if (typeof rawKeyword !== 'string' || !rawKeyword.trim()) {
    throw new Error('--search-subscription-file requires a non-empty keyword, or pass --keyword');
  }

  const rawSavedSearchName = options.savedSearchNameOverride ?? payload.savedSearchName;
  if (rawSavedSearchName !== undefined && (typeof rawSavedSearchName !== 'string' || !rawSavedSearchName.trim())) {
    throw new Error('--search-subscription-file savedSearchName must be a non-empty string when provided');
  }

  const rawConditions = payload.conditions ?? [];
  if (!Array.isArray(rawConditions)) {
    throw new Error('--search-subscription-file conditions must be an array when provided');
  }

  const applicationFilterInput = await loadApplicationFilterInput(payload, resolvedFilePath);
  const applicationFilterConditions = applicationFilterInput
    ? await buildApplicationFilterConditions(options.platform ?? '51job', applicationFilterInput, options)
    : [];

  return {
    keyword: rawKeyword.trim(),
    savedSearchName: typeof rawSavedSearchName === 'string' ? rawSavedSearchName.trim() : undefined,
    conditions: [
      ...rawConditions.map((condition, index) => parseCondition(condition, index)),
      ...applicationFilterConditions,
    ],
  };
}

function buildSkippedConditionResult(adapter: PlatformAdapter, condition: SearchCondition): SearchConditionApplyResult {
  return {
    platform: adapter.platform,
    condition,
    status: 'skipped',
    message: `Search condition kind "${condition.kind}" is not implemented for ${adapter.platform} yet.`,
  };
}

async function applySearchConditions(
  adapter: PlatformAdapter,
  page: Page,
  conditions: SearchCondition[],
): Promise<SearchConditionApplyResult[]> {
  const results: SearchConditionApplyResult[] = [];

  for (const condition of conditions) {
    if (!adapter.applySearchCondition) {
      results.push(buildSkippedConditionResult(adapter, condition));
      continue;
    }

    results.push(await adapter.applySearchCondition(page, condition));
  }

  return results;
}

function countConditionStatuses(
  conditionResults: SearchConditionApplyResult[],
): SearchSubscriptionSummary['conditionStatusCounts'] {
  const counts: SearchSubscriptionSummary['conditionStatusCounts'] = {
    applied: 0,
    skipped: 0,
    failed: 0,
  };

  for (const result of conditionResults) {
    counts[result.status] += 1;
  }

  return counts;
}

export async function runSearchSubscriptionWorkflow(
  adapter: PlatformAdapter,
  page: Page,
  plan: SearchConditionPlan,
  options: RunSearchSubscriptionWorkflowOptions,
): Promise<SearchSubscriptionSummary> {
  if (!adapter.prepareSearchConditionPage) {
    throw new Error(`Platform ${adapter.platform} does not support opening a search-condition input page.`);
  }
  if (!adapter.readSearchConditionResultTotal) {
    throw new Error(`Platform ${adapter.platform} does not support reading search-condition result totals.`);
  }
  if (options.save && !adapter.saveSearchCondition) {
    throw new Error(`Platform ${adapter.platform} does not support saving search conditions.`);
  }

  const searchPage = await adapter.prepareSearchConditionPage(page, plan.keyword, options);
  const conditionResults = await applySearchConditions(adapter, searchPage, plan.conditions);
  const conditionStatusCounts = countConditionStatuses(conditionResults);
  const allConditionsApplied = conditionStatusCounts.skipped === 0 && conditionStatusCounts.failed === 0;
  const { resultTotal, resultTotalSource } = await adapter.readSearchConditionResultTotal(searchPage, options);
  const savedSearchName = options.savedSearchName ?? plan.savedSearchName;
  let saved = false;

  if (options.save) {
    if (!savedSearchName) {
      throw new Error('Saving a search subscription requires savedSearchName in the file or --search-subscription-name');
    }
    if (!allConditionsApplied) {
      throw new Error('Refusing to save search subscription because not all search conditions were applied.');
    }

    await adapter.saveSearchCondition!(searchPage, savedSearchName, options);
    saved = true;
  }

  return {
    platform: adapter.platform,
    keyword: plan.keyword,
    savedSearchName,
    resultTotal,
    resultTotalSource,
    saveRequested: options.save,
    saved,
    allConditionsApplied,
    conditionStatusCounts,
    conditionResults,
  };
}
