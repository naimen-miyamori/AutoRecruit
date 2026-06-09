import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateRagAnswers, normalizeRagAnswerEvalCases } from '../rag/answer-eval.js';
import type { RagAnswer, RagAnswerSource } from '../rag/types.js';

function buildSource(overrides: Partial<RagAnswerSource>): RagAnswerSource {
  return {
    id: 'salary',
    label: 'JD',
    text: '薪资范围：15-25K，13薪',
    score: 0.9,
    sourceType: 'jd',
    sourceId: 'jd-active',
    chunkId: 'salary',
    verified: true,
    active: true,
    ...overrides,
  };
}

describe('RAG answer eval', () => {
  it('normalizes answer eval files from arrays or cases wrappers', () => {
    assert.deepStrictEqual(normalizeRagAnswerEvalCases([{
      id: 'salary',
      question: '薪资范围是多少？',
      expectedAnswerIncludes: ['15-25K'],
      expectedSourceTypes: ['jd'],
    }]), [{
      id: 'salary',
      question: '薪资范围是多少？',
      expectedAnswerIncludes: ['15-25K'],
      forbiddenAnswerIncludes: undefined,
      expectedSourceTypes: ['jd'],
      expectedChunkIds: undefined,
      expectedConversationIds: undefined,
      expectNoAnswer: undefined,
      expectedNoAnswerIncludes: undefined,
    }]);
    assert.equal(normalizeRagAnswerEvalCases({ cases: [{
      question: '有没有住宿？',
      expectedAnswerIncludes: ['住宿补贴'],
    }] }).length, 1);
    assert.throws(
      () => normalizeRagAnswerEvalCases([]),
      /at least one case/,
    );
    assert.throws(
      () => normalizeRagAnswerEvalCases([{ question: '没有期望项' }]),
      /at least one expectation/,
    );
    assert.throws(
      () => normalizeRagAnswerEvalCases([{ question: '来源错误', expectedSourceTypes: ['unknown'] }]),
      /unsupported source type/,
    );
  });

  it('evaluates final answers and cited sources', async () => {
    const answers = new Map<string, RagAnswer>([
      ['薪资范围是多少？', {
        answer: '这个岗位薪资范围是15-25K，13薪。',
        sources: [buildSource({ chunkId: 'salary', sourceType: 'jd' })],
      }],
      ['公司是否提供股票期权？', {
        answer: '当前 JD 和已确认历史答复中未说明股票期权信息，建议与招聘方确认。',
        sources: [],
      }],
    ]);

    const summary = await evaluateRagAnswers({
      platform: '51job',
      jobKey: 'rag-answer-eval-pass',
      cases: [
        {
          id: 'salary',
          question: '薪资范围是多少？',
          expectedAnswerIncludes: ['15-25K'],
          forbiddenAnswerIncludes: ['30K', '面议'],
          expectedSourceTypes: ['jd'],
          expectedChunkIds: ['salary'],
        },
        {
          id: 'stock',
          question: '公司是否提供股票期权？',
          expectNoAnswer: true,
          expectedNoAnswerIncludes: ['未说明'],
          forbiddenAnswerIncludes: ['提供股票期权', '有期权'],
        },
      ],
      answerQuestion: async ({ question }) => {
        const answer = answers.get(question);
        if (!answer) {
          throw new Error(`Unexpected question: ${question}`);
        }
        return answer;
      },
    });

    assert.equal(summary.caseCount, 2);
    assert.equal(summary.failedCount, 0);
    assert.equal(summary.metrics.passRate, 1);
    assert.equal(summary.metrics.answerTextAccuracy, 1);
    assert.equal(summary.metrics.sourceTypeAccuracy, 1);
    assert.equal(summary.metrics.noAnswerAccuracy, 1);
    assert.deepStrictEqual(summary.cases[0]?.sources.map((source) => source.chunkId), ['salary']);
    assert.equal(summary.cases[1]?.checks.expectedNoAnswerIncludes?.passed, true);
  });

  it('reports failed answer text and source expectations', async () => {
    const summary = await evaluateRagAnswers({
      platform: '51job',
      jobKey: 'rag-answer-eval-fail',
      cases: [{
        id: 'salary',
        question: '薪资范围是多少？',
        expectedAnswerIncludes: ['15-25K'],
        forbiddenAnswerIncludes: ['面议'],
        expectedSourceTypes: ['jd'],
        expectedChunkIds: ['salary'],
      }],
      answerQuestion: async () => ({
        answer: '这个岗位薪资面议。',
        sources: [buildSource({
          chunkId: 'location',
          sourceType: 'conversation',
          sourceId: 'conversation-conv-1',
          conversationId: 'conv-1',
          text: '工作地点：上海',
        })],
      }),
    });

    assert.equal(summary.failedCount, 1);
    assert.equal(summary.metrics.passRate, 0);
    assert.deepStrictEqual(summary.cases[0]?.checks.expectedAnswerIncludes?.missing, ['15-25K']);
    assert.deepStrictEqual(summary.cases[0]?.checks.forbiddenAnswerIncludes?.presentForbidden, ['面议']);
    assert.deepStrictEqual(summary.cases[0]?.checks.expectedSourceTypes?.missing, ['jd']);
    assert.deepStrictEqual(summary.cases[0]?.checks.expectedChunkIds?.missing, ['salary']);
    assert.deepStrictEqual(summary.cases[0]?.sources.map((source) => source.chunkId), ['location']);
  });
});
