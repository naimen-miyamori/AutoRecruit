import type { SupportedPlatform } from '../platforms/types.js';
import type { RagEmbeddingProvider } from './embeddings.js';
import {
  inspectRagJob,
  type RagInspectDependencies,
  type RagInspectQuestionDiagnostics,
  type RagInspectResultItem,
} from './inspect.js';
import { RagStore } from './rag-store.js';
import type { RagChunk, RagSourceType } from './types.js';

export interface RagEvalCase {
  id?: string;
  question: string;
  expectedTextIncludes?: string[];
  expectedSourceTypes?: RagSourceType[];
  expectedChunkIds?: string[];
  expectedConversationIds?: string[];
  expectNoAnswer?: boolean;
  forbiddenTextIncludes?: string[];
  unexpectedTextIncludes?: string[];
  maxHybridResults?: number;
}

export interface EvaluateRagJobOptions extends RagInspectDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  cases: RagEvalCase[];
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}

export interface RagEvalCheckResult {
  passed: boolean;
  expected?: string[];
  matched?: string[];
  missing?: string[];
  forbidden?: string[];
  presentForbidden?: string[];
  limit?: number;
  actual?: number;
  warnings?: string[];
}

export interface RagEvalCaseResult {
  id?: string;
  question: string;
  expectNoAnswer: boolean;
  passed: boolean;
  checks: {
    expectedTextIncludes?: RagEvalCheckResult;
    expectedSourceTypes?: RagEvalCheckResult;
    expectedChunkIds?: RagEvalCheckResult;
    expectedConversationIds?: RagEvalCheckResult;
    forbiddenTextIncludes?: RagEvalCheckResult;
    noAnswer?: RagEvalCheckResult;
    maxHybridResults?: RagEvalCheckResult;
  };
  retrieval: {
    denseChunkIds: string[];
    keywordChunkIds: string[];
    hybridChunkIds: string[];
    hybridResults: RagInspectResultItem[];
  };
}

export interface RagEvalMetrics {
  hitRate: number;
  recallAtK?: number;
  sourceTypeAccuracy?: number;
  noAnswerAccuracy?: number;
}

export interface RagEvalSummary {
  platform: SupportedPlatform;
  jobKey: string;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  metrics: RagEvalMetrics;
  cases: RagEvalCaseResult[];
}

const SOURCE_TYPES: RagSourceType[] = ['jd', 'conversation', 'recruiter_note', 'faq'];

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }

  return value.map((item) => item.trim());
}

function normalizeSourceTypes(value: unknown, fieldName: string): RagSourceType[] | undefined {
  const values = normalizeStringArray(value, fieldName);
  if (!values) {
    return undefined;
  }

  for (const item of values) {
    if (!SOURCE_TYPES.includes(item as RagSourceType)) {
      throw new Error(`${fieldName} contains unsupported source type: ${item}`);
    }
  }

  return values as RagSourceType[];
}

function normalizeBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function normalizeNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }

  return value;
}

