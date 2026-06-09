import type {
  RagChunk,
  RagEmbeddedChunk,
  RagQueryResult,
  RagSourceType,
  RagVectorFilter,
  RagVectorStore,
} from './types.js';

export function resolveRagTopK(): number {
  const rawValue = process.env.RAG_TOP_K?.trim();
  if (!rawValue) {
    return 8;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Environment variable RAG_TOP_K must be a positive integer');
  }

  return parsed;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function matchesFilter(chunk: RagChunk, filter: RagVectorFilter): boolean {
  if (chunk.platform !== filter.platform || chunk.jobKey !== filter.jobKey) {
    return false;
  }

  if (filter.active !== undefined && chunk.active !== filter.active) {
    return false;
  }

  if (filter.verified !== undefined && chunk.verified !== filter.verified) {
    return false;
  }

  if (filter.conversationId !== undefined && chunk.conversationId !== filter.conversationId) {
    return false;
  }

  if (filter.sourceTypes && !filter.sourceTypes.includes(chunk.sourceType)) {
    return false;
  }

  if (filter.factOnly && chunk.sourceType !== 'jd' && !chunk.verified) {
    return false;
  }

  return true;
}

export class MemoryVectorStore implements RagVectorStore {
  readonly kind = 'memory';

  private chunksById = new Map<string, RagEmbeddedChunk>();

  async ensureCollection(_embeddingDim: number): Promise<void> {
    return undefined;
  }

  async upsert(chunks: RagEmbeddedChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunksById.set(chunk.vectorId, chunk);
    }
  }

  async search(embedding: number[], filter: RagVectorFilter, limit: number): Promise<RagQueryResult[]> {
    return [...this.chunksById.values()]
      .filter((chunk) => matchesFilter(chunk, filter))
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(embedding, chunk.embedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async deleteByFilter(filter: RagVectorFilter): Promise<void> {
    for (const [id, chunk] of this.chunksById) {
      if (matchesFilter(chunk, filter)) {
        this.chunksById.delete(id);
      }
    }
  }
}

export function normalizeSourceTypesForFacts(sourceTypes?: RagSourceType[]): RagSourceType[] {
  return sourceTypes ?? ['jd', 'conversation', 'recruiter_note', 'faq'];
}
