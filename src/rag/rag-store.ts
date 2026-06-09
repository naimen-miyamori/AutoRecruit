import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { ensureAnswerLogId } from './answer-logs.js';
import type {
  RagAnswerLogRecord,
  RagChunk,
  RagEmbeddingCacheRecord,
  RagIndexManifest,
  RagSourceRecord,
  RagStoredConversationTurn,
} from './types.js';

interface RagPaths {
  ragDir: string;
  conversationsDir: string;
  sourcesPath: string;
  chunksPath: string;
  embeddingsPath: string;
  manifestPath: string;
  answerLogsPath: string;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonlFile(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  await fs.writeFile(filePath, content ? `${content}\n` : '', 'utf8');
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function dedupeByKey<T>(records: T[], keyFn: (record: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const record of records) {
    byKey.set(keyFn(record), record);
  }
  return [...byKey.values()];
}

export class RagStore {
  private getPaths(platform: SupportedPlatform, jobKey: string): RagPaths {
    const ragDir = path.join(config.dataDir, platform, 'jobs', jobKey, 'rag');
    return {
      ragDir,
      conversationsDir: path.join(ragDir, 'conversations'),
      sourcesPath: path.join(ragDir, 'sources.jsonl'),
      chunksPath: path.join(ragDir, 'chunks.jsonl'),
      embeddingsPath: path.join(ragDir, 'embeddings.jsonl'),
      manifestPath: path.join(ragDir, 'index-manifest.json'),
      answerLogsPath: path.join(ragDir, 'answer-logs.jsonl'),
    };
  }

  async initialize(platform: SupportedPlatform, jobKey: string): Promise<RagPaths> {
    const paths = this.getPaths(platform, jobKey);
    await Promise.all([
      ensureDir(paths.ragDir),
      ensureDir(paths.conversationsDir),
    ]);
    return paths;
  }

  async appendSources(platform: SupportedPlatform, jobKey: string, sources: RagSourceRecord[]): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    const existing = await readJsonlFile<RagSourceRecord>(paths.sourcesPath);
    await writeJsonlFile(paths.sourcesPath, dedupeByKey([...existing, ...sources], (source) => source.sourceId));
  }

  async replaceSources(platform: SupportedPlatform, jobKey: string, sources: RagSourceRecord[]): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    await writeJsonlFile(paths.sourcesPath, dedupeByKey(sources, (source) => source.sourceId));
  }

  async replaceConversationSources(
    platform: SupportedPlatform,
    jobKey: string,
    conversationId: string,
    sources: RagSourceRecord[],
  ): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    const existing = await readJsonlFile<RagSourceRecord>(paths.sourcesPath);
    await writeJsonlFile(paths.sourcesPath, dedupeByKey([
      ...existing.filter((source) => source.sourceType !== 'conversation' || source.conversationId !== conversationId),
      ...sources,
    ], (source) => source.sourceId));
  }

  async appendChunks(platform: SupportedPlatform, jobKey: string, chunks: RagChunk[]): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    const existing = await readJsonlFile<RagChunk>(paths.chunksPath);
    await writeJsonlFile(paths.chunksPath, dedupeByKey([...existing, ...chunks], (chunk) => chunk.chunkId));
  }

  async replaceChunks(platform: SupportedPlatform, jobKey: string, chunks: RagChunk[]): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    await writeJsonlFile(paths.chunksPath, dedupeByKey(chunks, (chunk) => chunk.chunkId));
  }

  async replaceConversationChunks(
    platform: SupportedPlatform,
    jobKey: string,
    conversationId: string,
    chunks: RagChunk[],
  ): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    const existing = await readJsonlFile<RagChunk>(paths.chunksPath);
    await writeJsonlFile(paths.chunksPath, dedupeByKey([
      ...existing.filter((chunk) => chunk.sourceType !== 'conversation' || chunk.conversationId !== conversationId),
      ...chunks,
    ], (chunk) => chunk.chunkId));
  }

  async listSources(platform: SupportedPlatform, jobKey: string): Promise<RagSourceRecord[]> {
    const paths = this.getPaths(platform, jobKey);
    return readJsonlFile<RagSourceRecord>(paths.sourcesPath);
  }

  async listChunks(platform: SupportedPlatform, jobKey: string): Promise<RagChunk[]> {
    const paths = this.getPaths(platform, jobKey);
    return readJsonlFile<RagChunk>(paths.chunksPath);
  }

  async listEmbeddingCacheRecords(platform: SupportedPlatform, jobKey: string): Promise<RagEmbeddingCacheRecord[]> {
    const paths = this.getPaths(platform, jobKey);
    return readJsonlFile<RagEmbeddingCacheRecord>(paths.embeddingsPath);
  }

  async appendEmbeddingCacheRecords(
    platform: SupportedPlatform,
    jobKey: string,
    records: RagEmbeddingCacheRecord[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const paths = await this.initialize(platform, jobKey);
    const existing = await readJsonlFile<RagEmbeddingCacheRecord>(paths.embeddingsPath);
    await writeJsonlFile(paths.embeddingsPath, dedupeByKey([...existing, ...records], (record) => [
      record.provider,
      record.model,
      record.contentHash,
    ].join('\0')));
  }

  async saveConversationTurns(
    platform: SupportedPlatform,
    jobKey: string,
    conversationId: string,
    turns: RagStoredConversationTurn[],
  ): Promise<string> {
    const paths = await this.initialize(platform, jobKey);
    const filePath = path.join(paths.conversationsDir, `${conversationId}.jsonl`);
    const existing = await readJsonlFile<RagStoredConversationTurn>(filePath);
    await writeJsonlFile(filePath, dedupeByKey([...existing, ...turns], (turn) => turn.id));
    return filePath;
  }

  async readConversationTurns(
    platform: SupportedPlatform,
    jobKey: string,
    conversationId: string,
  ): Promise<RagStoredConversationTurn[]> {
    const paths = this.getPaths(platform, jobKey);
    return readJsonlFile<RagStoredConversationTurn>(path.join(paths.conversationsDir, `${conversationId}.jsonl`));
  }

  async saveManifest(platform: SupportedPlatform, jobKey: string, manifest: RagIndexManifest): Promise<string> {
    const paths = await this.initialize(platform, jobKey);
    await writeJsonFile(paths.manifestPath, manifest);
    return paths.manifestPath;
  }

  async readManifest(platform: SupportedPlatform, jobKey: string): Promise<RagIndexManifest | undefined> {
    const paths = this.getPaths(platform, jobKey);
    return readJsonFile<RagIndexManifest>(paths.manifestPath);
  }

  async appendAnswerLog(platform: SupportedPlatform, jobKey: string, record: RagAnswerLogRecord): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    await fs.appendFile(paths.answerLogsPath, `${JSON.stringify(ensureAnswerLogId(record))}\n`, 'utf8');
  }

  async listAnswerLogs(platform: SupportedPlatform, jobKey: string): Promise<RagAnswerLogRecord[]> {
    const paths = this.getPaths(platform, jobKey);
    return (await readJsonlFile<RagAnswerLogRecord>(paths.answerLogsPath)).map(ensureAnswerLogId);
  }

  async replaceAnswerLogs(platform: SupportedPlatform, jobKey: string, records: RagAnswerLogRecord[]): Promise<void> {
    const paths = await this.initialize(platform, jobKey);
    await writeJsonlFile(paths.answerLogsPath, records.map(ensureAnswerLogId));
  }
}
