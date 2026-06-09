import type {
  RagChunk,
  RagEmbeddedChunk,
  RagQueryResult,
  RagVectorFilter,
  RagVectorStore,
} from './types.js';
import { normalizeSourceTypesForFacts } from './vector-store.js';

interface QdrantStoreOptions {
  url?: string;
  apiKey?: string;
  collectionName?: string;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantSearchResult {
  score: number;
  payload?: Record<string, unknown>;
}

interface QdrantCollectionInfoResponse {
  result?: {
    config?: {
      params?: {
        vectors?: unknown;
      };
    };
  };
}

const DEFAULT_COLLECTION_NAME = 'autorecruit_rag_chunks';

class QdrantHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QdrantHttpError';
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireQdrantUrl(url?: string): string {
  const resolved = url?.trim() || process.env.QDRANT_URL?.trim();
  if (!resolved) {
    throw new Error('Missing Qdrant configuration: set QDRANT_URL');
  }

  return trimTrailingSlash(resolved);
}

function resolveCollectionName(collectionName?: string): string {
  return collectionName?.trim() || process.env.RAG_VECTOR_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME;
}

function buildPayload(chunk: RagEmbeddedChunk): Record<string, unknown> {
  return {
    platform: chunk.platform,
    jobKey: chunk.jobKey,
    chunkId: chunk.chunkId,
    sourceId: chunk.sourceId,
    sourceType: chunk.sourceType,
    text: chunk.text,
    active: chunk.active,
    verified: chunk.verified,
    contentHash: chunk.contentHash,
    jdVersion: chunk.jdVersion,
    conversationId: chunk.conversationId,
    speaker: chunk.speaker,
    turnIds: chunk.turnIds,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    embeddingModel: chunk.embeddingModel,
    embeddingDim: chunk.embeddingDim,
    metadata: chunk.metadata,
  };
}

function buildChunkFromPayload(payload: Record<string, unknown>): RagChunk {
  return {
    platform: payload.platform as RagChunk['platform'],
    jobKey: payload.jobKey as string,
    chunkId: payload.chunkId as string,
    sourceId: payload.sourceId as string,
    sourceType: payload.sourceType as RagChunk['sourceType'],
    text: payload.text as string,
    active: payload.active as boolean,
    verified: payload.verified as boolean,
    contentHash: payload.contentHash as string,
    jdVersion: payload.jdVersion as string | undefined,
    conversationId: payload.conversationId as string | undefined,
    speaker: payload.speaker as RagChunk['speaker'],
    turnIds: payload.turnIds as string[] | undefined,
    createdAt: payload.createdAt as string,
    updatedAt: payload.updatedAt as string,
    metadata: payload.metadata as Record<string, unknown> | undefined,
  };
}

function buildMustCondition(key: string, value: unknown): Record<string, unknown> {
  return {
    key,
    match: {
      value,
    },
  };
}

function buildAnyCondition(key: string, values: unknown[]): Record<string, unknown> {
  return {
    key,
    match: {
      any: values,
    },
  };
}

function buildQdrantFilter(filter: RagVectorFilter): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [
    buildMustCondition('platform', filter.platform),
    buildMustCondition('jobKey', filter.jobKey),
  ];

  if (filter.active !== undefined) {
    must.push(buildMustCondition('active', filter.active));
  }

  if (filter.verified !== undefined) {
    must.push(buildMustCondition('verified', filter.verified));
  }

  if (filter.conversationId !== undefined) {
    must.push(buildMustCondition('conversationId', filter.conversationId));
  }

  const sourceTypes = filter.factOnly
    ? normalizeSourceTypesForFacts(filter.sourceTypes)
    : filter.sourceTypes;
  if (sourceTypes && sourceTypes.length > 0) {
    must.push(buildAnyCondition('sourceType', sourceTypes));
  }

  if (!filter.factOnly) {
    return { must };
  }

  return {
    must,
    min_should: {
      conditions: [
        buildMustCondition('sourceType', 'jd'),
        buildMustCondition('verified', true),
      ],
      min_count: 1,
    },
  };
}

