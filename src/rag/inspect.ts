import type { SupportedPlatform } from '../platforms/types.js';
import {
  createRagEmbeddingProvider,
  embedTexts as embedTextsImpl,
  resolveRagEmbeddingModel,
  type RagEmbeddingProvider,
} from './embeddings.js';
import { hybridSearch, keywordSearch } from './hybrid-search.js';
import { QdrantVectorStore } from './qdrant-store.js';
import { RagStore } from './rag-store.js';
import type {
  RagChunk,
  RagIndexManifest,
  RagQueryResult,
  RagSourceRecord,
  RagSourceType,
  RagVectorFilter,
  RagVectorStore,
} from './types.js';
import { resolveRagTopK } from './vector-store.js';

const DEFAULT_DENSE_LIMIT_MULTIPLIER = 4;
const DEFAULT_KEYWORD_LIMIT_MULTIPLIER = 4;
const DEFAULT_TEXT_PREVIEW_CHARS = 120;

export const inspectEmbedTextsRef = { fn: embedTextsImpl };

export interface RagInspectDependencies {
  ragStore?: RagStore;
  vectorStore?: RagVectorStore;
}

export interface InspectRagJobOptions extends RagInspectDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}

export interface RagSourceCounts {
  total: number;
  active: number;
  inactive: number;
  jd: number;
  conversation: number;
  recruiterNote: number;
  faq: number;
}

export interface RagChunkCounts {
  total: number;
  active: number;
  inactive: number;
  factChunks: number;
  jd: number;
  verifiedConversation: number;
  unverifiedConversation: number;
  recruiterNote: number;
  faq: number;
}

