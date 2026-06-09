import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { RagStore } from '../rag/rag-store.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import {
  buildRagMetricsReport,
  evaluateRagMetricsThresholds,
  readRagMetricsPolicy,
  renderRagMetricsMarkdown,
  writeRagMetrics,
} from './rag-metrics.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-metrics-'));
  tempDirs.push(tempDir);
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
    jobKey: 'rag-metrics',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('RAG metrics', () => {
  it('aggregates overall, platform, job, and daily quality metrics', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [
      { platform: '51job', jobKey: 'job-a' },
      { platform: 'liepin', jobKey: 'job-b' },
    ]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: true },
      confidence: 0.8,
      createdAt: '2026-06-08T10:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      question: '是否提供股票期权？',
      answer: '目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。',
      answered: false,
      noAnswerReason: 'no_trusted_context',
      sources: [],
      feedback: { correct: false },
      confidence: 0.1,
      createdAt: '2026-06-09T10:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('liepin', 'job-b', buildLog({
      platform: 'liepin',
      jobKey: 'job-b',
      question: '无来源回答',
      sources: [],
      confidence: 0.2,
      createdAt: '2026-06-09T11:00:00.000Z',
    }));

    const report = await buildRagMetricsReport({
      filePath,
      lowConfidenceThreshold: 0.3,
      ragStore,
      generatedAt: '2026-06-09T12:00:00.000Z',
    });

    assert.equal(report.jobCount, 2);
    assert.equal(report.failedJobCount, 0);
    assert.equal(report.overall.totalAnswers, 3);
    assert.equal(report.overall.reviewedCount, 2);
    assert.equal(report.overall.correctCount, 1);
    assert.equal(report.overall.incorrectCount, 1);
    assert.equal(report.overall.noAnswerCount, 1);
    assert.equal(report.overall.lowConfidenceCount, 1);
    assert.equal(report.overall.missingSourcesCount, 1);
    assert.equal(report.overall.averageConfidence, 0.3667);
    assert.equal(report.overall.rates.correctRate, 0.5);
    assert.equal(report.overall.rates.noAnswerRate, 0.3333);
    assert.deepStrictEqual(report.overall.errorTypes, [
      {
        errorType: 'unspecified',
        count: 1,
        incorrectRate: 1,
      },
    ]);
    assert.deepStrictEqual(report.thresholdViolations, []);
    assert.deepStrictEqual(report.byPlatform.map((item) => `${item.platform}:${item.totalAnswers}`), [
      '51job:2',
      'liepin:1',
    ]);
    assert.deepStrictEqual(report.byDay.map((item) => `${item.date}:${item.totalAnswers}`), [
      '2026-06-08:1',
      '2026-06-09:2',
    ]);
  });

  it('filters logs by createdAt date range', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      createdAt: '2026-06-01T00:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      createdAt: '2026-06-09T00:00:00.000Z',
    }));

    const report = await buildRagMetricsReport({
      filePath,
      since: '2026-06-09T00:00:00.000Z',
      ragStore,
    });

    assert.equal(report.overall.totalAnswers, 1);
    assert.equal(report.byDay[0]?.date, '2026-06-09');
  });

  it('renders markdown metrics summary', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: true },
    }));

    const markdown = renderRagMetricsMarkdown(await buildRagMetricsReport({
      filePath,
      ragStore,
      thresholds: { minCorrectRate: 0.9 },
    }));

    assert.match(markdown, /# RAG Metrics/);
    assert.match(markdown, /Correct rate: 100.0%/);
    assert.match(markdown, /minCorrectRate: 0.9/);
    assert.match(markdown, /No threshold violations/);
    assert.match(markdown, /\| 51job \| 1 \| 1 \| 100.0%/);
  });

  it('aggregates feedback error type distributions', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [
      { platform: '51job', jobKey: 'job-a' },
      { platform: 'liepin', jobKey: 'job-b' },
    ]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: false, errorType: 'wrong_fact' },
      createdAt: '2026-06-09T10:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      question: '这个岗位能远程办公吗？',
      feedback: { correct: false, errorType: 'wrong_fact' },
      createdAt: '2026-06-09T11:00:00.000Z',
    }));
    await ragStore.appendAnswerLog('liepin', 'job-b', buildLog({
      platform: 'liepin',
      jobKey: 'job-b',
      question: '是否有股票期权？',
      feedback: { correct: false },
      createdAt: '2026-06-09T12:00:00.000Z',
    }));

    const report = await buildRagMetricsReport({
      filePath,
      ragStore,
    });
    const markdown = renderRagMetricsMarkdown(report);

    assert.deepStrictEqual(report.overall.errorTypes, [
      {
        errorType: 'wrong_fact',
        count: 2,
        incorrectRate: 0.6667,
      },
      {
        errorType: 'unspecified',
        count: 1,
        incorrectRate: 0.3333,
      },
    ]);
    assert.deepStrictEqual(report.byPlatform.find((item) => item.platform === '51job')?.errorTypes, [
      {
        errorType: 'wrong_fact',
        count: 2,
        incorrectRate: 1,
      },
    ]);
    assert.deepStrictEqual(report.byJob.find((item) => item.jobKey === 'job-b')?.errorTypes, [
      {
        errorType: 'unspecified',
        count: 1,
        incorrectRate: 1,
      },
    ]);
    assert.deepStrictEqual(report.byDay[0]?.errorTypes, [
      {
        errorType: 'wrong_fact',
        count: 2,
        incorrectRate: 0.6667,
      },
      {
        errorType: 'unspecified',
        count: 1,
        incorrectRate: 0.3333,
      },
    ]);
    assert.match(markdown, /## Error Types/);
    assert.match(markdown, /\| wrong_fact \| 2 \| 66\.7% \|/);
    assert.match(markdown, /wrong_fact: 2 \(100\.0%\)/);
  });

  it('reads policy files and reports threshold violations', async () => {
    const tempDir = await makeTempDir();
    const policyPath = path.join(tempDir, 'policy.json');
    await writeJsonFile(policyPath, {
      minReviewRate: 0.8,
      minCorrectRate: 0.9,
      maxIncorrectRate: 0.05,
      maxNoAnswerRate: 0.2,
      maxLowConfidenceRate: 0.1,
      maxMissingSourcesRate: 0.1,
      maxErrorTypeRates: {
        unsupported_claim: 0.05,
        unspecified: 0.1,
      },
    });
    const policy = await readRagMetricsPolicy(policyPath);
    const violations = evaluateRagMetricsThresholds({
      totalAnswers: 10,
      answeredCount: 8,
      noAnswerCount: 2,
      reviewedCount: 5,
      unreviewedCount: 5,
      correctCount: 3,
      incorrectCount: 2,
      lowConfidenceCount: 2,
      missingSourcesCount: 1,
      averageConfidence: 0.4,
      rates: {
        reviewRate: 0.5,
        correctRate: 0.6,
        incorrectRate: 0.4,
        noAnswerRate: 0.2,
        lowConfidenceRate: 0.2,
        missingSourcesRate: 0.1,
      },
      errorTypes: [],
    }, policy);

    assert.deepStrictEqual(policy, {
      minReviewRate: 0.8,
      minCorrectRate: 0.9,
      maxIncorrectRate: 0.05,
      maxNoAnswerRate: 0.2,
      maxLowConfidenceRate: 0.1,
      maxMissingSourcesRate: 0.1,
      maxErrorTypeRates: {
        unsupported_claim: 0.05,
        unspecified: 0.1,
      },
    });
    assert.deepStrictEqual(violations.map((violation) => violation.metric), [
      'minReviewRate',
      'minCorrectRate',
      'maxIncorrectRate',
      'maxLowConfidenceRate',
    ]);
    assert.equal(violations.every((violation) => violation.remediation.length > 0), true);
  });

  it('reports threshold violations and recommendations for configured error type rates', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const policyPath = path.join(tempDir, 'policy.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await writeJsonFile(policyPath, {
      maxErrorTypeRates: {
        unsupported_claim: 0.2,
        bad_source: 0.2,
      },
    });
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: false, errorType: 'unsupported_claim' },
    }));
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      question: '引用来源不对的问题',
      feedback: { correct: false, errorType: 'bad_source' },
    }));
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      question: '事实错误问题',
      feedback: { correct: false, errorType: 'wrong_fact' },
    }));

    const result = await writeRagMetrics({
      filePath,
      policyPath,
      format: 'markdown',
      ragStore,
    });

    assert.deepStrictEqual(result.report.thresholdViolations.map((violation) => violation.metric), [
      'maxErrorTypeRates.unsupported_claim',
      'maxErrorTypeRates.bad_source',
    ]);
    assert.deepStrictEqual(result.report.thresholdViolations.map((violation) => violation.actual), [
      0.3333,
      0.3333,
    ]);
    assert.deepStrictEqual(result.report.recommendations.map((item) => `${item.severity}:${item.errorType}`), [
      'critical:unsupported_claim',
      'critical:bad_source',
    ]);
    assert.match(result.content, /Threshold violations:/);
    assert.match(result.content, /maxErrorTypeRates\.unsupported_claim expected <= 0\.2, actual 0\.3333/);
    assert.match(result.content, /Remediation: Tighten answer prompts/);
    assert.match(result.content, /## Recommendations/);
    assert.match(result.content, /critical: maxErrorTypeRates\.bad_source expected <= 0\.2, actual 0\.3333/);
  });

  it('rejects invalid error type rate policies', async () => {
    const tempDir = await makeTempDir();
    const invalidTypePath = path.join(tempDir, 'invalid-type-policy.json');
    const invalidRatePath = path.join(tempDir, 'invalid-rate-policy.json');
    await writeJsonFile(invalidTypePath, {
      maxErrorTypeRates: {
        typo: 0.1,
      },
    });
    await writeJsonFile(invalidRatePath, {
      maxErrorTypeRates: {
        unsupported_claim: 2,
      },
    });

    await assert.rejects(
      readRagMetricsPolicy(invalidTypePath),
      /not a supported error type/,
    );
    await assert.rejects(
      readRagMetricsPolicy(invalidRatePath),
      /must be a number between 0 and 1/,
    );
  });

  it('lets CLI thresholds override policy thresholds', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const policyPath = path.join(tempDir, 'policy.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await writeJsonFile(policyPath, {
      minCorrectRate: 0.9,
      maxNoAnswerRate: 0.1,
    });
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: true },
    }));

    const result = await writeRagMetrics({
      filePath,
      policyPath,
      thresholds: {
        minCorrectRate: 0.5,
      },
      ragStore,
    });

    assert.deepStrictEqual(result.report.thresholds, {
      minCorrectRate: 0.5,
      maxNoAnswerRate: 0.1,
    });
    assert.deepStrictEqual(result.report.thresholdViolations, []);
  });

  it('writes JSON and markdown outputs', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const jsonPath = path.join(tempDir, 'metrics.json');
    const markdownPath = path.join(tempDir, 'metrics.md');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
    }));

    const jsonResult = await writeRagMetrics({
      filePath,
      outputPath: jsonPath,
      ragStore,
    });
    const markdownResult = await writeRagMetrics({
      filePath,
      outputPath: markdownPath,
      format: 'markdown',
      ragStore,
    });
    const json = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as { overall?: { totalAnswers?: number } };
    const markdown = await fs.readFile(markdownPath, 'utf8');

    assert.equal(jsonResult.report.overall.totalAnswers, 1);
    assert.equal(markdownResult.report.overall.totalAnswers, 1);
    assert.equal(json.overall?.totalAnswers, 1);
    assert.match(markdown, /Total answers: 1/);
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
