import type { SupportedPlatform } from '../platforms/types.js';

export type RagSourceType = 'jd' | 'conversation' | 'recruiter_note' | 'faq';
export type RagSpeaker = 'candidate' | 'recruiter' | 'system';

export interface RagSourceRecord {
  platform: SupportedPlatform;
  jobKey: string;
  sourceId: string;
  sourceType: RagSourceType;
  title?: string;
  active: boolean;
  verified: boolean;
  contentHash: string;
  jdVersion?: string;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RagChunk {
  platform: SupportedPlatform;
  jobKey: string;
  chunkId: string;
  sourceId: string;
  sourceType: RagSourceType;
  text: string;
  active: boolean;
  verified: boolean;
  contentHash: string;
  jdVersion?: string;
  conversationId?: string;
  speaker?: RagSpeaker;
  turnIds?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RagEmbeddedChunk extends RagChunk {
  vectorId: string;
  embedding: number[];
  embeddingProvider?: string;
  embeddingModel: string;
  embeddingDim: number;
}

export interface RagEmbeddingCacheRecord {
  provider: string;
  model: string;
  contentHash: string;
  embedding: number[];
  embeddingDim: number;
  createdAt: string;
  updatedAt: string;
}

export interface RagQueryResult {
  chunk: RagChunk;
  score: number;
}

export interface RagAnswerSource {
  id: string;
  label: string;
  text: string;
  score: number;
  sourceType: RagSourceType;
  sourceId: string;
  chunkId: string;
  verified: boolean;
  active: boolean;
  speaker?: RagSpeaker;
  conversationId?: string;
  jdVersion?: string;
}

export interface RagAnswer {
  answer: string;
  sources: RagAnswerSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

export const RAG_ANSWER_FEEDBACK_ERROR_TYPES = [
  'wrong_fact',
  'unsupported_claim',
  'missing_context',
  'bad_source',
  'low_relevance',
  'wording_issue',
  'other',
] as const;

export type RagAnswerFeedbackErrorType = typeof RAG_ANSWER_FEEDBACK_ERROR_TYPES[number];

export interface RagAnswerFeedback {
  correct?: boolean;
  errorType?: RagAnswerFeedbackErrorType;
  note?: string;
  reviewedAt?: string;
  reviewer?: string;
}

export interface RagAnswerLogRecord {
  logId?: string;
  platform: SupportedPlatform;
  jobKey: string;
  question: string;
  answer: string;
  sources: RagAnswerSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
  createdAt: string;
  feedback?: RagAnswerFeedback;
  metadata?: Record<string, unknown>;
}

export interface RagConversationTurn {
  id?: string;
  role: RagSpeaker;
  content: string;
  verified?: boolean;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RagStoredConversationTurn extends Required<Pick<RagConversationTurn, 'id' | 'role' | 'content' | 'createdAt'>> {
  platform: SupportedPlatform;
  jobKey: string;
  conversationId: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
}

export interface RagIndexManifest {
  platform: SupportedPlatform;
  jobKey: string;
  updatedAt: string;
  embeddingProvider?: string;
  embeddingModel: string;
  embeddingDim?: number;
  vectorStore: string;
  jdVersion?: string;
  sourceCount: number;
  chunkCount: number;
  indexedChunkCount: number;
}

export interface RagVectorFilter {
  platform: SupportedPlatform;
  jobKey: string;
  active?: boolean;
  factOnly?: boolean;
  sourceTypes?: RagSourceType[];
  verified?: boolean;
  conversationId?: string;
}

export interface RagVectorStore {
  readonly kind: string;
  ensureCollection(embeddingDim: number): Promise<void>;
  upsert(chunks: RagEmbeddedChunk[]): Promise<void>;
  search(embedding: number[], filter: RagVectorFilter, limit: number): Promise<RagQueryResult[]>;
  deleteByFilter(filter: RagVectorFilter): Promise<void>;
}
