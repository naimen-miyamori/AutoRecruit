import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';
import type { OpenAISettingsOverride } from '../llm/openai-client.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';
import type { JobRecord } from '../types/job.js';
import {
  buildConversationRagRecords,
  buildJdRagRecords,
  createContentHash,
} from './chunking.js';
import { buildAnswerLogId } from './answer-logs.js';
import {
  createRagEmbeddingProvider,
  embedRagChunks as embedRagChunksImpl,
  embedTexts as embedTextsImpl,
  type RagEmbeddingProvider,
  resolveRagEmbeddingModel,
} from './embeddings.js';
import { hybridSearch } from './hybrid-search.js';
import { QdrantVectorStore } from './qdrant-store.js';
import { RagStore } from './rag-store.js';
import type {
  RagAnswer,
  RagAnswerSource,
  RagChunk,
  RagConversationTurn,
  RagEmbeddedChunk,
  RagEmbeddingCacheRecord,
  RagIndexManifest,
  RagSourceRecord,
  RagStoredConversationTurn,
  RagVectorFilter,
  RagVectorStore,
} from './types.js';
import { resolveRagTopK } from './vector-store.js';

const MAX_CONTEXT_CHARS = 4200;
const DEFAULT_DENSE_LIMIT_MULTIPLIER = 4;
const DEFAULT_MIN_CONFIDENCE_SCORE = 0.08;
const NO_ANSWER_TEXT = '目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。';

export const embedRagChunksRef = { fn: embedRagChunksImpl };
export const embedTextsRef = { fn: embedTextsImpl };
export const generateRagAnswerRef = { fn: generateAnswer };

export interface RagDependencies {
  jobStore?: JobStore;
  ragStore?: RagStore;
  vectorStore?: RagVectorStore;
}

export interface IndexJobJdOptions extends RagDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}

export interface IngestConversationOptions extends RagDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  turns: RagConversationTurn[];
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}

export interface AskRagQuestionOptions extends RagDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  question: string;
  topK?: number;
  autoIndex?: boolean;
  logAnswer?: boolean;
  answerLogMetadata?: Record<string, unknown>;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
  llmSettings?: OpenAISettingsOverride;
}

export interface RebuildRagIndexOptions extends RagDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
}

export interface RagIndexSummary {
  platform: SupportedPlatform;
  jobKey: string;
  sourceCount: number;
  chunkCount: number;
  indexedChunkCount: number;
  embeddingProvider?: string;
  embeddingModel: string;
  embeddingDim?: number;
  vectorStore: string;
  manifestPath: string;
}

export interface RagConversationIngestSummary extends RagIndexSummary {
  conversationId: string;
  conversationPath: string;
}

function createDefaultVectorStore(): RagVectorStore {
  return new QdrantVectorStore();
}

function resolveStores(dependencies: RagDependencies = {}): Required<RagDependencies> {
  return {
    jobStore: dependencies.jobStore ?? new JobStore(),
    ragStore: dependencies.ragStore ?? new RagStore(),
    vectorStore: dependencies.vectorStore ?? createDefaultVectorStore(),
  };
}

function buildManifest(options: {
  platform: SupportedPlatform;
  jobKey: string;
  embeddingProvider?: string;
  embeddingModel: string;
  embeddingDim?: number;
  vectorStore: string;
  jdVersion?: string;
  sourceCount: number;
  chunkCount: number;
  indexedChunkCount: number;
}): RagIndexManifest {
  return {
    platform: options.platform,
    jobKey: options.jobKey,
    updatedAt: new Date().toISOString(),
    embeddingProvider: options.embeddingProvider,
    embeddingModel: options.embeddingModel,
    embeddingDim: options.embeddingDim,
    vectorStore: options.vectorStore,
    jdVersion: options.jdVersion,
    sourceCount: options.sourceCount,
    chunkCount: options.chunkCount,
    indexedChunkCount: options.indexedChunkCount,
  };
}

function deactivateSources(sources: RagSourceRecord[], sourceType: RagSourceRecord['sourceType']): RagSourceRecord[] {
  const updatedAt = new Date().toISOString();
  return sources.map((source) => source.sourceType === sourceType && source.active
    ? { ...source, active: false, updatedAt }
    : source);
}

