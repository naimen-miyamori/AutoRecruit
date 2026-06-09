import fs from 'node:fs/promises';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { ingestConversation, type IngestConversationOptions, type RagConversationIngestSummary } from '../rag/service.js';
import type { RagConversationTurn, RagSpeaker } from '../rag/types.js';
import { doctorRagBatchItems, type RagDoctorBatchItem, type RagDoctorBatchSummary } from './rag-doctor-batch.js';

export interface RagConversationBatchItem {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  turns: RagConversationTurn[];
  sourceLine?: number;
}

export interface RagConversationBatchResultItem {
  index: number;
  sourceLine?: number;
  platform?: SupportedPlatform;
  jobKey?: string;
  conversationId?: string;
  turnCount?: number;
  verifiedTurnCount?: number;
  status: 'validated' | 'ingested' | 'failed';
  error?: string;
  summary?: RagConversationIngestSummary;
}

export interface RagConversationBatchSummary {
  filePath: string;
  dryRun: boolean;
  doctor: boolean;
  itemCount: number;
  successCount: number;
  failedCount: number;
  ingestedCount: number;
  results: RagConversationBatchResultItem[];
  doctorSummary?: RagDoctorBatchSummary;
}

interface Args {
  filePath?: string;
  dryRun: boolean;
  failOnError: boolean;
  doctor: boolean;
  doctorQuestion?: string;
  failOnDoctorIssue: boolean;
}

type IngestConversationFn = (options: IngestConversationOptions) => Promise<RagConversationIngestSummary>;
type DoctorRagBatchItemsFn = typeof doctorRagBatchItems;

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
    dryRun: parseBoolean(values.get('dry-run'), '--dry-run', false),
    failOnError: parseBoolean(values.get('fail-on-error'), '--fail-on-error', true),
    doctor: parseBoolean(values.get('doctor'), '--doctor', false),
    doctorQuestion: values.get('doctor-question'),
    failOnDoctorIssue: parseBoolean(values.get('fail-on-doctor-issue'), '--fail-on-doctor-issue', false),
  };
}

function normalizeRole(value: unknown, fieldPath: string): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`${fieldPath}.role must be candidate, recruiter, or system`);
}

function normalizeMetadata(value: unknown, fieldPath: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath}.metadata must be an object when provided`);
  }

  return value as Record<string, unknown>;
}

function normalizeTurn(value: unknown, fieldPath: string): RagConversationTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.content !== 'string' || !item.content.trim()) {
    throw new Error(`${fieldPath}.content must be a non-empty string`);
  }

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
    role: normalizeRole(item.role, fieldPath),
    content: item.content.trim(),
    verified: item.verified === true,
    createdAt: typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt.trim() : undefined,
    metadata: normalizeMetadata(item.metadata, fieldPath),
  };
}

function getStringField(item: Record<string, unknown>, fieldName: string, fieldPath: string): string {
  const value = item[fieldName];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldPath}.${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeTurns(item: Record<string, unknown>, fieldPath: string): RagConversationTurn[] {
  if (Array.isArray(item.turns)) {
    if (item.turns.length === 0) {
      throw new Error(`${fieldPath}.turns must contain at least one turn`);
    }

    return item.turns.map((turn, index) => normalizeTurn(turn, `${fieldPath}.turns[${index}]`));
  }

  if (item.content !== undefined || item.role !== undefined) {
    return [normalizeTurn(item, fieldPath)];
  }

  throw new Error(`${fieldPath} must include turns[] or a single turn with role/content`);
}

export function normalizeConversationBatchItem(
  value: unknown,
  index: number,
  sourceLine?: number,
): RagConversationBatchItem {
  const fieldPath = sourceLine ? `item at line ${sourceLine}` : `item[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }

  const item = value as Record<string, unknown>;
  const platform = parsePlatformArg(typeof item.platform === 'string' ? item.platform : undefined);
  const jobKey = typeof item.jobKey === 'string' && item.jobKey.trim()
    ? item.jobKey.trim()
    : typeof item.keyword === 'string' && item.keyword.trim()
      ? buildJobKey(item.keyword.trim(), '')
      : undefined;
  if (!jobKey) {
    throw new Error(`${fieldPath} must include jobKey or keyword`);
  }

  return {
    platform,
    jobKey,
    conversationId: getStringField(item, 'conversationId', fieldPath),
    turns: normalizeTurns(item, fieldPath),
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

  throw new Error('Conversation batch file must contain a JSON array, an object with items[], or JSONL rows');
}

