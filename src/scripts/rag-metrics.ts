import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupportedPlatform } from '../platforms/types.js';
import { ensureAnswerLogId, type RagAnswerLogRecordWithId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import { RAG_ANSWER_FEEDBACK_ERROR_TYPES } from '../rag/types.js';
import type { RagAnswerFeedbackErrorType } from '../rag/types.js';
import { readReviewBatchFile, type RagReviewBatchItem } from './rag-review-batch.js';

type RagMetricsFormat = 'json' | 'markdown';
type RagMetricsFeedbackErrorType = RagAnswerFeedbackErrorType | 'unspecified';
type RagMetricsScalarPolicyKey = Exclude<keyof RagMetricsPolicy, 'maxErrorTypeRates'>;
export type RagMetricsThresholdMetric = RagMetricsScalarPolicyKey | `maxErrorTypeRates.${RagMetricsFeedbackErrorType}`;

export interface RagMetricsCounters {
  totalAnswers: number;
  answeredCount: number;
  noAnswerCount: number;
  reviewedCount: number;
  unreviewedCount: number;
  correctCount: number;
  incorrectCount: number;
  lowConfidenceCount: number;
  missingSourcesCount: number;
  averageConfidence?: number;
}

export interface RagMetricsRates {
  reviewRate?: number;
  correctRate?: number;
  incorrectRate?: number;
  noAnswerRate?: number;
  lowConfidenceRate?: number;
  missingSourcesRate?: number;
}

export interface RagMetricsErrorTypeBucket {
  errorType: RagMetricsFeedbackErrorType;
  count: number;
  incorrectRate?: number;
}

export interface RagMetricsBucket extends RagMetricsCounters {
  rates: RagMetricsRates;
  errorTypes: RagMetricsErrorTypeBucket[];
}

export interface RagMetricsJobBucket extends RagMetricsBucket {
  platform: SupportedPlatform;
  jobKey: string;
  failed?: boolean;
  error?: string;
}

export interface RagMetricsPlatformBucket extends RagMetricsBucket {
  platform: SupportedPlatform;
}

export interface RagMetricsDailyBucket extends RagMetricsBucket {
  date: string;
}

export interface RagMetricsPolicy {
  minReviewRate?: number;
  minCorrectRate?: number;
  maxIncorrectRate?: number;
  maxNoAnswerRate?: number;
  maxLowConfidenceRate?: number;
  maxMissingSourcesRate?: number;
  maxErrorTypeRates?: Partial<Record<RagMetricsFeedbackErrorType, number>>;
}

export interface RagMetricsThresholdViolation {
  metric: RagMetricsThresholdMetric;
  actual?: number;
  expected: number;
  operator: '>=' | '<=';
  message: string;
  remediation: string;
  errorType?: RagMetricsFeedbackErrorType;
}

export interface RagMetricsRecommendation {
  code: string;
  severity: 'warning' | 'critical';
  message: string;
  action: string;
  metric?: RagMetricsThresholdMetric;
  errorType?: RagMetricsFeedbackErrorType;
}

export interface RagMetricsReport {
  filePath: string;
  generatedAt: string;
  since?: string;
  until?: string;
  lowConfidenceThreshold: number;
  thresholds?: RagMetricsPolicy;
  thresholdViolations: RagMetricsThresholdViolation[];
  recommendations: RagMetricsRecommendation[];
  jobCount: number;
  failedJobCount: number;
  overall: RagMetricsBucket;
  byPlatform: RagMetricsPlatformBucket[];
  byJob: RagMetricsJobBucket[];
  byDay: RagMetricsDailyBucket[];
}

interface Args {
  filePath?: string;
  outputPath?: string;
  format: RagMetricsFormat;
  policyPath?: string;
  since?: string;
  until?: string;
  lowConfidenceThreshold: number;
  failOnThreshold: boolean;
  minReviewRate?: number;
  minCorrectRate?: number;
  maxIncorrectRate?: number;
  maxNoAnswerRate?: number;
  maxLowConfidenceRate?: number;
  maxMissingSourcesRate?: number;
}

interface MutableMetricsCounters extends RagMetricsCounters {
  confidenceSum: number;
  confidenceCount: number;
  errorTypeCounts: Map<RagMetricsFeedbackErrorType, number>;
}

function emptyCounters(): MutableMetricsCounters {
  return {
    totalAnswers: 0,
    answeredCount: 0,
    noAnswerCount: 0,
    reviewedCount: 0,
    unreviewedCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    lowConfidenceCount: 0,
    missingSourcesCount: 0,
    confidenceSum: 0,
    confidenceCount: 0,
    errorTypeCounts: new Map<RagMetricsFeedbackErrorType, number>(),
  };
}

function parseBoolean(value: string | undefined, flagName: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${flagName} must be true or false`);
}

function parseOptionalRate(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flagName} must be a number between 0 and 1`);
  }

  return parsed;
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('--low-confidence-threshold must be a non-negative number');
  }

  return parsed;
}

