import fs from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { RagEmbeddingProvider } from './embeddings.js';
import {
  evaluateRagAnswers,
  normalizeRagAnswerEvalCases,
  type EvaluateRagAnswersOptions,
  type RagAnswerEvalSummary,
} from './answer-eval.js';
import {
  evaluateRagJob,
  normalizeRagEvalCases,
  type EvaluateRagJobOptions,
  type RagEvalSummary,
} from './eval.js';
import type { RagInspectDependencies } from './inspect.js';
import type { RagDependencies } from './service.js';

export interface RagRegressionSuiteItem {
  id?: string;
  platform: SupportedPlatform;
  jobKey: string;
  keyword?: string;
  retrievalEvalFile?: string;
  answerEvalFile?: string;
}

export interface RagRegressionSuite {
  items: RagRegressionSuiteItem[];
}

export interface RunRagRegressionOptions extends RagInspectDependencies, RagDependencies {
  suite: RagRegressionSuite;
  suiteDir?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
  includeAnswerEval?: boolean;
  evaluateRetrieval?: (options: EvaluateRagJobOptions) => Promise<RagEvalSummary>;
  evaluateAnswers?: (options: EvaluateRagAnswersOptions) => Promise<RagAnswerEvalSummary>;
}

export interface RagRegressionItemResult {
  id?: string;
  platform: SupportedPlatform;
  jobKey: string;
  keyword?: string;
  retrievalEvalFile?: string;
  answerEvalFile?: string;
  passed: boolean;
  retrieval?: RagEvalSummary;
  answer?: RagAnswerEvalSummary;
}

export interface RagRegressionSummary {
  itemCount: number;
  passedItemCount: number;
  failedItemCount: number;
  retrievalCaseCount: number;
  retrievalFailedCount: number;
  answerCaseCount: number;
  answerFailedCount: number;
  passed: boolean;
  items: RagRegressionItemResult[];
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeSuiteItem(value: unknown, index: number): RagRegressionSuiteItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RAG regression suite item at index ${index} must be an object`);
  }

  const item = value as Record<string, unknown>;
  const platform = parsePlatformArg(normalizeNonEmptyString(item.platform, `items[${index}].platform`));
  const keyword = normalizeNonEmptyString(item.keyword, `items[${index}].keyword`);
  const jobKey = normalizeNonEmptyString(item.jobKey, `items[${index}].jobKey`) ?? (keyword ? buildJobKey(keyword, '') : undefined);
  if (!jobKey) {
    throw new Error(`RAG regression suite item at index ${index} must include jobKey or keyword`);
  }

  const retrievalEvalFile = normalizeNonEmptyString(item.retrievalEvalFile, `items[${index}].retrievalEvalFile`);
  const answerEvalFile = normalizeNonEmptyString(item.answerEvalFile, `items[${index}].answerEvalFile`);
  if (!retrievalEvalFile && !answerEvalFile) {
    throw new Error(`RAG regression suite item at index ${index} must include retrievalEvalFile or answerEvalFile`);
  }

  return {
    id: normalizeNonEmptyString(item.id, `items[${index}].id`),
    platform,
    jobKey,
    keyword,
    retrievalEvalFile,
    answerEvalFile,
  };
}

export function normalizeRagRegressionSuite(payload: unknown): RagRegressionSuite {
  const itemsPayload = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : undefined;

  if (!itemsPayload) {
    throw new Error('RAG regression suite must contain a JSON array or an object with an items array');
  }

  if (itemsPayload.length === 0) {
    throw new Error('RAG regression suite must contain at least one item');
  }

  return {
    items: itemsPayload.map((item, index) => normalizeSuiteItem(item, index)),
  };
}

function resolveSuitePath(filePath: string, suiteDir?: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(suiteDir ?? process.cwd(), filePath);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

async function runRetrievalEval(
  item: RagRegressionSuiteItem,
  options: RunRagRegressionOptions,
): Promise<RagEvalSummary | undefined> {
  if (!item.retrievalEvalFile) {
    return undefined;
  }

  const payload = await readJsonFile(resolveSuitePath(item.retrievalEvalFile, options.suiteDir));
  const evaluateRetrieval = options.evaluateRetrieval ?? evaluateRagJob;
  return evaluateRetrieval({
    platform: item.platform,
    jobKey: item.jobKey,
    cases: normalizeRagEvalCases(payload),
    topK: options.topK,
    denseTopK: options.denseTopK,
    keywordTopK: options.keywordTopK,
    embeddingModel: options.embeddingModel,
    embeddingProvider: options.embeddingProvider,
    ragStore: options.ragStore,
    vectorStore: options.vectorStore,
  });
}

async function runAnswerEval(
  item: RagRegressionSuiteItem,
  options: RunRagRegressionOptions,
): Promise<RagAnswerEvalSummary | undefined> {
  if (!item.answerEvalFile) {
    return undefined;
  }

  const payload = await readJsonFile(resolveSuitePath(item.answerEvalFile, options.suiteDir));
  const evaluateAnswers = options.evaluateAnswers ?? evaluateRagAnswers;
  return evaluateAnswers({
    platform: item.platform,
    jobKey: item.jobKey,
    cases: normalizeRagAnswerEvalCases(payload),
    topK: options.topK,
    embeddingModel: options.embeddingModel,
    embeddingProvider: options.embeddingProvider,
    jobStore: options.jobStore,
    ragStore: options.ragStore,
    vectorStore: options.vectorStore,
  });
}

export async function runRagRegression(options: RunRagRegressionOptions): Promise<RagRegressionSummary> {
  const items: RagRegressionItemResult[] = [];

  for (const item of options.suite.items) {
    const retrieval = await runRetrievalEval(item, options);
    const answer = options.includeAnswerEval === false ? undefined : await runAnswerEval(item, options);
    const passed = (retrieval?.failedCount ?? 0) === 0 && (answer?.failedCount ?? 0) === 0;
    items.push({
      id: item.id,
      platform: item.platform,
      jobKey: item.jobKey,
      keyword: item.keyword,
      retrievalEvalFile: item.retrievalEvalFile,
      answerEvalFile: item.answerEvalFile,
      passed,
      retrieval,
      answer,
    });
  }

  const retrievalCaseCount = items.reduce((sum, item) => sum + (item.retrieval?.caseCount ?? 0), 0);
  const retrievalFailedCount = items.reduce((sum, item) => sum + (item.retrieval?.failedCount ?? 0), 0);
  const answerCaseCount = items.reduce((sum, item) => sum + (item.answer?.caseCount ?? 0), 0);
  const answerFailedCount = items.reduce((sum, item) => sum + (item.answer?.failedCount ?? 0), 0);
  const passedItemCount = items.filter((item) => item.passed).length;

  return {
    itemCount: items.length,
    passedItemCount,
    failedItemCount: items.length - passedItemCount,
    retrievalCaseCount,
    retrievalFailedCount,
    answerCaseCount,
    answerFailedCount,
    passed: items.every((item) => item.passed),
    items,
  };
}

export async function readRagRegressionSuiteFile(filePath: string): Promise<RagRegressionSuite> {
  return normalizeRagRegressionSuite(await readJsonFile(filePath));
}
