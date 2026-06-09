import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AskRagQuestionOptions, IngestConversationOptions } from '../rag/service.js';
import type { RagAnswer } from '../rag/types.js';
import {
  handleRagApiRequest,
  resolveRagApiConfig,
} from './rag-api.js';

function buildAnswer(overrides: Partial<RagAnswer> = {}): RagAnswer {
  return {
    answer: '这个岗位薪资范围是15-25K，13薪。',
    answered: true,
    confidence: 0.9,
    sources: [{
      id: 'salary',
      label: 'JD',
      text: '薪资范围：15-25K，13薪',
      score: 0.9,
      sourceType: 'jd',
      sourceId: 'jd-active',
      chunkId: 'salary',
      verified: true,
      active: true,
    }],
    ...overrides,
  };
}

describe('RAG product API', () => {
  it('resolves safe default API configuration', () => {
    const config = resolveRagApiConfig();

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3978);
    assert.equal(config.maxBodyBytes, 1024 * 1024);
  });

  it('returns health status', async () => {
    const response = await handleRagApiRequest({
      method: 'GET',
      pathname: '/health',
    });

    assert.equal(response.statusCode, 200);
    assert.deepStrictEqual(response.body, {
      status: 'ok',
      service: 'rag-api',
    });
  });

  it('requires bearer auth when configured', async () => {
    const unauthorized = await handleRagApiRequest({
      method: 'GET',
      pathname: '/health',
      config: { apiKey: 'secret' },
    });
    const authorized = await handleRagApiRequest({
      method: 'GET',
      pathname: '/health',
      headers: { authorization: 'Bearer secret' },
      config: { apiKey: 'secret' },
    });

    assert.equal(unauthorized.statusCode, 401);
    assert.equal((unauthorized.body as { error?: { code?: string } }).error?.code, 'unauthorized');
    assert.equal(authorized.statusCode, 200);
  });

  it('answers RAG questions through the product API', async () => {
    const calls: AskRagQuestionOptions[] = [];
    const response = await handleRagApiRequest({
      method: 'POST',
      pathname: '/v1/rag/answer',
      body: {
        platform: '51job',
        keyword: '优衣库 店长',
        question: '薪资是多少？',
        topK: 3,
        autoIndex: false,
        logAnswer: false,
        metadata: {
          externalConversationId: 'conv-1',
        },
      },
      answerQuestion: async (options) => {
        calls.push(options);
        return buildAnswer();
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.platform, '51job');
    assert.equal(calls[0]?.jobKey, '优衣库-店长');
    assert.equal(calls[0]?.question, '薪资是多少？');
    assert.equal(calls[0]?.topK, 3);
    assert.equal(calls[0]?.autoIndex, false);
    assert.equal(calls[0]?.logAnswer, false);
    assert.deepStrictEqual(calls[0]?.answerLogMetadata, {
      externalConversationId: 'conv-1',
    });
    assert.equal((response.body as { answer?: string }).answer, '这个岗位薪资范围是15-25K，13薪。');
  });

  it('ingests verified conversations through the product API', async () => {
    const calls: IngestConversationOptions[] = [];
    const response = await handleRagApiRequest({
      method: 'POST',
      pathname: '/v1/rag/conversations',
      body: {
        platform: 'liepin',
        jobKey: 'store-manager',
        conversationId: 'conv-1',
        turns: [
          {
            id: 'turn-1',
            role: 'candidate',
            content: '有住宿补贴吗？',
          },
          {
            id: 'turn-2',
            role: 'recruiter',
            content: '每月800元住宿补贴。',
            verified: true,
          },
        ],
      },
      ingestConversationFn: async (options) => {
        calls.push(options);
        return {
          platform: options.platform,
          jobKey: options.jobKey,
          conversationId: options.conversationId,
          indexedChunkCount: 1,
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.platform, 'liepin');
    assert.equal(calls[0]?.jobKey, 'store-manager');
    assert.equal(calls[0]?.conversationId, 'conv-1');
    assert.equal(calls[0]?.turns.length, 2);
    assert.equal(calls[0]?.turns[1]?.verified, true);
    assert.equal((response.body as { verifiedTurnCount?: number }).verifiedTurnCount, 1);
  });

  it('returns validation errors as JSON 400 responses', async () => {
    const response = await handleRagApiRequest({
      method: 'POST',
      pathname: '/v1/rag/answer',
      body: {
        platform: '51job',
        question: '缺少职位',
      },
      answerQuestion: async () => buildAnswer(),
    });

    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: { message?: string } }).error?.message ?? '', /jobKey or keyword/);
  });
});
