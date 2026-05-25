import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import {
  main,
  closeBrowserSessionRef,
  ensureAuthenticatedBrowserSessionRef,
  exportJobResultsRef,
  extractCandidateListRef,
  openSubscribeSearchRef,
  sendJobReportRef,
} from '../index.js';
import { JobStore } from '../storage/job-store.js';
import type { MainResult, MainRunSummary } from '../index.js';
import type { CandidateScoreArtifact, JobRecord, ReportDeliveryOptions, RunResult } from '../types/job.js';
import { sendJobReport, sendJobReportEmailRef } from './send-job-report-email.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-send-report-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  sendJobReportEmailRef.fn = async ({ recipient, subject }) => ({ recipient, subject });
  ensureAuthenticatedBrowserSessionRef.fn = async (_platform) => {
    throw new Error('unexpected browser session setup');
  };
  closeBrowserSessionRef.fn = async () => undefined;
  exportJobResultsRef.fn = async () => {
    throw new Error('unexpected export');
  };
  openSubscribeSearchRef.fn = async () => {
    throw new Error('unexpected subscribe search');
  };
  sendJobReportRef.fn = sendJobReport;
  extractCandidateListRef.fn = async () => {
    throw new Error('unexpected candidate extraction');
  };
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedJobRecord(
  jobKey: string,
  reportDelivery: ReportDeliveryOptions = {},
) {
  const store = new JobStore();
  const jobRecord: JobRecord = {
    jobKey,
    platform: '51job',
    searchKeyword: '东南亚 销售',
    recipientEmail: reportDelivery.recipientEmail,
    ccEmails: reportDelivery.ccEmails,
    rawText: 'raw jd',
    normalizedJob: {
      title: '东南亚销售经理',
      majors: [],
      languageRequirements: [],
      responsibilities: [],
      hardRequirements: [],
      preferredRequirements: [],
      regionPreferences: [],
      industryTags: [],
    },
    createdAt: '2026-04-21T00:00:00.000Z',
  };

  await store.saveJobRecord('51job', jobRecord);
  return { store, jobRecord };
}

async function saveRunResult(store: JobStore, jobKey: string, runResult: RunResult) {
  await store.saveRunResult('51job', jobKey, runResult);
}

function assertSinglePlatformSummary(result: MainResult): MainRunSummary {
  assert.equal(Array.isArray(result), false);
  return result as MainRunSummary;
}

async function seedJobData(
  jobKey: string,
  reportDelivery: ReportDeliveryOptions = {},
) {
  const { store } = await seedJobRecord(jobKey, reportDelivery);
  const artifact: CandidateScoreArtifact = {
    candidateId: 'cand-1',
    model: 'claude-test',
    scoredAt: '2026-04-21T00:00:01.000Z',
    status: 'success',
    score: {
      totalScore: 88,
      dimensionScores: {
        education: { score: 88, reason: 'ok' },
        language: { score: 88, reason: 'ok' },
        experience: { score: 88, reason: 'ok' },
        industryMatch: { score: 88, reason: 'ok' },
        regionMatch: { score: 88, reason: 'ok' },
        responsibilityMatch: { score: 88, reason: 'ok' },
      },
      risks: [],
      summary: 'good fit for email verification',
    },
  };

  await store.saveCandidateScoreArtifact('51job', jobKey, artifact);
  await saveRunResult(store, jobKey, {
    jobKey,
    platform: '51job',
    fetchedAt: '2026-04-21T00:00:02.000Z',
    totalCandidates: 1,
    newCandidateIds: ['cand-1'],
    scoredCandidates: ['cand-1'],
    failedCandidates: [],
  });
}