export interface RagInspectSourceSummary {
  sourceId: string;
  sourceType: RagSourceType;
  active: boolean;
  verified: boolean;
  title?: string;
  jdVersion?: string;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagInspectConversationSummary {
  conversationId: string;
  sourceIds: string[];
  turnCount: number;
  verifiedFactChunkCount: number;
  unverifiedChunkCount: number;
}

export interface RagInspectResultItem {
  chunkId: string;
  sourceId: string;
  sourceType: RagSourceType;
  label: string;
  score: number;
  active: boolean;
  verified: boolean;
  speaker?: RagChunk['speaker'];
  conversationId?: string;
  jdVersion?: string;
  textPreview: string;
}

export interface RagInspectQuestionDiagnostics {
  question: string;
  embeddingProvider: string;
  embeddingModel: string;
  topK: number;
  denseTopK: number;
  keywordTopK: number;
  filter: RagVectorFilter;
  denseResults: RagInspectResultItem[];
  keywordResults: RagInspectResultItem[];
  hybridResults: RagInspectResultItem[];
}

export interface RagInspectSummary {
  platform: SupportedPlatform;
  jobKey: string;
  manifest?: RagIndexManifest;
  sourceCounts: RagSourceCounts;
  chunkCounts: RagChunkCounts;
  embeddingCacheCount: number;
  activeJdSources: RagInspectSourceSummary[];
  inactiveJdSources: RagInspectSourceSummary[];
  conversations: RagInspectConversationSummary[];
  questionDiagnostics?: RagInspectQuestionDiagnostics;
}

function createDefaultVectorStore(): RagVectorStore {
  return new QdrantVectorStore();
}

function parsePositiveIntegerEnv(name: string): number | undefined {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return parsed;
}

function resolveDenseLimit(finalLimit: number, override?: number): number {
  return override ?? parsePositiveIntegerEnv('RAG_DENSE_TOP_K') ?? finalLimit * DEFAULT_DENSE_LIMIT_MULTIPLIER;
}

function resolveKeywordLimit(finalLimit: number, override?: number): number {
  return override ?? parsePositiveIntegerEnv('RAG_KEYWORD_TOP_K') ?? finalLimit * DEFAULT_KEYWORD_LIMIT_MULTIPLIER;
}

function isFactChunk(chunk: RagChunk): boolean {
  return chunk.active && (chunk.sourceType === 'jd' || chunk.verified);
}

function countBySourceType(records: Array<{ sourceType: RagSourceType }>, sourceType: RagSourceType): number {
  return records.filter((record) => record.sourceType === sourceType).length;
}

function buildSourceCounts(sources: RagSourceRecord[]): RagSourceCounts {
  return {
    total: sources.length,
    active: sources.filter((source) => source.active).length,
    inactive: sources.filter((source) => !source.active).length,
    jd: countBySourceType(sources, 'jd'),
    conversation: countBySourceType(sources, 'conversation'),
    recruiterNote: countBySourceType(sources, 'recruiter_note'),
    faq: countBySourceType(sources, 'faq'),
  };
}

function buildChunkCounts(chunks: RagChunk[]): RagChunkCounts {
  return {
    total: chunks.length,
    active: chunks.filter((chunk) => chunk.active).length,
    inactive: chunks.filter((chunk) => !chunk.active).length,
    factChunks: chunks.filter(isFactChunk).length,
    jd: countBySourceType(chunks, 'jd'),
    verifiedConversation: chunks.filter((chunk) => chunk.sourceType === 'conversation' && chunk.verified).length,
    unverifiedConversation: chunks.filter((chunk) => chunk.sourceType === 'conversation' && !chunk.verified).length,
    recruiterNote: countBySourceType(chunks, 'recruiter_note'),
    faq: countBySourceType(chunks, 'faq'),
  };
}

function summarizeSource(source: RagSourceRecord): RagInspectSourceSummary {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    active: source.active,
    verified: source.verified,
    title: source.title,
    jdVersion: source.jdVersion,
    conversationId: source.conversationId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function buildConversationSummaries(
  sources: RagSourceRecord[],
  chunks: RagChunk[],
): RagInspectConversationSummary[] {
  const conversationIds = new Set<string>();
  for (const source of sources) {
    if (source.conversationId) {
      conversationIds.add(source.conversationId);
    }
  }
  for (const chunk of chunks) {
    if (chunk.conversationId) {
      conversationIds.add(chunk.conversationId);
    }
  }

  return [...conversationIds].sort().map((conversationId) => {
    const conversationChunks = chunks.filter((chunk) => chunk.conversationId === conversationId);
    return {
      conversationId,
      sourceIds: sources
        .filter((source) => source.conversationId === conversationId)
        .map((source) => source.sourceId)
        .sort(),
      turnCount: new Set(conversationChunks.flatMap((chunk) => chunk.turnIds ?? [])).size,
      verifiedFactChunkCount: conversationChunks.filter((chunk) => chunk.verified).length,
      unverifiedChunkCount: conversationChunks.filter((chunk) => !chunk.verified).length,
    };
  });
}

function formatSourceLabel(chunk: RagChunk): string {
  const label = typeof chunk.metadata?.label === 'string' ? chunk.metadata.label : undefined;
  if (label) {
    return label;
  }

  if (chunk.sourceType === 'jd') {
    return 'JD';
  }

  if (chunk.sourceType === 'conversation') {
    return chunk.speaker === 'recruiter' ? '已确认招聘方答复' : '历史对话';
  }

  return chunk.sourceType;
}

function previewText(text: string, maxChars = DEFAULT_TEXT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function toInspectResultItem(result: RagQueryResult): RagInspectResultItem {
  return {
    chunkId: result.chunk.chunkId,
    sourceId: result.chunk.sourceId,
    sourceType: result.chunk.sourceType,
    label: formatSourceLabel(result.chunk),
    score: result.score,
    active: result.chunk.active,
    verified: result.chunk.verified,
    speaker: result.chunk.speaker,
    conversationId: result.chunk.conversationId,
    jdVersion: result.chunk.jdVersion,
    textPreview: previewText(result.chunk.text),
  };
}

function buildFactFilter(platform: SupportedPlatform, jobKey: string): RagVectorFilter {
  return {
    platform,
    jobKey,
    active: true,
    factOnly: true,
    sourceTypes: ['jd', 'conversation', 'recruiter_note', 'faq'],
  };
}

async function buildQuestionDiagnostics(options: {
  platform: SupportedPlatform;
  jobKey: string;
  question: string;
  chunks: RagChunk[];
  manifest?: RagIndexManifest;
  vectorStore: RagVectorStore;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}): Promise<RagInspectQuestionDiagnostics> {
  const question = options.question.trim();
  if (!question) {
    throw new Error('Question must be a non-empty string');
  }

  const finalLimit = options.topK ?? resolveRagTopK();
  const denseLimit = resolveDenseLimit(finalLimit, options.denseTopK);
  const keywordLimit = resolveKeywordLimit(finalLimit, options.keywordTopK);
  const embeddingProvider = options.embeddingProvider
    ?? createRagEmbeddingProvider(options.manifest?.embeddingProvider);
  const embeddingModel = options.embeddingModel
    ?? options.manifest?.embeddingModel
    ?? resolveRagEmbeddingModel();
  const [questionEmbedding] = await inspectEmbedTextsRef.fn([question], embeddingModel, embeddingProvider);
  if (!questionEmbedding) {
    throw new Error('Embedding model returned no vector for the question');
  }

  const filter = buildFactFilter(options.platform, options.jobKey);
  const denseResults = await options.vectorStore.search(questionEmbedding, filter, denseLimit);
  const keywordResults = keywordSearch(question, options.chunks, filter, keywordLimit);
  const hybridResults = hybridSearch({
    denseResults,
    chunks: options.chunks,
    question,
    filter,
    limit: finalLimit,
    keywordLimit,
    rerankCandidateLimit: parsePositiveIntegerEnv('RAG_RERANK_CANDIDATE_K'),
  });

  return {
    question,
    embeddingProvider: embeddingProvider.name,
    embeddingModel,
    topK: finalLimit,
    denseTopK: denseLimit,
    keywordTopK: keywordLimit,
    filter,
    denseResults: denseResults.map(toInspectResultItem),
    keywordResults: keywordResults.map(toInspectResultItem),
    hybridResults: hybridResults.map(toInspectResultItem),
  };
}

export async function inspectRagJob(options: InspectRagJobOptions): Promise<RagInspectSummary> {
  const ragStore = options.ragStore ?? new RagStore();
  const [manifest, sources, chunks, embeddingCacheRecords] = await Promise.all([
    ragStore.readManifest(options.platform, options.jobKey),
    ragStore.listSources(options.platform, options.jobKey),
    ragStore.listChunks(options.platform, options.jobKey),
    ragStore.listEmbeddingCacheRecords(options.platform, options.jobKey),
  ]);
  const question = options.question?.trim();
  const vectorStore = question ? options.vectorStore ?? createDefaultVectorStore() : undefined;

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    manifest,
    sourceCounts: buildSourceCounts(sources),
    chunkCounts: buildChunkCounts(chunks),
    embeddingCacheCount: embeddingCacheRecords.length,
    activeJdSources: sources
      .filter((source) => source.sourceType === 'jd' && source.active)
      .map(summarizeSource),
    inactiveJdSources: sources
      .filter((source) => source.sourceType === 'jd' && !source.active)
      .map(summarizeSource),
    conversations: buildConversationSummaries(sources, chunks),
    questionDiagnostics: question
      ? await buildQuestionDiagnostics({
        platform: options.platform,
        jobKey: options.jobKey,
        question,
        chunks,
        manifest,
        vectorStore: vectorStore as RagVectorStore,
        topK: options.topK,
        denseTopK: options.denseTopK,
        keywordTopK: options.keywordTopK,
        embeddingModel: options.embeddingModel,
        embeddingProvider: options.embeddingProvider,
      })
      : undefined,
  };
}
