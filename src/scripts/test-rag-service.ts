import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { answerQuestionWithRag, embedRagChunksRef, embedTextsRef, generateRagAnswerRef, indexJobJd, ingestConversation, rebuildRagIndex } from '../rag/service.js';
import { RagStore } from '../rag/rag-store.js';
import { MemoryVectorStore } from '../rag/vector-store.js';
import { JobStore } from '../storage/job-store.js';
import type { JobRecord } from '../types/job.js';
import type { RagChunk, RagEmbeddedChunk, RagQueryResult, RagVectorFilter, RagVectorStore } from '../rag/types.js';
import type { RagEmbeddingProvider } from '../rag/embeddings.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-'));
  tempDirs.push(tempDir);
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
  return tempDir;
}

function buildJobRecord(jobKey: string): JobRecord {
  return {
    platform: '51job',
    jobKey,
    searchKeyword: '东南亚 销售',
    rawText: '职位名称：东南亚销售经理\n薪资范围：15-25K\n职责：负责东南亚客户开发',
    normalizedJob: {
      title: '东南亚销售经理',
      salaryRange: { raw: '15-25K' },
      majors: [],
      languageRequirements: ['英语可作为工作语言'],
      responsibilities: ['负责东南亚客户开发'],
      hardRequirements: ['5年以上销售经验'],
      preferredRequirements: [],
      regionPreferences: ['东南亚'],
      industryTags: ['销售'],
    },
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

function stubEmbeddingEnv() {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  return () => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  };
}

function buildRagChunk(chunkId: string, text: string): RagChunk {
  return {
    platform: '51job',
    jobKey: 'rag-answer-hybrid',
    chunkId,
    sourceId: 'jd-test',
    sourceType: 'jd',
    text,
    active: true,
    verified: true,
    contentHash: chunkId,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
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

describe('RAG service', () => {
  it('indexes a stored JD into local facts and vector store', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const jobStore = new JobStore();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const jobKey = 'rag-jd-index';

    await jobStore.saveJobRecord('51job', buildJobRecord(jobKey));

    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      const summary = await indexJobJd({
        platform: '51job',
        jobKey,
        jobStore,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      const chunks = await ragStore.listChunks('51job', jobKey);
      const sources = await ragStore.listSources('51job', jobKey);

      assert.equal(summary.vectorStore, 'memory');
      assert.equal(summary.sourceCount, 1);
      assert.equal(sources.length, 1);
      assert.ok(chunks.length >= 2);
      assert.equal(chunks.every((chunk) => chunk.sourceType === 'jd'), true);
      assert.equal(chunks.every((chunk) => chunk.verified), true);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('keeps old JD records inactive when a stored JD is reindexed', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const jobStore = new JobStore();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const jobKey = 'rag-jd-reindex';

    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      await jobStore.saveJobRecord('51job', buildJobRecord(jobKey));
      await indexJobJd({
        platform: '51job',
        jobKey,
        jobStore,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });

      await jobStore.saveJobRecord('51job', {
        ...buildJobRecord(jobKey),
        rawText: '职位名称：日韩销售经理\n薪资范围：18-28K\n职责：负责日韩客户开发',
        normalizedJob: {
          ...buildJobRecord(jobKey).normalizedJob,
          title: '日韩销售经理',
          responsibilities: ['负责日韩客户开发'],
          regionPreferences: ['日韩'],
        },
      });
      const summary = await indexJobJd({
        platform: '51job',
        jobKey,
        jobStore,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      const chunks = await ragStore.listChunks('51job', jobKey);
      const sources = await ragStore.listSources('51job', jobKey);
      const activeJdSources = sources.filter((source) => source.sourceType === 'jd' && source.active);
      const inactiveJdSources = sources.filter((source) => source.sourceType === 'jd' && !source.active);
      const activeJdChunks = chunks.filter((chunk) => chunk.sourceType === 'jd' && chunk.active);
      const inactiveJdChunks = chunks.filter((chunk) => chunk.sourceType === 'jd' && !chunk.active);

      assert.equal(summary.sourceCount, 1);
      assert.equal(activeJdSources.length, 1);
      assert.equal(inactiveJdSources.length, 1);
      assert.ok(activeJdChunks.length > 0);
      assert.ok(inactiveJdChunks.length > 0);
      assert.equal(activeJdChunks.some((chunk) => chunk.text.includes('日韩客户开发')), true);
      assert.equal(activeJdChunks.some((chunk) => chunk.text.includes('东南亚客户开发')), false);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('ingests conversations but indexes only verified recruiter facts', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      const summary = await ingestConversation({
        platform: '51job',
        jobKey: 'rag-conversation',
        conversationId: 'conv-1',
        turns: [
          { role: 'candidate', content: '公司提供住宿吗？' },
          { role: 'recruiter', content: '可以提供住宿补贴。', verified: true },
          { role: 'recruiter', content: '这句未确认。', verified: false },
        ],
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      const chunks = await ragStore.listChunks('51job', 'rag-conversation');
      const turns = await ragStore.readConversationTurns('51job', 'rag-conversation', 'conv-1');
      const results = await vectorStore.search([1, 1], {
        platform: '51job',
        jobKey: 'rag-conversation',
        active: true,
        factOnly: true,
        sourceTypes: ['conversation'],
      }, 10);

      assert.equal(summary.conversationId, 'conv-1');
      assert.equal(chunks.length, 3);
      assert.equal(turns.length, 3);
      assert.deepStrictEqual(results.map((result) => result.chunk.text), ['可以提供住宿补贴。']);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('ingests conversations incrementally without duplicating or dropping prior facts', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      await ingestConversation({
        platform: '51job',
        jobKey: 'rag-conversation-incremental',
        conversationId: 'conv-1',
        turns: [
          { id: 'turn-1', role: 'candidate', content: '有住宿补贴吗？' },
          { id: 'turn-2', role: 'recruiter', content: '住宿补贴每月800元。', verified: true },
        ],
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });

      const summary = await ingestConversation({
        platform: '51job',
        jobKey: 'rag-conversation-incremental',
        conversationId: 'conv-1',
        turns: [
          { id: 'turn-2', role: 'recruiter', content: '住宿补贴每月800元。', verified: true },
          { id: 'turn-3', role: 'candidate', content: '有交通补贴吗？' },
          { id: 'turn-4', role: 'recruiter', content: '交通补贴每月300元。', verified: true },
        ],
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      const chunks = await ragStore.listChunks('51job', 'rag-conversation-incremental');
      const turns = await ragStore.readConversationTurns('51job', 'rag-conversation-incremental', 'conv-1');
      const results = await vectorStore.search([1, 1], {
        platform: '51job',
        jobKey: 'rag-conversation-incremental',
        active: true,
        factOnly: true,
        sourceTypes: ['conversation'],
      }, 10);
      const resultTexts = results.map((result) => result.chunk.text).sort();

      assert.equal(summary.sourceCount, 1);
      assert.equal(summary.chunkCount, 4);
      assert.equal(chunks.length, 4);
      assert.equal(turns.length, 4);
      assert.deepStrictEqual(resultTexts, ['交通补贴每月300元。', '住宿补贴每月800元。']);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('replaces conversation chunks when a verified turn is corrected to unverified', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      await ingestConversation({
        platform: '51job',
        jobKey: 'rag-conversation-correction',
        conversationId: 'conv-1',
        turns: [
          { id: 'turn-1', role: 'recruiter', content: '交通补贴每月500元。', verified: true },
        ],
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      await ingestConversation({
        platform: '51job',
        jobKey: 'rag-conversation-correction',
        conversationId: 'conv-1',
        turns: [
          { id: 'turn-1', role: 'recruiter', content: '交通补贴每月500元，待确认。', verified: false },
        ],
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });
      const chunks = await ragStore.listChunks('51job', 'rag-conversation-correction');
      const results = await vectorStore.search([1, 1], {
        platform: '51job',
        jobKey: 'rag-conversation-correction',
        active: true,
        factOnly: true,
        sourceTypes: ['conversation'],
      }, 10);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]?.text, '交通补贴每月500元，待确认。');
      assert.equal(chunks[0]?.verified, false);
      assert.deepStrictEqual(results, []);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('rebuilds vector index from local chunks', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const jobStore = new JobStore();
    const ragStore = new RagStore();
    const firstVectorStore = new MemoryVectorStore();
    const rebuiltVectorStore = new MemoryVectorStore();
    const originalEmbedRagChunks = embedRagChunksRef.fn;
    embedRagChunksRef.fn = async (chunks, model = 'test-embedding') => ({
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vectorId: `vector-${chunk.chunkId}`,
        embedding: [index + 1, 1],
        embeddingModel: model,
        embeddingDim: 2,
      })),
      newCacheRecords: [],
    });

    try {
      await jobStore.saveJobRecord('51job', buildJobRecord('rag-rebuild'));
      await indexJobJd({
        platform: '51job',
        jobKey: 'rag-rebuild',
        jobStore,
        ragStore,
        vectorStore: firstVectorStore,
        embeddingModel: 'test-embedding',
      });

      const summary = await rebuildRagIndex({
        platform: '51job',
        jobKey: 'rag-rebuild',
        ragStore,
        vectorStore: rebuiltVectorStore,
        embeddingModel: 'test-embedding',
      });
      const results = await rebuiltVectorStore.search([1, 1], {
        platform: '51job',
        jobKey: 'rag-rebuild',
        active: true,
        factOnly: true,
      }, 5);

      assert.ok(summary.indexedChunkCount > 0);
      assert.ok(results.length > 0);
    } finally {
      embedRagChunksRef.fn = originalEmbedRagChunks;
      restoreEnv();
    }
  });

  it('answers with hybrid retrieval by adding keyword matches to dense results', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const jobKey = 'rag-answer-hybrid';
    const salaryChunk = buildRagChunk('salary', '薪资范围：15-25K，13薪');
    const locationChunk = buildRagChunk('location', '工作地点：上海');
    const vectorStore = new FixedSearchVectorStore([{
      chunk: locationChunk,
      score: 0.99,
    }]);
    const originalEmbedTexts = embedTextsRef.fn;
    const originalGenerateRagAnswer = generateRagAnswerRef.fn;

    embedTextsRef.fn = async () => [[1, 1]];
    generateRagAnswerRef.fn = async (_question, sources) => `sources:${sources.map((source) => source.chunkId).join(',')}`;

    try {
      await ragStore.replaceChunks('51job', jobKey, [salaryChunk, locationChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingModel: 'test-embedding',
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 2,
        indexedChunkCount: 2,
      });

      const result = await answerQuestionWithRag({
        platform: '51job',
        jobKey,
        question: '薪资范围是多少？15K可以吗？',
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        topK: 2,
      });

      assert.deepStrictEqual(result.sources.map((source) => source.chunkId), ['salary', 'location']);
      assert.equal(result.answer, 'sources:salary,location');
      assert.equal(result.answered, true);
      assert.equal(typeof result.confidence, 'number');
      const logs = await ragStore.listAnswerLogs('51job', jobKey);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.question, '薪资范围是多少？15K可以吗？');
      assert.equal(logs[0]?.answer, 'sources:salary,location');
      assert.equal(logs[0]?.answered, true);
      assert.deepStrictEqual(logs[0]?.sources.map((source) => source.chunkId), ['salary', 'location']);
    } finally {
      embedTextsRef.fn = originalEmbedTexts;
      generateRagAnswerRef.fn = originalGenerateRagAnswer;
      restoreEnv();
    }
  });

  it('returns auditable no-answer when retrieval has no trusted context', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const jobKey = 'rag-answer-no-trusted-context';
    const unverifiedConversationChunk = {
      ...buildRagChunk('unverified', '交通补贴每月500元，待确认。'),
      jobKey,
      sourceType: 'conversation' as const,
      verified: false,
      conversationId: 'conv-1',
    };
    const vectorStore = new FixedSearchVectorStore([{
      chunk: unverifiedConversationChunk,
      score: 0.99,
    }]);
    const originalEmbedTexts = embedTextsRef.fn;
    const originalGenerateRagAnswer = generateRagAnswerRef.fn;
    let generateCalled = false;

    embedTextsRef.fn = async () => [[1, 1]];
    generateRagAnswerRef.fn = async () => {
      generateCalled = true;
      return 'should not be called';
    };

    try {
      await ragStore.replaceChunks('51job', jobKey, [unverifiedConversationChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingModel: 'test-embedding',
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 1,
        indexedChunkCount: 0,
      });

      const result = await answerQuestionWithRag({
        platform: '51job',
        jobKey,
        question: '交通补贴是多少？',
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });

      assert.equal(result.answered, false);
      assert.equal(result.noAnswerReason, 'no_trusted_context');
      assert.equal(result.answer.includes('未说明'), true);
      assert.deepStrictEqual(result.sources, []);
      assert.equal(generateCalled, false);
      const logs = await ragStore.listAnswerLogs('51job', jobKey);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.answered, false);
      assert.equal(logs[0]?.noAnswerReason, 'no_trusted_context');
    } finally {
      embedTextsRef.fn = originalEmbedTexts;
      generateRagAnswerRef.fn = originalGenerateRagAnswer;
      restoreEnv();
    }
  });

  it('returns no-answer instead of calling the model when confidence is below the threshold', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const originalMinConfidence = process.env.RAG_MIN_CONFIDENCE_SCORE;
    process.env.RAG_MIN_CONFIDENCE_SCORE = '10';
    const ragStore = new RagStore();
    const jobKey = 'rag-answer-low-confidence';
    const salaryChunk = {
      ...buildRagChunk('salary', '薪资范围：15-25K，13薪'),
      jobKey,
    };
    const vectorStore = new FixedSearchVectorStore([{
      chunk: salaryChunk,
      score: 0.5,
    }]);
    const originalEmbedTexts = embedTextsRef.fn;
    const originalGenerateRagAnswer = generateRagAnswerRef.fn;
    let generateCalled = false;

    embedTextsRef.fn = async () => [[1, 1]];
    generateRagAnswerRef.fn = async () => {
      generateCalled = true;
      return 'should not be called';
    };

    try {
      await ragStore.replaceChunks('51job', jobKey, [salaryChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingModel: 'test-embedding',
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 1,
        indexedChunkCount: 1,
      });

      const result = await answerQuestionWithRag({
        platform: '51job',
        jobKey,
        question: '薪资范围是多少？',
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });

      assert.equal(result.answered, false);
      assert.equal(result.noAnswerReason, 'low_confidence');
      assert.equal(result.answer.includes('未说明'), true);
      assert.deepStrictEqual(result.sources.map((source) => source.chunkId), ['salary']);
      assert.equal(generateCalled, false);
      const logs = await ragStore.listAnswerLogs('51job', jobKey);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.answered, false);
      assert.equal(logs[0]?.noAnswerReason, 'low_confidence');
    } finally {
      embedTextsRef.fn = originalEmbedTexts;
      generateRagAnswerRef.fn = originalGenerateRagAnswer;
      if (originalMinConfidence === undefined) {
        delete process.env.RAG_MIN_CONFIDENCE_SCORE;
      } else {
        process.env.RAG_MIN_CONFIDENCE_SCORE = originalMinConfidence;
      }
      restoreEnv();
    }
  });

  it('can disable answer logging for offline answer evaluation', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const ragStore = new RagStore();
    const jobKey = 'rag-answer-no-log';
    const salaryChunk = {
      ...buildRagChunk('salary', '薪资范围：15-25K，13薪'),
      jobKey,
    };
    const vectorStore = new FixedSearchVectorStore([{
      chunk: salaryChunk,
      score: 0.99,
    }]);
    const originalEmbedTexts = embedTextsRef.fn;
    const originalGenerateRagAnswer = generateRagAnswerRef.fn;

    embedTextsRef.fn = async () => [[1, 1]];
    generateRagAnswerRef.fn = async () => '该岗位薪资范围为15-25K。';

    try {
      await ragStore.replaceChunks('51job', jobKey, [salaryChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingModel: 'test-embedding',
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 1,
        indexedChunkCount: 1,
      });

      await answerQuestionWithRag({
        platform: '51job',
        jobKey,
        question: '薪资范围是多少？',
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        logAnswer: false,
      });

      assert.deepStrictEqual(await ragStore.listAnswerLogs('51job', jobKey), []);
    } finally {
      embedTextsRef.fn = originalEmbedTexts;
      generateRagAnswerRef.fn = originalGenerateRagAnswer;
      restoreEnv();
    }
  });

  it('reuses cached embeddings when reindexing unchanged chunks', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const jobStore = new JobStore();
    const ragStore = new RagStore();
    const vectorStore = new MemoryVectorStore();
    const jobKey = 'rag-embedding-cache';
    let embeddingCalls = 0;
    const embeddingProvider: RagEmbeddingProvider = {
      name: 'openai',
      async embedTexts(texts) {
        embeddingCalls += 1;
        return texts.map((_text, index) => [index + 1, 1]);
      },
    };

    try {
      await jobStore.saveJobRecord('51job', buildJobRecord(jobKey));
      await indexJobJd({
        platform: '51job',
        jobKey,
        jobStore,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        embeddingProvider,
      });
      const firstCacheRecords = await ragStore.listEmbeddingCacheRecords('51job', jobKey);
      await indexJobJd({
        platform: '51job',
        jobKey,
        jobStore,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        embeddingProvider,
      });
      const secondCacheRecords = await ragStore.listEmbeddingCacheRecords('51job', jobKey);

      assert.equal(embeddingCalls, 1);
      assert.ok(firstCacheRecords.length > 0);
      assert.equal(secondCacheRecords.length, firstCacheRecords.length);
      assert.ok(secondCacheRecords.every((record) => record.model === 'test-embedding'));
    } finally {
      restoreEnv();
    }
  });

  it('uses the embedding provider recorded in the manifest for questions', async () => {
    await makeTempDir();
    const restoreEnv = stubEmbeddingEnv();
    const originalLocalUrl = process.env.RAG_EMBEDDING_LOCAL_URL;
    process.env.RAG_EMBEDDING_LOCAL_URL = 'http://localhost:65535';
    const ragStore = new RagStore();
    const jobKey = 'rag-answer-provider';
    const chunk = {
      ...buildRagChunk('provider', '薪资范围：15-25K'),
      jobKey,
    };
    let observedProviderName = '';
    const vectorStore = new FixedSearchVectorStore([{
      chunk,
      score: 1,
    }]);
    const originalEmbedTexts = embedTextsRef.fn;
    const originalGenerateRagAnswer = generateRagAnswerRef.fn;

    embedTextsRef.fn = async (_texts, _model, provider) => {
      assert.ok(provider);
      observedProviderName = provider.name;
      return [[1, 1]];
    };
    generateRagAnswerRef.fn = async () => 'ok';

    try {
      await ragStore.replaceChunks('51job', jobKey, [chunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingProvider: 'local-http',
        embeddingModel: 'test-embedding',
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 1,
        indexedChunkCount: 1,
      });

      await answerQuestionWithRag({
        platform: '51job',
        jobKey,
        question: '薪资范围是多少？',
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
      });

      assert.equal(observedProviderName, 'local-http');
    } finally {
      embedTextsRef.fn = originalEmbedTexts;
      generateRagAnswerRef.fn = originalGenerateRagAnswer;
      if (originalLocalUrl === undefined) {
        delete process.env.RAG_EMBEDDING_LOCAL_URL;
      } else {
        process.env.RAG_EMBEDDING_LOCAL_URL = originalLocalUrl;
      }
      restoreEnv();
    }
  });
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  delete process.env.DATA_DIR;
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
