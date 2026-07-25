import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type {
  BossChatOperationInput,
  BossChatOperationResult,
  BossJobSyncRun,
  BossPositionSummary,
} from '../types/boss.js';
import type { BossChatReviewRun, JobRecord } from '../types/job.js';
import type { ArtifactDescriptor } from './api-contracts.js';
import { bossReceiptArtifact, bossReviewArtifact, bossSyncArtifact } from './artifact-read-model.js';

interface BossReadModelOptions {
  dataDir?: string;
}

export interface BossPositionView extends BossPositionSummary {
  jobKey?: string;
  sourceHash?: string;
  syncedAt?: string;
}

export interface BossJobSyncRunSummary {
  runId: string;
  syncedAt: string;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  artifact: ArtifactDescriptor;
}

export interface BossChatReviewRunSummary {
  runId: string;
  reviewedAt: string;
  unreadConversations: number;
  reviewedConversations: number;
  matchedCandidates: number;
  failedConversations: number;
  followUpConversations?: number;
  artifact: ArtifactDescriptor;
}

export interface BossChatReceiptRecord {
  receiptId: string;
  input: BossChatOperationInput;
  result: BossChatOperationResult;
  artifact: ArtifactDescriptor;
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((entry) => entry.endsWith('.json')).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
}

function fileId(fileName: string): string {
  return fileName.replace(/\.json$/, '');
}

export class BossReadModel {
  private readonly dataDir: string;

  constructor(options: BossReadModelOptions = {}) {
    this.dataDir = options.dataDir ?? config.dataDir;
  }

  async listPositions(): Promise<BossPositionView[]> {
    const positions = await readJsonIfExists<BossPositionSummary[]>(
      path.join(this.dataDir, 'boss', 'job-sync', 'positions.latest.json'),
    ) ?? [];
    const recordsById = new Map<string, JobRecord>();
    const jobsDir = path.join(this.dataDir, 'boss', 'jobs');
    for (const jobKey of await listDirectories(jobsDir)) {
      const record = await readJsonIfExists<JobRecord>(path.join(jobsDir, jobKey, 'jd.json'));
      if (record?.bossPosition?.bossJobId) recordsById.set(record.bossPosition.bossJobId, record);
    }

    return positions.map((position) => {
      const record = recordsById.get(position.bossJobId);
      return {
        ...position,
        jobKey: record?.jobKey,
        sourceHash: record?.bossPosition?.sourceHash,
        syncedAt: record?.bossPosition?.syncedAt,
      };
    });
  }

  async listJobSyncRuns(): Promise<BossJobSyncRunSummary[]> {
    const runsDir = path.join(this.dataDir, 'boss', 'job-sync', 'runs');
    return Promise.all((await listJsonFiles(runsDir)).map(async (fileName) => {
      const run = await readJson<BossJobSyncRun>(path.join(runsDir, fileName));
      const runId = fileId(fileName);
      return {
        runId,
        syncedAt: run.syncedAt,
        created: run.created,
        updated: run.updated,
        unchanged: run.unchanged,
        failed: run.failed,
        artifact: bossSyncArtifact(runId),
      };
    }));
  }

  async getJobSyncRun(runId: string): Promise<(BossJobSyncRun & { runId: string; artifact: ArtifactDescriptor }) | undefined> {
    assertSafeSegment(runId, 'runId');
    const run = await readJsonIfExists<BossJobSyncRun>(path.join(this.dataDir, 'boss', 'job-sync', 'runs', `${runId}.json`));
    return run ? { ...run, runId, artifact: bossSyncArtifact(runId) } : undefined;
  }

  async listChatReviewRuns(): Promise<BossChatReviewRunSummary[]> {
    const runsDir = path.join(this.dataDir, 'boss', 'chat-review', 'runs');
    return Promise.all((await listJsonFiles(runsDir)).map(async (fileName) => {
      const run = await readJson<BossChatReviewRun>(path.join(runsDir, fileName));
      const runId = fileId(fileName);
      return {
        runId,
        reviewedAt: run.reviewedAt,
        unreadConversations: run.unreadConversations,
        reviewedConversations: run.reviewedConversations,
        matchedCandidates: run.matchedCandidates,
        failedConversations: run.failedConversations,
        followUpConversations: run.followUpConversations,
        artifact: bossReviewArtifact(runId),
      };
    }));
  }

  async getChatReviewRun(runId: string): Promise<(BossChatReviewRun & { runId: string; artifact: ArtifactDescriptor }) | undefined> {
    assertSafeSegment(runId, 'runId');
    const run = await readJsonIfExists<BossChatReviewRun>(path.join(this.dataDir, 'boss', 'chat-review', 'runs', `${runId}.json`));
    return run ? { ...run, runId, artifact: bossReviewArtifact(runId) } : undefined;
  }

  async listChatReceipts(): Promise<BossChatReceiptRecord[]> {
    const runsDir = path.join(this.dataDir, 'boss', 'chat-operations', 'runs');
    const receipts = await Promise.all((await listJsonFiles(runsDir)).map(async (fileName) => {
      const record = await readJson<{ input: BossChatOperationInput; result: BossChatOperationResult }>(path.join(runsDir, fileName));
      if (!record.input.intentId) return undefined;
      return {
        receiptId: fileId(fileName),
        ...record,
        artifact: bossReceiptArtifact(record.input.intentId),
      };
    }));
    return receipts
      .filter((item): item is BossChatReceiptRecord => Boolean(item))
      .sort((left, right) => right.result.completedAt.localeCompare(left.result.completedAt));
  }

  async getChatReceipt(intentId: string): Promise<BossChatReceiptRecord | undefined> {
    const normalized = intentId.trim();
    if (!normalized || normalized.length > 240 || normalized.includes('\0')) {
      throw new Error('intentId is invalid');
    }
    const receiptId = crypto.createHash('sha256').update(normalized).digest('hex');
    const record = await readJsonIfExists<{ input: BossChatOperationInput; result: BossChatOperationResult }>(
      path.join(this.dataDir, 'boss', 'chat-operations', 'runs', `${receiptId}.json`),
    );
    if (!record) return undefined;
    if (record.input.intentId !== normalized) throw new Error('Boss receipt identity mismatch');
    return {
      receiptId,
      ...record,
      artifact: bossReceiptArtifact(normalized),
    };
  }
}
