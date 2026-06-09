import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { doctorRagJob } from '../rag/doctor.js';
import type { RagInspectSummary } from '../rag/inspect.js';

const originalDataDir = config.dataDir;
const originalEmbeddingProvider = process.env.RAG_EMBEDDING_PROVIDER;
const originalEmbeddingModel = process.env.RAG_EMBEDDING_MODEL;
const originalQdrantUrl = process.env.QDRANT_URL;

function buildInspectSummary(overrides: Partial<RagInspectSummary> = {}): RagInspectSummary {
  return {
    platform: '51job',
    jobKey: 'rag-doctor',
    manifest: {
      platform: '51job',
      jobKey: 'rag-doctor',
      updatedAt: '2026-06-01T00:00:00.000Z',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDim: 1536,
      vectorStore: 'memory',
      sourceCount: 1,
      chunkCount: 1,
      indexedChunkCount: 1,
    },
    sourceCounts: {
      total: 1,
      active: 1,
      inactive: 0,
      jd: 1,
      conversation: 0,
      recruiterNote: 0,
      faq: 0,
    },
    chunkCounts: {
      total: 1,
      active: 1,
      inactive: 0,
      factChunks: 1,
      jd: 1,
      verifiedConversation: 0,
      unverifiedConversation: 0,
      recruiterNote: 0,
      faq: 0,
    },
    embeddingCacheCount: 1,
    activeJdSources: [{
      sourceId: 'jd-active',
      sourceType: 'jd',
      active: true,
      verified: true,
      jdVersion: 'v1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }],
    inactiveJdSources: [],
    conversations: [],
    ...overrides,
  };
}

describe('RAG doctor', () => {
  it('reports ok for a healthy local RAG state', async () => {
    process.env.RAG_EMBEDDING_PROVIDER = 'openai';
    process.env.RAG_EMBEDDING_MODEL = 'text-embedding-3-small';

    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'rag-doctor',
      inspectJob: async () => buildInspectSummary(),
    });

    assert.equal(summary.status, 'ok');
    assert.deepStrictEqual(summary.issues, []);
    assert.deepStrictEqual(summary.recommendations, []);
  });

  it('reports missing local records as errors', async () => {
    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'missing',
      inspectJob: async () => buildInspectSummary({
        manifest: undefined,
        sourceCounts: {
          total: 0,
          active: 0,
          inactive: 0,
          jd: 0,
          conversation: 0,
          recruiterNote: 0,
          faq: 0,
        },
        chunkCounts: {
          total: 0,
          active: 0,
          inactive: 0,
          factChunks: 0,
          jd: 0,
          verifiedConversation: 0,
          unverifiedConversation: 0,
          recruiterNote: 0,
          faq: 0,
        },
        activeJdSources: [],
      }),
    });

    assert.equal(summary.status, 'error');
    assert.equal(summary.issues.some((issue) => issue.code === 'missing_manifest'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'no_sources'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'no_chunks'), true);
    assert.ok(summary.recommendations.length > 0);
  });

  it('warns when conversations exist but no verified recruiter facts are available', async () => {
    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'unverified-conversation',
      inspectJob: async () => buildInspectSummary({
        sourceCounts: {
          total: 2,
          active: 2,
          inactive: 0,
          jd: 1,
          conversation: 1,
          recruiterNote: 0,
          faq: 0,
        },
        chunkCounts: {
          total: 2,
          active: 2,
          inactive: 0,
          factChunks: 1,
          jd: 1,
          verifiedConversation: 0,
          unverifiedConversation: 1,
          recruiterNote: 0,
          faq: 0,
        },
        conversations: [{
          conversationId: 'conv-1',
          sourceIds: ['conversation-conv-1'],
          turnCount: 2,
          verifiedFactChunkCount: 0,
          unverifiedChunkCount: 2,
        }],
      }),
    });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.issues.some((issue) => issue.code === 'conversation_without_verified_facts'), true);
  });

  it('warns about manifest mismatches and missing Qdrant configuration', async () => {
    delete process.env.QDRANT_URL;
    process.env.RAG_EMBEDDING_PROVIDER = 'local-http';
    process.env.RAG_EMBEDDING_MODEL = 'bge-m3';

    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'manifest-mismatch',
      inspectJob: async () => buildInspectSummary({
        manifest: {
          platform: '51job',
          jobKey: 'manifest-mismatch',
          updatedAt: '2026-06-01T00:00:00.000Z',
          embeddingProvider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          embeddingDim: 1536,
          vectorStore: 'qdrant',
          sourceCount: 9,
          chunkCount: 8,
          indexedChunkCount: 0,
        },
      }),
    });

    assert.equal(summary.status, 'error');
    assert.equal(summary.issues.some((issue) => issue.code === 'manifest_chunk_count_mismatch'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'manifest_source_count_mismatch'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'embedding_model_mismatch'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'embedding_provider_mismatch'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'missing_qdrant_url'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'manifest_zero_indexed_chunks'), true);
  });

  it('adds question diagnostics issues when retrieval misses expected paths', async () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'question-diagnostics',
      question: '这个岗位有住宿补贴吗？',
      checkQdrant: async () => undefined,
      inspectJob: async () => buildInspectSummary({
        manifest: {
          platform: '51job',
          jobKey: 'question-diagnostics',
          updatedAt: '2026-06-01T00:00:00.000Z',
          embeddingProvider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          vectorStore: 'qdrant',
          sourceCount: 1,
          chunkCount: 1,
          indexedChunkCount: 1,
        },
        questionDiagnostics: {
          question: '这个岗位有住宿补贴吗？',
          embeddingProvider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          topK: 8,
          denseTopK: 32,
          keywordTopK: 32,
          filter: {
            platform: '51job',
            jobKey: 'question-diagnostics',
            active: true,
            factOnly: true,
            sourceTypes: ['jd', 'conversation', 'recruiter_note', 'faq'],
          },
          denseResults: [],
          keywordResults: [],
          hybridResults: [],
        },
      }),
    });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.issues.some((issue) => issue.code === 'dense_no_results'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'keyword_no_results'), true);
    assert.equal(summary.issues.some((issue) => issue.code === 'hybrid_no_results'), true);
  });

  it('reports Qdrant reachability failures when configured', async () => {
    process.env.QDRANT_URL = 'http://localhost:6333';

    const summary = await doctorRagJob({
      platform: '51job',
      jobKey: 'qdrant-down',
      checkQdrant: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      inspectJob: async () => buildInspectSummary({
        manifest: {
          platform: '51job',
          jobKey: 'qdrant-down',
          updatedAt: '2026-06-01T00:00:00.000Z',
          embeddingProvider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          vectorStore: 'qdrant',
          sourceCount: 1,
          chunkCount: 1,
          indexedChunkCount: 1,
        },
      }),
    });

    assert.equal(summary.status, 'error');
    assert.equal(summary.issues.some((issue) => issue.code === 'qdrant_unreachable'), true);
  });
});

after(() => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  if (originalEmbeddingProvider === undefined) {
    delete process.env.RAG_EMBEDDING_PROVIDER;
  } else {
    process.env.RAG_EMBEDDING_PROVIDER = originalEmbeddingProvider;
  }
  if (originalEmbeddingModel === undefined) {
    delete process.env.RAG_EMBEDDING_MODEL;
  } else {
    process.env.RAG_EMBEDDING_MODEL = originalEmbeddingModel;
  }
  if (originalQdrantUrl === undefined) {
    delete process.env.QDRANT_URL;
  } else {
    process.env.QDRANT_URL = originalQdrantUrl;
  }
});
