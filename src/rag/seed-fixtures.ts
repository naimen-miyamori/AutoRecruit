import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';
import type { RagEmbeddingProvider } from './embeddings.js';
import {
  ingestConversation,
  indexJobJd,
  type IngestConversationOptions,
  type IndexJobJdOptions,
  type RagConversationIngestSummary,
  type RagDependencies,
  type RagIndexSummary,
} from './service.js';
import type { RagConversationTurn, RagSpeaker } from './types.js';

export interface RagFixtureJob {
  platform: SupportedPlatform;
  jobKey: string;
  filePath: string;
  jobRecord: JobRecord;
}

export interface RagFixtureConversation {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  filePath: string;
  turns: RagConversationTurn[];
}

export interface RagFixtureSeedItem {
  platform: SupportedPlatform;
  jobKey: string;
  filePath: string;
  status: 'created' | 'overwritten' | 'skipped';
  indexed?: RagIndexSummary;
}

export interface RagFixtureSeedSummary {
  fixtureDir: string;
  jobCount: number;
  createdCount: number;
  overwrittenCount: number;
  skippedCount: number;
  indexedCount: number;
  conversationCount: number;
  ingestedConversationCount: number;
  conversations: RagFixtureConversationSeedItem[];
  items: RagFixtureSeedItem[];
}

export interface RagFixtureConversationSeedItem {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  filePath: string;
  status: 'loaded' | 'ingested';
  ingested?: RagConversationIngestSummary;
}

export interface SeedRagFixturesOptions extends RagDependencies {
  fixtureDir: string;
  overwrite?: boolean;
  index?: boolean;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
  indexJob?: (options: IndexJobJdOptions) => Promise<RagIndexSummary>;
  ingestConversation?: (options: IngestConversationOptions) => Promise<RagConversationIngestSummary>;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function normalizeJobRecord(value: unknown, filePath: string): JobRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RAG fixture job file must contain an object: ${filePath}`);
  }

  const record = value as Partial<JobRecord>;
  if (typeof record.jobKey !== 'string' || !record.jobKey.trim()) {
    throw new Error(`RAG fixture job file must include jobKey: ${filePath}`);
  }

  const platform = parsePlatformArg(record.platform);
  if (typeof record.searchKeyword !== 'string' || !record.searchKeyword.trim()) {
    throw new Error(`RAG fixture job file must include searchKeyword: ${filePath}`);
  }

  if (typeof record.rawText !== 'string' || !record.rawText.trim()) {
    throw new Error(`RAG fixture job file must include rawText: ${filePath}`);
  }

  const normalizedJob = record.normalizedJob;
  if (!normalizedJob || typeof normalizedJob !== 'object' || typeof normalizedJob.title !== 'string' || !normalizedJob.title.trim()) {
    throw new Error(`RAG fixture job file must include normalizedJob.title: ${filePath}`);
  }

  const normalizeStringArray = (fieldName: keyof Pick<NormalizedJob,
    'majors'
    | 'languageRequirements'
    | 'responsibilities'
    | 'hardRequirements'
    | 'preferredRequirements'
    | 'regionPreferences'
    | 'industryTags'
  >): string[] => {
    const valueForField = normalizedJob[fieldName];
    if (valueForField === undefined) {
      return [];
    }

    if (!Array.isArray(valueForField) || valueForField.some((item) => typeof item !== 'string')) {
      throw new Error(`RAG fixture job file normalizedJob.${fieldName} must be a string array: ${filePath}`);
    }

    return valueForField.map((item) => item.trim()).filter(Boolean);
  };

  if (normalizedJob.experienceYearsMin !== undefined && typeof normalizedJob.experienceYearsMin !== 'number') {
    throw new Error(`RAG fixture job file normalizedJob.experienceYearsMin must be a number: ${filePath}`);
  }

  return {
    jobKey: record.jobKey.trim(),
    platform,
    searchKeyword: record.searchKeyword.trim(),
    rawText: record.rawText.trim(),
    normalizedJob: {
      title: normalizedJob.title.trim(),
      location: normalizedJob.location,
      department: normalizedJob.department,
      salaryRange: normalizedJob.salaryRange,
      ageRange: normalizedJob.ageRange,
      education: normalizedJob.education,
      majors: normalizeStringArray('majors'),
      languageRequirements: normalizeStringArray('languageRequirements'),
      responsibilities: normalizeStringArray('responsibilities'),
      hardRequirements: normalizeStringArray('hardRequirements'),
      preferredRequirements: normalizeStringArray('preferredRequirements'),
      experienceYearsMin: normalizedJob.experienceYearsMin,
      regionPreferences: normalizeStringArray('regionPreferences'),
      industryTags: normalizeStringArray('industryTags'),
    },
    createdAt: typeof record.createdAt === 'string' && record.createdAt.trim()
      ? record.createdAt.trim()
      : new Date().toISOString(),
  };
}

async function listFixtureJobFiles(fixtureDir: string): Promise<string[]> {
  const jobsDir = path.join(fixtureDir, 'jobs');
  const files: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === 'jd.json') {
        files.push(entryPath);
      }
    }
  }

  await walk(jobsDir);
  return files.sort();
}

async function walkJsonFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(entryPath);
      }
    }
  }

  await walk(dirPath);
  return files.sort();
}

function normalizeConversationRole(value: unknown, filePath: string, index: number): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`RAG fixture conversation file turn at index ${index} has invalid role in ${filePath}`);
}

function normalizeConversationTurn(value: unknown, filePath: string, index: number): RagConversationTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RAG fixture conversation file turn at index ${index} must be an object: ${filePath}`);
  }

  const item = value as Record<string, unknown>;
  if (typeof item.content !== 'string' || !item.content.trim()) {
    throw new Error(`RAG fixture conversation file turn at index ${index} must include content: ${filePath}`);
  }

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
    role: normalizeConversationRole(item.role, filePath, index),
    content: item.content.trim(),
    verified: item.verified === true,
    createdAt: typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt.trim() : undefined,
    metadata: item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown>
      : undefined,
  };
}

