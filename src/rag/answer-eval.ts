import type { SupportedPlatform } from '../platforms/types.js';
import type { RagEmbeddingProvider } from './embeddings.js';
import { answerQuestionWithRag, type RagDependencies } from './service.js';
import type { RagAnswer, RagAnswerSource, RagSourceType } from './types.js';

export interface RagAnswerEvalCase {
  id?: string;
  question: string;
  expectedAnswerIncludes?: string[];
  forbiddenAnswerIncludes?: string[];
  expectedSourceTypes?: RagSourceType[];
  expectedChunkIds?: string[];
  expectedConversationIds?: string[];
  expectNoAnswer?: boolean;
  expectedNoAnswerIncludes?: string[];
}

export interface EvaluateRagAnswersOptions extends RagDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  cases: RagAnswerEvalCase[];
  topK?: number;
  autoIndex?: boolean;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
  answerQuestion?: (options: {
    platform: SupportedPlatform;
    jobKey: string;
    question: string;
    topK?: number;
    autoIndex?: boolean;
    embeddingModel?: string;
    embeddingProvider?: RagEmbeddingProvider;
  } & RagDependencies) => Promise<RagAnswer>;
}

export interface RagAnswerEvalCheckResult {
  passed: boolean;
  expected?: string[];
  matched?: string[];
  missing?: string[];
  forbidden?: string[];
  presentForbidden?: string[];
}

export interface RagAnswerEvalCaseResult {
  id?: string;
  question: string;
  answer: string;
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
  expectNoAnswer: boolean;
  passed: boolean;
  checks: {
    expectedAnswerIncludes?: RagAnswerEvalCheckResult;
    forbiddenAnswerIncludes?: RagAnswerEvalCheckResult;
    expectedNoAnswerIncludes?: RagAnswerEvalCheckResult;
    expectedSourceTypes?: RagAnswerEvalCheckResult;
    expectedChunkIds?: RagAnswerEvalCheckResult;
    expectedConversationIds?: RagAnswerEvalCheckResult;
  };
  sources: Array<{
    chunkId: string;
    sourceType: RagSourceType;
    sourceId: string;
    label: string;
    score: number;
    conversationId?: string;
    jdVersion?: string;
    textPreview: string;
  }>;
}

export interface RagAnswerEvalMetrics {
  passRate: number;
  answerTextAccuracy?: number;
  sourceTypeAccuracy?: number;
  noAnswerAccuracy?: number;
}

export interface RagAnswerEvalSummary {
  platform: SupportedPlatform;
  jobKey: string;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  metrics: RagAnswerEvalMetrics;
  cases: RagAnswerEvalCaseResult[];
}

const SOURCE_TYPES: RagSourceType[] = ['jd', 'conversation', 'recruiter_note', 'faq'];
const DEFAULT_NO_ANSWER_INCLUDES = ['未说明'];
const DEFAULT_TEXT_PREVIEW_CHARS = 120;

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

