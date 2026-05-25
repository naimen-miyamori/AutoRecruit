import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { PlatformAdapter, SearchWaitOptions } from '../platforms/types.js';
import type {
  SearchCondition,
  SearchConditionApplyResult,
  SearchConditionPlan,
  SearchSubscriptionSummary,
} from '../types/job.js';

interface LoadSearchConditionPlanFileOptions {
  keywordOverride?: string;
  savedSearchNameOverride?: string;
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

export async function loadSearchConditionPlanFile(
  filePath: string,
  options: LoadSearchConditionPlanFileOptions = {},
): Promise<SearchConditionPlan> {
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(filePath, 'utf8'));
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

  return {
    keyword: rawKeyword.trim(),
    savedSearchName: typeof rawSavedSearchName === 'string' ? rawSavedSearchName.trim() : undefined,
    conditions: rawConditions.map((condition, index) => parseCondition(condition, index)),
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
  const { resultTotal, resultTotalSource } = await adapter.readSearchConditionResultTotal(searchPage, options);
  const savedSearchName = options.savedSearchName ?? plan.savedSearchName;
  let saved = false;

  if (options.save) {
    if (!savedSearchName) {
      throw new Error('Saving a search subscription requires savedSearchName in the file or --search-subscription-name');
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
    conditionResults,
  };
}