function deactivateChunks(chunks: RagChunk[], sourceType: RagChunk['sourceType']): RagChunk[] {
  const updatedAt = new Date().toISOString();
  return chunks.map((chunk) => chunk.sourceType === sourceType && chunk.active
    ? { ...chunk, active: false, updatedAt }
    : chunk);
}

function countActiveSources(sources: RagSourceRecord[]): number {
  return sources.filter((source) => source.active).length;
}

function countActiveChunks(chunks: RagChunk[]): number {
  return chunks.filter((chunk) => chunk.active).length;
}

function buildStableConversationTurnId(turn: RagConversationTurn): string {
  if (turn.id?.trim()) {
    return turn.id.trim();
  }

  return `auto-${createContentHash([
    turn.role,
    turn.createdAt?.trim() ?? '',
    turn.content.trim(),
  ].join('\n')).slice(0, 16)}`;
}

function mergeConversationTurns(
  existingTurns: RagStoredConversationTurn[],
  incomingTurns: RagStoredConversationTurn[],
): RagStoredConversationTurn[] {
  const byId = new Map<string, RagStoredConversationTurn>();
  for (const turn of existingTurns) {
    byId.set(turn.id, turn);
  }

  for (const turn of incomingTurns) {
    byId.set(turn.id, turn);
  }

  return [...byId.values()];
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

function parseNonNegativeNumberEnv(name: string): number | undefined {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number`);
  }

  return parsed;
}

function resolveMinConfidenceScore(): number {
  return parseNonNegativeNumberEnv('RAG_MIN_CONFIDENCE_SCORE') ?? DEFAULT_MIN_CONFIDENCE_SCORE;
}

function shouldUseHybridRetrieval(): boolean {
  const mode = process.env.RAG_RETRIEVAL_MODE?.trim().toLowerCase();
  if (!mode || mode === 'hybrid') {
    return true;
  }

  if (mode === 'dense') {
    return false;
  }

  throw new Error('Environment variable RAG_RETRIEVAL_MODE must be either hybrid or dense');
}

function resolveDenseSearchLimit(finalLimit: number): number {
  return parsePositiveIntegerEnv('RAG_DENSE_TOP_K') ?? finalLimit * DEFAULT_DENSE_LIMIT_MULTIPLIER;
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

function toAnswerSource(result: { chunk: RagChunk; score: number }): RagAnswerSource {
  return {
    id: result.chunk.chunkId,
    label: formatSourceLabel(result.chunk),
    text: result.chunk.text,
    score: result.score,
    sourceType: result.chunk.sourceType,
    sourceId: result.chunk.sourceId,
    chunkId: result.chunk.chunkId,
    verified: result.chunk.verified,
    active: result.chunk.active,
    speaker: result.chunk.speaker,
    conversationId: result.chunk.conversationId,
    jdVersion: result.chunk.jdVersion,
  };
}

function isTrustedAnswerSource(source: RagAnswerSource): boolean {
  return source.active && (source.sourceType === 'jd' || source.verified);
}

function buildNoAnswer(question: string, sources: RagAnswerSource[], reason: string): RagAnswer {
  return {
    answer: NO_ANSWER_TEXT,
    sources,
    answered: false,
    confidence: sources[0]?.score ?? 0,
    noAnswerReason: reason,
  };
}

async function appendAnswerLog(
  ragStore: RagStore,
  options: AskRagQuestionOptions,
  question: string,
  answer: RagAnswer,
): Promise<void> {
  if (options.logAnswer === false) {
    return;
  }

  const createdAt = new Date().toISOString();
  await ragStore.appendAnswerLog(options.platform, options.jobKey, {
    logId: buildAnswerLogId({
      platform: options.platform,
      jobKey: options.jobKey,
      question,
      createdAt,
    }),
    platform: options.platform,
    jobKey: options.jobKey,
    question,
    answer: answer.answer,
    sources: answer.sources,
    answered: answer.answered,
    confidence: answer.confidence,
    noAnswerReason: answer.noAnswerReason,
    createdAt,
    metadata: options.answerLogMetadata,
  });
}

function buildContext(sources: RagAnswerSource[]): string {
  let totalLength = 0;
  const blocks: string[] = [];

  for (const source of sources) {
    const block = [
      `[${source.chunkId}] ${source.label}`,
      `sourceType=${source.sourceType}; verified=${source.verified}`,
      source.text,
    ].join('\n');
    if (totalLength + block.length > MAX_CONTEXT_CHARS && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    totalLength += block.length;
  }

  return blocks.join('\n\n');
}

function cleanAnswerText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
}

async function embedAndUpsert(
  ragStore: RagStore,
  vectorStore: RagVectorStore,
  platform: SupportedPlatform,
  jobKey: string,
  chunks: RagChunk[],
  embeddingModel: string,
  embeddingProvider?: RagEmbeddingProvider,
): Promise<{ indexedChunkCount: number; embeddingDim?: number }> {
  const activeChunks = chunks.filter((chunk) => chunk.active);
  if (activeChunks.length === 0) {
    return {
      indexedChunkCount: 0,
      embeddingDim: undefined,
    };
  }

  const cacheRecords = await ragStore.listEmbeddingCacheRecords(platform, jobKey);
  const embedded = await embedRagChunksRef.fn(activeChunks, embeddingModel, {
    provider: embeddingProvider,
    cacheRecords,
  }) as { chunks: RagEmbeddedChunk[]; newCacheRecords: RagEmbeddingCacheRecord[] } | RagEmbeddedChunk[];
  const embeddedChunks = Array.isArray(embedded) ? embedded : embedded.chunks;
  const embeddingDim = embeddedChunks.find((chunk) => chunk.embeddingDim > 0)?.embeddingDim;
  if (!embeddingDim) {
    throw new Error('Embedding model returned no vectors');
  }

  if (!Array.isArray(embedded) && embedded.newCacheRecords.length > 0) {
    await ragStore.appendEmbeddingCacheRecords(platform, jobKey, embedded.newCacheRecords);
  }
  await vectorStore.ensureCollection(embeddingDim);
  await vectorStore.upsert(embeddedChunks);

  return {
    indexedChunkCount: embeddedChunks.length,
    embeddingDim,
  };
}

async function saveManifestSummary(
  ragStore: RagStore,
  options: Omit<RagIndexManifest, 'updatedAt'>,
): Promise<RagIndexSummary> {
  const manifest = buildManifest(options);
  const manifestPath = await ragStore.saveManifest(options.platform, options.jobKey, manifest);

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    sourceCount: options.sourceCount,
    chunkCount: options.chunkCount,
    indexedChunkCount: options.indexedChunkCount,
    embeddingProvider: options.embeddingProvider,
    embeddingModel: options.embeddingModel,
    embeddingDim: options.embeddingDim,
    vectorStore: options.vectorStore,
    manifestPath,
  };
}

export async function indexJobJd(options: IndexJobJdOptions): Promise<RagIndexSummary> {
  const { jobStore, ragStore, vectorStore } = resolveStores(options);
  const embeddingModel = options.embeddingModel ?? resolveRagEmbeddingModel();
  const embeddingProvider = options.embeddingProvider ?? createRagEmbeddingProvider();
  const jobRecord: JobRecord = await jobStore.readJobRecord(options.platform, options.jobKey);
  const records = buildJdRagRecords({
    platform: options.platform,
    jobKey: options.jobKey,
    rawText: jobRecord.rawText,
    normalizedJob: jobRecord.normalizedJob,
  });

  await vectorStore.deleteByFilter({
    platform: options.platform,
    jobKey: options.jobKey,
    sourceTypes: ['jd'],
  });
  const previousSources = await ragStore.listSources(options.platform, options.jobKey);
  const previousChunks = await ragStore.listChunks(options.platform, options.jobKey);
  await ragStore.replaceSources(options.platform, options.jobKey, [
    ...deactivateSources(previousSources, 'jd'),
    records.source,
  ]);
  await ragStore.replaceChunks(options.platform, options.jobKey, [
    ...deactivateChunks(previousChunks, 'jd'),
    ...records.chunks,
  ]);

  const indexed = await embedAndUpsert(ragStore, vectorStore, options.platform, options.jobKey, records.chunks, embeddingModel, embeddingProvider);
  const sources = await ragStore.listSources(options.platform, options.jobKey);
  const chunks = await ragStore.listChunks(options.platform, options.jobKey);

  return saveManifestSummary(ragStore, {
    platform: options.platform,
    jobKey: options.jobKey,
    embeddingModel,
    embeddingProvider: embeddingProvider.name,
    embeddingDim: indexed.embeddingDim,
    vectorStore: vectorStore.kind,
    jdVersion: records.source.jdVersion,
    sourceCount: countActiveSources(sources),
    chunkCount: countActiveChunks(chunks),
    indexedChunkCount: indexed.indexedChunkCount,
  });
}

export async function ingestConversation(options: IngestConversationOptions): Promise<RagConversationIngestSummary> {
  const { ragStore, vectorStore } = resolveStores(options);
  const embeddingModel = options.embeddingModel ?? resolveRagEmbeddingModel();
  const embeddingProvider = options.embeddingProvider ?? createRagEmbeddingProvider();
  const createdAt = new Date().toISOString();
  const incomingTurns: RagStoredConversationTurn[] = options.turns.map((turn) => ({
    platform: options.platform,
    jobKey: options.jobKey,
    conversationId: options.conversationId,
    id: buildStableConversationTurnId(turn),
    role: turn.role,
    content: turn.content.trim(),
    verified: turn.verified === true && turn.role === 'recruiter',
    createdAt: turn.createdAt ?? createdAt,
    metadata: turn.metadata,
  }));
  const existingTurns = await ragStore.readConversationTurns(options.platform, options.jobKey, options.conversationId);
  const storedTurns = mergeConversationTurns(existingTurns, incomingTurns);
  const records = buildConversationRagRecords({
    platform: options.platform,
    jobKey: options.jobKey,
    conversationId: options.conversationId,
    turns: storedTurns,
    createdAt,
  });
  const factChunks = records.chunks.filter((chunk) => chunk.sourceType !== 'conversation' || chunk.verified);

  await vectorStore.deleteByFilter({
    platform: options.platform,
    jobKey: options.jobKey,
    sourceTypes: ['conversation'],
    conversationId: options.conversationId,
  });
  await ragStore.replaceConversationSources(options.platform, options.jobKey, options.conversationId, [records.source]);
  await ragStore.replaceConversationChunks(options.platform, options.jobKey, options.conversationId, records.chunks);
  const conversationPath = await ragStore.saveConversationTurns(
    options.platform,
    options.jobKey,
    options.conversationId,
    storedTurns,
  );

  const indexed = await embedAndUpsert(ragStore, vectorStore, options.platform, options.jobKey, factChunks, embeddingModel, embeddingProvider);
  const sources = await ragStore.listSources(options.platform, options.jobKey);
  const chunks = await ragStore.listChunks(options.platform, options.jobKey);
  const summary = await saveManifestSummary(ragStore, {
    platform: options.platform,
    jobKey: options.jobKey,
    embeddingModel,
    embeddingProvider: embeddingProvider.name,
    embeddingDim: indexed.embeddingDim,
    vectorStore: vectorStore.kind,
    sourceCount: countActiveSources(sources),
    chunkCount: countActiveChunks(chunks),
    indexedChunkCount: indexed.indexedChunkCount,
  });

  return {
    ...summary,
    conversationId: options.conversationId,
    conversationPath,
  };
}

export async function rebuildRagIndex(options: RebuildRagIndexOptions): Promise<RagIndexSummary> {
  const { ragStore, vectorStore } = resolveStores(options);
  const embeddingModel = options.embeddingModel ?? resolveRagEmbeddingModel();
  const embeddingProvider = options.embeddingProvider ?? createRagEmbeddingProvider();
  const sources = await ragStore.listSources(options.platform, options.jobKey);
  const chunks = await ragStore.listChunks(options.platform, options.jobKey);
  const factChunks = chunks.filter((chunk) => chunk.active && (chunk.sourceType === 'jd' || chunk.verified));

  if (chunks.length === 0) {
    throw new Error(`No RAG chunks found for ${options.platform} job key ${options.jobKey}; run rag:index first`);
  }

  await vectorStore.deleteByFilter({
    platform: options.platform,
    jobKey: options.jobKey,
  });
  const indexed = await embedAndUpsert(ragStore, vectorStore, options.platform, options.jobKey, factChunks, embeddingModel, embeddingProvider);

  return saveManifestSummary(ragStore, {
    platform: options.platform,
    jobKey: options.jobKey,
    embeddingModel,
    embeddingProvider: embeddingProvider.name,
    embeddingDim: indexed.embeddingDim,
    vectorStore: vectorStore.kind,
    jdVersion: sources.find((source) => source.sourceType === 'jd' && source.active)?.jdVersion,
    sourceCount: countActiveSources(sources),
    chunkCount: countActiveChunks(chunks),
    indexedChunkCount: indexed.indexedChunkCount,
  });
}

async function generateAnswer(question: string, sources: RagAnswerSource[], settings?: OpenAISettingsOverride): Promise<string> {
  const answerText = await completeJsonTextFromOpenAI({
    featureName: 'RAG question answering',
    modelEnvName: 'RAG_MODEL',
    input: [
      `候选人问题：${question}`,
      '',
      '可用上下文：',
      buildContext(sources),
    ].join('\n'),
    instructions: [
      '你是招聘方助手，负责根据招聘 JD 和已确认的招聘方历史答复回答候选人问题。',
      '只能使用提供的上下文作答，不要补充或猜测上下文中没有的信息。',
      'JD 内容优先于历史对话；历史对话只有 verified=true 时才可作为事实。',
      '如果上下文中没有答案，明确说明目前 JD/历史确认答复中未说明，并建议候选人与招聘方确认。',
      '回答要面向候选人，使用中文，语气专业、自然、简洁。',
      '不要提及 RAG、检索、模型、chunkId 或内部流程。',
      '直接输出答案文本，不要输出 JSON、markdown 标题或代码块。',
    ].join('\n'),
    maxOutputTokens: 700,
    settings,
  });

  return cleanAnswerText(answerText);
}

export async function answerQuestionWithRag(options: AskRagQuestionOptions): Promise<RagAnswer> {
  const { ragStore, vectorStore } = resolveStores(options);
  const question = options.question.trim();
  if (!question) {
    throw new Error('Question must be a non-empty string');
  }

  let manifest = await ragStore.readManifest(options.platform, options.jobKey);
  const embeddingProvider = options.embeddingProvider ?? createRagEmbeddingProvider(manifest?.embeddingProvider);
  if (!manifest) {
    if (options.autoIndex === false) {
      throw new Error(`Missing RAG index for ${options.platform} job key ${options.jobKey}; run rag:index first`);
    }

    await indexJobJd({
      platform: options.platform,
      jobKey: options.jobKey,
      jobStore: options.jobStore,
      ragStore,
      vectorStore,
      embeddingModel: options.embeddingModel,
      embeddingProvider,
    });
    manifest = await ragStore.readManifest(options.platform, options.jobKey);
  }

  const embeddingModel = options.embeddingModel ?? manifest?.embeddingModel ?? resolveRagEmbeddingModel();
  const [questionEmbedding] = await embedTextsRef.fn([question], embeddingModel, embeddingProvider);
  if (!questionEmbedding) {
    throw new Error('Embedding model returned no vector for the question');
  }

  const filter: RagVectorFilter = {
    platform: options.platform,
    jobKey: options.jobKey,
    active: true,
    factOnly: true,
    sourceTypes: ['jd', 'conversation', 'recruiter_note', 'faq'],
  };
  const finalLimit = options.topK ?? resolveRagTopK();
  const denseResults = await vectorStore.search(questionEmbedding, filter, resolveDenseSearchLimit(finalLimit));
  const results = shouldUseHybridRetrieval()
    ? hybridSearch({
      denseResults,
      chunks: await ragStore.listChunks(options.platform, options.jobKey),
      question,
      filter,
      limit: finalLimit,
      keywordLimit: parsePositiveIntegerEnv('RAG_KEYWORD_TOP_K'),
      rerankCandidateLimit: parsePositiveIntegerEnv('RAG_RERANK_CANDIDATE_K'),
    })
    : denseResults.slice(0, finalLimit);
  const sources = results.map(toAnswerSource);
  const trustedSources = sources.filter(isTrustedAnswerSource);
  const confidence = trustedSources[0]?.score ?? 0;

  if (trustedSources.length === 0) {
    const answer = buildNoAnswer(question, sources, 'no_trusted_context');
    await appendAnswerLog(ragStore, options, question, answer);
    return answer;
  }

  if (confidence < resolveMinConfidenceScore()) {
    const answer = buildNoAnswer(question, trustedSources, 'low_confidence');
    await appendAnswerLog(ragStore, options, question, answer);
    return answer;
  }

  const answer: RagAnswer = {
    answer: await generateRagAnswerRef.fn(question, trustedSources, options.llmSettings),
    sources: trustedSources,
    answered: true,
    confidence,
  };
  await appendAnswerLog(ragStore, options, question, answer);
  return answer;
}