export async function readConversationBatchFile(filePath: string): Promise<RagConversationBatchItem[]> {
  const content = await fs.readFile(filePath, 'utf8');
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const items = extractPayloadItems(JSON.parse(trimmed) as unknown);
      return items.map((item, index) => normalizeConversationBatchItem(item, index));
    } catch (error) {
      if (trimmed.startsWith('[')) {
        throw error;
      }
    }
  }

  return trimmed.split('\n')
    .map((line, index) => ({ line: line.trim(), sourceLine: index + 1 }))
    .filter((item) => item.line)
    .map(({ line, sourceLine }, index) => normalizeConversationBatchItem(JSON.parse(line) as unknown, index, sourceLine));
}

function buildResultBase(item: RagConversationBatchItem, index: number): Omit<RagConversationBatchResultItem, 'status'> {
  return {
    index,
    sourceLine: item.sourceLine,
    platform: item.platform,
    jobKey: item.jobKey,
    conversationId: item.conversationId,
    turnCount: item.turns.length,
    verifiedTurnCount: item.turns.filter((turn) => turn.role === 'recruiter' && turn.verified === true).length,
  };
}

function uniqueIngestedDoctorItems(results: RagConversationBatchResultItem[]): RagDoctorBatchItem[] {
  const items: RagDoctorBatchItem[] = [];
  const seenKeys = new Set<string>();

  for (const result of results) {
    if (result.status !== 'ingested' || !result.platform || !result.jobKey) {
      continue;
    }

    const key = `${result.platform}\0${result.jobKey}`;
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    items.push({
      platform: result.platform,
      jobKey: result.jobKey,
    });
  }

  return items;
}

export async function ingestConversationBatch(options: {
  filePath: string;
  dryRun?: boolean;
  failOnError?: boolean;
  doctor?: boolean;
  doctorQuestion?: string;
  ingestConversationFn?: IngestConversationFn;
  doctorRagBatchItemsFn?: DoctorRagBatchItemsFn;
}): Promise<RagConversationBatchSummary> {
  const dryRun = options.dryRun === true;
  const failOnError = options.failOnError !== false;
  const doctor = options.doctor === true;
  const ingestConversationFn = options.ingestConversationFn ?? ingestConversation;
  const doctorRagBatchItemsFn = options.doctorRagBatchItemsFn ?? doctorRagBatchItems;
  const results: RagConversationBatchResultItem[] = [];
  const items = await readConversationBatchFile(options.filePath);

  for (const [index, item] of items.entries()) {
    const base = buildResultBase(item, index);
    try {
      if (dryRun) {
        results.push({
          ...base,
          status: 'validated',
        });
        continue;
      }

      const summary = await ingestConversationFn({
        platform: item.platform,
        jobKey: item.jobKey,
        conversationId: item.conversationId,
        turns: item.turns,
      });
      results.push({
        ...base,
        status: 'ingested',
        summary,
      });
    } catch (error) {
      results.push({
        ...base,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      if (failOnError) {
        break;
      }
    }
  }

  const successCount = results.filter((result) => result.status === 'validated' || result.status === 'ingested').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const doctorItems = doctor && !dryRun ? uniqueIngestedDoctorItems(results) : [];
  const doctorSummary = doctor
    ? await doctorRagBatchItemsFn({
      filePath: options.filePath,
      items: doctorItems,
      question: options.doctorQuestion,
    })
    : undefined;

  return {
    filePath: options.filePath,
    dryRun,
    doctor,
    itemCount: items.length,
    successCount,
    failedCount,
    ingestedCount: results.filter((result) => result.status === 'ingested').length,
    results,
    doctorSummary,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    throw new Error('Usage: npm run rag:ingest-conversations -- --file ./conversations.jsonl [--dry-run true] [--fail-on-error false]');
  }

  const summary = await ingestConversationBatch({
    filePath: args.filePath,
    dryRun: args.dryRun,
    failOnError: args.failOnError,
    doctor: args.doctor,
    doctorQuestion: args.doctorQuestion,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failedCount > 0 && args.failOnError) {
    process.exitCode = 1;
  } else if (args.failOnDoctorIssue && summary.doctorSummary && summary.doctorSummary.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