function parseFormat(value: string | undefined): RagMetricsFormat {
  if (value === undefined || value === 'json') {
    return 'json';
  }

  if (value === 'markdown') {
    return 'markdown';
  }

  throw new Error('--format must be json or markdown');
}

function parseOptionalIsoDate(value: string | undefined, flagName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${flagName} must be a valid date or datetime`);
  }

  return value;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value.trim());
    index += 1;
  }

  return {
    filePath: values.get('file'),
    outputPath: values.get('output'),
    format: parseFormat(values.get('format')),
    policyPath: values.get('policy'),
    since: parseOptionalIsoDate(values.get('since'), '--since'),
    until: parseOptionalIsoDate(values.get('until'), '--until'),
    lowConfidenceThreshold: parseThreshold(values.get('low-confidence-threshold'), 0.3),
    failOnThreshold: parseBoolean(values.get('fail-on-threshold'), '--fail-on-threshold', false),
    minReviewRate: parseOptionalRate(values.get('min-review-rate'), '--min-review-rate'),
    minCorrectRate: parseOptionalRate(values.get('min-correct-rate'), '--min-correct-rate'),
    maxIncorrectRate: parseOptionalRate(values.get('max-incorrect-rate'), '--max-incorrect-rate'),
    maxNoAnswerRate: parseOptionalRate(values.get('max-no-answer-rate'), '--max-no-answer-rate'),
    maxLowConfidenceRate: parseOptionalRate(values.get('max-low-confidence-rate'), '--max-low-confidence-rate'),
    maxMissingSourcesRate: parseOptionalRate(values.get('max-missing-sources-rate'), '--max-missing-sources-rate'),
  };
}

function validatePolicyRate(
  policy: Record<string, unknown>,
  fieldName: RagMetricsScalarPolicyKey,
): number | undefined {
  const value = policy[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`policy.${fieldName} must be a number between 0 and 1`);
  }

  return value;
}

function validateErrorTypeRatePolicy(policy: Record<string, unknown>): Partial<Record<RagMetricsFeedbackErrorType, number>> | undefined {
  const value = policy.maxErrorTypeRates;
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy.maxErrorTypeRates must be a JSON object');
  }

  const allowedErrorTypes = new Set<string>([...RAG_ANSWER_FEEDBACK_ERROR_TYPES, 'unspecified']);
  const result: Partial<Record<RagMetricsFeedbackErrorType, number>> = {};
  for (const [errorType, rawRate] of Object.entries(value as Record<string, unknown>)) {
    if (!allowedErrorTypes.has(errorType)) {
      throw new Error(`policy.maxErrorTypeRates.${errorType} is not a supported error type`);
    }

    if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate < 0 || rawRate > 1) {
      throw new Error(`policy.maxErrorTypeRates.${errorType} must be a number between 0 and 1`);
    }

    result[errorType as RagMetricsFeedbackErrorType] = rawRate;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export async function readRagMetricsPolicy(policyPath: string): Promise<RagMetricsPolicy> {
  const payload = JSON.parse(await fs.readFile(policyPath, 'utf8')) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('RAG metrics policy must be a JSON object');
  }

  const policy = payload as Record<string, unknown>;
  return cleanPolicy({
    minReviewRate: validatePolicyRate(policy, 'minReviewRate'),
    minCorrectRate: validatePolicyRate(policy, 'minCorrectRate'),
    maxIncorrectRate: validatePolicyRate(policy, 'maxIncorrectRate'),
    maxNoAnswerRate: validatePolicyRate(policy, 'maxNoAnswerRate'),
    maxLowConfidenceRate: validatePolicyRate(policy, 'maxLowConfidenceRate'),
    maxMissingSourcesRate: validatePolicyRate(policy, 'maxMissingSourcesRate'),
    maxErrorTypeRates: validateErrorTypeRatePolicy(policy),
  }) ?? {};
}

function cleanPolicy(policy: RagMetricsPolicy): RagMetricsPolicy | undefined {
  const scalarEntries = Object.entries(policy)
    .filter((entry): entry is [RagMetricsScalarPolicyKey, number] => entry[0] !== 'maxErrorTypeRates' && entry[1] !== undefined);
  const maxErrorTypeRates = policy.maxErrorTypeRates === undefined
    ? undefined
    : Object.fromEntries(Object.entries(policy.maxErrorTypeRates).filter((entry): entry is [RagMetricsFeedbackErrorType, number] => entry[1] !== undefined)) as Partial<Record<RagMetricsFeedbackErrorType, number>>;
  const hasErrorTypeRates = maxErrorTypeRates !== undefined && Object.keys(maxErrorTypeRates).length > 0;
  if (scalarEntries.length === 0 && !hasErrorTypeRates) {
    return undefined;
  }

  return {
    ...Object.fromEntries(scalarEntries),
    ...(hasErrorTypeRates ? { maxErrorTypeRates } : {}),
  } as RagMetricsPolicy;
}

function mergePolicies(policy: RagMetricsPolicy | undefined, override: RagMetricsPolicy | undefined): RagMetricsPolicy | undefined {
  const cleanedPolicy = cleanPolicy(policy ?? {});
  const cleanedOverride = cleanPolicy(override ?? {});
  return cleanPolicy({
    ...cleanedPolicy,
    ...cleanedOverride,
    maxErrorTypeRates: {
      ...(cleanedPolicy?.maxErrorTypeRates ?? {}),
      ...(cleanedOverride?.maxErrorTypeRates ?? {}),
    },
  });
}

function inDateRange(log: RagAnswerLogRecordWithId, since?: string, until?: string): boolean {
  const timestamp = Date.parse(log.createdAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  if (since !== undefined && timestamp < Date.parse(since)) {
    return false;
  }

  if (until !== undefined && timestamp > Date.parse(until)) {
    return false;
  }

  return true;
}

function addLogToCounters(
  counters: MutableMetricsCounters,
  log: RagAnswerLogRecordWithId,
  lowConfidenceThreshold: number,
): void {
  counters.totalAnswers += 1;
  if (log.answered === false) {
    counters.noAnswerCount += 1;
  } else {
    counters.answeredCount += 1;
  }

  if (log.feedback?.correct === true) {
    counters.reviewedCount += 1;
    counters.correctCount += 1;
  } else if (log.feedback?.correct === false) {
    counters.reviewedCount += 1;
    counters.incorrectCount += 1;
    const errorType = normalizeFeedbackErrorType(log.feedback.errorType);
    counters.errorTypeCounts.set(errorType, (counters.errorTypeCounts.get(errorType) ?? 0) + 1);
  } else {
    counters.unreviewedCount += 1;
  }

  if (log.answered !== false && log.confidence !== undefined && log.confidence < lowConfidenceThreshold) {
    counters.lowConfidenceCount += 1;
  }

  if (log.answered !== false && log.sources.length === 0) {
    counters.missingSourcesCount += 1;
  }

  if (log.confidence !== undefined) {
    counters.confidenceSum += log.confidence;
    counters.confidenceCount += 1;
  }
}

function normalizeFeedbackErrorType(value: unknown): RagMetricsFeedbackErrorType {
  if (typeof value === 'string' && (RAG_ANSWER_FEEDBACK_ERROR_TYPES as readonly string[]).includes(value)) {
    return value as RagAnswerFeedbackErrorType;
  }

  return 'unspecified';
}

function rate(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) {
    return undefined;
  }

  return Number((numerator / denominator).toFixed(4));
}

function finalizeErrorTypes(
  errorTypeCounts: Map<RagMetricsFeedbackErrorType, number>,
  incorrectCount: number,
): RagMetricsErrorTypeBucket[] {
  return [...errorTypeCounts.entries()]
    .sort(([leftType, leftCount], [rightType, rightCount]) => {
      const countDiff = rightCount - leftCount;
      if (countDiff !== 0) {
        return countDiff;
      }

      return leftType.localeCompare(rightType);
    })
    .map(([errorType, count]) => ({
      errorType,
      count,
      incorrectRate: rate(count, incorrectCount),
    }));
}

function finalizeCounters(counters: MutableMetricsCounters): RagMetricsBucket {
  const {
    confidenceSum,
    confidenceCount,
    errorTypeCounts,
    ...base
  } = counters;
  return {
    ...base,
    averageConfidence: confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(4)) : undefined,
    rates: {
      reviewRate: rate(base.reviewedCount, base.totalAnswers),
      correctRate: rate(base.correctCount, base.reviewedCount),
      incorrectRate: rate(base.incorrectCount, base.reviewedCount),
      noAnswerRate: rate(base.noAnswerCount, base.totalAnswers),
      lowConfidenceRate: rate(base.lowConfidenceCount, base.totalAnswers),
      missingSourcesRate: rate(base.missingSourcesCount, base.totalAnswers),
    },
    errorTypes: finalizeErrorTypes(errorTypeCounts, base.incorrectCount),
  };
}

function sortPlatforms(buckets: RagMetricsPlatformBucket[]): RagMetricsPlatformBucket[] {
  return buckets.sort((left, right) => left.platform.localeCompare(right.platform));
}

function sortJobs(buckets: RagMetricsJobBucket[]): RagMetricsJobBucket[] {
  return buckets.sort((left, right) => {
    const platformDiff = left.platform.localeCompare(right.platform);
    if (platformDiff !== 0) {
      return platformDiff;
    }

    return left.jobKey.localeCompare(right.jobKey);
  });
}

function sortDays(buckets: RagMetricsDailyBucket[]): RagMetricsDailyBucket[] {
  return buckets.sort((left, right) => left.date.localeCompare(right.date));
}

export async function buildRagMetricsReport(options: {
  filePath: string;
  since?: string;
  until?: string;
  lowConfidenceThreshold?: number;
  thresholds?: RagMetricsPolicy;
  ragStore?: RagStore;
  generatedAt?: string;
}): Promise<RagMetricsReport> {
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? 0.3;
  const ragStore = options.ragStore ?? new RagStore();
  const items = await readReviewBatchFile(options.filePath);
  const overall = emptyCounters();
  const platformCounters = new Map<SupportedPlatform, MutableMetricsCounters>();
  const dayCounters = new Map<string, MutableMetricsCounters>();
  const byJob: RagMetricsJobBucket[] = [];
  let failedJobCount = 0;

  for (const item of items) {
    const jobCounters = emptyCounters();
    try {
      const logs = (await ragStore.listAnswerLogs(item.platform, item.jobKey))
        .map(ensureAnswerLogId)
        .filter((log) => inDateRange(log, options.since, options.until));
      for (const log of logs) {
        addLogToCounters(overall, log, lowConfidenceThreshold);
        addLogToCounters(jobCounters, log, lowConfidenceThreshold);
        const platformCounter = platformCounters.get(item.platform) ?? emptyCounters();
        platformCounters.set(item.platform, platformCounter);
        addLogToCounters(platformCounter, log, lowConfidenceThreshold);
        const date = log.createdAt.slice(0, 10);
        const dayCounter = dayCounters.get(date) ?? emptyCounters();
        dayCounters.set(date, dayCounter);
        addLogToCounters(dayCounter, log, lowConfidenceThreshold);
      }
      byJob.push({
        platform: item.platform,
        jobKey: item.jobKey,
        ...finalizeCounters(jobCounters),
      });
    } catch (error) {
      failedJobCount += 1;
      byJob.push({
        platform: item.platform,
        jobKey: item.jobKey,
        failed: true,
        error: error instanceof Error ? error.message : String(error),
        ...finalizeCounters(jobCounters),
      });
    }
  }

  const thresholds = cleanPolicy(options.thresholds ?? {});
  const overallBucket = finalizeCounters(overall);
  const thresholdViolations = evaluateRagMetricsThresholds(overallBucket, thresholds);
  return {
    filePath: options.filePath,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    since: options.since,
    until: options.until,
    lowConfidenceThreshold,
    thresholds,
    thresholdViolations,
    recommendations: buildRagMetricsRecommendations(thresholdViolations),
    jobCount: items.length,
    failedJobCount,
    overall: overallBucket,
    byPlatform: sortPlatforms([...platformCounters.entries()].map(([platform, counters]) => ({
      platform,
      ...finalizeCounters(counters),
    }))),
    byJob: sortJobs(byJob),
    byDay: sortDays([...dayCounters.entries()].map(([date, counters]) => ({
      date,
      ...finalizeCounters(counters),
    }))),
  };
}

function formatRate(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatTopErrorTypes(errorTypes: RagMetricsErrorTypeBucket[], limit = 2): string {
  if (errorTypes.length === 0) {
    return '-';
  }

  return errorTypes
    .slice(0, limit)
    .map((item) => `${item.errorType}: ${item.count} (${formatRate(item.incorrectRate)})`)
    .join(', ');
}

function getRemediation(metric: RagMetricsThresholdMetric, errorType?: RagMetricsFeedbackErrorType): string {
  if (metric === 'minReviewRate') {
    return 'Run rag:review:batch, mark answers with rag:feedback, and avoid promoting unreviewed answers into regression cases.';
  }

  if (metric === 'minCorrectRate' || metric === 'maxIncorrectRate') {
    return 'Review incorrect logs, group them by feedback.errorType, then fix stale JD facts, verified conversation facts, prompt constraints, or retrieval settings based on the dominant error type.';
  }

  if (metric === 'maxNoAnswerRate') {
    return 'Check whether missing answers are truly outside JD/verified conversations; add verified facts for recurring candidate questions.';
  }

  if (metric === 'maxLowConfidenceRate') {
    return 'Inspect dense/keyword/hybrid hits for representative questions and tune chunking, retrieval thresholds, or embedding configuration.';
  }

  if (metric === 'maxMissingSourcesRate') {
    return 'Check the RAG answer path and logging path; saved RAG answers should include cited sources unless they are explicit no-answer responses.';
  }

  if (errorType === 'wrong_fact' || errorType === 'missing_context') {
    return 'Fix or add authoritative JD fields and verified recruiter conversation facts, then rebuild the affected job index.';
  }

  if (errorType === 'unsupported_claim') {
    return 'Tighten answer prompts and confidence gating so the model refuses instead of expanding beyond JD and verified facts.';
  }

  if (errorType === 'bad_source' || errorType === 'low_relevance') {
    return 'Run rag:inspect with representative questions, review dense/keyword/hybrid hits, then adjust chunking or retrieval/rerank settings.';
  }

  if (errorType === 'wording_issue') {
    return 'Improve answer style instructions and add reviewed correct examples to answer regression cases.';
  }

  if (errorType === 'unspecified') {
    return 'Backfill missing --error-type values on old incorrect feedback so future metrics can identify the real root cause.';
  }

  return 'Review the incorrect logs manually and add a more specific feedback.errorType where possible.';
}

function addMinViolation(
  violations: RagMetricsThresholdViolation[],
  metric: RagMetricsThresholdMetric,
  actual: number | undefined,
  expected: number | undefined,
): void {
  if (expected === undefined) {
    return;
  }

  if (actual === undefined || actual < expected) {
    violations.push({
      metric,
      actual,
      expected,
      operator: '>=',
      message: `${metric} expected >= ${expected}, actual ${actual ?? 'undefined'}`,
      remediation: getRemediation(metric),
    });
  }
}

function addMaxViolation(
  violations: RagMetricsThresholdViolation[],
  metric: RagMetricsThresholdMetric,
  actual: number | undefined,
  expected: number | undefined,
  errorType?: RagMetricsFeedbackErrorType,
): void {
  if (expected === undefined || actual === undefined) {
    return;
  }

  if (actual > expected) {
    violations.push({
      metric,
      actual,
      expected,
      operator: '<=',
      message: `${metric} expected <= ${expected}, actual ${actual}`,
      remediation: getRemediation(metric, errorType),
      errorType,
    });
  }
}

function addErrorTypeViolations(
  violations: RagMetricsThresholdViolation[],
  overall: RagMetricsBucket,
  thresholds: Partial<Record<RagMetricsFeedbackErrorType, number>> | undefined,
): void {
  if (!thresholds) {
    return;
  }

  const actualRates = new Map(overall.errorTypes.map((item) => [item.errorType, item.incorrectRate]));
  for (const [errorType, expected] of Object.entries(thresholds) as Array<[RagMetricsFeedbackErrorType, number]>) {
    addMaxViolation(
      violations,
      `maxErrorTypeRates.${errorType}`,
      actualRates.get(errorType) ?? 0,
      expected,
      errorType,
    );
  }
}

export function evaluateRagMetricsThresholds(
  overall: RagMetricsBucket,
  thresholds: RagMetricsPolicy | undefined,
): RagMetricsThresholdViolation[] {
  if (!thresholds) {
    return [];
  }

  const violations: RagMetricsThresholdViolation[] = [];
  addMinViolation(violations, 'minReviewRate', overall.rates.reviewRate, thresholds.minReviewRate);
  addMinViolation(violations, 'minCorrectRate', overall.rates.correctRate, thresholds.minCorrectRate);
  addMaxViolation(violations, 'maxIncorrectRate', overall.rates.incorrectRate, thresholds.maxIncorrectRate);
  addMaxViolation(violations, 'maxNoAnswerRate', overall.rates.noAnswerRate, thresholds.maxNoAnswerRate);
  addMaxViolation(violations, 'maxLowConfidenceRate', overall.rates.lowConfidenceRate, thresholds.maxLowConfidenceRate);
  addMaxViolation(violations, 'maxMissingSourcesRate', overall.rates.missingSourcesRate, thresholds.maxMissingSourcesRate);
  addErrorTypeViolations(violations, overall, thresholds.maxErrorTypeRates);
  return violations;
}

export function buildRagMetricsRecommendations(
  violations: RagMetricsThresholdViolation[],
): RagMetricsRecommendation[] {
  return violations.map((violation) => ({
    code: `threshold:${violation.metric}`,
    severity: violation.metric.startsWith('maxErrorTypeRates.unsupported_claim') || violation.metric.startsWith('maxErrorTypeRates.bad_source')
      ? 'critical'
      : 'warning',
    message: violation.message,
    action: violation.remediation,
    metric: violation.metric,
    errorType: violation.errorType,
  }));
}

export function renderRagMetricsMarkdown(report: RagMetricsReport): string {
  const lines: string[] = [
    '# RAG Metrics',
    '',
    `File: ${report.filePath}`,
    `Generated at: ${report.generatedAt}`,
    `Date range: ${report.since ?? '-'} to ${report.until ?? '-'}`,
    '',
    '## Overall',
    '',
    `- Jobs: ${report.jobCount}`,
    `- Failed jobs: ${report.failedJobCount}`,
    `- Total answers: ${report.overall.totalAnswers}`,
    `- Reviewed: ${report.overall.reviewedCount}`,
    `- Unreviewed: ${report.overall.unreviewedCount}`,
    `- Correct rate: ${formatRate(report.overall.rates.correctRate)}`,
    `- Incorrect rate: ${formatRate(report.overall.rates.incorrectRate)}`,
    `- No-answer rate: ${formatRate(report.overall.rates.noAnswerRate)}`,
    `- Low-confidence rate: ${formatRate(report.overall.rates.lowConfidenceRate)}`,
    `- Missing-source rate: ${formatRate(report.overall.rates.missingSourcesRate)}`,
    `- Average confidence: ${report.overall.averageConfidence ?? '-'}`,
    '',
    '## Thresholds',
    '',
  ];

  if (!report.thresholds) {
    lines.push('No thresholds configured.');
    lines.push('');
  } else {
    for (const [key, value] of Object.entries(report.thresholds)) {
      lines.push(`- ${key}: ${value}`);
    }
    lines.push('');
    if (report.thresholdViolations.length === 0) {
      lines.push('No threshold violations.');
    } else {
      lines.push('Threshold violations:');
      lines.push('');
      for (const violation of report.thresholdViolations) {
        lines.push(`- ${violation.message}`);
        lines.push(`  Remediation: ${violation.remediation}`);
      }
    }
    lines.push('');
  }

  lines.push('## Recommendations');
  lines.push('');
  if (report.recommendations.length === 0) {
    lines.push('No recommendations.');
    lines.push('');
  } else {
    for (const item of report.recommendations) {
      lines.push(`- ${item.severity}: ${item.message}`);
      lines.push(`  Action: ${item.action}`);
    }
    lines.push('');
  }

  lines.push('## Error Types');
  lines.push('');
  if (report.overall.errorTypes.length === 0) {
    lines.push('No incorrect feedback error types.');
    lines.push('');
  } else {
    lines.push('| Error Type | Count | Incorrect Rate |');
    lines.push('| --- | ---: | ---: |');
    for (const item of report.overall.errorTypes) {
      lines.push(`| ${item.errorType} | ${item.count} | ${formatRate(item.incorrectRate)} |`);
    }
    lines.push('');
  }

  lines.push(
    '## By Platform',
    '',
  );

  if (report.byPlatform.length === 0) {
    lines.push('No platform metrics.');
    lines.push('');
  } else {
    lines.push('| Platform | Answers | Reviewed | Correct Rate | No-answer Rate | Missing-source Rate | Top Error Types |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const item of report.byPlatform) {
      lines.push(`| ${item.platform} | ${item.totalAnswers} | ${item.reviewedCount} | ${formatRate(item.rates.correctRate)} | ${formatRate(item.rates.noAnswerRate)} | ${formatRate(item.rates.missingSourcesRate)} | ${formatTopErrorTypes(item.errorTypes)} |`);
    }
    lines.push('');
  }

  lines.push('## By Job');
  lines.push('');
  if (report.byJob.length === 0) {
    lines.push('No job metrics.');
    lines.push('');
  } else {
    lines.push('| Platform | Job | Answers | Reviewed | Correct Rate | No-answer Rate | Missing-source Rate | Top Error Types | Failed |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const item of report.byJob) {
      lines.push(`| ${item.platform} | ${item.jobKey} | ${item.totalAnswers} | ${item.reviewedCount} | ${formatRate(item.rates.correctRate)} | ${formatRate(item.rates.noAnswerRate)} | ${formatRate(item.rates.missingSourcesRate)} | ${formatTopErrorTypes(item.errorTypes)} | ${item.failed === true ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }

  lines.push('## By Day');
  lines.push('');
  if (report.byDay.length === 0) {
    lines.push('No daily metrics.');
    lines.push('');
  } else {
    lines.push('| Date | Answers | Reviewed | Correct Rate | No-answer Rate | Missing-source Rate | Top Error Types |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const item of report.byDay) {
      lines.push(`| ${item.date} | ${item.totalAnswers} | ${item.reviewedCount} | ${formatRate(item.rates.correctRate)} | ${formatRate(item.rates.noAnswerRate)} | ${formatRate(item.rates.missingSourcesRate)} | ${formatTopErrorTypes(item.errorTypes)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeRagMetrics(options: {
  filePath: string;
  outputPath?: string;
  format?: RagMetricsFormat;
  policyPath?: string;
  thresholds?: RagMetricsPolicy;
  since?: string;
  until?: string;
  lowConfidenceThreshold?: number;
  ragStore?: RagStore;
}): Promise<{ report: RagMetricsReport; content: string; outputPath?: string }> {
  const policy = options.policyPath ? await readRagMetricsPolicy(options.policyPath) : undefined;
  const thresholds = mergePolicies(policy, options.thresholds);
  const report = await buildRagMetricsReport({
    filePath: options.filePath,
    since: options.since,
    until: options.until,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    thresholds,
    ragStore: options.ragStore,
  });
  const content = options.format === 'markdown'
    ? renderRagMetricsMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, 'utf8');
    return { report, content, outputPath };
  }

  return { report, content };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    throw new Error('Usage: npm run rag:metrics -- --file ./rag-review-jobs.json [--output ./rag-metrics.json]');
  }

  const result = await writeRagMetrics({
    filePath: args.filePath,
    outputPath: args.outputPath,
    format: args.format,
    policyPath: args.policyPath,
    thresholds: {
      minReviewRate: args.minReviewRate,
      minCorrectRate: args.minCorrectRate,
      maxIncorrectRate: args.maxIncorrectRate,
      maxNoAnswerRate: args.maxNoAnswerRate,
      maxLowConfidenceRate: args.maxLowConfidenceRate,
      maxMissingSourcesRate: args.maxMissingSourcesRate,
    },
    since: args.since,
    until: args.until,
    lowConfidenceThreshold: args.lowConfidenceThreshold,
  });

  if (!result.outputPath) {
    console.log(result.content);
  } else {
    console.log(JSON.stringify({
      filePath: result.report.filePath,
      outputPath: result.outputPath,
      jobCount: result.report.jobCount,
      failedJobCount: result.report.failedJobCount,
      totalAnswers: result.report.overall.totalAnswers,
      reviewedCount: result.report.overall.reviewedCount,
      correctRate: result.report.overall.rates.correctRate,
      noAnswerRate: result.report.overall.rates.noAnswerRate,
      missingSourcesRate: result.report.overall.rates.missingSourcesRate,
      errorTypes: result.report.overall.errorTypes,
      thresholdViolationCount: result.report.thresholdViolations.length,
      thresholdViolations: result.report.thresholdViolations,
      recommendations: result.report.recommendations,
    }, null, 2));
  }

  if (args.failOnThreshold && result.report.thresholdViolations.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
