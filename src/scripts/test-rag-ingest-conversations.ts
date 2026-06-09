import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ingestConversationBatch,
  normalizeConversationBatchItem,
  readConversationBatchFile,
} from './rag-ingest-conversations.js';
import type { RagDoctorBatchItem, RagDoctorBatchSummary } from './rag-doctor-batch.js';
import type { IngestConversationOptions, RagConversationIngestSummary } from '../rag/service.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-rag-batch-ingest-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildSummary(options: IngestConversationOptions): RagConversationIngestSummary {
  return {
    platform: options.platform,
    jobKey: options.jobKey,
    conversationId: options.conversationId,
    conversationPath: `/tmp/${options.conversationId}.jsonl`,
    sourceCount: 1,
    chunkCount: options.turns.length,
    indexedChunkCount: options.turns.filter((turn) => turn.role === 'recruiter' && turn.verified === true).length,
    embeddingModel: 'test-embedding',
    vectorStore: 'test-vector-store',
    manifestPath: '/tmp/manifest.json',
  };
}

function buildDoctorSummary(filePath: string, items: RagDoctorBatchItem[]): RagDoctorBatchSummary {
  return {
    filePath,
    status: items.some((item) => item.jobKey === 'warning-job') ? 'warning' : 'ok',
    itemCount: items.length,
    okCount: items.filter((item) => item.jobKey !== 'warning-job').length,
    warningCount: items.filter((item) => item.jobKey === 'warning-job').length,
    errorCount: 0,
    failedCount: 0,
    issueCounts: items.some((item) => item.jobKey === 'warning-job')
      ? [{ code: 'conversation_without_verified_facts', count: 1, severity: 'warning' }]
      : [],
    recommendations: items.some((item) => item.jobKey === 'warning-job')
      ? ['确认招聘方答复已设置 role=recruiter 且 verified=true，然后重新导入对应 conversation。']
      : [],
    results: items.map((item, index) => ({
      index,
      platform: item.platform,
      jobKey: item.jobKey,
      status: item.jobKey === 'warning-job' ? 'warning' : 'ok',
      issueCount: item.jobKey === 'warning-job' ? 1 : 0,
      issueCodes: item.jobKey === 'warning-job' ? ['conversation_without_verified_facts'] : [],
      recommendations: item.jobKey === 'warning-job'
        ? ['确认招聘方答复已设置 role=recruiter 且 verified=true，然后重新导入对应 conversation。']
        : [],
    })),
  };
}

