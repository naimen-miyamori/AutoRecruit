import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import {
  normalizeReviewBatchItem,
  readReviewBatchFile,
  renderRagReviewBatchMarkdown,
  reviewRagBatch,
  writeRagReviewBatch,
} from './rag-review-batch.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-review-batch-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function useTempDataDir(): Promise<string> {
  const tempDir = await makeTempDir();
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
  return tempDir;
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
    jobKey: 'rag-review-batch',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('RAG review batch', () => {
  it('normalizes batch items and derives job keys from keywords', () => {
    const item = normalizeReviewBatchItem({
      platform: '51job',
      keyword: '优衣库 店长',
    }, 0);

    assert.equal(item.platform, '51job');
    assert.equal(item.jobKey, '优衣库-店长');
    assert.throws(
      () => normalizeReviewBatchItem({ platform: '51job' }, 0),
      /jobKey or keyword/,
    );
    assert.throws(
      () => normalizeReviewBatchItem({ jobKey: 'x' }, 0),
      /platform must be a non-empty string/,
    );
  });

  it('reads JSON arrays, items wrappers, and JSONL rows', async () => {
    const tempDir = await makeTempDir();
    const arrayPath = path.join(tempDir, 'array.json');
    const wrapperPath = path.join(tempDir, 'wrapper.json');
    const jsonlPath = path.join(tempDir, 'jobs.jsonl');

    await writeJsonFile(arrayPath, [{ platform: '51job', jobKey: '优衣库' }]);
    await writeJsonFile(wrapperPath, { items: [{ platform: 'liepin', jobKey: '销售经理' }] });
    await fs.writeFile(jsonlPath, [
      JSON.stringify({ platform: 'zhilian', jobKey: '运营' }),
      JSON.stringify({ platform: '51job', keyword: '门店 店长' }),
    ].join('\n'), 'utf8');

    const arrayItems = await readReviewBatchFile(arrayPath);
    const wrapperItems = await readReviewBatchFile(wrapperPath);
    const jsonlItems = await readReviewBatchFile(jsonlPath);

    assert.equal(arrayItems[0]?.jobKey, '优衣库');
    assert.equal(wrapperItems[0]?.platform, 'liepin');
    assert.equal(jsonlItems.length, 2);
    assert.equal(jsonlItems[0]?.sourceLine, 1);
    assert.equal(jsonlItems[1]?.jobKey, '门店-店长');
  });

  it('summarizes stored answer logs across jobs', async () => {
    const tempDir = await useTempDataDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [
      { platform: '51job', jobKey: 'needs-review' },
      { platform: 'liepin', jobKey: 'ok-job' },
      { platform: 'zhilian', jobKey: 'empty-job' },
    ]);
    await ragStore.appendAnswerLog('51job', 'needs-review', buildLog({
      platform: '51job',
      jobKey: 'needs-review',
      question: '未审核问题',
    }));
    await ragStore.appendAnswerLog('51job', 'needs-review', buildLog({
      platform: '51job',
      jobKey: 'needs-review',
      question: '无来源问题',
      sources: [],
      createdAt: '2026-06-09T00:01:00.000Z',
    }));
    await ragStore.appendAnswerLog('liepin', 'ok-job', buildLog({
      platform: 'liepin',
      jobKey: 'ok-job',
      question: '已审核正确问题',
      feedback: { correct: true },
    }));

    const summary = await reviewRagBatch({ filePath, ragStore });

    assert.equal(summary.status, 'needs_review');
    assert.equal(summary.itemCount, 3);
    assert.equal(summary.okCount, 2);
    assert.equal(summary.needsReviewCount, 1);
    assert.equal(summary.failedCount, 0);
    assert.equal(summary.totals.totalLogCount, 3);
    assert.equal(summary.totals.reviewItemCount, 2);
    assert.equal(summary.totals.unreviewed, 2);
    assert.equal(summary.totals.reviewedCorrect, 1);
    assert.equal(summary.totals.missingSources, 1);
    assert.equal(summary.totals.missingErrorType, 0);
    assert.equal(summary.results[0]?.status, 'needs_review');
    assert.equal(summary.results[1]?.status, 'ok');
    assert.equal(summary.results[2]?.status, 'ok');
  });

  it('renders markdown with batch summary and nested job review items', async () => {
    const tempDir = await useTempDataDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'needs-review' }]);
    await ragStore.appendAnswerLog('51job', 'needs-review', buildLog({
      platform: '51job',
      jobKey: 'needs-review',
      question: '这个岗位有住宿补贴吗？',
    }));

    const markdown = renderRagReviewBatchMarkdown(await reviewRagBatch({ filePath, ragStore }));

    assert.match(markdown, /# RAG Review Batch/);
    assert.match(markdown, /Jobs needing review: 1/);
    assert.match(markdown, /51job \/ needs-review/);
    assert.match(markdown, /这个岗位有住宿补贴吗？/);
    assert.match(markdown, /rtk npm run rag:feedback/);
  });

  it('summarizes missing error types for old incorrect feedback', async () => {
    const tempDir = await useTempDataDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'needs-error-type' }]);
    await ragStore.appendAnswerLog('51job', 'needs-error-type', buildLog({
      platform: '51job',
      jobKey: 'needs-error-type',
      question: '旧标错日志',
      feedback: { correct: false, note: '历史标错' },
    }));

    const summary = await reviewRagBatch({ filePath, ragStore });
    const markdown = renderRagReviewBatchMarkdown(summary);

    assert.equal(summary.totals.reviewedIncorrect, 1);
    assert.equal(summary.totals.missingErrorType, 1);
    assert.equal(summary.results[0]?.counts?.missingErrorType, 1);
    assert.match(markdown, /Missing error types: 1/);
    assert.match(markdown, /Fill missing error type/);
  });

  it('writes markdown and JSON outputs', async () => {
    const tempDir = await useTempDataDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const markdownPath = path.join(tempDir, 'review.md');
    const jsonPath = path.join(tempDir, 'review.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'needs-review' }]);
    await ragStore.appendAnswerLog('51job', 'needs-review', buildLog({
      platform: '51job',
      jobKey: 'needs-review',
    }));

    const markdownResult = await writeRagReviewBatch({
      filePath,
      outputPath: markdownPath,
      ragStore,
    });
    const jsonResult = await writeRagReviewBatch({
      filePath,
      format: 'json',
      outputPath: jsonPath,
      ragStore,
    });
    const markdown = await fs.readFile(markdownPath, 'utf8');
    const json = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as { status?: string };

    assert.equal(markdownResult.summary.status, 'needs_review');
    assert.equal(jsonResult.summary.status, 'needs_review');
    assert.match(markdown, /Review items: 1/);
    assert.equal(json.status, 'needs_review');
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
