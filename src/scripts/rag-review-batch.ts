import fs from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { ensureAnswerLogId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import {
  buildRagReviewReport,
  renderRagReviewMarkdown,
  type RagReviewReport,
} from './rag-review.js';

type RagReviewBatchFormat = 'markdown' | 'json';

export interface RagReviewBatchItem {
  platform: SupportedPlatform;
  jobKey: string;
  sourceLine?: number;
}

export interface RagReviewBatchResultItem {
  index: number;
  sourceLine?: number;
  platform?: SupportedPlatform;
  jobKey?: string;
  status: 'ok' | 'needs_review' | 'failed';
  totalLogCount?: number;
  itemCount?: number;
  counts?: RagReviewReport['counts'];
  report?: RagReviewReport;
  error?: string;
}

export interface RagReviewBatchSummary {
  filePath: string;
  status: 'ok' | 'needs_review' | 'failed';
  itemCount: number;
  okCount: number;
  needsReviewCount: number;
  failedCount: number;
  totals: RagReviewReport['counts'] & {
    totalLogCount: number;
    reviewItemCount: number;
  };
  results: RagReviewBatchResultItem[];
}

interface Args {
  filePath?: string;
  format: RagReviewBatchFormat;
  outputPath?: string;
  includeReviewed: boolean;
  lowConfidenceThreshold: number;
  limit?: number;
  reviewer?: string;
  failOnIssue: boolean;
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

function parseFormat(value: string | undefined): RagReviewBatchFormat {
  if (value === undefined || value === 'markdown') {
    return 'markdown';
  }

  if (value === 'json') {
    return 'json';
  }

  throw new Error('--format must be markdown or json');
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
    format: parseFormat(values.get('format')),
    outputPath: values.get('output'),
    includeReviewed: parseBoolean(values.get('include-reviewed'), '--include-reviewed', false),
    lowConfidenceThreshold: parseThreshold(values.get('low-confidence-threshold'), 0.3),
    limit: parseOptionalPositiveInteger(values.get('limit'), '--limit'),
    reviewer: values.get('reviewer'),
    failOnIssue: parseBoolean(values.get('fail-on-issue'), '--fail-on-issue', false),
  };
}

function getOptionalStringField(
  item: Record<string, unknown>,
  fieldName: string,
  fieldPath: string,
): string | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldPath}.${fieldName} must be a non-empty string when provided`);
  }

  return value.trim();
}

export function normalizeReviewBatchItem(
  value: unknown,
  index: number,
  sourceLine?: number,
): RagReviewBatchItem {
  const fieldPath = sourceLine ? `item at line ${sourceLine}` : `item[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.platform !== 'string' || !item.platform.trim()) {
    throw new Error(`${fieldPath}.platform must be a non-empty string`);
  }

  const platform = parsePlatformArg(item.platform.trim());
  const keyword = getOptionalStringField(item, 'keyword', fieldPath);
  const jobKey = getOptionalStringField(item, 'jobKey', fieldPath)
    ?? (keyword ? buildJobKey(keyword, '') : undefined);
  if (!jobKey) {
    throw new Error(`${fieldPath} must include jobKey or keyword`);
  }

  return {
    platform,
    jobKey,
    sourceLine,
  };
}

function extractPayloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: unknown[] }).items;
  }

  throw new Error('RAG review batch file must contain a JSON array, an object with items[], or JSONL rows');
}

export async function readReviewBatchFile(filePath: string): Promise<RagReviewBatchItem[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const items = extractPayloadItems(JSON.parse(trimmed) as unknown);
      return items.map((item, index) => normalizeReviewBatchItem(item, index));
    } catch (error) {
      if (trimmed.startsWith('[')) {
        throw error;
      }
    }
  }

  return trimmed.split('\n')
    .map((line, index) => ({ line: line.trim(), sourceLine: index + 1 }))
    .filter((item) => item.line)
    .map(({ line, sourceLine }, index) => normalizeReviewBatchItem(JSON.parse(line) as unknown, index, sourceLine));
}

function emptyCounts(): RagReviewBatchSummary['totals'] {
  return {
    totalLogCount: 0,
    reviewItemCount: 0,
    unreviewed: 0,
    reviewedCorrect: 0,
    reviewedIncorrect: 0,
    noAnswer: 0,
    lowConfidence: 0,
    missingSources: 0,
    missingErrorType: 0,
  };
}

function addCounts(
  target: RagReviewBatchSummary['totals'],
  report: RagReviewReport,
): void {
  target.totalLogCount += report.totalLogCount;
  target.reviewItemCount += report.itemCount;
  target.unreviewed += report.counts.unreviewed;
  target.reviewedCorrect += report.counts.reviewedCorrect;
  target.reviewedIncorrect += report.counts.reviewedIncorrect;
  target.noAnswer += report.counts.noAnswer;
  target.lowConfidence += report.counts.lowConfidence;
  target.missingSources += report.counts.missingSources;
  target.missingErrorType += report.counts.missingErrorType;
}

function summarizeStatus(results: RagReviewBatchResultItem[]): RagReviewBatchSummary['status'] {
  if (results.some((result) => result.status === 'failed')) {
    return 'failed';
  }

  if (results.some((result) => result.status === 'needs_review')) {
    return 'needs_review';
  }

  return 'ok';
}