describe('RAG conversation batch ingest', () => {
  it('normalizes batch items and derives job keys from keywords', () => {
    const item = normalizeConversationBatchItem({
      platform: '51job',
      keyword: '优衣库 店长',
      conversationId: 'conv-1',
      turns: [
        { id: 'turn-1', role: 'candidate', content: '有住宿吗？' },
        { id: 'turn-2', role: 'recruiter', content: '有住宿补贴。', verified: true },
      ],
    }, 0);

    assert.equal(item.platform, '51job');
    assert.equal(item.jobKey, '优衣库-店长');
    assert.equal(item.conversationId, 'conv-1');
    assert.equal(item.turns.length, 2);
    assert.equal(item.turns[1]?.verified, true);
    assert.throws(
      () => normalizeConversationBatchItem({ platform: '51job', conversationId: 'x', turns: [] }, 0),
      /jobKey or keyword/,
    );
    assert.throws(
      () => normalizeConversationBatchItem({ platform: '51job', jobKey: 'x', conversationId: 'x', role: 'candidate', content: '' }, 0),
      /content must be a non-empty string/,
    );
  });

  it('reads JSON arrays, items wrappers, and JSONL single-turn rows', async () => {
    const tempDir = await makeTempDir();
    const arrayPath = path.join(tempDir, 'array.json');
    const wrapperPath = path.join(tempDir, 'wrapper.json');
    const jsonlPath = path.join(tempDir, 'rows.jsonl');

    await writeJsonFile(arrayPath, [{
      platform: '51job',
      jobKey: '优衣库',
      conversationId: 'conv-array',
      turns: [{ role: 'candidate', content: '问题' }],
    }]);
    await writeJsonFile(wrapperPath, {
      items: [{
        platform: 'liepin',
        jobKey: '销售经理',
        conversationId: 'conv-wrapper',
        turns: [{ role: 'recruiter', content: '答复', verified: true }],
      }],
    });
    await fs.writeFile(jsonlPath, [
      JSON.stringify({
        platform: 'zhilian',
        jobKey: '运营',
        conversationId: 'conv-jsonl',
        id: 'turn-1',
        role: 'candidate',
        content: '单行问题',
      }),
      JSON.stringify({
        platform: 'zhilian',
        jobKey: '运营',
        conversationId: 'conv-jsonl',
        id: 'turn-2',
        role: 'recruiter',
        content: '单行答复',
        verified: true,
      }),
    ].join('\n'), 'utf8');

    const arrayItems = await readConversationBatchFile(arrayPath);
    const wrapperItems = await readConversationBatchFile(wrapperPath);
    const jsonlItems = await readConversationBatchFile(jsonlPath);

    assert.equal(arrayItems[0]?.conversationId, 'conv-array');
    assert.equal(wrapperItems[0]?.platform, 'liepin');
    assert.equal(jsonlItems.length, 2);
    assert.equal(jsonlItems[0]?.sourceLine, 1);
    assert.equal(jsonlItems[1]?.turns[0]?.verified, true);
  });

  it('dry-runs batch files without calling ingest', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'conversations.json');
    await writeJsonFile(filePath, [{
      platform: '51job',
      jobKey: '优衣库',
      conversationId: 'conv-1',
      turns: [{ role: 'candidate', content: '有住宿吗？' }],
    }]);
    let ingestCalled = false;

    const summary = await ingestConversationBatch({
      filePath,
      dryRun: true,
      ingestConversationFn: async (options) => {
        ingestCalled = true;
        return buildSummary(options);
      },
    });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.doctor, false);
    assert.equal(summary.itemCount, 1);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.ingestedCount, 0);
    assert.equal(summary.results[0]?.status, 'validated');
    assert.equal(ingestCalled, false);
  });

  it('can run doctor once per successfully ingested job after batch ingest', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'conversations.json');
    await writeJsonFile(filePath, [
      {
        platform: '51job',
        jobKey: 'same-job',
        conversationId: 'conv-1',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '有住宿补贴。', verified: true }],
      },
      {
        platform: '51job',
        jobKey: 'same-job',
        conversationId: 'conv-2',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '晚班有补贴。', verified: true }],
      },
      {
        platform: 'liepin',
        jobKey: 'warning-job',
        conversationId: 'conv-3',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '未确认答复。', verified: false }],
      },
      {
        platform: 'zhilian',
        jobKey: 'failed-job',
        conversationId: 'fail-conv',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '失败行。', verified: true }],
      },
    ]);
    const doctorCalls: Array<{ filePath: string; items: RagDoctorBatchItem[]; question?: string }> = [];

    const summary = await ingestConversationBatch({
      filePath,
      doctor: true,
      doctorQuestion: '这个岗位有住宿补贴吗？',
      failOnError: false,
      ingestConversationFn: async (options) => {
        if (options.conversationId === 'fail-conv') {
          throw new Error('simulated ingest failure');
        }
        return buildSummary(options);
      },
      doctorRagBatchItemsFn: async (options) => {
        doctorCalls.push({
          filePath: options.filePath,
          items: options.items,
          question: options.question,
        });
        return buildDoctorSummary(options.filePath, options.items);
      },
    });

    assert.equal(summary.doctor, true);
    assert.equal(summary.ingestedCount, 3);
    assert.equal(summary.failedCount, 1);
    assert.equal(doctorCalls.length, 1);
    assert.equal(doctorCalls[0]?.question, '这个岗位有住宿补贴吗？');
    assert.deepStrictEqual(doctorCalls[0]?.items.map((item) => `${item.platform}:${item.jobKey}`), [
      '51job:same-job',
      'liepin:warning-job',
    ]);
    assert.equal(summary.doctorSummary?.status, 'warning');
    assert.equal(summary.doctorSummary?.itemCount, 2);
    assert.equal(summary.doctorSummary?.warningCount, 1);
  });

  it('reports an empty doctor summary for dry-run items', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'conversations.json');
    await writeJsonFile(filePath, [{
      platform: '51job',
      jobKey: 'dry-run-job',
      conversationId: 'conv-1',
      turns: [{ role: 'recruiter', content: '仅校验。', verified: true }],
    }]);
    let doctorCalled = false;

    const summary = await ingestConversationBatch({
      filePath,
      dryRun: true,
      doctor: true,
      doctorRagBatchItemsFn: async (options) => {
        doctorCalled = true;
        return buildDoctorSummary(options.filePath, options.items);
      },
    });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.doctor, true);
    assert.equal(summary.doctorSummary?.itemCount, 0);
    assert.equal(doctorCalled, true);
  });

  it('ingests multiple platforms and isolates row failures when configured', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'conversations.json');
    await writeJsonFile(filePath, [
      {
        platform: '51job',
        jobKey: '优衣库',
        conversationId: 'conv-1',
        turns: [
          { id: 'turn-1', role: 'candidate', content: '有住宿吗？' },
          { id: 'turn-2', role: 'recruiter', content: '住宿补贴800元。', verified: true },
        ],
      },
      {
        platform: 'liepin',
        jobKey: '销售经理',
        conversationId: 'fail-conv',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '错误行。', verified: true }],
      },
      {
        platform: 'zhilian',
        jobKey: '运营',
        conversationId: 'conv-3',
        turns: [{ id: 'turn-1', role: 'recruiter', content: '未确认答复。', verified: false }],
      },
    ]);
    const calls: IngestConversationOptions[] = [];

    const summary = await ingestConversationBatch({
      filePath,
      failOnError: false,
      ingestConversationFn: async (options) => {
        calls.push(options);
        if (options.conversationId === 'fail-conv') {
          throw new Error('simulated ingest failure');
        }
        return buildSummary(options);
      },
    });

    assert.equal(summary.itemCount, 3);
    assert.equal(summary.successCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.ingestedCount, 2);
    assert.deepStrictEqual(summary.results.map((result) => result.status), ['ingested', 'failed', 'ingested']);
    assert.equal(summary.results[0]?.verifiedTurnCount, 1);
    assert.equal(summary.results[2]?.verifiedTurnCount, 0);
    assert.equal(calls.length, 3);
    assert.deepStrictEqual(calls.map((call) => `${call.platform}:${call.jobKey}:${call.conversationId}`), [
      '51job:优衣库:conv-1',
      'liepin:销售经理:fail-conv',
      'zhilian:运营:conv-3',
    ]);
  });

  it('stops on the first row failure by default', async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, 'conversations.json');
    await writeJsonFile(filePath, [
      {
        platform: '51job',
        jobKey: '优衣库',
        conversationId: 'fail-conv',
        turns: [{ role: 'recruiter', content: '错误行。', verified: true }],
      },
      {
        platform: '51job',
        jobKey: '优衣库',
        conversationId: 'skipped-conv',
        turns: [{ role: 'recruiter', content: '不会执行。', verified: true }],
      },
    ]);
    let calls = 0;

    const summary = await ingestConversationBatch({
      filePath,
      ingestConversationFn: async (options) => {
        calls += 1;
        throw new Error(`failed ${options.conversationId}`);
      },
    });

    assert.equal(summary.failedCount, 1);
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0]?.status, 'failed');
    assert.equal(calls, 1);
  });
});

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
