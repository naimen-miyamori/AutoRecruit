import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { evaluateRagJob, normalizeRagEvalCases } from '../rag/eval.js';
import { inspectEmbedTextsRef } from '../rag/inspect.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagEmbeddingProvider } from '../rag/embeddings.js';
import type {
  RagChunk,
  RagEmbeddedChunk,
  RagQueryResult,
  RagVectorFilter,
  RagVectorStore,
} from '../rag/types.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-eval-'));
  tempDirs.push(tempDir);
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
  return tempDir;
}

function buildChunk(overrides: Partial<RagChunk>): RagChunk {
  return {
    platform: '51job',
    jobKey: 'rag-eval',
    chunkId: 'chunk',
    sourceId: 'source',
    sourceType: 'jd',
    text: '职位信息',
    active: true,
    verified: true,
    contentHash: 'hash',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

class FixedSearchVectorStore implements RagVectorStore {
  readonly kind = 'fixed';

  constructor(private readonly resultsByQuestion: Map<string, RagQueryResult[]>) {}

  async ensureCollection(_embeddingDim: number): Promise<void> {
    return undefined;
  }

  async upsert(_chunks: RagEmbeddedChunk[]): Promise<void> {
    return undefined;
  }

  async search(embedding: number[], _filter: RagVectorFilter, _limit: number): Promise<RagQueryResult[]> {
    const questionId = String(embedding[0] ?? 0);
    return this.resultsByQuestion.get(questionId) ?? [];
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

describe('RAG eval', () => {
  it('normalizes eval files from arrays or cases wrappers', () => {
    assert.deepStrictEqual(normalizeRagEvalCases([{
      id: 'salary',
      question: '薪资范围是多少？',
      expectedTextIncludes: ['15-25K'],
      expectedSourceTypes: ['jd'],
    }]), [{
      id: 'salary',
      question: '薪资范围是多少？',
      expectedTextIncludes: ['15-25K'],
      expectedSourceTypes: ['jd'],
      expectedChunkIds: undefined,
      expectedConversationIds: undefined,
      expectNoAnswer: undefined,
      forbiddenTextIncludes: undefined,
      unexpectedTextIncludes: undefined,
      maxHybridResults: undefined,
    }]);
    assert.equal(normalizeRagEvalCases({ cases: [{
      question: '有没有住宿？',
      expectedTextIncludes: ['住宿补贴'],
    }] }).length, 1);
    assert.throws(
      () => normalizeRagEvalCases([{ question: '没有期望项' }]),
      /at least one expectation/,
    );
    assert.throws(
      () => normalizeRagEvalCases([]),
      /at least one case/,
    );
    assert.throws(
      () => normalizeRagEvalCases([{ question: '来源错误', expectedSourceTypes: ['unknown'] }]),
      /unsupported source type/,
    );
  });

  it('evaluates retrieval hits, source types, and no-answer checks', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const jobKey = 'rag-eval-pass';
    const salaryChunk = buildChunk({
      jobKey,
      chunkId: 'salary',
      sourceId: 'jd-active',
      sourceType: 'jd',
      text: '薪资范围：15-25K，13薪',
    });
    const housingChunk = buildChunk({
      jobKey,
      chunkId: 'housing',
      sourceId: 'conversation-conv-1',
      sourceType: 'conversation',
      text: '可以提供住宿补贴。',
      conversationId: 'conv-1',
      speaker: 'recruiter',
      verified: true,
    });
    const vectorStore = new FixedSearchVectorStore(new Map([
      ['1', [{ chunk: salaryChunk, score: 0.9 }]],
      ['2', [{ chunk: housingChunk, score: 0.9 }]],
      ['3', []],
    ]));
    const originalEmbedTexts = inspectEmbedTextsRef.fn;
    inspectEmbedTextsRef.fn = async (texts) => texts.map((text) => {
      if (text.includes('住宿')) {
        return [2, 1];
      }
      if (text.includes('股票')) {
        return [3, 1];
      }
      return [1, 1];
    });

    try {
      await ragStore.replaceChunks('51job', jobKey, [salaryChunk, housingChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingProvider: 'openai',
        embeddingModel: 'test-embedding',
        embeddingDim: 2,
        vectorStore: 'fixed',
        sourceCount: 2,
        chunkCount: 2,
        indexedChunkCount: 2,
      });

      const summary = await evaluateRagJob({
        platform: '51job',
        jobKey,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        embeddingProvider,
        topK: 2,
        cases: [
          {
            id: 'salary',
            question: '薪资范围是多少？',
            expectedTextIncludes: ['15-25K'],
            expectedSourceTypes: ['jd'],
            expectedChunkIds: ['salary'],
          },
          {
            id: 'housing',
            question: '有没有住宿补贴？',
            expectedTextIncludes: ['住宿补贴'],
            expectedSourceTypes: ['conversation'],
            expectedConversationIds: ['conv-1'],
          },
          {
            id: 'stock',
            question: '公司是否提供股票期权？',
            expectNoAnswer: true,
            unexpectedTextIncludes: ['股票期权'],
          },
        ],
      });

      assert.equal(summary.caseCount, 3);
      assert.equal(summary.failedCount, 0);
      assert.equal(summary.metrics.hitRate, 1);
      assert.equal(summary.metrics.recallAtK, 1);
      assert.equal(summary.metrics.sourceTypeAccuracy, 1);
      assert.equal(summary.metrics.noAnswerAccuracy, 1);
      assert.deepStrictEqual(summary.cases[0]?.retrieval.hybridChunkIds, ['salary']);
      assert.deepStrictEqual(summary.cases[1]?.retrieval.hybridChunkIds, ['housing']);
      assert.equal(summary.cases[2]?.checks.noAnswer?.passed, true);
    } finally {
      inspectEmbedTextsRef.fn = originalEmbedTexts;
    }
  });

  it('reports failed expectations with retrieval evidence', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const jobKey = 'rag-eval-fail';
    const locationChunk = buildChunk({
      jobKey,
      chunkId: 'location',
      sourceId: 'jd-active',
      sourceType: 'jd',
      text: '工作地点：上海',
    });
    const vectorStore = new FixedSearchVectorStore(new Map([
      ['1', [{ chunk: locationChunk, score: 0.9 }]],
    ]));
    const originalEmbedTexts = inspectEmbedTextsRef.fn;
    inspectEmbedTextsRef.fn = async () => [[1, 1]];

    try {
      await ragStore.replaceChunks('51job', jobKey, [locationChunk]);
      await ragStore.saveManifest('51job', jobKey, {
        platform: '51job',
        jobKey,
        updatedAt: '2026-06-01T00:00:00.000Z',
        embeddingProvider: 'openai',
        embeddingModel: 'test-embedding',
        embeddingDim: 2,
        vectorStore: 'fixed',
        sourceCount: 1,
        chunkCount: 1,
        indexedChunkCount: 1,
      });

      const summary = await evaluateRagJob({
        platform: '51job',
        jobKey,
        ragStore,
        vectorStore,
        embeddingModel: 'test-embedding',
        embeddingProvider,
        topK: 1,
        cases: [{
          id: 'salary',
          question: '薪资范围是多少？',
          expectedTextIncludes: ['15-25K'],
          expectedChunkIds: ['salary'],
          forbiddenTextIncludes: ['上海'],
        }],
      });

      assert.equal(summary.failedCount, 1);
      assert.equal(summary.metrics.hitRate, 0);
      assert.deepStrictEqual(summary.cases[0]?.checks.expectedTextIncludes?.missing, ['15-25K']);
      assert.deepStrictEqual(summary.cases[0]?.checks.expectedChunkIds?.missing, ['salary']);
      assert.deepStrictEqual(summary.cases[0]?.checks.forbiddenTextIncludes?.presentForbidden, ['上海']);
      assert.deepStrictEqual(summary.cases[0]?.retrieval.hybridChunkIds, ['location']);
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
