import fs from 'node:fs/promises';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { doctorRagJob, type DoctorRagJobOptions, type RagDoctorIssue, type RagDoctorSummary } from '../rag/doctor.js';

export interface RagDoctorBatchItem {
  platform: SupportedPlatform;
  jobKey: string;
  question?: string;
  sourceLine?: number;
}

export interface RagDoctorBatchResultItem {
  index: number;
  sourceLine?: number;
  platform?: SupportedPlatform;
  jobKey?: string;
  question?: string;
  status: RagDoctorSummary['status'] | 'failed';
  issueCount?: number;
  issueCodes?: string[];
  recommendations?: string[];
  summary?: RagDoctorSummary;
  error?: string;
}

export interface RagDoctorIssueCount {
  code: string;
  count: number;
  severity: RagDoctorIssue['severity'];
}

export interface RagDoctorBatchSummary {
  filePath: string;
  status: RagDoctorSummary['status'];
  itemCount: number;
  okCount: number;
  warningCount: number;
  errorCount: number;
  failedCount: number;
  issueCounts: RagDoctorIssueCount[];
  recommendations: string[];
  results: RagDoctorBatchResultItem[];
}

interface Args {
  filePath?: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  failOnIssue: boolean;
}

type DoctorRagJobFn = (options: DoctorRagJobOptions) => Promise<RagDoctorSummary>;

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

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    filePath: values.get('file'),
    question: values.get('question'),
    topK: parseOptionalPositiveInteger(values.get('top-k'), '--top-k'),
    denseTopK: parseOptionalPositiveInteger(values.get('dense-top-k'), '--dense-top-k'),
    keywordTopK: parseOptionalPositiveInteger(values.get('keyword-top-k'), '--keyword-top-k'),
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

export function normalizeDoctorBatchItem(
  value: unknown,
  index: number,
  sourceLine?: number,
): RagDoctorBatchItem {
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
    question: getOptionalStringField(item, 'question', fieldPath),
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

  throw new Error('RAG doctor batch file must contain a JSON array, an object with items[], or JSONL rows');
}

export async function readDoctorBatchFile(filePath: string): Promise<RagDoctorBatchItem[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const items = extractPayloadItems(JSON.parse(trimmed) as unknown);
      return items.map((item, index) => normalizeDoctorBatchItem(item, index));
    } catch (error) {
      if (trimmed.startsWith('[')) {
        throw error;
      }
    }
  }

  return trimmed.split('\n')
    .map((line, index) => ({ line: line.trim(), sourceLine: index + 1 }))
    .filter((item) => item.line)
    .map(({ line, sourceLine }, index) => normalizeDoctorBatchItem(JSON.parse(line) as unknown, index, sourceLine));
}

function buildResultBase(item: RagDoctorBatchItem, index: number): Omit<RagDoctorBatchResultItem, 'status'> {
  return {
    index,
    sourceLine: item.sourceLine,
    platform: item.platform,
    jobKey: item.jobKey,
    question: item.question,
  };
}

function summarizeBatchStatus(results: RagDoctorBatchResultItem[]): RagDoctorBatchSummary['status'] {
  if (results.some((result) => result.status === 'error' || result.status === 'failed')) {
    return 'error';
  }

  if (results.some((result) => result.status === 'warning')) {
    return 'warning';
  }

  return 'ok';
}

function summarizeIssueCounts(results: RagDoctorBatchResultItem[]): RagDoctorIssueCount[] {
  const counts = new Map<string, RagDoctorIssueCount>();
  const severityRank: Record<RagDoctorIssue['severity'], number> = {
    info: 0,
    warning: 1,
    error: 2,
  };

  for (const result of results) {
    for (const issue of result.summary?.issues ?? []) {
      const existing = counts.get(issue.code);
      if (!existing) {
        counts.set(issue.code, {
          code: issue.code,
          count: 1,
          severity: issue.severity,
        });
        continue;
      }

      existing.count += 1;
      if (severityRank[issue.severity] > severityRank[existing.severity]) {
        existing.severity = issue.severity;
      }
    }
  }

  return [...counts.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    return left.code.localeCompare(right.code);
  });
}

function summarizeRecommendations(results: RagDoctorBatchResultItem[]): string[] {
  return [...new Set(results.flatMap((result) => result.recommendations ?? []))];
}

export async function doctorRagBatch(options: {
  filePath: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  doctorRagJobFn?: DoctorRagJobFn;
}): Promise<RagDoctorBatchSummary> {
  const items = await readDoctorBatchFile(options.filePath);
  return doctorRagBatchItems({
    filePath: options.filePath,
    items,
    question: options.question,
    topK: options.topK,
    denseTopK: options.denseTopK,
    keywordTopK: options.keywordTopK,
    doctorRagJobFn: options.doctorRagJobFn,
  });
}

export async function doctorRagBatchItems(options: {
  filePath: string;
  items: RagDoctorBatchItem[];
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  doctorRagJobFn?: DoctorRagJobFn;
}): Promise<RagDoctorBatchSummary> {
  const doctorRagJobFn = options.doctorRagJobFn ?? doctorRagJob;
  const results: RagDoctorBatchResultItem[] = [];

  for (const [index, item] of options.items.entries()) {
    const base = buildResultBase(item, index);
    const question = item.question ?? options.question;
    try {
      const summary = await doctorRagJobFn({
        platform: item.platform,
        jobKey: item.jobKey,
        question,
        topK: options.topK,
        denseTopK: options.denseTopK,
        keywordTopK: options.keywordTopK,
      });
      results.push({
        ...base,
        question,
        status: summary.status,
        issueCount: summary.issues.length,
        issueCodes: summary.issues.map((issue) => issue.code),
        recommendations: summary.recommendations,
        summary,
      });
    } catch (error) {
      results.push({
        ...base,
        question,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    filePath: options.filePath,
    status: summarizeBatchStatus(results),
    itemCount: options.items.length,
    okCount: results.filter((result) => result.status === 'ok').length,
    warningCount: results.filter((result) => result.status === 'warning').length,
    errorCount: results.filter((result) => result.status === 'error').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    issueCounts: summarizeIssueCounts(results),
    recommendations: summarizeRecommendations(results),
    results,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    throw new Error('Usage: npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json [--question "<question>"] [--fail-on-issue true]');
  }

  const summary = await doctorRagBatch({
    filePath: args.filePath,
    question: args.question,
    topK: args.topK,
    denseTopK: args.denseTopK,
    keywordTopK: args.keywordTopK,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (args.failOnIssue && summary.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