describe('sendJobReport', () => {
  it('uses the stored recipient email by default', async () => {
    const jobKey = `job-email-default-${Date.now()}`;
    await seedJobData(jobKey, { recipientEmail: 'saved@example.com' });

    const sent: Array<{ recipient: string; subject: string; markdown: string; ccEmails?: string[] }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, markdown, ccEmails }) => {
      sent.push({ recipient, subject, markdown, ccEmails });
      return { recipient, subject };
    };

    const result = await sendJobReport('51job', jobKey);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.recipient, 'saved@example.com');
    assert.equal(sent[0]?.subject, '东南亚销售经理 评分结果（1/1）');
    assert.match(sent[0]?.markdown ?? '', /^# 东南亚销售经理 评分结果/m);
    assert.deepStrictEqual(result, {
      jobKey,
      recipient: 'saved@example.com',
      subject: '东南亚销售经理 评分结果（1/1）',
      summary: {
        candidateCount: 1,
        successCount: 1,
        failureCount: 0,
      },
    });
  });

  it('uses stored cc emails by default', async () => {
    const jobKey = `job-email-default-cc-${Date.now()}`;
    await seedJobData(jobKey, {
      recipientEmail: 'saved@example.com',
      ccEmails: ['cc1@example.com', 'cc2@example.com'],
    });

    const sent: Array<{ recipient: string; subject: string; ccEmails?: string[] }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, ccEmails }) => {
      sent.push({ recipient, subject, ccEmails });
      return { recipient, subject };
    };

    await sendJobReport('51job', jobKey);

    assert.deepStrictEqual(sent, [{
      recipient: 'saved@example.com',
      subject: '东南亚销售经理 评分结果（1/1）',
      ccEmails: ['cc1@example.com', 'cc2@example.com'],
    }]);
  });

  it('prefers the explicit recipient override', async () => {
    const jobKey = `job-email-override-${Date.now()}`;
    await seedJobData(jobKey, { recipientEmail: 'saved@example.com' });

    let sentRecipient = '';
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sentRecipient = recipient;
      return { recipient, subject };
    };

    const result = await sendJobReport('51job', jobKey, { recipientEmail: 'override@example.com' });

    assert.equal(sentRecipient, 'override@example.com');
    assert.equal(result.recipient, 'override@example.com');
  });

  it('allows clearing stored cc emails with an explicit empty override', async () => {
    const jobKey = `job-email-clear-cc-${Date.now()}`;
    await seedJobData(jobKey, {
      recipientEmail: 'saved@example.com',
      ccEmails: ['saved-cc@example.com'],
    });

    let sentCcEmails: string[] | undefined;
    sendJobReportEmailRef.fn = async ({ recipient, subject, ccEmails }) => {
      sentCcEmails = ccEmails;
      return { recipient, subject };
    };

    await sendJobReport('51job', jobKey, { ccEmails: [] });

    assert.deepStrictEqual(sentCcEmails, []);
  });

  it('uses the last stored recipient after job record updates without an explicit email', async () => {
    const jobKey = `job-email-preserve-recipient-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, {
      recipientEmail: 'saved@example.com',
      ccEmails: ['saved-cc@example.com'],
    });
    await store.saveCandidateScoreArtifact('51job', jobKey, {
      candidateId: 'cand-1',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:01.000Z',
      status: 'success',
      score: {
        totalScore: 88,
        dimensionScores: {
          education: { score: 88, reason: 'ok' },
          language: { score: 88, reason: 'ok' },
          experience: { score: 88, reason: 'ok' },
          industryMatch: { score: 88, reason: 'ok' },
          regionMatch: { score: 88, reason: 'ok' },
          responsibilityMatch: { score: 88, reason: 'ok' },
        },
        risks: [],
        summary: 'good fit for email verification',
      },
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-1'],
      scoredCandidates: ['cand-1'],
      failedCandidates: [],
    });

    await store.saveJobRecord('51job', {
      jobKey,
      platform: '51job',
      searchKeyword: '东南亚 销售',
      rawText: 'updated raw jd',
      normalizedJob: {
        title: '东南亚销售经理',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-04-22T00:00:00.000Z',
      recipientEmail: 'saved@example.com',
      ccEmails: ['saved-cc@example.com'],
    });

    let sentRecipient = '';
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sentRecipient = recipient;
      return { recipient, subject };
    };

    const result = await sendJobReport('51job', jobKey);

    assert.equal(sentRecipient, 'saved@example.com');
    assert.equal(result.recipient, 'saved@example.com');
  });

  it('sends a dedicated no-new-candidates email for an empty latest run', async () => {
    const jobKey = `job-email-empty-run-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, {
      recipientEmail: 'saved@example.com',
      ccEmails: ['cc@example.com'],
    });
    await store.saveCandidateScoreArtifact('51job', jobKey, {
      candidateId: 'cand-old',
      model: 'claude-test',
      scoredAt: '2026-04-20T00:00:01.000Z',
      status: 'success',
      score: {
        totalScore: 91,
        dimensionScores: {
          education: { score: 91, reason: 'ok' },
          language: { score: 91, reason: 'ok' },
          experience: { score: 91, reason: 'ok' },
          industryMatch: { score: 91, reason: 'ok' },
          regionMatch: { score: 91, reason: 'ok' },
          responsibilityMatch: { score: 91, reason: 'ok' },
        },
        risks: [],
        summary: 'older candidate',
      },
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:00.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-old'],
      scoredCandidates: ['cand-old'],
      failedCandidates: [],
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-22T03:23:03.505Z',
      totalCandidates: 0,
      newCandidateIds: [],
      scoredCandidates: [],
      failedCandidates: [],
    });

    const sent: Array<{ recipient: string; subject: string; markdown: string; ccEmails?: string[] }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, markdown, ccEmails }) => {
      sent.push({ recipient, subject, markdown, ccEmails });
      return { recipient, subject };
    };

    const result = await sendJobReport('51job', jobKey);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.recipient, 'saved@example.com');
    assert.equal(sent[0]?.subject, '东南亚销售经理 本次无新增候选人');
    assert.deepStrictEqual(sent[0]?.ccEmails, ['cc@example.com']);
    assert.match(sent[0]?.markdown ?? '', /^# 东南亚销售经理 无新增候选人通知/m);
    assert.match(sent[0]?.markdown ?? '', /- 平台来源: 51job/);
    assert.match(sent[0]?.markdown ?? '', /jobKey: `job-email-empty-run-/);
    assert.match(sent[0]?.markdown ?? '', /fetchedAt: `2026-04-22T03:23:03.505Z`/);
    assert.match(sent[0]?.markdown ?? '', /本次抓取未发现新的候选人，新增候选人数为 0。/);
    assert.deepStrictEqual(result, {
      jobKey,
      recipient: 'saved@example.com',
      subject: '东南亚销售经理 本次无新增候选人',
      summary: {
        candidateCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    });
  });

  it('fails when latest run candidates have no matching artifacts', async () => {
    const jobKey = `job-email-missing-latest-artifacts-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, { recipientEmail: 'saved@example.com' });
    await store.saveCandidateScoreArtifact('51job', jobKey, {
      candidateId: 'cand-old',
      model: 'claude-test',
      scoredAt: '2026-04-20T00:00:01.000Z',
      status: 'success',
      score: {
        totalScore: 91,
        dimensionScores: {
          education: { score: 91, reason: 'ok' },
          language: { score: 91, reason: 'ok' },
          experience: { score: 91, reason: 'ok' },
          industryMatch: { score: 91, reason: 'ok' },
          regionMatch: { score: 91, reason: 'ok' },
          responsibilityMatch: { score: 91, reason: 'ok' },
        },
        risks: [],
        summary: 'older candidate',
      },
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:00.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-old'],
      scoredCandidates: ['cand-old'],
      failedCandidates: [],
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-22T03:23:03.505Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-new'],
      scoredCandidates: ['cand-new'],
      failedCandidates: [],
    });

    await assert.rejects(
      () => sendJobReport('51job', jobKey),
      /No score artifacts found for latest run of job key .*expected candidate IDs: cand-new/,
    );
  });

  it('uses the resolved stored recipient in orchestration when no email arg is provided', async () => {
    const storedRecipient = 'saved@example.com';
    const sendCalls: Array<{ jobKey: string; recipient?: string }> = [];
    const exportCalls: string[] = [];
    const jobKey = '东南亚-销售';

    await seedJobRecord(jobKey, { recipientEmail: storedRecipient });
    await fs.mkdir(path.join(tempDir, '51job', 'jobs', jobKey, 'results'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '51job', 'jobs', jobKey, 'results', '2026-04-21T00-00-00.000Z.json'),
      JSON.stringify({
        jobKey,
        platform: '51job',
        fetchedAt: '2026-04-21T00:00:00.000Z',
        totalCandidates: 1,
        newCandidateIds: ['cand-old'],
        scoredCandidates: ['cand-old'],
        failedCandidates: [],
      }, null, 2),
      'utf8',
    );

    ensureAuthenticatedBrowserSessionRef.fn = async (_platform) => ({
      browser: {} as never,
      context: {} as never,
      page: {} as never,
    });
    openSubscribeSearchRef.fn = async () => ({}) as never;
    closeBrowserSessionRef.fn = async () => undefined;
    extractCandidateListRef.fn = async () => ({
      candidates: [],
    });
    exportJobResultsRef.fn = async (_platform, jobKey) => {
      exportCalls.push(jobKey);
      return {
        jobKey,
        exportPath: path.join(tempDir, 'exports', 'latest.md'),
        summary: {
          candidateCount: 0,
          successCount: 0,
          failureCount: 0,
        },
        markdown: '# export',
      };
    };
    sendJobReportRef.fn = async (_platform, jobKey, delivery) => {
      sendCalls.push({ jobKey, recipient: delivery?.recipientEmail });
      return {
        jobKey,
        recipient: delivery?.recipientEmail ?? storedRecipient,
        subject: 'no new candidates',
        summary: {
          candidateCount: 0,
          successCount: 0,
          failureCount: 0,
        },
      };
    };

    const outputChunks: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (value?: unknown) => {
      outputChunks.push(String(value));
    };

    try {
      const result = assertSinglePlatformSummary(await main([
        '--keyword',
        '东南亚 销售',
        '--jd',
        '职位名称：东南亚销售经理',
      ]));

      assert.equal(exportCalls.length, 1);
      assert.deepStrictEqual(sendCalls, [{ jobKey: '东南亚-销售', recipient: storedRecipient }]);
      assert.equal(result.exportError, undefined);
      assert.equal(result.emailError, undefined);
      assert.equal(result.newCandidates, 0);
      assert.equal(result.emailAttempted, true);
      assert.equal(result.emailDelivered, true);
      assert.equal(result.emailRecipient, storedRecipient);
      assert.match(outputChunks.join('\n'), /"emailAttempted": true/);
      assert.match(outputChunks.join('\n'), /"emailRecipient": "saved@example.com"/);
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('uses the resolved stored recipient for send orchestration decisions', async () => {
    const storedRecipient = 'saved@example.com';
    await seedJobRecord('东南亚销售经理', { recipientEmail: storedRecipient });

    let delegatedDelivery: ReportDeliveryOptions | undefined;
    sendJobReportRef.fn = async (_platform, _jobKey, delivery) => {
      delegatedDelivery = delivery;
      return {
        jobKey: '东南亚销售经理',
        recipient: delivery?.recipientEmail ?? storedRecipient,
        subject: 'no new candidates',
        summary: {
          candidateCount: 0,
          successCount: 0,
          failureCount: 0,
        },
      };
    };

    const result = await sendJobReportRef.fn('51job', '东南亚销售经理', { recipientEmail: storedRecipient });

    assert.deepStrictEqual(delegatedDelivery, { recipientEmail: storedRecipient });
    assert.equal(result.recipient, storedRecipient);
  });

  it('fails when no recipient email exists', async () => {
    const jobKey = `job-email-no-recipient-${Date.now()}`;
    await seedJobData(jobKey);

    await assert.rejects(() => sendJobReport('51job', jobKey), /No recipient email found for job key/);
  });

  it('fails when no latest run result exists', async () => {
    const jobKey = `job-email-no-run-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, { recipientEmail: 'saved@example.com' });
    await store.saveCandidateScoreArtifact('51job', jobKey, {
      candidateId: 'cand-1',
      model: 'claude-test',
      scoredAt: '2026-04-21T00:00:01.000Z',
      status: 'success',
      score: {
        totalScore: 88,
        dimensionScores: {
          education: { score: 88, reason: 'ok' },
          language: { score: 88, reason: 'ok' },
          experience: { score: 88, reason: 'ok' },
          industryMatch: { score: 88, reason: 'ok' },
          regionMatch: { score: 88, reason: 'ok' },
          responsibilityMatch: { score: 88, reason: 'ok' },
        },
        risks: [],
        summary: 'good fit for email verification',
      },
    });

    await assert.rejects(() => sendJobReport('51job', jobKey), /No run results found for job key/);
  });
});