function normalizeEvalCase(value: unknown, index: number): RagEvalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RAG eval case at index ${index} must be an object`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.question !== 'string' || !item.question.trim()) {
    throw new Error(`RAG eval case at index ${index} must include a non-empty question`);
  }

  const normalized: RagEvalCase = {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
    question: item.question.trim(),
    expectedTextIncludes: normalizeStringArray(item.expectedTextIncludes, `cases[${index}].expectedTextIncludes`),
    expectedSourceTypes: normalizeSourceTypes(item.expectedSourceTypes, `cases[${index}].expectedSourceTypes`),
    expectedChunkIds: normalizeStringArray(item.expectedChunkIds, `cases[${index}].expectedChunkIds`),
    expectedConversationIds: normalizeStringArray(item.expectedConversationIds, `cases[${index}].expectedConversationIds`),
    expectNoAnswer: normalizeBoolean(item.expectNoAnswer, `cases[${index}].expectNoAnswer`),
    forbiddenTextIncludes: normalizeStringArray(item.forbiddenTextIncludes, `cases[${index}].forbiddenTextIncludes`),
    unexpectedTextIncludes: normalizeStringArray(item.unexpectedTextIncludes, `cases[${index}].unexpectedTextIncludes`),
    maxHybridResults: normalizeNonNegativeInteger(item.maxHybridResults, `cases[${index}].maxHybridResults`),
  };
  const hasExpectation = normalized.expectNoAnswer === true
    || Boolean(normalized.expectedTextIncludes?.length)
    || Boolean(normalized.expectedSourceTypes?.length)
    || Boolean(normalized.expectedChunkIds?.length)
    || Boolean(normalized.expectedConversationIds?.length)
    || Boolean(normalized.forbiddenTextIncludes?.length)
    || Boolean(normalized.unexpectedTextIncludes?.length)
    || normalized.maxHybridResults !== undefined;

  if (!hasExpectation) {
    throw new Error(`RAG eval case at index ${index} must include at least one expectation`);
  }

  return normalized;
}

export function normalizeRagEvalCases(payload: unknown): RagEvalCase[] {
  const casesPayload = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { cases?: unknown }).cases)
      ? (payload as { cases: unknown[] }).cases
      : undefined;

  if (!casesPayload) {
    throw new Error('RAG eval file must contain a JSON array or an object with a cases array');
  }

  if (casesPayload.length === 0) {
    throw new Error('RAG eval file must contain at least one case');
  }

  return casesPayload.map((item, index) => normalizeEvalCase(item, index));
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function buildChunkTextById(chunks: RagChunk[]): Map<string, string> {
  return new Map(chunks.map((chunk) => [chunk.chunkId, chunk.text]));
}

function buildHybridContext(results: RagInspectResultItem[], chunkTextById: Map<string, string>): string {
  return results.map((result) => chunkTextById.get(result.chunkId) ?? result.textPreview).join('\n\n');
}

function evaluateExpectedText(expected: string[] | undefined, hybridContext: string): RagEvalCheckResult | undefined {
  if (!expected?.length) {
    return undefined;
  }

  const matched = expected.filter((item) => includesText(hybridContext, item));
  const missing = expected.filter((item) => !matched.includes(item));
  return {
    passed: missing.length === 0,
    expected,
    matched,
    missing,
  };
}

function evaluateExpectedValues(expected: string[] | undefined, actual: string[]): RagEvalCheckResult | undefined {
  if (!expected?.length) {
    return undefined;
  }

  const uniqueActual = [...new Set(actual)];
  const matched = expected.filter((item) => uniqueActual.includes(item));
  const missing = expected.filter((item) => !matched.includes(item));
  return {
    passed: missing.length === 0,
    expected,
    matched,
    missing,
  };
}

function evaluateForbiddenText(forbidden: string[] | undefined, hybridContext: string): RagEvalCheckResult | undefined {
  if (!forbidden?.length) {
    return undefined;
  }

  const presentForbidden = forbidden.filter((item) => includesText(hybridContext, item));
  return {
    passed: presentForbidden.length === 0,
    forbidden,
    presentForbidden,
  };
}

function evaluateNoAnswer(testCase: RagEvalCase, hybridContext: string): RagEvalCheckResult | undefined {
  if (testCase.expectNoAnswer !== true) {
    return undefined;
  }

  const forbidden = [
    ...(testCase.forbiddenTextIncludes ?? []),
    ...(testCase.unexpectedTextIncludes ?? []),
  ];
  const check = evaluateForbiddenText(forbidden, hybridContext);
  if (check) {
    return check;
  }

  return {
    passed: true,
    warnings: ['expectNoAnswer only checks configured forbiddenTextIncludes/unexpectedTextIncludes in offline retrieval eval; generated-answer correctness is not evaluated'],
  };
}

function evaluateForbiddenTextForCase(testCase: RagEvalCase, hybridContext: string): RagEvalCheckResult | undefined {
  if (testCase.expectNoAnswer === true) {
    return undefined;
  }

  return evaluateForbiddenText([
    ...(testCase.forbiddenTextIncludes ?? []),
    ...(testCase.unexpectedTextIncludes ?? []),
  ], hybridContext);
}

function evaluateMaxHybridResults(limit: number | undefined, actual: number): RagEvalCheckResult | undefined {
  if (limit === undefined) {
    return undefined;
  }

  return {
    passed: actual <= limit,
    limit,
    actual,
  };
}

function isPassed(check: RagEvalCheckResult | undefined): boolean {
  return check?.passed !== false;
}

function evaluateCase(
  testCase: RagEvalCase,
  diagnostics: RagInspectQuestionDiagnostics,
  chunkTextById: Map<string, string>,
): RagEvalCaseResult {
  const hybridResults = diagnostics.hybridResults;
  const hybridContext = buildHybridContext(hybridResults, chunkTextById);
  const checks: RagEvalCaseResult['checks'] = {
    expectedTextIncludes: testCase.expectNoAnswer === true
      ? undefined
      : evaluateExpectedText(testCase.expectedTextIncludes, hybridContext),
    expectedSourceTypes: evaluateExpectedValues(
      testCase.expectedSourceTypes,
      hybridResults.map((result) => result.sourceType),
    ),
    expectedChunkIds: evaluateExpectedValues(
      testCase.expectedChunkIds,
      hybridResults.map((result) => result.chunkId),
    ),
    expectedConversationIds: evaluateExpectedValues(
      testCase.expectedConversationIds,
      hybridResults.map((result) => result.conversationId).filter((item): item is string => Boolean(item)),
    ),
    forbiddenTextIncludes: evaluateForbiddenTextForCase(testCase, hybridContext),
    noAnswer: evaluateNoAnswer(testCase, hybridContext),
    maxHybridResults: evaluateMaxHybridResults(testCase.maxHybridResults, hybridResults.length),
  };
  const passed = Object.values(checks).every(isPassed);

  return {
    id: testCase.id,
    question: testCase.question,
    expectNoAnswer: testCase.expectNoAnswer === true,
    passed,
    checks,
    retrieval: {
      denseChunkIds: diagnostics.denseResults.map((result) => result.chunkId),
      keywordChunkIds: diagnostics.keywordResults.map((result) => result.chunkId),
      hybridChunkIds: hybridResults.map((result) => result.chunkId),
      hybridResults,
    },
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function buildMetrics(results: RagEvalCaseResult[]): RagEvalMetrics {
  const retrievalResults = results.filter((result) => !result.expectNoAnswer && (
    result.checks.expectedTextIncludes || result.checks.expectedChunkIds
  ));
  const sourceTypeResults = results.filter((result) => result.checks.expectedSourceTypes);
  const noAnswerResults = results.filter((result) => result.expectNoAnswer);

  return {
    hitRate: ratio(results.filter((result) => result.passed).length, results.length),
    recallAtK: retrievalResults.length > 0
      ? ratio(retrievalResults.filter((result) => (
        isPassed(result.checks.expectedTextIncludes) && isPassed(result.checks.expectedChunkIds)
      )).length, retrievalResults.length)
      : undefined,
    sourceTypeAccuracy: sourceTypeResults.length > 0
      ? ratio(sourceTypeResults.filter((result) => isPassed(result.checks.expectedSourceTypes)).length, sourceTypeResults.length)
      : undefined,
    noAnswerAccuracy: noAnswerResults.length > 0
      ? ratio(noAnswerResults.filter((result) => isPassed(result.checks.noAnswer) && isPassed(result.checks.maxHybridResults)).length, noAnswerResults.length)
      : undefined,
  };
}

export async function evaluateRagJob(options: EvaluateRagJobOptions): Promise<RagEvalSummary> {
  const ragStore = options.ragStore ?? new RagStore();
  const chunks = await ragStore.listChunks(options.platform, options.jobKey);
  const chunkTextById = buildChunkTextById(chunks);
  const cases = options.cases.map((item, index) => normalizeEvalCase(item, index));
  if (cases.length === 0) {
    throw new Error('RAG eval requires at least one case');
  }
  const results: RagEvalCaseResult[] = [];

  for (const testCase of cases) {
    const inspection = await inspectRagJob({
      platform: options.platform,
      jobKey: options.jobKey,
      question: testCase.question,
      topK: options.topK,
      denseTopK: options.denseTopK,
      keywordTopK: options.keywordTopK,
      embeddingModel: options.embeddingModel,
      embeddingProvider: options.embeddingProvider,
      ragStore,
      vectorStore: options.vectorStore,
    });

    if (!inspection.questionDiagnostics) {
      throw new Error(`RAG eval did not produce diagnostics for question: ${testCase.question}`);
    }

    results.push(evaluateCase(testCase, inspection.questionDiagnostics, chunkTextById));
  }

  const passedCount = results.filter((result) => result.passed).length;
  return {
    platform: options.platform,
    jobKey: options.jobKey,
    caseCount: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    metrics: buildMetrics(results),
    cases: results,
  };
}
