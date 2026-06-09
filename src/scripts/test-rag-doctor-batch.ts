import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  doctorRagBatch,
  normalizeDoctorBatchItem,
  readDoctorBatchFile,
} from './rag-doctor-batch.js';
import type { DoctorRagJobOptions, RagDoctorSummary } from '../rag/doctor.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-doctor-batch-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildDoctorSummary(
  options: DoctorRagJobOptions,
  status: RagDoctorSummary['status'],
  issueCodes: string[] = [],
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
    issues: issueCodes.map((code) => ({
      code,
      severity: code.includes('missing') || code.includes('unreachable') ? 'error' : 'warning',
      message: `${code} message`,
      recommendation: `${code} recommendation`,
    })),
    recommendations: issueCodes.map((code) => `${code} recommendation`),
  };
}

describe('RAG doctor batch', () => {
  it('normalizes batch items and derives job keys from keywords', () => {
    const item = normalizeDoctorBatchItem({
      platform: '51job',
      keyword: '优衣库 店长',
      question: '有住宿吗？',
    }, 0);

    assert.equal(item.platform, '51job');
    assert.equal(item.jobKey, '优衣库-店长');
    assert.equal(item.question, '有住宿吗？');
    assert.throws(
      () => normalizeDoctorBatchItem({ platform: '51job', question: '缺少职位' }, 0),
      /jobKey or keyword/,
    );
    assert.throws(
      () => normalizeDoctorBatchItem({ jobKey: 'x' }, 0),
      /platform must be a non-empty string/,
    );
    assert.throws(
      () => normalizeDoctorBatchItem({ platform: '51job', jobKey: 'x', question: '' }, 0),
      /question must be a non-empty string/,
    );
  });

  it('reads JSON arrays, items wrappers, and JSONL rows', async () => {
    const tempDir = await makeTempDir();
    const arrayPath = path.join(tempDir, 'array.json');
    const wrapperPath = path.join(tempDir, 'wrapper.json');
    const jsonlPath = path.join(tempDir, 'jobs.jsonl');

    await writeJsonFile(arrayPath, [{
      platform: '51job',
      jobKey: '优衣库',
    }]);
    await writeJsonFile(wrapperPath, {
      items: [{
        platform: 'liepin',
        jobKey: '销售经理',
        question: '需要出差吗？',
      }],
    });
    await fs.writeFile(jsonlPath, [
      JSON.stringify({ platform: 'zhilian', jobKey: '运营' }),
      JSON.stringify({ platform: '51job', keyword: '门店 店长' }),
    ].join('\n'), 'utf8');

    const arrayItems = await readDoctorBatchFile(arrayPath);
    const wrapperItems = await readDoctorBatchFile(wrapperPath);
    const jsonlItems = await readDoctorBatchFile(jsonlPath);

    assert.equal(arrayItems[0]?.jobKey, '优衣库');
    assert.equal(wrapperItems[0]?.platform, 'liepin');
    assert.equal(wrapperItems[0]?.question, '需要出差吗？');
    assert.equal(jsonlItems.length, 2);
    assert.equal(jsonlItems[0]?.sourceLine, 1);
    assert.equal(jsonlItems[1]?.jobKey, '门店-店长');
  });

  it('summarizes all job statuses, issue counts, and recommendations', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    await writeJsonFile(filePath, [
      { platform: '51job', jobKey: 'ok-job' },
      { platform: 'liepin', jobKey: 'warning-job', question: '岗位地点在哪？' },
      { platform: 'zhilian', jobKey: 'error-job' },
    ]);
    const calls: DoctorRagJobOptions[] = [];

    const summary = await doctorRagBatch({
      filePath,
      question: '默认问题',
      doctorRagJobFn: async (options) => {
        calls.push(options);
        if (options.jobKey === 'warning-job') {
          return buildDoctorSummary(options, 'warning', ['conversation_without_verified_facts']);
        }
        if (options.jobKey === 'error-job') {
          return buildDoctorSummary(options, 'error', ['missing_qdrant_url', 'conversation_without_verified_facts']);
        }
        return buildDoctorSummary(options, 'ok');
      },
    });

    assert.equal(summary.status, 'error');
    assert.equal(summary.itemCount, 3);
    assert.equal(summary.okCount, 1);
    assert.equal(summary.warningCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.failedCount, 0);
    assert.deepStrictEqual(summary.issueCounts.map((item) => `${item.code}:${item.count}`), [
      'conversation_without_verified_facts:2',
      'missing_qdrant_url:1',
    ]);
    assert.equal(summary.recommendations.includes('missing_qdrant_url recommendation'), true);
    assert.deepStrictEqual(calls.map((call) => call.question), [
      '默认问题',
      '岗位地点在哪？',
      '默认问题',
    ]);
  });

  it('records per-job failures and continues diagnosing later jobs', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'jobs.json');
    await writeJsonFile(filePath, [
      { platform: '51job', jobKey: 'first' },
      { platform: '51job', jobKey: 'broken' },
      { platform: '51job', jobKey: 'last' },
    ]);
    const calls: string[] = [];

    const summary = await doctorRagBatch({
      filePath,
      doctorRagJobFn: async (options) => {
        calls.push(options.jobKey);
        if (options.jobKey === 'broken') {
          throw new Error('simulated doctor failure');
        }
        return buildDoctorSummary(options, 'ok');
      },
    });

    assert.equal(summary.status, 'error');
    assert.equal(summary.okCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.results[1]?.status, 'failed');
    assert.match(summary.results[1]?.error ?? '', /simulated doctor failure/);
    assert.deepStrictEqual(calls, ['first', 'broken', 'last']);
  });
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
