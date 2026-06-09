import fs from 'node:fs/promises';
import path from 'node:path';
import { RagStore } from '../rag/rag-store.js';
import {
  doctorRagBatch,
  type RagDoctorBatchSummary,
} from './rag-doctor-batch.js';
import {
  renderRagReviewBatchMarkdown,
  reviewRagBatch,
  type RagReviewBatchSummary,
} from './rag-review-batch.js';
import {
  buildRagMetricsReport,
  readRagMetricsPolicy,
  renderRagMetricsMarkdown,
  type RagMetricsPolicy,
  type RagMetricsReport,
} from './rag-metrics.js';

type RagOpsFormat = 'markdown' | 'json';
export type RagOpsReportStatus = 'ok' | 'needs_attention' | 'failed';

type DoctorRagBatchOptions = Parameters<typeof doctorRagBatch>[0];

export interface RagOpsRecommendation {
  source: 'doctor' | 'review' | 'metrics';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  action?: string;
}

export interface RagOpsReport {
  filePath: string;
  generatedAt: string;
  status: RagOpsReportStatus;
  recommendations: RagOpsRecommendation[];
  doctor: RagDoctorBatchSummary;
  review: RagReviewBatchSummary;
  metrics: RagMetricsReport;
}

interface Args {
  filePath?: string;
  outputPath?: string;
  format: RagOpsFormat;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  includeReviewed: boolean;
  lowConfidenceThreshold: number;
  limit?: number;
  reviewer?: string;
  policyPath?: string;
  since?: string;
  until?: string;
  failOnIssue: boolean;
  metricThresholds?: RagMetricsPolicy;
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

function parseOptionalPositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
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

function parseFormat(value: string | undefined): RagOpsFormat {
  if (value === undefined || value === 'markdown') {
    return 'markdown';
  }

  if (value === 'json') {
    return 'json';
  }

  throw new Error('--format must be markdown or json');
}

function parseOptionalIsoDate(value: string | undefined, flagName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(value))) {
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

  const metricThresholds = cleanMetricsPolicy({
    minReviewRate: parseOptionalRate(values.get('min-review-rate'), '--min-review-rate'),
    minCorrectRate: parseOptionalRate(values.get('min-correct-rate'), '--min-correct-rate'),
    maxIncorrectRate: parseOptionalRate(values.get('max-incorrect-rate'), '--max-incorrect-rate'),
    maxNoAnswerRate: parseOptionalRate(values.get('max-no-answer-rate'), '--max-no-answer-rate'),
    maxLowConfidenceRate: parseOptionalRate(values.get('max-low-confidence-rate'), '--max-low-confidence-rate'),
    maxMissingSourcesRate: parseOptionalRate(values.get('max-missing-sources-rate'), '--max-missing-sources-rate'),
  });

  return {
    filePath: values.get('file'),
    outputPath: values.get('output'),
    format: parseFormat(values.get('format')),
    question: values.get('question'),
    topK: parseOptionalPositiveInteger(values.get('top-k'), '--top-k'),
    denseTopK: parseOptionalPositiveInteger(values.get('dense-top-k'), '--dense-top-k'),
    keywordTopK: parseOptionalPositiveInteger(values.get('keyword-top-k'), '--keyword-top-k'),
    includeReviewed: parseBoolean(values.get('include-reviewed'), '--include-reviewed', false),
    lowConfidenceThreshold: parseThreshold(values.get('low-confidence-threshold'), 0.3),
    limit: parseOptionalPositiveInteger(values.get('limit'), '--limit'),
    reviewer: values.get('reviewer'),
    policyPath: values.get('policy'),
    since: parseOptionalIsoDate(values.get('since'), '--since'),
    until: parseOptionalIsoDate(values.get('until'), '--until'),
    failOnIssue: parseBoolean(values.get('fail-on-issue'), '--fail-on-issue', false),
    metricThresholds,
  };
}