function extractVectorSize(vectors: unknown): number | undefined {
  if (!vectors || typeof vectors !== 'object') {
    return undefined;
  }

  if ('size' in vectors && typeof vectors.size === 'number') {
    return vectors.size;
  }

  const namedVectors = Object.values(vectors as Record<string, unknown>);
  const firstNamedVector = namedVectors.find((value) => value && typeof value === 'object' && 'size' in value) as { size?: unknown } | undefined;
  return typeof firstNamedVector?.size === 'number' ? firstNamedVector.size : undefined;
}

export class QdrantVectorStore implements RagVectorStore {
  readonly kind = 'qdrant';

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly collectionName: string;

  constructor(options: QdrantStoreOptions = {}) {
    this.url = requireQdrantUrl(options.url);
    this.apiKey = options.apiKey?.trim() || process.env.QDRANT_API_KEY?.trim() || undefined;
    this.collectionName = resolveCollectionName(options.collectionName);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new QdrantHttpError(`Qdrant request failed: ${method} ${path} ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  async ensureCollection(embeddingDim: number): Promise<void> {
    if (embeddingDim <= 0) {
      throw new Error('Cannot create Qdrant collection without a positive embedding dimension');
    }

    const collectionPath = `/collections/${encodeURIComponent(this.collectionName)}`;
    const existing = await this.request<QdrantCollectionInfoResponse>('GET', collectionPath)
      .catch((error) => {
        if (error instanceof QdrantHttpError && error.status === 404) {
          return undefined;
        }

        throw error;
      });
    const existingVectorSize = extractVectorSize(existing?.result?.config?.params?.vectors);

    if (existingVectorSize !== undefined) {
      if (existingVectorSize !== embeddingDim) {
        throw new Error(`Qdrant collection ${this.collectionName} uses vector size ${existingVectorSize}, but ${embeddingDim} is required for the current embedding model`);
      }
    } else {
      await this.request('PUT', collectionPath, {
        vectors: {
          size: embeddingDim,
          distance: 'Cosine',
        },
      });
    }

    await Promise.all([
      this.createPayloadIndex('platform', 'keyword'),
      this.createPayloadIndex('jobKey', 'keyword'),
      this.createPayloadIndex('sourceType', 'keyword'),
      this.createPayloadIndex('active', 'bool'),
      this.createPayloadIndex('verified', 'bool'),
      this.createPayloadIndex('conversationId', 'keyword'),
    ]);
  }

  private async createPayloadIndex(fieldName: string, fieldSchema: 'keyword' | 'bool'): Promise<void> {
    await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}/index`, {
      field_name: fieldName,
      field_schema: fieldSchema,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|Conflict/i.test(message)) {
        throw error;
      }
    });
  }

  async upsert(chunks: RagEmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const points: QdrantPoint[] = chunks.map((chunk) => ({
      id: chunk.vectorId,
      vector: chunk.embedding,
      payload: buildPayload(chunk),
    }));

    await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}/points?wait=true`, {
      points,
    });
  }

  async search(embedding: number[], filter: RagVectorFilter, limit: number): Promise<RagQueryResult[]> {
    const response = await this.request<{ result: QdrantSearchResult[] }>('POST', `/collections/${encodeURIComponent(this.collectionName)}/points/search`, {
      vector: embedding,
      filter: buildQdrantFilter(filter),
      limit,
      with_payload: true,
    });

    return response.result.map((item) => ({
      chunk: buildChunkFromPayload(item.payload ?? {}),
      score: item.score,
    }));
  }

  async deleteByFilter(filter: RagVectorFilter): Promise<void> {
    await this.request('POST', `/collections/${encodeURIComponent(this.collectionName)}/points/delete?wait=true`, {
      filter: buildQdrantFilter(filter),
    }).catch((error) => {
      if (error instanceof QdrantHttpError && error.status === 404) {
        return;
      }

      throw error;
    });
  }
}