export async function reviewRagBatch(options: {
  filePath: string;
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  ragStore?: RagStore;
}): Promise<RagReviewBatchSummary> {
  const items = await readReviewBatchFile(options.filePath);
  return reviewRagBatchItems({
    filePath: options.filePath,
    items,
    includeReviewed: options.includeReviewed,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    limit: options.limit,
    reviewer: options.reviewer,
    ragStore: options.ragStore,
  });
}

export async function reviewRagBatchItems(options: {
  filePath: string;
  items: RagReviewBatchItem[];
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  ragStore?: RagStore;
}): Promise<RagReviewBatchSummary> {
  const ragStore = options.ragStore ?? new RagStore();
  const results: RagReviewBatchResultItem[] = [];
  const totals = emptyCounts();

  for (const [index, item] of options.items.entries()) {
    try {
      const logs = await ragStore.listAnswerLogs(item.platform, item.jobKey);
      const report = buildRagReviewReport({
        platform: item.platform,
        jobKey: item.jobKey,
        logs: logs.map(ensureAnswerLogId),
        includeReviewed: options.includeReviewed,
        lowConfidenceThreshold: options.lowConfidenceThreshold,
        limit: options.limit,
        reviewer: options.reviewer,
      });
      addCounts(totals, report);
      results.push({
        index,
        sourceLine: item.sourceLine,
        platform: item.platform,
        jobKey: item.jobKey,
        status: report.itemCount > 0 ? 'needs_review' : 'ok',
        totalLogCount: report.totalLogCount,
        itemCount: report.itemCount,
        counts: report.counts,
        report,
      });
    } catch (error) {
      results.push({
        index,
        sourceLine: item.sourceLine,
        platform: item.platform,
        jobKey: item.jobKey,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    filePath: options.filePath,
    status: summarizeStatus(results),
    itemCount: options.items.length,
    okCount: results.filter((result) => result.status === 'ok').length,
    needsReviewCount: results.filter((result) => result.status === 'needs_review').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    totals,
    results,
  };
}

export function renderRagReviewBatchMarkdown(summary: RagReviewBatchSummary): string {
  const lines: string[] = [
    '# RAG Review Batch',
    '',
    `File: ${summary.filePath}`,
    `Status: ${summary.status}`,
    '',
    '## Summary',
    '',
    `- Jobs: ${summary.itemCount}`,
    `- OK jobs: ${summary.okCount}`,
    `- Jobs needing review: ${summary.needsReviewCount}`,
    `- Failed jobs: ${summary.failedCount}`,
    `- Total logs: ${summary.totals.totalLogCount}`,
    `- Review items: ${summary.totals.reviewItemCount}`,
    `- Unreviewed: ${summary.totals.unreviewed}`,
    `- Reviewed correct: ${summary.totals.reviewedCorrect}`,
    `- Reviewed incorrect: ${summary.totals.reviewedIncorrect}`,
    `- No-answer logs: ${summary.totals.noAnswer}`,
    `- Low-confidence answers: ${summary.totals.lowConfidence}`,
    `- Missing-source answers: ${summary.totals.missingSources}`,
    `- Missing error types: ${summary.totals.missingErrorType}`,
    '',
    '## Jobs',
    '',
  ];

  if (summary.results.length === 0) {
    lines.push('No jobs.');
    lines.push('');
    return lines.join('\n');
  }

  for (const result of summary.results) {
    lines.push(`## ${result.index + 1}. ${result.platform ?? '-'} / ${result.jobKey ?? '-'}`);
    lines.push('');
    lines.push(`- status: ${result.status}`);
    if (result.error) {
      lines.push(`- error: ${result.error}`);
    }
    if (result.totalLogCount !== undefined) {
      lines.push(`- total logs: ${result.totalLogCount}`);
      lines.push(`- review items: ${result.itemCount ?? 0}`);
    }
    lines.push('');
    if (result.report && result.report.items.length > 0) {
      lines.push(renderRagReviewMarkdown(result.report));
      lines.push('');
    }
  }

  return lines.join('\n');
}

export async function writeRagReviewBatch(options: {
  filePath: string;
  format?: RagReviewBatchFormat;
  outputPath?: string;
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  ragStore?: RagStore;
}): Promise<{ summary: RagReviewBatchSummary; content: string; outputPath?: string }> {
  const summary = await reviewRagBatch({
    filePath: options.filePath,
    includeReviewed: options.includeReviewed,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    limit: options.limit,
    reviewer: options.reviewer,
    ragStore: options.ragStore,
  });
  const content = options.format === 'json'
    ? `${JSON.stringify(summary, null, 2)}\n`
    : renderRagReviewBatchMarkdown(summary);

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, 'utf8');
    return { summary, content, outputPath };
  }

  return { summary, content };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    throw new Error('Usage: npm run rag:review:batch -- --file ./rag-review-jobs.json [--output ./rag-review.md] [--fail-on-issue true]');
  }

  const result = await writeRagReviewBatch({
    filePath: args.filePath,
    format: args.format,
    outputPath: args.outputPath,
    includeReviewed: args.includeReviewed,
    lowConfidenceThreshold: args.lowConfidenceThreshold,
    limit: args.limit,
    reviewer: args.reviewer,
  });

  if (!result.outputPath) {
    console.log(result.content);
  } else {
    console.log(JSON.stringify({
      filePath: result.summary.filePath,
      outputPath: result.outputPath,
      status: result.summary.status,
      itemCount: result.summary.itemCount,
      okCount: result.summary.okCount,
      needsReviewCount: result.summary.needsReviewCount,
      failedCount: result.summary.failedCount,
      totals: result.summary.totals,
    }, null, 2));
  }

  if (args.failOnIssue && result.summary.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
