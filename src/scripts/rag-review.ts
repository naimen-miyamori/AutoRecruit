import fs from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { ensureAnswerLogId, type RagAnswerLogRecordWithId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerFeedback, RagSourceType } from '../rag/types.js';

type RagReviewFormat = 'markdown' | 'json';
type RagReviewReason = 'reviewed_incorrect' | 'missing_error_type' | 'no_answer' | 'missing_sources' | 'low_confidence' | 'unreviewed' | 'reviewed_correct';
type RagReviewStatus = 'reviewed_correct' | 'reviewed_incorrect' | 'unreviewed';

export interface RagReviewSourcePreview {
  sourceType: RagSourceType;
  chunkId: string;
  sourceId: string;
  score: number;
  text: string;
  verified: boolean;
  conversationId?: string;
}

export interface RagReviewItem {
  logId: string;
  createdAt: string;
  question: string;
  answer: string;
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
  status: RagReviewStatus;
  reasons: RagReviewReason[];
  feedback?: RagAnswerFeedback;
  sourceCount: number;
  sources: RagReviewSourcePreview[];
  feedbackCommands: {
    markCorrect: string;
    markIncorrect: string;
    fillErrorType?: string;
  };
}

export interface RagReviewReport {
  platform: SupportedPlatform;
  jobKey: string;
  generatedAt: string;
  lowConfidenceThreshold: number;
  totalLogCount: number;
  itemCount: number;
  counts: {
    unreviewed: number;
    reviewedCorrect: number;
    reviewedIncorrect: number;
    noAnswer: number;
    lowConfidence: number;
    missingSources: number;
    missingErrorType: number;
  };
  items: RagReviewItem[];
}