function cleanMetricsPolicy(policy: RagMetricsPolicy | undefined): RagMetricsPolicy | undefined {
  if (!policy) {
    return undefined;
  }

  const result: RagMetricsPolicy = {};
  if (policy.minReviewRate !== undefined) {
    result.minReviewRate = policy.minReviewRate;
  }
  if (policy.minCorrectRate !== undefined) {
    result.minCorrectRate = policy.minCorrectRate;
  }
  if (policy.maxIncorrectRate !== undefined) {
    result.maxIncorrectRate = policy.maxIncorrectRate;
  }
  if (policy.maxNoAnswerRate !== undefined) {
    result.maxNoAnswerRate = policy.maxNoAnswerRate;
  }
  if (policy.maxLowConfidenceRate !== undefined) {
    result.maxLowConfidenceRate = policy.maxLowConfidenceRate;
  }
  if (policy.maxMissingSourcesRate !== undefined) {
    result.maxMissingSourcesRate = policy.maxMissingSourcesRate;
  }

  const errorTypeRates = Object.fromEntries(
    Object.entries(policy.maxErrorTypeRates ?? {})
      .filter((entry): entry is [string, number] => entry[1] !== undefined),
  ) as RagMetricsPolicy['maxErrorTypeRates'];
  if (errorTypeRates && Object.keys(errorTypeRates).length > 0) {
    result.maxErrorTypeRates = errorTypeRates;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeMetricsPolicies(
  policy: RagMetricsPolicy | undefined,
  overrides: RagMetricsPolicy | undefined,
): RagMetricsPolicy | undefined {
  const cleanedPolicy = cleanMetricsPolicy(policy);
  const cleanedOverrides = cleanMetricsPolicy(overrides);
  if (!cleanedPolicy) {
    return cleanedOverrides;
  }

  if (!cleanedOverrides) {
    return cleanedPolicy;
  }

  return cleanMetricsPolicy({
    ...cleanedPolicy,
    ...cleanedOverrides,
    maxErrorTypeRates: {
      ...(cleanedPolicy.maxErrorTypeRates ?? {}),
      ...(cleanedOverrides.maxErrorTypeRates ?? {}),
    },
  });
}

function summarizeOpsStatus(options: {
  doctor: RagDoctorBatchSummary;
  review: RagReviewBatchSummary;
  metrics: RagMetricsReport;
}): RagOpsReportStatus {
  if (
    options.doctor.status === 'error'
    || options.review.status === 'failed'
    || options.metrics.failedJobCount > 0
    || options.metrics.thresholdViolations.length > 0
  ) {
    return 'failed';
  }

  if (
    options.doctor.status === 'warning'
    || options.review.status === 'needs_review'
  ) {
    return 'needs_attention';
  }

  return 'ok';
}

function buildOpsRecommendations(options: {
  doctor: RagDoctorBatchSummary;
  review: RagReviewBatchSummary;
  metrics: RagMetricsReport;
}): RagOpsRecommendation[] {
  const recommendations: RagOpsRecommendation[] = [];

  for (const recommendation of options.doctor.recommendations) {
    recommendations.push({
      source: 'doctor',
      severity: options.doctor.status === 'error' ? 'critical' : 'warning',
      message: recommendation,
    });
  }

  if (options.review.needsReviewCount > 0 || options.review.totals.reviewItemCount > 0) {
    recommendations.push({
      source: 'review',
      severity: 'warning',
      message: `Review ${options.review.totals.reviewItemCount} RAG answer logs across ${options.review.needsReviewCount} jobs.`,
      action: 'Run the feedback commands in the review section, then regenerate metrics.',
    });
  }

  if (options.review.totals.missingErrorType > 0) {
    recommendations.push({
      source: 'review',
      severity: 'warning',
      message: `Backfill ${options.review.totals.missingErrorType} incorrect feedback records without errorType.`,
      action: 'Use the Fill missing error type commands and replace --error-type other with the real cause.',
    });
  }

  for (const recommendation of options.metrics.recommendations) {
    recommendations.push({
      source: 'metrics',
      severity: recommendation.severity,
      message: recommendation.message,
      action: recommendation.action,
    });
  }

  return recommendations;
}

export async function buildRagOpsReport(options: {
  filePath: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  policyPath?: string;
  thresholds?: RagMetricsPolicy;
  since?: string;
  until?: string;
  ragStore?: RagStore;
  doctorRagJobFn?: DoctorRagBatchOptions['doctorRagJobFn'];
  generatedAt?: string;
}): Promise<RagOpsReport> {
  const ragStore = options.ragStore ?? new RagStore();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const policy = options.policyPath ? await readRagMetricsPolicy(options.policyPath) : undefined;
  const thresholds = mergeMetricsPolicies(policy, options.thresholds);

  const doctor = await doctorRagBatch({
    filePath: options.filePath,
    question: options.question,
    topK: options.topK,
    denseTopK: options.denseTopK,
    keywordTopK: options.keywordTopK,
    doctorRagJobFn: options.doctorRagJobFn,
  });
  const review = await reviewRagBatch({
    filePath: options.filePath,
    includeReviewed: options.includeReviewed,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    limit: options.limit,
    reviewer: options.reviewer,
    ragStore,
  });
  const metrics = await buildRagMetricsReport({
    filePath: options.filePath,
    since: options.since,
    until: options.until,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    thresholds,
    ragStore,
    generatedAt,
  });

  const status = summarizeOpsStatus({ doctor, review, metrics });
  const recommendations = buildOpsRecommendations({ doctor, review, metrics });

  return {
    filePath: options.filePath,
    generatedAt,
    status,
    recommendations,
    doctor,
    review,
    metrics,
  };
}

function formatRate(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function escapeTableCell(value: unknown): string {
  return String(value ?? '-').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function demoteMarkdownHeadings(markdown: string, levels: number): string {
  const prefix = '#'.repeat(levels);
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (line.startsWith('```')) {
      inFence = !inFence;
      return line;
    }

    if (!inFence && /^#{1,6}\s/.test(line)) {
      return `${prefix}${line}`;
    }

    return line;
  }).join('\n');
}

export function renderRagOpsMarkdown(report: RagOpsReport): string {
  const lines: string[] = [
    '# RAG Operations Report',
    '',
    `File: ${report.filePath}`,
    `Generated at: ${report.generatedAt}`,
    `Status: ${report.status}`,
    '',
    '## Executive Summary',
    '',
    `- Doctor: ${report.doctor.status} (${report.doctor.okCount} ok, ${report.doctor.warningCount} warning, ${report.doctor.errorCount} error, ${report.doctor.failedCount} failed)`,
    `- Review: ${report.review.status} (${report.review.needsReviewCount} jobs needing review, ${report.review.totals.reviewItemCount} review items, ${report.review.totals.missingErrorType} missing error types)`,
    `- Metrics: ${report.metrics.overall.totalAnswers} answers, ${report.metrics.overall.reviewedCount} reviewed, correct rate ${formatRate(report.metrics.overall.rates.correctRate)}, no-answer rate ${formatRate(report.metrics.overall.rates.noAnswerRate)}, missing-source rate ${formatRate(report.metrics.overall.rates.missingSourcesRate)}`,
    `- Threshold violations: ${report.metrics.thresholdViolations.length}`,
    '',
    '## Recommendations',
    '',
  ];

  if (report.recommendations.length === 0) {
    lines.push('No recommendations.');
    lines.push('');
  } else {
    for (const item of report.recommendations) {
      lines.push(`- ${item.severity} / ${item.source}: ${item.message}`);
      if (item.action) {
        lines.push(`  Action: ${item.action}`);
      }
    }
    lines.push('');
  }

  lines.push('## Doctor Summary');
  lines.push('');
  lines.push(`- Jobs: ${report.doctor.itemCount}`);
  lines.push(`- Status: ${report.doctor.status}`);
  lines.push(`- OK jobs: ${report.doctor.okCount}`);
  lines.push(`- Warning jobs: ${report.doctor.warningCount}`);
  lines.push(`- Error jobs: ${report.doctor.errorCount}`);
  lines.push(`- Failed jobs: ${report.doctor.failedCount}`);
  lines.push('');

  if (report.doctor.issueCounts.length === 0) {
    lines.push('No doctor issues.');
    lines.push('');
  } else {
    lines.push('| Issue Code | Count | Severity |');
    lines.push('| --- | ---: | --- |');
    for (const issue of report.doctor.issueCounts) {
      lines.push(`| ${escapeTableCell(issue.code)} | ${issue.count} | ${issue.severity} |`);
    }
    lines.push('');
  }

  if (report.doctor.results.length > 0) {
    lines.push('| Platform | Job | Status | Issues | Error |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const result of report.doctor.results) {
      lines.push([
        escapeTableCell(result.platform),
        escapeTableCell(result.jobKey),
        escapeTableCell(result.status),
        escapeTableCell(result.issueCodes?.join(', ') || '-'),
        escapeTableCell(result.error),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
  }

  lines.push('## Review Details');
  lines.push('');
  lines.push(demoteMarkdownHeadings(renderRagReviewBatchMarkdown(report.review), 2));
  lines.push('');
  lines.push('## Metrics Details');
  lines.push('');
  lines.push(demoteMarkdownHeadings(renderRagMetricsMarkdown(report.metrics), 2));
  lines.push('');

  return lines.join('\n');
}

export async function writeRagOpsReport(options: {
  filePath: string;
  outputPath?: string;
  format?: RagOpsFormat;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  policyPath?: string;
  thresholds?: RagMetricsPolicy;
  since?: string;
  until?: string;
  ragStore?: RagStore;
  doctorRagJobFn?: DoctorRagBatchOptions['doctorRagJobFn'];
  generatedAt?: string;
}): Promise<{ report: RagOpsReport; content: string; outputPath?: string }> {
  const report = await buildRagOpsReport(options);
  const content = options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderRagOpsMarkdown(report);

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
    throw new Error('Usage: npm run rag:ops -- --file ./rag-review-jobs.json [--question "<question>"] [--policy ./rag-metrics-policy.json] [--output ./rag-ops.md] [--fail-on-issue true]');
  }

  const result = await writeRagOpsReport({
    filePath: args.filePath,
    outputPath: args.outputPath,
    format: args.format,
    question: args.question,
    topK: args.topK,
    denseTopK: args.denseTopK,
    keywordTopK: args.keywordTopK,
    includeReviewed: args.includeReviewed,
    lowConfidenceThreshold: args.lowConfidenceThreshold,
    limit: args.limit,
    reviewer: args.reviewer,
    policyPath: args.policyPath,
    thresholds: args.metricThresholds,
    since: args.since,
    until: args.until,
  });

  if (!result.outputPath) {
    console.log(result.content);
  } else {
    console.log(JSON.stringify({
      filePath: result.report.filePath,
      outputPath: result.outputPath,
      status: result.report.status,
      doctorStatus: result.report.doctor.status,
      reviewStatus: result.report.review.status,
      totalAnswers: result.report.metrics.overall.totalAnswers,
      reviewItems: result.report.review.totals.reviewItemCount,
      thresholdViolationCount: result.report.metrics.thresholdViolations.length,
    }, null, 2));
  }

  if (args.failOnIssue && result.report.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