function normalizeAnswerEvalCase(value: unknown, index: number): RagAnswerEvalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RAG answer eval case at index ${index} must be an object`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.question !== 'string' || !item.question.trim()) {
    throw new Error(`RAG answer eval case at index ${index} must include a non-empty question`);
  }

  const normalized: RagAnswerEvalCase = {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
    question: item.question.trim(),
    expectedAnswerIncludes: normalizeStringArray(item.expectedAnswerIncludes, `cases[${index}].expectedAnswerIncludes`),
    forbiddenAnswerIncludes: normalizeStringArray(item.forbiddenAnswerIncludes, `cases[${index}].forbiddenAnswerIncludes`),
    expectedSourceTypes: normalizeSourceTypes(item.expectedSourceTypes, `cases[${index}].expectedSourceTypes`),
    expectedChunkIds: normalizeStringArray(item.expectedChunkIds, `cases[${index}].expectedChunkIds`),
    expectedConversationIds: normalizeStringArray(item.expectedConversationIds, `cases[${index}].expectedConversationIds`),
    expectNoAnswer: normalizeBoolean(item.expectNoAnswer, `cases[${index}].expectNoAnswer`),
    expectedNoAnswerIncludes: normalizeStringArray(item.expectedNoAnswerIncludes, `cases[${index}].expectedNoAnswerIncludes`),
  };
  const hasExpectation = normalized.expectNoAnswer === true
    || Boolean(normalized.expectedAnswerIncludes?.length)
    || Boolean(normalized.forbiddenAnswerIncludes?.length)
    || Boolean(normalized.expectedSourceTypes?.length)
    || Boolean(normalized.expectedChunkIds?.length)
    || Boolean(normalized.expectedConversationIds?.length)
    || Boolean(normalized.expectedNoAnswerIncludes?.length);

  if (!hasExpectation) {
    throw new Error(`RAG answer eval case at index ${index} must include at least one expectation`);
  }

  return normalized;
}

export function normalizeRagAnswerEvalCases(payload: unknown): RagAnswerEvalCase[] {
  const casesPayload = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { cases?: unknown }).cases)
      ? (payload as { cases: unknown[] }).cases
      : undefined;

  if (!casesPayload) {
    throw new Error('RAG answer eval file must contain a JSON array or an object with a cases array');
  }

  if (casesPayload.length === 0) {
    throw new Error('RAG answer eval file must contain at least one case');
  }

  return casesPayload.map((item, index) => normalizeAnswerEvalCase(item, index));
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function evaluateExpectedText(expected: string[] | undefined, answer: string): RagAnswerEvalCheckResult | undefined {
  if (!expected?.length) {
    return undefined;
  }

  const matched = expected.filter((item) => includesText(answer, item));
  const missing = expected.filter((item) => !matched.includes(item));
  return {
    passed: missing.length === 0,
    expected,
    matched,
    missing,
  };
}

function evaluateForbiddenText(forbidden: string[] | undefined, answer: string): RagAnswerEvalCheckResult | undefined {
  if (!forbidden?.length) {
    return undefined;
  }

  const presentForbidden = forbidden.filter((item) => includesText(answer, item));
  return {
    passed: presentForbidden.length === 0,
    forbidden,
    presentForbidden,
  };
}

function evaluateExpectedValues(expected: string[] | undefined, actual: string[]): RagAnswerEvalCheckResult | undefined {
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

function evaluateNoAnswer(testCase: RagAnswerEvalCase, answer: string): RagAnswerEvalCheckResult | undefined {
  if (testCase.expectNoAnswer !== true) {
    return undefined;
  }

  return evaluateExpectedText(testCase.expectedNoAnswerIncludes ?? DEFAULT_NO_ANSWER_INCLUDES, answer);
}

function isPassed(check: RagAnswerEvalCheckResult | undefined): boolean {
  return check?.passed !== false;
}

function previewText(text: string, maxChars = DEFAULT_TEXT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function summarizeSources(sources: RagAnswerSource[]): RagAnswerEvalCaseResult['sources'] {
  return sources.map((source) => ({
    chunkId: source.chunkId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    label: source.label,
    score: source.score,
    conversationId: source.conversationId,
    jdVersion: source.jdVersion,
    textPreview: previewText(source.text),
  }));
}

function evaluateCase(testCase: RagAnswerEvalCase, answerResult: RagAnswer): RagAnswerEvalCaseResult {
  const answer = answerResult.answer;
  const checks: RagAnswerEvalCaseResult['checks'] = {
    expectedAnswerIncludes: testCase.expectNoAnswer === true
      ? undefined
      : evaluateExpectedText(testCase.expectedAnswerIncludes, answer),
    forbiddenAnswerIncludes: evaluateForbiddenText(testCase.forbiddenAnswerIncludes, answer),
    expectedNoAnswerIncludes: evaluateNoAnswer(testCase, answer),
    expectedSourceTypes: evaluateExpectedValues(
      testCase.expectedSourceTypes,
      answerResult.sources.map((source) => source.sourceType),
    ),
    expectedChunkIds: evaluateExpectedValues(
      testCase.expectedChunkIds,
      answerResult.sources.map((source) => source.chunkId),
    ),
    expectedConversationIds: evaluateExpectedValues(
      testCase.expectedConversationIds,
      answerResult.sources.map((source) => source.conversationId).filter((item): item is string => Boolean(item)),
    ),
  };
  const passed = Object.values(checks).every(isPassed);

  return {
    id: testCase.id,
    question: testCase.question,
    answer,
    answered: answerResult.answered,
    confidence: answerResult.confidence,
    noAnswerReason: answerResult.noAnswerReason,
    expectNoAnswer: testCase.expectNoAnswer === true,
    passed,
    checks,
    sources: summarizeSources(answerResult.sources),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function buildMetrics(results: RagAnswerEvalCaseResult[]): RagAnswerEvalMetrics {
  const answerTextResults = results.filter((result) => (
    result.checks.expectedAnswerIncludes || result.checks.forbiddenAnswerIncludes
  ));
  const sourceTypeResults = results.filter((result) => result.checks.expectedSourceTypes);
  const noAnswerResults = results.filter((result) => result.expectNoAnswer);

  return {
    passRate: ratio(results.filter((result) => result.passed).length, results.length),
    answerTextAccuracy: answerTextResults.length > 0
      ? ratio(answerTextResults.filter((result) => (
        isPassed(result.checks.expectedAnswerIncludes) && isPassed(result.checks.forbiddenAnswerIncludes)
      )).length, answerTextResults.length)
      : undefined,
    sourceTypeAccuracy: sourceTypeResults.length > 0
      ? ratio(sourceTypeResults.filter((result) => isPassed(result.checks.expectedSourceTypes)).length, sourceTypeResults.length)
      : undefined,
    noAnswerAccuracy: noAnswerResults.length > 0
      ? ratio(noAnswerResults.filter((result) => isPassed(result.checks.expectedNoAnswerIncludes) && isPassed(result.checks.forbiddenAnswerIncludes)).length, noAnswerResults.length)
      : undefined,
  };
}

export async function evaluateRagAnswers(options: EvaluateRagAnswersOptions): Promise<RagAnswerEvalSummary> {
  const cases = options.cases.map((item, index) => normalizeAnswerEvalCase(item, index));
  if (cases.length === 0) {
    throw new Error('RAG answer eval requires at least one case');
  }

  const answerQuestion = options.answerQuestion ?? answerQuestionWithRag;
  const results: RagAnswerEvalCaseResult[] = [];

  for (const testCase of cases) {
    const answer = await answerQuestion({
      platform: options.platform,
      jobKey: options.jobKey,
      question: testCase.question,
      topK: options.topK,
      autoIndex: options.autoIndex,
      logAnswer: false,
      embeddingModel: options.embeddingModel,
      embeddingProvider: options.embeddingProvider,
      jobStore: options.jobStore,
      ragStore: options.ragStore,
      vectorStore: options.vectorStore,
    });

    results.push(evaluateCase(testCase, answer));
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