interface Args {
  platform: SupportedPlatform;
  jobKey?: string;
  keyword?: string;
  format: RagReviewFormat;
  outputPath?: string;
  includeReviewed: boolean;
  lowConfidenceThreshold: number;
  limit?: number;
  reviewer?: string;
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

function parseFormat(value: string | undefined): RagReviewFormat {
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
    platform: parsePlatformArg(values.get('platform')),
    jobKey: values.get('job-key'),
    keyword: values.get('keyword'),
    format: parseFormat(values.get('format')),
    outputPath: values.get('output'),
    includeReviewed: parseBoolean(values.get('include-reviewed'), '--include-reviewed', false),
    lowConfidenceThreshold: parseThreshold(values.get('low-confidence-threshold'), 0.3),
    limit: parseOptionalPositiveInteger(values.get('limit'), '--limit'),
    reviewer: values.get('reviewer'),
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncateText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function getStatus(log: RagAnswerLogRecordWithId): RagReviewStatus {
  if (log.feedback?.correct === true) {
    return 'reviewed_correct';
  }

  if (log.feedback?.correct === false) {
    return 'reviewed_incorrect';
  }

  return 'unreviewed';
}

function getReasons(log: RagAnswerLogRecordWithId, lowConfidenceThreshold: number): RagReviewReason[] {
  const reasons: RagReviewReason[] = [];

  if (log.feedback?.correct === false) {
    reasons.push('reviewed_incorrect');
    if (log.feedback.errorType === undefined) {
      reasons.push('missing_error_type');
    }
  }

  if (log.answered === false) {
    reasons.push('no_answer');
  }

  if (log.answered !== false && log.sources.length === 0) {
    reasons.push('missing_sources');
  }

  if (log.answered !== false && log.confidence !== undefined && log.confidence < lowConfidenceThreshold) {
    reasons.push('low_confidence');
  }

  if (log.feedback?.correct === true) {
    reasons.push('reviewed_correct');
  } else if (log.feedback?.correct !== false) {
    reasons.push('unreviewed');
  }

  return reasons;
}

function getPriority(reasons: RagReviewReason[]): number {
  if (reasons.includes('reviewed_incorrect')) {
    return 10;
  }

  if (reasons.includes('no_answer')) {
    return 20;
  }

  if (reasons.includes('missing_sources')) {
    return 30;
  }

  if (reasons.includes('low_confidence')) {
    return 40;
  }

  if (reasons.includes('unreviewed')) {
    return 50;
  }

  return 90;
}

function buildFeedbackCommands(options: {
  platform: SupportedPlatform;
  jobKey: string;
  logId: string;
  hasMissingErrorType: boolean;
  reviewer?: string;
}): { markCorrect: string; markIncorrect: string; fillErrorType?: string } {
  const base = [
    'rtk npm run rag:feedback --',
    '--platform',
    options.platform,
    '--job-key',
    shellQuote(options.jobKey),
    '--log-id',
    shellQuote(options.logId),
  ].join(' ');
  const reviewer = options.reviewer ? ` --reviewer ${shellQuote(options.reviewer)}` : '';
  const markIncorrect = `${base} --correct false --error-type other --note ${shellQuote('请填写问题原因')}${reviewer}`;
  return {
    markCorrect: `${base} --correct true --note ${shellQuote('已人工确认')}${reviewer}`,
    markIncorrect,
    ...(options.hasMissingErrorType ? { fillErrorType: markIncorrect } : {}),
  };
}

function toReviewItem(options: {
  platform: SupportedPlatform;
  jobKey: string;
  log: RagAnswerLogRecordWithId;
  lowConfidenceThreshold: number;
  reviewer?: string;
}): RagReviewItem {
  const reasons = getReasons(options.log, options.lowConfidenceThreshold);
  return {
    logId: options.log.logId,
    createdAt: options.log.createdAt,
    question: options.log.question,
    answer: options.log.answer,
    answered: options.log.answered,
    confidence: options.log.confidence,
    noAnswerReason: options.log.noAnswerReason,
    status: getStatus(options.log),
    reasons,
    feedback: options.log.feedback,
    sourceCount: options.log.sources.length,
    sources: options.log.sources.slice(0, 5).map((source) => ({
      sourceType: source.sourceType,
      chunkId: source.chunkId,
      sourceId: source.sourceId,
      score: source.score,
      text: truncateText(source.text, 180),
      verified: source.verified,
      conversationId: source.conversationId,
    })),
    feedbackCommands: buildFeedbackCommands({
      platform: options.platform,
      jobKey: options.jobKey,
      logId: options.log.logId,
      hasMissingErrorType: options.log.feedback?.correct === false && options.log.feedback.errorType === undefined,
      reviewer: options.reviewer,
    }),
  };
}

function compareItems(a: RagReviewItem, b: RagReviewItem): number {
  const priorityDiff = getPriority(a.reasons) - getPriority(b.reasons);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function buildRagReviewReport(options: {
  platform: SupportedPlatform;
  jobKey: string;
  logs: RagAnswerLogRecordWithId[];
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  generatedAt?: string;
}): RagReviewReport {
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? 0.3;
  const logs = options.logs.map(ensureAnswerLogId);
  const counts = {
    unreviewed: logs.filter((log) => log.feedback?.correct === undefined).length,
    reviewedCorrect: logs.filter((log) => log.feedback?.correct === true).length,
    reviewedIncorrect: logs.filter((log) => log.feedback?.correct === false).length,
    noAnswer: logs.filter((log) => log.answered === false).length,
    lowConfidence: logs.filter((log) => log.answered !== false && log.confidence !== undefined && log.confidence < lowConfidenceThreshold).length,
    missingSources: logs.filter((log) => log.answered !== false && log.sources.length === 0).length,
    missingErrorType: logs.filter((log) => log.feedback?.correct === false && log.feedback.errorType === undefined).length,
  };
  const items = logs
    .filter((log) => options.includeReviewed === true || log.feedback?.correct !== true)
    .map((log) => toReviewItem({
      platform: options.platform,
      jobKey: options.jobKey,
      log,
      lowConfidenceThreshold,
      reviewer: options.reviewer,
    }))
    .sort(compareItems)
    .slice(0, options.limit);

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    lowConfidenceThreshold,
    totalLogCount: logs.length,
    itemCount: items.length,
    counts,
    items,
  };
}

function renderOptionalValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  return String(value);
}

export function renderRagReviewMarkdown(report: RagReviewReport): string {
  const lines: string[] = [
    `# RAG Review: ${report.platform}/${report.jobKey}`,
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Total logs: ${report.totalLogCount}`,
    `- Review items: ${report.itemCount}`,
    `- Unreviewed: ${report.counts.unreviewed}`,
    `- Reviewed correct: ${report.counts.reviewedCorrect}`,
    `- Reviewed incorrect: ${report.counts.reviewedIncorrect}`,
    `- No-answer logs: ${report.counts.noAnswer}`,
    `- Low-confidence answers: ${report.counts.lowConfidence} (< ${report.lowConfidenceThreshold})`,
    `- Missing-source answers: ${report.counts.missingSources}`,
    `- Missing error types: ${report.counts.missingErrorType}`,
    '',
    '## Items',
    '',
  ];

  if (report.items.length === 0) {
    lines.push('No review items.');
    lines.push('');
    return lines.join('\n');
  }

  report.items.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${item.question}`);
    lines.push('');
    lines.push(`- logId: \`${item.logId}\``);
    lines.push(`- createdAt: ${item.createdAt}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- reasons: ${item.reasons.join(', ')}`);
    lines.push(`- answered: ${renderOptionalValue(item.answered)}`);
    lines.push(`- confidence: ${renderOptionalValue(item.confidence)}`);
    lines.push(`- noAnswerReason: ${renderOptionalValue(item.noAnswerReason)}`);
    lines.push(`- sourceCount: ${item.sourceCount}`);
    if (item.feedback) {
      lines.push(`- feedback: correct=${renderOptionalValue(item.feedback.correct)}, errorType=${renderOptionalValue(item.feedback.errorType)}, reviewer=${renderOptionalValue(item.feedback.reviewer)}, note=${renderOptionalValue(item.feedback.note)}`);
    }
    lines.push('');
    lines.push('Answer:');
    lines.push('');
    lines.push('```text');
    lines.push(item.answer);
    lines.push('```');
    lines.push('');
    if (item.sources.length > 0) {
      lines.push('Sources:');
      lines.push('');
      for (const source of item.sources) {
        lines.push(`- ${source.sourceType} / ${source.chunkId} / score=${source.score}: ${source.text}`);
      }
      lines.push('');
    }
    lines.push('Feedback commands:');
    lines.push('');
    lines.push('```bash');
    lines.push(item.feedbackCommands.markCorrect);
    lines.push(item.feedbackCommands.markIncorrect);
    if (item.feedbackCommands.fillErrorType) {
      lines.push(`# Fill missing error type: edit --error-type before running if other is not accurate`);
      lines.push(item.feedbackCommands.fillErrorType);
    }
    lines.push('```');
    lines.push('');
  });

  return lines.join('\n');
}

