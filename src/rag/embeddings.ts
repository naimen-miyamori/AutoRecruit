import { createHash } from 'node:crypto';
import { getOpenAIClient } from '../llm/openai-client.js';
import type { RagChunk, RagEmbeddedChunk, RagEmbeddingCacheRecord } from './types.js';

const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5';
const DEFAULT_LOCAL_EMBEDDING_URL = 'http://127.0.0.1:8011';

export type RagEmbeddingProviderName = 'openai' | 'local-http';

export interface RagEmbeddingProvider {
  readonly name: RagEmbeddingProviderName;
  embedTexts(texts: string[], model: string): Promise<number[][]>;
}

export interface EmbedRagChunksOptions {
  provider?: RagEmbeddingProvider;
  cacheRecords?: RagEmbeddingCacheRecord[];
}

class OpenAIEmbeddingProvider implements RagEmbeddingProvider {
  readonly name = 'openai';

  async embedTexts(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await getOpenAIClient().embeddings.create({
      model,
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }
}

class LocalHttpEmbeddingProvider implements RagEmbeddingProvider {
  readonly name = 'local-http';

  private readonly url: string;
  private readonly apiKey?: string;

  constructor(url = process.env.RAG_EMBEDDING_LOCAL_URL?.trim() || process.env.EMBEDDING_LOCAL_URL?.trim() || DEFAULT_LOCAL_EMBEDDING_URL) {
    if (!url) {
      throw new Error('Missing local embedding service URL: set RAG_EMBEDDING_LOCAL_URL');
    }

    this.url = url.replace(/\/+$/, '');
    this.apiKey = process.env.RAG_EMBEDDING_LOCAL_API_KEY?.trim() || process.env.EMBEDDING_LOCAL_API_KEY?.trim() || undefined;
  }

  async embedTexts(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetch(`${this.url}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(`Local embedding request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`);
    }

    const payload = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
      embeddings?: number[][];
    };
    const embeddings = payload.data?.map((item) => item.embedding ?? []) ?? payload.embeddings;
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error(`Local embedding service returned ${embeddings?.length ?? 0} vectors for ${texts.length} texts`);
    }

    return embeddings;
  }
}

export function resolveRagEmbeddingProviderName(): RagEmbeddingProviderName {
  const provider = process.env.RAG_EMBEDDING_PROVIDER?.trim().toLowerCase()
    || process.env.EMBEDDING_PROVIDER?.trim().toLowerCase()
    || 'local-http';

  if (provider === 'openai' || provider === 'local-http') {
    return provider;
  }

  throw new Error('Environment variable RAG_EMBEDDING_PROVIDER must be either openai or local-http');
}

export function createRagEmbeddingProvider(providerName: string = resolveRagEmbeddingProviderName()): RagEmbeddingProvider {
  if (providerName === 'openai') {
    return new OpenAIEmbeddingProvider();
  }

  if (providerName !== 'local-http') {
    throw new Error(`Unsupported RAG embedding provider: ${providerName}`);
  }

  return new LocalHttpEmbeddingProvider();
}

export function resolveRagEmbeddingModel(): string {
  return process.env.RAG_EMBEDDING_MODEL?.trim()
    || process.env.EMBEDDING_MODEL?.trim()
    || DEFAULT_EMBEDDING_MODEL;
}

export async function embedTexts(texts: string[], model = resolveRagEmbeddingModel(), provider = createRagEmbeddingProvider()): Promise<number[][]> {
  return provider.embedTexts(texts, model);
}

export function buildVectorId(chunk: RagChunk): string {
  const hash = createHash('sha256').update([
    chunk.platform,
    chunk.jobKey,
    chunk.chunkId,
  ].join('\0')).digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

function buildCacheKey(providerName: string, model: string, contentHash: string): string {
  return [providerName, model, contentHash].join('\0');
}

function buildCacheRecordByKey(records: RagEmbeddingCacheRecord[] = []): Map<string, RagEmbeddingCacheRecord> {
  const byKey = new Map<string, RagEmbeddingCacheRecord>();
  for (const record of records) {
    byKey.set(buildCacheKey(record.provider, record.model, record.contentHash), record);
  }
  return byKey;
}

export async function embedRagChunks(
  chunks: RagChunk[],
  model = resolveRagEmbeddingModel(),
  options: EmbedRagChunksOptions = {},
): Promise<{ chunks: RagEmbeddedChunk[]; newCacheRecords: RagEmbeddingCacheRecord[] }> {
  const provider = options.provider ?? createRagEmbeddingProvider();
  const cacheByKey = buildCacheRecordByKey(options.cacheRecords);
  const embeddingsByChunkId = new Map<string, number[]>();
  const chunksToEmbed: RagChunk[] = [];

  for (const chunk of chunks) {
    const cacheKey = buildCacheKey(provider.name, model, chunk.contentHash);
    const cached = cacheByKey.get(cacheKey);
    if (cached) {
      embeddingsByChunkId.set(chunk.chunkId, cached.embedding);
    } else {
      chunksToEmbed.push(chunk);
    }
  }

  const freshEmbeddings = chunksToEmbed.length > 0
    ? await provider.embedTexts(chunksToEmbed.map((chunk) => chunk.text), model)
    : [];
  const createdAt = new Date().toISOString();
  const newCacheRecords: RagEmbeddingCacheRecord[] = [];

  chunksToEmbed.forEach((chunk, index) => {
    const embedding = freshEmbeddings[index] ?? [];
    embeddingsByChunkId.set(chunk.chunkId, embedding);
    newCacheRecords.push({
      provider: provider.name,
      model,
      contentHash: chunk.contentHash,
      embedding,
      embeddingDim: embedding.length,
      createdAt,
      updatedAt: createdAt,
    });
  });

  return {
    chunks: chunks.map((chunk) => {
      const embedding = embeddingsByChunkId.get(chunk.chunkId) ?? [];
      return {
        ...chunk,
        vectorId: buildVectorId(chunk),
        embedding,
        embeddingProvider: provider.name,
        embeddingModel: model,
        embeddingDim: embedding.length,
      };
    }),
    newCacheRecords,
  };
}
