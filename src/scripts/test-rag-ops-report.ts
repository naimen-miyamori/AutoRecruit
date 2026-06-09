import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from '../config.js';
import { RagStore } from '../rag/rag-store.js';
import type { DoctorRagJobOptions, RagDoctorSummary } from '../rag/doctor.js';
import type { RagAnswerLogRecord, RagAnswerSource } from '../rag/types.js';
import {
  buildRagOpsReport,
  renderRagOpsMarkdown,
  writeRagOpsReport,
} from './rag-ops-report.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;
const originalDataDirEnv = process.env.DATA_DIR;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-ops-'));
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
    jobKey: 'job-a',
    question: '薪资范围是多少？',
    answer: '这个岗位薪资范围是15-25K，13薪。',
    sources: [buildSource()],
    answered: true,
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function buildDoctorSummary(
  options: DoctorRagJobOptions,
  status: RagDoctorSummary['status'],
  issueCode?: string,
): RagDoctorSummary {
  return {
    platform: options.platform,
    jobKey: options.jobKey,
    status,
    inspect: {
      platform: options.platform,
      jobKey: options.jobKey,
      sourceCounts: {
        total: 1,
        active: 1,
        inactive: 0,
        jd: 1,
        conversation: 0,
        recruiterNote: 0,
        faq: 0,
      },
      chunkCounts: {
        total: 1,
        active: 1,
        inactive: 0,
        factChunks: 1,
        jd: 1,
        verifiedConversation: 0,
        unverifiedConversation: 0,
        recruiterNote: 0,
        faq: 0,
      },
      embeddingCacheCount: 1,
      activeJdSources: [],
      inactiveJdSources: [],
      conversations: [],
    },
    issues: issueCode ? [{
      code: issueCode,
      severity: status === 'error' ? 'error' : 'warning',
      message: `${issueCode} message`,
      recommendation: `${issueCode} recommendation`,
    }] : [],
    recommendations: issueCode ? [`${issueCode} recommendation`] : [],
  };
}

describe('RAG ops report', () => {
  it('combines doctor, review, and metrics into a failed operations report', async () => {
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
      sources: [],
      feedback: { correct: false, errorType: 'unsupported_claim' },
    }));
    await ragStore.appendAnswerLog('liepin', 'job-b', buildLog({
      platform: 'liepin',
      jobKey: 'job-b',
      feedback: { correct: true },
      createdAt: '2026-06-09T01:00:00.000Z',
    }));

    const report = await buildRagOpsReport({
      filePath,
      question: '这个岗位薪资范围是多少？',
      thresholds: {
        maxMissingSourcesRate: 0.1,
        maxErrorTypeRates: {
          unsupported_claim: 0.2,
        },
      },
      ragStore,
      generatedAt: '2026-06-09T02:00:00.000Z',
      doctorRagJobFn: async (options) => buildDoctorSummary(
        options,
        options.jobKey === 'job-a' ? 'warning' : 'ok',
        options.jobKey === 'job-a' ? 'conversation_without_verified_facts' : undefined,
      ),
    });

    assert.equal(report.status, 'failed');
    assert.equal(report.doctor.status, 'warning');
    assert.equal(report.review.status, 'needs_review');
    assert.equal(report.review.totals.reviewItemCount, 1);
    assert.equal(report.metrics.overall.totalAnswers, 2);
    assert.deepStrictEqual(report.metrics.thresholdViolations.map((item) => item.metric), [
      'maxMissingSourcesRate',
      'maxErrorTypeRates.unsupported_claim',
    ]);
    assert.equal(report.recommendations.some((item) => item.source === 'doctor'), true);
    assert.equal(report.recommendations.some((item) => item.source === 'review'), true);
    assert.equal(report.recommendations.some((item) => item.source === 'metrics' && item.severity === 'critical'), true);
  });

  it('renders markdown with all operational sections', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
    }));

    const markdown = renderRagOpsMarkdown(await buildRagOpsReport({
      filePath,
      ragStore,
      doctorRagJobFn: async (options) => buildDoctorSummary(options, 'ok'),
    }));

    assert.match(markdown, /# RAG Operations Report/);
    assert.match(markdown, /## Executive Summary/);
    assert.match(markdown, /## Doctor Summary/);
    assert.match(markdown, /## Review Details/);
    assert.match(markdown, /### RAG Review Batch/);
    assert.match(markdown, /## Metrics Details/);
    assert.match(markdown, /### RAG Metrics/);
    assert.match(markdown, /Review: needs_review/);
    assert.match(markdown, /Total answers: 1/);
  });

  it('writes JSON output', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    const outputPath = path.join(tempDir, 'rag-ops.json');
    const ragStore = new RagStore();
    await writeJsonFile(filePath, [{ platform: '51job', jobKey: 'job-a' }]);
    await ragStore.appendAnswerLog('51job', 'job-a', buildLog({
      platform: '51job',
      jobKey: 'job-a',
      feedback: { correct: true },
    }));

    const result = await writeRagOpsReport({
      filePath,
      outputPath,
      format: 'json',
      ragStore,
      doctorRagJobFn: async (options) => buildDoctorSummary(options, 'ok'),
    });
    const json = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
      status?: string;
      doctor?: { status?: string };
      metrics?: { overall?: { totalAnswers?: number } };
    };

    assert.equal(result.report.status, 'ok');
    assert.equal(json.status, 'ok');
    assert.equal(json.doctor?.status, 'ok');
    assert.equal(json.metrics?.overall?.totalAnswers, 1);
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