export async function writeRagReview(options: {
  platform: SupportedPlatform;
  jobKey: string;
  format?: RagReviewFormat;
  outputPath?: string;
  includeReviewed?: boolean;
  lowConfidenceThreshold?: number;
  limit?: number;
  reviewer?: string;
  ragStore?: RagStore;
}): Promise<{ report: RagReviewReport; content: string; outputPath?: string }> {
  const ragStore = options.ragStore ?? new RagStore();
  const logs = await ragStore.listAnswerLogs(options.platform, options.jobKey);
  const report = buildRagReviewReport({
    platform: options.platform,
    jobKey: options.jobKey,
    logs: logs.map(ensureAnswerLogId),
    includeReviewed: options.includeReviewed,
    lowConfidenceThreshold: options.lowConfidenceThreshold,
    limit: options.limit,
    reviewer: options.reviewer,
  });
  const content = options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderRagReviewMarkdown(report);

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
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);

  if (!jobKey) {
    throw new Error('Usage: npm run rag:review -- --platform <platform> --keyword "<keyword>" [--format markdown|json] [--output ./rag-review.md]');
  }

  const result = await writeRagReview({
    platform: args.platform,
    jobKey,
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
      platform: result.report.platform,
      jobKey: result.report.jobKey,
      outputPath: result.outputPath,
      totalLogCount: result.report.totalLogCount,
      itemCount: result.report.itemCount,
      counts: result.report.counts,
    }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
