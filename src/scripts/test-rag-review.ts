import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { buildAnswerLogId } from '../rag/answer-logs.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import {
  buildRagReviewReport,
  renderRagReviewMarkdown,
  writeRagReview,
} from './rag-review.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-review-'));
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
    jobKey: 'rag-review',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('RAG review report', () => {
  it('prioritizes actionable answer logs and excludes reviewed-correct logs by default', () => {
    const reviewedCorrect = buildLog({
      question: '已确认正确的问题',
      feedback: { correct: true, reviewedAt: '2026-06-09T01:00:00.000Z' },
    });
    const unreviewed = buildLog({
      question: '普通未审核问题',
      createdAt: '2026-06-09T00:01:00.000Z',
    });
    const noAnswer = buildLog({
      question: '是否提供股票期权？',
      answer: '目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。',
      answered: false,
      noAnswerReason: 'no_trusted_context',
      sources: [],
      createdAt: '2026-06-09T00:02:00.000Z',
    });
    const lowConfidence = buildLog({
      question: '低置信回答',
      confidence: 0.1,
      createdAt: '2026-06-09T00:03:00.000Z',
    });
    const missingSources = buildLog({
      question: '无来源回答',
      sources: [],
      createdAt: '2026-06-09T00:04:00.000Z',
    });
    const reviewedIncorrect = buildLog({
      question: '已标错回答',
      feedback: { correct: false, note: '薪资说错' },
      createdAt: '2026-06-09T00:05:00.000Z',
    });

    const report = buildRagReviewReport({
      platform: '51job',
      jobKey: 'rag-review',
      logs: [
        reviewedCorrect,
        unreviewed,
        noAnswer,
        lowConfidence,
        missingSources,
        reviewedIncorrect,
      ].map((log) => ({ ...log, logId: buildAnswerLogId(log) })),
      lowConfidenceThreshold: 0.3,
      generatedAt: '2026-06-09T02:00:00.000Z',
    });

    assert.equal(report.totalLogCount, 6);
    assert.equal(report.itemCount, 5);
    assert.equal(report.counts.reviewedCorrect, 1);
    assert.equal(report.counts.reviewedIncorrect, 1);
    assert.equal(report.counts.noAnswer, 1);
    assert.equal(report.counts.lowConfidence, 1);
    assert.equal(report.counts.missingSources, 1);
    assert.equal(report.counts.missingErrorType, 1);
    assert.deepStrictEqual(report.items[0]?.reasons, ['reviewed_incorrect', 'missing_error_type']);
    assert.deepStrictEqual(report.items.map((item) => item.question), [
      '已标错回答',
      '是否提供股票期权？',
      '无来源回答',
      '低置信回答',
      '普通未审核问题',
    ]);
    assert.equal(report.items.some((item) => item.question === '已确认正确的问题'), false);
  });

  it('can include reviewed-correct logs when requested', () => {
    const log = buildLog({
      question: '已确认正确的问题',
      feedback: { correct: true },
    });
    const report = buildRagReviewReport({
      platform: '51job',
      jobKey: 'rag-review',
      logs: [{ ...log, logId: buildAnswerLogId(log) }],
      includeReviewed: true,
    });

    assert.equal(report.itemCount, 1);
    assert.equal(report.items[0]?.status, 'reviewed_correct');
    assert.deepStrictEqual(report.items[0]?.reasons, ['reviewed_correct']);
  });

  it('renders markdown with copyable feedback commands', () => {
    const log = buildLog({
      question: '这个岗位有住宿补贴吗？',
      createdAt: '2026-06-09T03:00:00.000Z',
    });
    const logId = buildAnswerLogId(log);
    const report = buildRagReviewReport({
      platform: '51job',
      jobKey: '东南亚 销售',
      logs: [{ ...log, logId }],
      reviewer: 'reviewer-a',
      generatedAt: '2026-06-09T04:00:00.000Z',
    });

    const markdown = renderRagReviewMarkdown(report);

    assert.match(markdown, /# RAG Review: 51job\/东南亚 销售/);
    assert.match(markdown, /这个岗位有住宿补贴吗？/);
    assert.match(markdown, new RegExp(logId));
    assert.match(markdown, /rtk npm run rag:feedback/);
    assert.match(markdown, /--correct true/);
    assert.match(markdown, /--correct false/);
    assert.match(markdown, /--error-type other/);
    assert.match(markdown, /--reviewer reviewer-a/);
  });

  it('renders existing feedback error types', () => {
    const log = buildLog({
      question: '这个岗位是否远程办公？',
      feedback: {
        correct: false,
        errorType: 'unsupported_claim',
        note: '回答引用了资料里没有的信息',
      },
      createdAt: '2026-06-09T03:30:00.000Z',
    });
    const report = buildRagReviewReport({
      platform: '51job',
      jobKey: '东南亚 销售',
      logs: [{ ...log, logId: buildAnswerLogId(log) }],
    });

    const markdown = renderRagReviewMarkdown(report);

    assert.match(markdown, /errorType=unsupported_claim/);
  });

  it('renders missing error type counts and fill commands for old incorrect feedback', () => {
    const log = buildLog({
      question: '旧日志缺少错误类型',
      feedback: {
        correct: false,
        note: '历史标错',
      },
      createdAt: '2026-06-09T03:40:00.000Z',
    });
    const logId = buildAnswerLogId(log);
    const report = buildRagReviewReport({
      platform: '51job',
      jobKey: '东南亚 销售',
      logs: [{ ...log, logId }],
      reviewer: 'reviewer-a',
    });

    const markdown = renderRagReviewMarkdown(report);

    assert.equal(report.counts.missingErrorType, 1);
    assert.deepStrictEqual(report.items[0]?.reasons, ['reviewed_incorrect', 'missing_error_type']);
    assert.equal(report.items[0]?.feedbackCommands.fillErrorType?.includes('--error-type other'), true);
    assert.match(markdown, /Missing error types: 1/);
    assert.match(markdown, /Fill missing error type/);
    assert.match(markdown, /--error-type other/);
  });

  it('writes markdown or JSON review files from stored answer logs', async () => {
    const tempDir = await makeTempDir();
    const ragStore = new RagStore();
    await ragStore.appendAnswerLog('51job', 'rag-review', buildLog());
    await ragStore.appendAnswerLog('51job', 'rag-review', buildLog({
      question: '已确认正确的问题',
      feedback: { correct: true },
      createdAt: '2026-06-09T03:01:00.000Z',
    }));
    const markdownPath = path.join(tempDir, 'rag-review.md');
    const jsonPath = path.join(tempDir, 'rag-review.json');

    const markdownResult = await writeRagReview({
      platform: '51job',
      jobKey: 'rag-review',
      outputPath: markdownPath,
      ragStore,
    });
    const jsonResult = await writeRagReview({
      platform: '51job',
      jobKey: 'rag-review',
      format: 'json',
      outputPath: jsonPath,
      includeReviewed: true,
      ragStore,
    });
    const markdown = await fs.readFile(markdownPath, 'utf8');
    const json = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as { itemCount?: number };

    assert.equal(markdownResult.report.itemCount, 1);
    assert.equal(jsonResult.report.itemCount, 2);
    assert.match(markdown, /Review items: 1/);
    assert.equal(json.itemCount, 2);
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
