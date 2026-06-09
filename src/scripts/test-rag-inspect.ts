import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { inspectEmbedTextsRef, inspectRagJob } from '../rag/inspect.js';
import { RagStore } from '../rag/rag-store.js';
import type {
  RagChunk,
  RagEmbeddedChunk,
  RagQueryResult,
  RagSourceRecord,
  RagVectorFilter,
  RagVectorStore,
} from '../rag/types.js';
import type { RagEmbeddingProvider } from '../rag/embeddings.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-inspect-'));
  tempDirs.push(tempDir);
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
  return tempDir;
}

function buildSource(overrides: Partial<RagSourceRecord>): RagSourceRecord {
  const sourceType = overrides.sourceType ?? 'jd';
  return {
    platform: '51job',
    jobKey: 'rag-inspect',
    sourceId: `${sourceType}-source`,
    sourceType,
    active: true,
    verified: true,
    contentHash: `${sourceType}-hash`,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildChunk(overrides: Partial<RagChunk>): RagChunk {
  const sourceType = overrides.sourceType ?? 'jd';
  return {
    platform: '51job',
    jobKey: 'rag-inspect',
    chunkId: `${sourceType}-chunk`,
    sourceId: `${sourceType}-source`,
    sourceType,
    text: '职位信息',
    active: true,
    verified: true,
    contentHash: `${sourceType}-chunk-hash`,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

class FixedSearchVectorStore implements RagVectorStore {
  readonly kind = 'fixed';

  constructor(private readonly results: RagQueryResult[]) {}

  async ensureCollection(_embeddingDim: number): Promise<void> {
    return undefined;
  }

  async upsert(_chunks: RagEmbeddedChunk[]): Promise<void> {
    return undefined;
  }

  async search(_embedding: number[], _filter: RagVectorFilter, _limit: number): Promise<RagQueryResult[]> {
    return this.results;
  }

  async deleteByFilter(_filter: RagVectorFilter): Promise<void> {
    return undefined;
  }
}

const embeddingProvider: RagEmbeddingProvider = {
  name: 'openai',
  async embedTexts(texts) {
    return texts.map(() => [1, 1]);
  },
};

describe('RAG inspect', () => {
  it('summarizes local RAG records without requiring vector diagnostics', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const jobKey = 'rag-inspect-summary';
    const activeJdSource = buildSource({
      jobKey,
      sourceId: 'jd-active',
      sourceType: 'jd',
      jdVersion: 'v2',
    });
    const inactiveJdSource = buildSource({
      jobKey,
      sourceId: 'jd-inactive',
      sourceType: 'jd',
      active: false,
      jdVersion: 'v1',
    });
    const conversationSource = buildSource({
      jobKey,
      sourceId: 'conversation-conv-1',
      sourceType: 'conversation',
      conversationId: 'conv-1',
    });

    await ragStore.replaceSources('51job', jobKey, [activeJdSource, inactiveJdSource, conversationSource]);
    await ragStore.replaceChunks('51job', jobKey, [
      buildChunk({ jobKey, chunkId: 'jd-active-chunk', sourceId: 'jd-active', sourceType: 'jd', jdVersion: 'v2' }),
      buildChunk({ jobKey, chunkId: 'jd-inactive-chunk', sourceId: 'jd-inactive', sourceType: 'jd', active: false, jdVersion: 'v1' }),
      buildChunk({
        jobKey,
        chunkId: 'conversation-verified',
        sourceId: 'conversation-conv-1',
        sourceType: 'conversation',
        text: '可以提供住宿补贴。',
        conversationId: 'conv-1',
        speaker: 'recruiter',
        verified: true,
        turnIds: ['turn-2'],
      }),
      buildChunk({
        jobKey,
        chunkId: 'conversation-unverified',
        sourceId: 'conversation-conv-1',
        sourceType: 'conversation',
        text: '候选人询问住宿。',
        conversationId: 'conv-1',
        speaker: 'candidate',
        verified: false,
        turnIds: ['turn-1'],
      }),
    ]);
    await ragStore.appendEmbeddingCacheRecords('51job', jobKey, [{
      provider: 'openai',
      model: 'test-embedding',
      contentHash: 'jd-active-chunk',
      embedding: [1, 1],
      embeddingDim: 2,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }]);
    await ragStore.saveManifest('51job', jobKey, {
      platform: '51job',
      jobKey,
      updatedAt: '2026-06-01T00:00:00.000Z',
      embeddingProvider: 'openai',
      embeddingModel: 'test-embedding',
      embeddingDim: 2,
      vectorStore: 'fixed',
      jdVersion: 'v2',
      sourceCount: 2,
      chunkCount: 3,
      indexedChunkCount: 2,
    });

    const result = await inspectRagJob({
      platform: '51job',
      jobKey,
      ragStore,
    });

    assert.equal(result.sourceCounts.total, 3);
    assert.equal(result.sourceCounts.active, 2);
    assert.equal(result.sourceCounts.inactive, 1);
    assert.equal(result.sourceCounts.jd, 2);
    assert.equal(result.sourceCounts.conversation, 1);
    assert.equal(result.chunkCounts.total, 4);
    assert.equal(result.chunkCounts.active, 3);
    assert.equal(result.chunkCounts.factChunks, 2);
    assert.equal(result.chunkCounts.verifiedConversation, 1);
    assert.equal(result.chunkCounts.unverifiedConversation, 1);
    assert.equal(result.embeddingCacheCount, 1);
    assert.deepStrictEqual(result.activeJdSources.map((source) => source.sourceId), ['jd-active']);
    assert.deepStrictEqual(result.inactiveJdSources.map((source) => source.sourceId), ['jd-inactive']);
    assert.deepStrictEqual(result.conversations, [{
      conversationId: 'conv-1',
      sourceIds: ['conversation-conv-1'],
      turnCount: 2,
      verifiedFactChunkCount: 1,
      unverifiedChunkCount: 1,
    }]);
    assert.equal(result.questionDiagnostics, undefined);
  });

  it('reports dense, keyword, and hybrid retrieval diagnostics for a question', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const jobKey = 'rag-inspect-question';
    const salaryChunk = buildChunk({
      jobKey,
      chunkId: 'salary',
      sourceId: 'jd-active',
      sourceType: 'jd',
      text: '薪资范围：15-25K，13薪',
      metadata: { label: '结构化 JD 摘要' },
    });
    const locationChunk = buildChunk({
      jobKey,
      chunkId: 'location',
      sourceId: 'jd-active',
      sourceType: 'jd',
      text: '工作地点：上海',
    });
    const vectorStore = new FixedSearchVectorStore([{
      chunk: locationChunk,
      score: 0.95,
    }]);
    const originalEmbedTexts = inspectEmbedTextsRef.fn;
    inspectEmbedTextsRef.fn = async () => [[1, 1]];

    try {
      await ragStore.replaceChunks('51job', jobKey, [salaryChunk, locationChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingProvider: 'openai',
        embeddingModel: 'test-embedding',
        embeddingDim: 2,
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 2,
        indexedChunkCount: 2,
      });

      const result = await inspectRagJob({
        platform: '51job',
        jobKey,
        ragStore,
        vectorStore,
        question: '薪资范围是多少？15K可以吗？',
        topK: 2,
        embeddingModel: 'test-embedding',
        embeddingProvider,
      });

      assert.ok(result.questionDiagnostics);
      assert.equal(result.questionDiagnostics.embeddingProvider, 'openai');
      assert.deepStrictEqual(result.questionDiagnostics.denseResults.map((item) => item.chunkId), ['location']);
      assert.deepStrictEqual(result.questionDiagnostics.keywordResults.map((item) => item.chunkId), ['salary']);
      assert.deepStrictEqual(result.questionDiagnostics.hybridResults.map((item) => item.chunkId), ['salary', 'location']);
      assert.equal(result.questionDiagnostics.hybridResults[0]?.label, '结构化 JD 摘要');
      assert.match(result.questionDiagnostics.hybridResults[0]?.textPreview ?? '', /15-25K/);
    } finally {
      inspectEmbedTextsRef.fn = originalEmbedTexts;
    }
  });
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  delete process.env.DATA_DIR;
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
