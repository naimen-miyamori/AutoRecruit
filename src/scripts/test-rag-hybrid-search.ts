import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hybridSearch } from '../rag/hybrid-search.js';
import type { RagChunk, RagVectorFilter } from '../rag/types.js';

function buildChunk(chunkId: string, text: string): RagChunk {
  return {
    platform: '51job',
    jobKey: 'hybrid-job',
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

const filter: RagVectorFilter = {
  platform: '51job',
  jobKey: 'hybrid-job',
  active: true,
  factOnly: true,
  sourceTypes: ['jd', 'conversation'],
};

describe('RAG hybrid search', () => {
  it('adds keyword matches when dense retrieval misses an exact fact', () => {
    const salaryChunk = buildChunk('salary', '薪资范围：15-25K，13薪');
    const locationChunk = buildChunk('location', '工作地点：上海');

    const results = hybridSearch({
      denseResults: [{
        chunk: locationChunk,
        score: 0.95,
      }],
      chunks: [salaryChunk, locationChunk],
      question: '薪资范围是多少？15K可以吗？',
      filter,
      limit: 2,
    });

    assert.deepStrictEqual(results.map((result) => result.chunk.chunkId), ['salary', 'location']);
  });

  it('keeps metadata filtering when adding keyword results', () => {
    const activeChunk = buildChunk('active', '英语可作为工作语言');
    const inactiveChunk = {
      ...buildChunk('inactive', '英语不是必须条件'),
      active: false,
    };

    const results = hybridSearch({
      denseResults: [],
      chunks: [activeChunk, inactiveChunk],
      question: '英语要求是什么？',
      filter,
      limit: 5,
    });

    assert.deepStrictEqual(results.map((result) => result.chunk.chunkId), ['active']);
  });
});
