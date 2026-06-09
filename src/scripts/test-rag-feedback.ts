import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { buildAnswerLogId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import { buildAnswerEvalExportPayload } from './rag-export-answer-eval.js';
import { writeRagFeedback } from './rag-feedback.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-feedback-'));
  tempDirs.push(tempDir);
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
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
    jobKey: 'rag-feedback',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('RAG feedback writer', () => {
  it('updates one answer log by logId and preserves other logs', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const firstLog = buildLog();
    const secondLog = buildLog({
      question: '工作地点在哪里？',
      answer: '工作地点在上海。',
      createdAt: '2026-06-09T00:01:00.000Z',
    });
    await ragStore.appendAnswerLog('51job', 'rag-feedback', firstLog);
    await ragStore.appendAnswerLog('51job', 'rag-feedback', secondLog);
    const firstLogId = buildAnswerLogId(firstLog);

    const summary = await writeRagFeedback({
      platform: '51job',
      jobKey: 'rag-feedback',
      logId: firstLogId,
      correct: true,
      note: '回答准确',
      reviewer: 'recruiter-a',
      reviewedAt: '2026-06-09T01:00:00.000Z',
      ragStore,
    });
    const logs = await ragStore.listAnswerLogs('51job', 'rag-feedback');

    assert.equal(summary.logId, firstLogId);
    assert.equal(summary.feedback.correct, true);
    assert.equal(logs.length, 2);
    assert.equal(logs[0]?.logId, firstLogId);
    assert.deepStrictEqual(logs[0]?.feedback, {
      correct: true,
      note: '回答准确',
      reviewer: 'recruiter-a',
      reviewedAt: '2026-06-09T01:00:00.000Z',
    });
    assert.equal(logs[1]?.question, '工作地点在哪里？');
    assert.equal(logs[1]?.feedback, undefined);
  });

  it('updates by createdAt and fills logId for old logs', async () => {
    const tempDir = await makeTempDir();
    const ragStore = new RagStore();
    const oldLog = buildLog({
      createdAt: '2026-06-09T02:00:00.000Z',
    });
    const ragDir = path.join(tempDir, '51job', 'jobs', 'rag-feedback', 'rag');
    await fs.mkdir(ragDir, { recursive: true });
    await fs.writeFile(path.join(ragDir, 'answer-logs.jsonl'), `${JSON.stringify(oldLog)}\n`, 'utf8');

    const summary = await writeRagFeedback({
      platform: '51job',
      jobKey: 'rag-feedback',
      createdAt: '2026-06-09T02:00:00.000Z',
      correct: false,
      errorType: 'wrong_fact',
      note: '薪资说错',
      reviewedAt: '2026-06-09T02:10:00.000Z',
      ragStore,
    });
    const [log] = await ragStore.listAnswerLogs('51job', 'rag-feedback');

    assert.equal(summary.logId, buildAnswerLogId(oldLog));
    assert.equal(log?.logId, buildAnswerLogId(oldLog));
    assert.deepStrictEqual(log?.feedback, {
      correct: false,
      errorType: 'wrong_fact',
      note: '薪资说错',
      reviewedAt: '2026-06-09T02:10:00.000Z',
    });
  });

  it('writes error type for incorrect feedback', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const log = buildLog();
    await ragStore.appendAnswerLog('51job', 'rag-feedback', log);

    const summary = await writeRagFeedback({
      platform: '51job',
      jobKey: 'rag-feedback',
      logId: buildAnswerLogId(log),
      correct: false,
      errorType: 'unsupported_claim',
      note: '回答提到了资料里没有的福利',
      reviewedAt: '2026-06-09T02:20:00.000Z',
      ragStore,
    });
    const [storedLog] = await ragStore.listAnswerLogs('51job', 'rag-feedback');

    assert.equal(summary.feedback.errorType, 'unsupported_claim');
    assert.equal(storedLog?.feedback?.errorType, 'unsupported_claim');
  });

  it('rejects invalid or misplaced error types', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const log = buildLog();
    await ragStore.appendAnswerLog('51job', 'rag-feedback', log);

    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        logId: buildAnswerLogId(log),
        correct: false,
        errorType: 'typo' as never,
        ragStore,
      }),
      /--error-type must be one of/,
    );
    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        logId: buildAnswerLogId(log),
        correct: true,
        errorType: 'wrong_fact',
        ragStore,
      }),
      /--error-type is only valid/,
    );
  });

  it('rejects ambiguous question selector', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    await ragStore.appendAnswerLog('51job', 'rag-feedback', buildLog({
      createdAt: '2026-06-09T03:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('51job', 'rag-feedback', buildLog({
      createdAt: '2026-06-09T03:01:00.000Z',
    }));

    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        question: '薪资范围是多少？',
        correct: true,
        ragStore,
      }),
      /Selector matched 2 answer logs/,
    );
  });

  it('rejects missing and conflicting selectors', async () => {
    await makeTempDir();
    const ragStore = new RagStore();

    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        correct: true,
        ragStore,
      }),
      /Provide exactly one selector/,
    );
    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        logId: 'answer-log-a',
        createdAt: '2026-06-09T00:00:00.000Z',
        correct: true,
        ragStore,
      }),
      /Provide exactly one selector/,
    );
  });

  it('rejects no matching log', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    await ragStore.appendAnswerLog('51job', 'rag-feedback', buildLog());

    await assert.rejects(
      writeRagFeedback({
        platform: '51job',
        jobKey: 'rag-feedback',
        logId: 'answer-log-missing',
        correct: true,
        ragStore,
      }),
      /No answer log matched/,
    );
  });

  it('makes reviewed correct logs exportable as answer eval cases', async () => {
    await makeTempDir();
    const ragStore = new RagStore();
    const log = buildLog();
    await ragStore.appendAnswerLog('51job', 'rag-feedback', log);
    await writeRagFeedback({
      platform: '51job',
      jobKey: 'rag-feedback',
      logId: buildAnswerLogId(log),
      correct: true,
      reviewedAt: '2026-06-09T04:00:00.000Z',
      ragStore,
    });

    const output = buildAnswerEvalExportPayload(await ragStore.listAnswerLogs('51job', 'rag-feedback'));

    assert.equal(output.cases.length, 1);
    assert.equal(output.cases[0]?.id, buildAnswerLogId(log));
    assert.equal(output.cases[0]?.metadata?.logId, buildAnswerLogId(log));
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