function normalizeConversationTurns(value: unknown, filePath: string): RagConversationTurn[] {
  const turnsPayload = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { turns?: unknown }).turns)
      ? (value as { turns: unknown[] }).turns
      : undefined;

  if (!turnsPayload) {
    throw new Error(`RAG fixture conversation file must contain a JSON array or an object with a turns array: ${filePath}`);
  }

  if (turnsPayload.length === 0) {
    throw new Error(`RAG fixture conversation file must contain at least one turn: ${filePath}`);
  }

  return turnsPayload.map((item, index) => normalizeConversationTurn(item, filePath, index));
}

function parseConversationPath(filePath: string, conversationsDir: string): {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
} {
  const relativePath = path.relative(conversationsDir, filePath);
  const parts = relativePath.split(path.sep);
  if (parts.length < 3) {
    throw new Error(`RAG fixture conversation path must be conversations/<platform>/<jobKey>/<conversationId>.json: ${filePath}`);
  }

  return {
    platform: parsePlatformArg(parts[0]),
    jobKey: parts[1],
    conversationId: parts.slice(2).join('/').replace(/\.json$/i, ''),
  };
}

export async function readRagFixtureJobs(fixtureDir: string): Promise<RagFixtureJob[]> {
  const resolvedFixtureDir = path.resolve(fixtureDir);
  const files = await listFixtureJobFiles(resolvedFixtureDir);
  const jobs: RagFixtureJob[] = [];

  for (const filePath of files) {
    const jobRecord = normalizeJobRecord(await readJsonFile<unknown>(filePath), filePath);
    jobs.push({
      platform: jobRecord.platform,
      jobKey: jobRecord.jobKey,
      filePath,
      jobRecord,
    });
  }

  return jobs;
}

export async function readRagFixtureConversations(fixtureDir: string): Promise<RagFixtureConversation[]> {
  const resolvedFixtureDir = path.resolve(fixtureDir);
  const conversationsDir = path.join(resolvedFixtureDir, 'conversations');
  const files = await walkJsonFiles(conversationsDir);

  return Promise.all(files.map(async (filePath) => {
    const parsedPath = parseConversationPath(filePath, conversationsDir);
    return {
      ...parsedPath,
      filePath,
      turns: normalizeConversationTurns(await readJsonFile<unknown>(filePath), filePath),
    };
  }));
}

export async function seedRagFixtures(options: SeedRagFixturesOptions): Promise<RagFixtureSeedSummary> {
  const fixtureDir = path.resolve(options.fixtureDir);
  const jobStore = options.jobStore ?? new JobStore();
  const jobs = await readRagFixtureJobs(fixtureDir);
  const conversations = await readRagFixtureConversations(fixtureDir);
  const items: RagFixtureSeedItem[] = [];
  const conversationItems: RagFixtureConversationSeedItem[] = [];
  const indexJob = options.indexJob ?? indexJobJd;
  const ingestConversationFixture = options.ingestConversation ?? ingestConversation;

  for (const job of jobs) {
    const existing = await jobStore.readJobRecordIfExists(job.platform, job.jobKey);
    const shouldWrite = !existing || options.overwrite === true;
    const status: RagFixtureSeedItem['status'] = existing
      ? options.overwrite === true ? 'overwritten' : 'skipped'
      : 'created';

    if (shouldWrite) {
      await jobStore.saveJobRecord(job.platform, job.jobRecord);
    }

    const indexed = options.index === true
      ? await indexJob({
        platform: job.platform,
        jobKey: job.jobKey,
        jobStore,
        ragStore: options.ragStore,
        vectorStore: options.vectorStore,
        embeddingModel: options.embeddingModel,
        embeddingProvider: options.embeddingProvider,
      })
      : undefined;

    items.push({
      platform: job.platform,
      jobKey: job.jobKey,
      filePath: path.relative(process.cwd(), job.filePath),
      status,
      indexed,
    });
  }

  for (const conversation of conversations) {
    const ingested = options.index === true
      ? await ingestConversationFixture({
        platform: conversation.platform,
        jobKey: conversation.jobKey,
        conversationId: conversation.conversationId,
        turns: conversation.turns,
        jobStore,
        ragStore: options.ragStore,
        vectorStore: options.vectorStore,
        embeddingModel: options.embeddingModel,
        embeddingProvider: options.embeddingProvider,
      })
      : undefined;

    conversationItems.push({
      platform: conversation.platform,
      jobKey: conversation.jobKey,
      conversationId: conversation.conversationId,
      filePath: path.relative(process.cwd(), conversation.filePath),
      status: ingested ? 'ingested' : 'loaded',
      ingested,
    });
  }

  return {
    fixtureDir,
    jobCount: items.length,
    createdCount: items.filter((item) => item.status === 'created').length,
    overwrittenCount: items.filter((item) => item.status === 'overwritten').length,
    skippedCount: items.filter((item) => item.status === 'skipped').length,
    indexedCount: items.filter((item) => item.indexed).length,
    conversationCount: conversationItems.length,
    ingestedConversationCount: conversationItems.filter((item) => item.ingested).length,
    conversations: conversationItems,
    items,
  };
}
