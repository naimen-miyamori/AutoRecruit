import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { normalizeRagAnswerEvalCases } from '../rag/answer-eval.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import {
  buildAnswerEvalExportPayload,
  exportAnswerEvalFromLogs,
} from './rag-export-answer-eval.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-export-answer-eval-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function buildSource(overrides: Partial<RagAnswerSource> = {}): RagAnswerSource {
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

function buildLog(overrides: Partial<RagAnswerLogRecord> = {}): RagAnswerLogRecord {
  return {
    platform: '51job',
    jobKey: 'rag-export',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('RAG answer eval export from answer logs', () => {
  it('exports only verified feedback logs by default', () => {
    const output = buildAnswerEvalExportPayload([
      buildLog({
        question: '薪资范围是多少？',
        feedback: { correct: true, reviewedAt: '2026-06-09T01:00:00.000Z' },
      }),
      buildLog({
        question: '工作地点在哪里？',
        answer: '工作地点在上海。',
        feedback: { correct: false },
      }),
      buildLog({
        question: '需要出差吗？',
        answer: '该岗位需要出差。',
      }),
    ]);

    assert.equal(output.cases.length, 1);
    assert.equal(output.cases[0]?.question, '薪资范围是多少？');
    assert.deepStrictEqual(output.cases[0]?.expectedAnswerIncludes, ['这个岗位薪资范围是15-25K，13薪。']);
    assert.deepStrictEqual(output.cases[0]?.expectedSourceTypes, ['jd']);
    assert.deepStrictEqual(output.cases[0]?.expectedChunkIds, ['salary']);
    assert.equal(output.cases[0]?.metadata?.exportedFrom, 'answer-log');
    assert.equal(output.cases[0]?.metadata?.logId, output.cases[0]?.id);
    assert.doesNotThrow(() => normalizeRagAnswerEvalCases(output));
  });

  it('can include unreviewed logs and no-answer records when requested', () => {
    const output = buildAnswerEvalExportPayload([
      buildLog({
        question: '是否提供股票期权？',
        answer: '目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。',
        sources: [],
        answered: false,
        noAnswerReason: 'no_trusted_context',
      }),
      buildLog({
        question: '住宿补贴是多少？',
        answer: '每月800元住宿补贴。',
        sources: [buildSource({
          sourceType: 'conversation',
          sourceId: 'conversation-hiring-policy',
          chunkId: 'conversation-hiring-policy-turn-2',
          conversationId: 'hiring-policy',
          text: '每月800元住宿补贴。',
        })],
        answered: true,
      }),
    ], {
      onlyFeedback: false,
      includeNoAnswer: true,
    });

    assert.equal(output.cases.length, 2);
    assert.equal(output.cases[0]?.expectNoAnswer, true);
    assert.deepStrictEqual(output.cases[0]?.expectedNoAnswerIncludes, ['未说明']);
    assert.deepStrictEqual(output.cases[1]?.expectedSourceTypes, ['conversation']);
    assert.deepStrictEqual(output.cases[1]?.expectedConversationIds, ['hiring-policy']);
    assert.doesNotThrow(() => normalizeRagAnswerEvalCases(output));
  });

  it('can export source-derived key facts instead of the full answer', () => {
    const output = buildAnswerEvalExportPayload([
      buildLog({
        question: '薪资和福利是什么？',
        answer: '这个岗位薪资是15-25K，13薪，并提供五险一金。',
        sources: [buildSource({
          text: '薪资范围：15-25K，13薪。福利：五险一金。补充信息：季度团建。',
        })],
        feedback: { correct: true },
      }),
    ], {
      expectedTextMode: 'source',
    });

    assert.deepStrictEqual(output.cases[0]?.expectedAnswerIncludes, [
      '薪资范围：15-25K，13薪',
      '福利：五险一金',
    ]);
    assert.equal(output.cases[0]?.metadata?.expectedTextMode, 'source');
    assert.equal(output.cases[0]?.metadata?.draft, true);
    assert.equal(output.cases[0]?.metadata?.expectedTextNeedsReview, true);
    assert.match(output.cases[0]?.metadata?.expectedTextReviewNote ?? '', /Source-derived/);
    assert.doesNotThrow(() => normalizeRagAnswerEvalCases(output));
  });

  it('falls back to the full answer in hybrid mode when sources cannot be matched', () => {
    const output = buildAnswerEvalExportPayload([
      buildLog({
        question: '上班地点在哪里？',
        answer: '工作地点在上海。',
        sources: [buildSource({
          text: '候选人需要能接受门店轮班。',
        })],
        feedback: { correct: true },
      }),
    ], {
      expectedTextMode: 'hybrid',
    });

    assert.deepStrictEqual(output.cases[0]?.expectedAnswerIncludes, ['工作地点在上海。']);
    assert.equal(output.cases[0]?.metadata?.expectedTextMode, 'hybrid');
    assert.match(output.cases[0]?.metadata?.expectedTextReviewNote ?? '', /fallback/);
    assert.doesNotThrow(() => normalizeRagAnswerEvalCases(output));
  });

  it('writes exported answer eval cases to the requested file', async () => {
    const tempDir = await makeTempDir();
    process.env.DATA_DIR = tempDir;
    (config as { dataDir: string }).dataDir = tempDir;
    const outputPath = path.join(tempDir, 'answer-eval.json');
    const ragStore = new RagStore();
    await ragStore.appendAnswerLog('51job', 'rag-export', buildLog({
      feedback: { correct: true },
    }));
    await ragStore.appendAnswerLog('51job', 'rag-export', buildLog({
      question: '未审核问题',
      answer: '未审核回答。',
    }));

    const summary = await exportAnswerEvalFromLogs({
      platform: '51job',
      jobKey: 'rag-export',
      outputPath,
      expectedTextMode: 'source',
      ragStore,
    });
    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8')) as unknown;

    assert.equal(summary.logCount, 2);
    assert.equal(summary.exportedCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.expectedTextMode, 'source');
    assert.equal(summary.draftCount, 1);
    assert.equal(summary.needsReviewCount, 1);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(normalizeRagAnswerEvalCases(payload).length, 1);
  });
});

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  if (originalDataDirEnv === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDirEnv;
  }
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
