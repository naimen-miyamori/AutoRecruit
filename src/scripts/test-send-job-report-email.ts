import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import {
  buildBossRoutedMainRunEmailSummary,
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
import type {
  BossCandidateRoutingArtifact,
  BossRejectionEmailOutboxEntry,
  CandidateRoutingArtifact,
  CandidateScoreArtifact,
  JobRecord,
  ReportDeliveryOptions,
  RunResult,
} from '../types/job.js';
import { sendBossRoutedReports, sendJobReport, sendJobReportEmailRef, sendPostScoreRoutedReports } from './send-job-report-email.js';

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
  platform: '51job' | 'liepin' | 'zhilian' | 'boss' = '51job',
) {
  const store = new JobStore();
  const jobRecord: JobRecord = {
    jobKey,
    platform,
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

  await store.saveJobRecord(platform, jobRecord);
  return { store, jobRecord };
}

async function saveRunResult(store: JobStore, jobKey: string, runResult: RunResult, platform: '51job' | 'liepin' | 'zhilian' | 'boss' = '51job') {
  await store.saveRunResult(platform, jobKey, runResult);
}

function bossScoreArtifact(
  candidateId: string,
  status: CandidateScoreArtifact['status'] = 'success',
  risks: string[] = [],
): CandidateScoreArtifact {
  const base = {
    candidateId,
    model: 'claude-test',
    scoredAt: '2026-07-31T00:00:01.000Z',
  };
  if (status === 'failed') {
    return { ...base, status, error: 'simulated scoring failure' };
  }
  return {
    ...base,
    status,
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
      risks,
      summary: `${candidateId} scoring summary`,
    },
  };
}

interface BossRoutingSeed {
  candidateId: string;
  classification: BossCandidateRoutingArtifact['classification'];
  artifactStatus?: CandidateScoreArtifact['status'];
  matchedRequirementIds?: string[];
  unknownRequirementIds?: string[];
  evidence?: string[];
  missingCriteria?: string[];
  risks?: string[];
}

async function seedBossRoutedRun(
  jobKey: string,
  candidates: BossRoutingSeed[],
  options: { unroutedNewCandidateIds?: string[]; newContract?: boolean } = {},
): Promise<{ store: JobStore; fetchedAt: string }> {
  const store = new JobStore();
  const fetchedAt = '2026-07-31T00:00:02.000Z';
  const policyHash = 'boss-policy-hash';
  const qualifiedCandidateIds = candidates.filter((candidate) => candidate.classification === 'qualified').map((candidate) => candidate.candidateId);
  const reviewCandidateIds = candidates.filter((candidate) => candidate.classification === 'review').map((candidate) => candidate.candidateId);
  const rejectedCandidateIds = candidates.filter((candidate) => candidate.classification === 'rejected').map((candidate) => candidate.candidateId);
  const jobRecord: JobRecord = {
    jobKey,
    platform: 'boss',
    searchKeyword: 'Boss 测试岗位',
    recipientEmail: 'primary@example.com',
    ccEmails: ['primary-cc@example.com'],
    bossForwarding: { mode: 'email', recipient: 'primary-forward@example.com' },
    bossScreening: {
      enabled: true,
      policyVersion: 2,
      decisionMode: 'reject-on-any-missing',
      requirements: [{
        id: 'requirement-1',
        enabled: true,
        kind: 'modelRequirement',
        requirement: '满足测试岗位要求',
        criteria: ['明确证据'],
        insufficientEvidence: ['无证据'],
      }],
      secondaryDelivery: { recipientEmail: 'secondary@example.com', ccEmails: ['secondary-cc@example.com'] },
    },
    rawText: 'raw jd',
    normalizedJob: {
      title: 'Boss 测试岗位',
      majors: [],
      languageRequirements: [],
      responsibilities: [],
      hardRequirements: [],
      preferredRequirements: [],
      regionPreferences: [],
      industryTags: [],
    },
    createdAt: fetchedAt,
  };
  await store.saveJobRecord('boss', jobRecord);
  await Promise.all(candidates.map(async (candidate) => {
    const artifact = bossScoreArtifact(candidate.candidateId, candidate.artifactStatus, candidate.risks);
    await store.saveCandidateScoreArtifact('boss', jobKey, artifact);
    const audience = candidate.classification === 'rejected' ? 'secondary' : 'primary';
    const matchedRequirementIds = candidate.matchedRequirementIds ?? (candidate.classification === 'rejected' ? ['requirement-1'] : []);
    const unknownRequirementIds = candidate.unknownRequirementIds ?? (candidate.classification === 'review' ? ['requirement-1'] : []);
    await store.saveBossCandidateRoutingArtifact('boss', jobKey, {
      candidateId: candidate.candidateId,
      fetchedAt,
      scoredAt: artifact.scoredAt,
      decidedAt: `2026-07-31T00:00:0${candidates.indexOf(candidate) + 3}.000Z`,
      policyHash,
      scoreStatus: artifact.status,
      ...(artifact.status === 'failed' ? { scoreError: artifact.error } : {}),
      classification: candidate.classification,
      audience,
      requirementEvaluations: candidate.classification === 'rejected'
        ? [{
          requirementId: 'requirement-1',
          outcome: 'missing',
          evidence: candidate.evidence ?? [`${candidate.candidateId} 明确证据`],
          missingCriteria: candidate.missingCriteria ?? ['明确证据'],
          reason: 'missing',
        }]
        : candidate.classification === 'review'
          ? [{ requirementId: 'requirement-1', outcome: 'unknown', evidence: candidate.evidence ?? [], missingCriteria: [], reason: 'insufficient evidence' }]
          : [{ requirementId: 'requirement-1', outcome: 'satisfied', evidence: candidate.evidence ?? [`${candidate.candidateId} 明确证据`], missingCriteria: [], reason: 'satisfied' }],
      matchedRequirementIds,
      unknownRequirementIds,
      reason: candidate.classification === 'review' ? '条件证据不足，需要人工复核' : `${candidate.classification} routing result`,
      forwarding: { status: 'sent', mode: 'email', recipient: audience === 'primary' ? 'primary-forward@example.com' : 'secondary-forward@example.com' },
    });
  }));
  await store.saveRunResult('boss', jobKey, {
    jobKey,
    platform: 'boss',
    fetchedAt,
    totalCandidates: candidates.length + (options.unroutedNewCandidateIds?.length ?? 0),
    newCandidateIds: [
      ...candidates.map((candidate) => candidate.candidateId),
      ...(options.unroutedNewCandidateIds ?? []),
    ],
    scoredCandidates: candidates.filter((candidate) => (candidate.artifactStatus ?? 'success') === 'success').map((candidate) => candidate.candidateId),
    failedCandidates: [
      ...candidates.filter((candidate) => candidate.artifactStatus === 'failed').map((candidate) => ({ candidateId: candidate.candidateId, error: 'simulated scoring failure' })),
      ...(options.unroutedNewCandidateIds ?? []).map((candidateId) => ({ candidateId, error: 'simulated capture failure' })),
    ],
    bossRouting: {
      enabled: true,
      policyHash,
      reportDelivery: {
        primary: { recipientEmail: 'primary@example.com', ccEmails: ['immutable-primary-cc@example.com'] },
        secondary: { recipientEmail: 'secondary@example.com', ccEmails: ['immutable-secondary-cc@example.com'] },
      },
      qualifiedCandidateIds,
      reviewCandidateIds,
      rejectedCandidateIds,
      forwardingStatusCounts: { sent: candidates.length },
      ...(options.newContract ? { rejectionEmailStatusCounts: { sent: rejectedCandidateIds.length } } : {}),
    },
  });
  return { store, fetchedAt };
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

  it('uses Zhilian copied share links in report emails', async () => {
    const jobKey = `job-email-zhilian-share-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, { recipientEmail: 'saved@example.com' }, 'zhilian');
    await store.saveCandidateScoreArtifact('zhilian', jobKey, {
      candidateId: 'cand-zhilian-1',
      candidateShareUrl: 'https://m.zhaopin.com/b/resume-package?zhaopinToken=share-token-1',
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
        summary: 'good fit with share link',
      },
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: 'zhilian',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-zhilian-1'],
      scoredCandidates: ['cand-zhilian-1'],
      failedCandidates: [],
    }, 'zhilian');

    const sent: Array<{ markdown: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, markdown }) => {
      sent.push({ markdown });
      return { recipient, subject };
    };

    await sendJobReport('zhilian', jobKey);

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.markdown ?? '', /https:\/\/m\.zhaopin\.com\/b\/resume-package\?zhaopinToken=share-token-1/);
    assert.doesNotMatch(sent[0]?.markdown ?? '', /### cand-zhilian-1/);
  });

  it('fails Zhilian report emails when a current-run artifact has no copied share link', async () => {
    const jobKey = `job-email-zhilian-missing-share-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, { recipientEmail: 'saved@example.com' }, 'zhilian');
    await store.saveCandidateScoreArtifact('zhilian', jobKey, {
      candidateId: 'cand-zhilian-missing',
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
        summary: 'missing share link',
      },
    });
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: 'zhilian',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-zhilian-missing'],
      scoredCandidates: ['cand-zhilian-missing'],
      failedCandidates: [],
    }, 'zhilian');

    await assert.rejects(
      () => sendJobReport('zhilian', jobKey),
      /Missing Zhilian copied share link for candidate cand-zhilian-missing/,
    );
  });

  it('fails Zhilian report emails when copied share links are duplicated', async () => {
    const jobKey = `job-email-zhilian-duplicate-share-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, { recipientEmail: 'saved@example.com' }, 'zhilian');
    const duplicateShareLink = 'https://m.zhaopin.com/b/resume-package?zhaopinToken=duplicate-token';
    for (const candidateId of ['cand-zhilian-a', 'cand-zhilian-b']) {
      await store.saveCandidateScoreArtifact('zhilian', jobKey, {
        candidateId,
        candidateShareUrl: duplicateShareLink,
        model: 'claude-test',
        scoredAt: `2026-04-21T00:00:0${candidateId.endsWith('a') ? '1' : '2'}.000Z`,
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
          summary: 'duplicate share link',
        },
      });
    }
    await saveRunResult(store, jobKey, {
      jobKey,
      platform: 'zhilian',
      fetchedAt: '2026-04-21T00:00:03.000Z',
      totalCandidates: 2,
      newCandidateIds: ['cand-zhilian-a', 'cand-zhilian-b'],
      scoredCandidates: ['cand-zhilian-a', 'cand-zhilian-b'],
      failedCandidates: [],
    }, 'zhilian');

    await assert.rejects(
      () => sendJobReport('zhilian', jobKey),
      /Duplicate Zhilian copied share link for candidates cand-zhilian-a and cand-zhilian-b/,
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

  it('sends review candidates only to the primary Boss report and rejected candidates only to the secondary report', async () => {
    const jobKey = `boss-routed-reports-${Date.now()}`;
    await seedBossRoutedRun(jobKey, [
      {
        candidateId: 'qualified-candidate',
        classification: 'qualified',
        evidence: ['符合证据一', '符合证据二', '符合证据三不应出现'],
        risks: ['符合风险一', '符合风险二', '符合风险三不应出现'],
      },
      { candidateId: 'review-candidate', classification: 'review' },
      {
        candidateId: 'rejected-candidate',
        classification: 'rejected',
        evidence: ['简历信息一', '简历信息二', '简历信息三不应出现'],
        missingCriteria: ['缺失条件一', '缺失条件二', '缺失条件三不应出现'],
        risks: ['否定风险一', '否定风险二', '否定风险三不应出现'],
      },
    ]);
    const sent: Array<{ recipient: string; markdown: string; subject: string; ccEmails?: string[] }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, markdown, subject, ccEmails }) => {
      sent.push({ recipient, markdown, subject, ccEmails });
      return { recipient, subject };
    };

    const result = await sendBossRoutedReports(jobKey);

    assert.equal(sent.length, 2);
    const primary = sent.find((item) => item.recipient === 'primary@example.com');
    const secondary = sent.find((item) => item.recipient === 'secondary@example.com');
    assert.ok(primary);
    assert.ok(secondary);
    assert.equal(primary.subject, '【BOSS】Boss 测试岗位 评分结果（2/2）（主）');
    assert.equal(secondary.subject, '【BOSS】Boss 测试岗位 评分结果（1/1）（副）');
    assert.match(primary.markdown, /## 明确符合/);
    assert.match(primary.markdown, /## 需复核/);
    assert.match(primary.markdown, /qualified-candidate/);
    assert.match(primary.markdown, /review-candidate/);
    assert.doesNotMatch(primary.markdown, /rejected-candidate/);
    assert.match(primary.markdown, /满足依据：符合证据一；符合证据二/);
    assert.match(primary.markdown, /主要风险：符合风险一；符合风险二/);
    assert.doesNotMatch(primary.markdown, /符合证据三不应出现|符合风险三不应出现/);
    assert.match(secondary.markdown, /## 明确否定候选人/);
    assert.match(secondary.markdown, /rejected-candidate/);
    assert.match(secondary.markdown, /缺失条件：缺失条件一；缺失条件二/);
    assert.match(secondary.markdown, /简历信息：简历信息一；简历信息二/);
    assert.match(secondary.markdown, /主要风险：否定风险一；否定风险二/);
    assert.doesNotMatch(secondary.markdown, /缺失条件三不应出现|简历信息三不应出现|否定风险三不应出现/);
    assert.doesNotMatch(secondary.markdown, /qualified-candidate|review-candidate/);
    assert.doesNotMatch(`${primary.markdown}\n${secondary.markdown}`, /候选人速览|排名结果|维度评分|评分时间|模型:/);
    assert.deepStrictEqual(primary.ccEmails, ['immutable-primary-cc@example.com']);
    assert.deepStrictEqual(secondary.ccEmails, ['immutable-secondary-cc@example.com']);
    assert.equal(result.reportDeliveries.primary.delivered, true);
    assert.equal(result.reportDeliveries.secondary.delivered, true);
    assert.equal(result.reportDeliveries.primary.summary.candidateCount, 2);
    assert.equal(result.reportDeliveries.secondary.summary.candidateCount, 1);
  });

  it('summarizes secondary-only Boss report delivery in the legacy top-level email fields', () => {
    const summary = buildBossRoutedMainRunEmailSummary({
      primary: {
        jobKey: 'boss-secondary-only',
        audience: 'primary',
        attempted: false,
        delivered: false,
        skipReason: 'no-primary-audience-candidates',
        summary: { candidateCount: 0, successCount: 0, failureCount: 0 },
      },
      secondary: {
        jobKey: 'boss-secondary-only',
        audience: 'secondary',
        attempted: true,
        delivered: true,
        recipient: 'secondary@example.com',
        subject: 'secondary report',
        summary: { candidateCount: 15, successCount: 15, failureCount: 0 },
      },
    });

    assert.deepStrictEqual(summary, {
      emailAttempted: true,
      emailDelivered: true,
      emailRecipient: 'secondary@example.com',
      emailSubject: 'secondary report',
      emailError: undefined,
    });
  });

  it('skips the new rejected aggregate report and summarizes candidate-level email receipts', async () => {
    const jobKey = `boss-rejection-email-report-${Date.now()}`;
    const { store } = await seedBossRoutedRun(jobKey, [
      { candidateId: 'qualified-email-candidate', classification: 'qualified' },
      {
        candidateId: 'rejected-email-candidate',
        classification: 'rejected',
        missingCriteria: ['缺少明确证据'],
      },
      {
        candidateId: 'rejected-email-sending',
        classification: 'rejected',
        missingCriteria: ['发送状态待核对'],
      },
    ], { newContract: true });
    const routingArtifacts = await store.listBossCandidateRoutingArtifacts('boss', jobKey);
    const routingArtifact = routingArtifacts
      .find((artifact) => artifact.candidateId === 'rejected-email-candidate')!;
    const emailEntry: BossRejectionEmailOutboxEntry = {
      version: 1,
      deliveryId: 'rejection-report-delivery-1',
      candidateId: routingArtifact.candidateId,
      routingDecisionId: routingArtifact.routingDecisionId ?? 'rejection-report-decision-1',
      routingArtifact,
      policyHash: routingArtifact.policyHash,
      recipientEmail: 'secondary@example.com',
      ccEmails: ['secondary-cc@example.com'],
      messageId: '<rejection-report-delivery-1@autorecruit.local>',
      subject: '明确否定',
      markdown: '完整简历',
      contentHash: 'content-hash',
      status: 'sent',
      createdAt: routingArtifact.decidedAt,
      updatedAt: routingArtifact.decidedAt,
      completedAt: routingArtifact.decidedAt,
    };
    await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, emailEntry);
    const sendingArtifact = routingArtifacts
      .find((artifact) => artifact.candidateId === 'rejected-email-sending')!;
    await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, {
      ...emailEntry,
      deliveryId: 'rejection-report-delivery-sending',
      candidateId: sendingArtifact.candidateId,
      routingDecisionId: sendingArtifact.routingDecisionId ?? 'rejection-report-decision-sending',
      routingArtifact: sendingArtifact,
      messageId: '<rejection-report-delivery-sending@autorecruit.local>',
      status: 'sending',
      completedAt: undefined,
    });
    const sent: Array<{ recipient: string; subject: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sent.push({ recipient, subject });
      return { recipient, subject };
    };

    const result = await sendBossRoutedReports(jobKey);

    assert.deepStrictEqual(sent.map((item) => item.recipient), ['primary@example.com']);
    assert.equal(result.reportDeliveries.secondary.skipReason, 'rejected-candidates-delivered-individually');
    assert.deepStrictEqual(result.rejectionEmails, {
      eligible: 2,
      pending: 0,
      sending: 1,
      sent: 1,
      retryableFailed: 0,
      uncertain: 0,
      superseded: 0,
      failedCandidateIds: ['rejected-email-sending'],
      deliveryTargets: [{
        recipientEmail: 'secondary@example.com',
        ccEmails: ['secondary-cc@example.com'],
      }],
    });
  });

  it('keeps aggregate Boss email delivery false when any required audience report fails', () => {
    const summary = buildBossRoutedMainRunEmailSummary({
      primary: {
        jobKey: 'boss-partial-report-failure',
        audience: 'primary',
        attempted: true,
        delivered: true,
        recipient: 'primary@example.com',
        subject: 'primary report',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      },
      secondary: {
        jobKey: 'boss-partial-report-failure',
        audience: 'secondary',
        attempted: true,
        delivered: false,
        recipient: 'secondary@example.com',
        subject: 'secondary report',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        error: 'smtp failed',
      },
    });

    assert.equal(summary.emailAttempted, true);
    assert.equal(summary.emailDelivered, false);
    assert.equal(summary.emailRecipient, 'primary@example.com');
    assert.equal(summary.emailError, 'smtp failed');

    const immutableFailure = buildBossRoutedMainRunEmailSummary({
      primary: {
        jobKey: 'boss-immutable-rejection-failure',
        audience: 'primary',
        attempted: true,
        delivered: true,
        recipient: 'primary@example.com',
        subject: 'primary report',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      },
      secondary: {
        jobKey: 'boss-immutable-rejection-failure',
        audience: 'secondary',
        attempted: false,
        delivered: false,
        skipReason: 'rejected-candidates-delivered-individually',
        summary: { candidateCount: 0, successCount: 0, failureCount: 0 },
      },
    }, {
      enabled: true,
      policyHash: 'policy-hash',
      qualifiedCandidateIds: [],
      reviewCandidateIds: [],
      rejectedCandidateIds: ['invalid-immutable-target'],
      forwardingStatusCounts: {},
      rejectionEmailStatusCounts: { superseded: 1 },
    });
    assert.equal(immutableFailure.emailDelivered, false);
    assert.match(immutableFailure.emailError ?? '', /not confirmed sent/);
  });

  it('reports routed Boss candidates when another attempted candidate failed before scoring and routing', async () => {
    const jobKey = `boss-routed-with-capture-failure-${Date.now()}`;
    await seedBossRoutedRun(
      jobKey,
      [{ candidateId: 'review-candidate', classification: 'review', artifactStatus: 'failed' }],
      { unroutedNewCandidateIds: ['capture-failed-candidate'] },
    );
    const sent: Array<{ recipient: string; markdown: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, markdown, subject }) => {
      sent.push({ recipient, markdown });
      return { recipient, subject };
    };

    const result = await sendBossRoutedReports(jobKey);

    assert.equal(result.reportDeliveries.primary.delivered, true);
    assert.equal(result.reportDeliveries.primary.summary.candidateCount, 1);
    assert.equal(result.reportDeliveries.secondary.skipReason, 'no-rejected-candidates');
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.markdown ?? '', /review-candidate/);
    assert.doesNotMatch(sent[0]?.markdown ?? '', /capture-failed-candidate/);
  });

  it('sends a primary report for review-only Boss runs and skips primary when every routed candidate is rejected', async () => {
    const reviewOnlyKey = `boss-review-only-${Date.now()}`;
    await seedBossRoutedRun(reviewOnlyKey, [{ candidateId: 'review-candidate', classification: 'review' }]);
    const sent: Array<{ recipient: string; markdown: string; subject: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, markdown, subject }) => {
      sent.push({ recipient, markdown, subject });
      return { recipient, subject };
    };
    const reviewOnly = await sendBossRoutedReports(reviewOnlyKey);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.recipient, 'primary@example.com');
    assert.match(sent[0]?.markdown ?? '', /需复核/);
    assert.equal(reviewOnly.reportDeliveries.primary.delivered, true);
    assert.equal(reviewOnly.reportDeliveries.secondary.skipReason, 'no-rejected-candidates');

    const rejectedOnlyKey = `boss-rejected-only-${Date.now()}`;
    await seedBossRoutedRun(rejectedOnlyKey, [{ candidateId: 'rejected-candidate', classification: 'rejected' }]);
    sent.length = 0;
    const rejectedOnly = await sendBossRoutedReports(rejectedOnlyKey);
    assert.deepStrictEqual(sent.map((item) => item.recipient), ['secondary@example.com']);
    assert.equal(rejectedOnly.reportDeliveries.primary.attempted, false);
    assert.equal(rejectedOnly.reportDeliveries.primary.skipReason, 'no-primary-audience-candidates');
    assert.equal(rejectedOnly.reportDeliveries.secondary.delivered, true);
  });

  it('requires an explicit audience for manual Boss replay and never sends an unfiltered second report', async () => {
    const jobKey = `boss-manual-audience-${Date.now()}`;
    await seedBossRoutedRun(jobKey, [
      { candidateId: 'qualified-candidate', classification: 'qualified' },
      { candidateId: 'rejected-candidate', classification: 'rejected' },
    ]);
    const sent: Array<{ recipient: string; markdown: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, markdown, subject }) => {
      sent.push({ recipient, markdown });
      return { recipient, subject };
    };

    const primary = await sendJobReport('boss', jobKey);
    assert.equal(primary.audience, 'primary');
    assert.deepStrictEqual(sent.map((item) => item.recipient), ['primary@example.com']);
    assert.doesNotMatch(sent[0]?.markdown ?? '', /rejected-candidate/);

    sent.length = 0;
    const secondary = await sendJobReport('boss', jobKey, {}, { audience: 'secondary' });
    assert.equal(secondary.audience, 'secondary');
    assert.deepStrictEqual(sent.map((item) => item.recipient), ['secondary@example.com']);
    assert.doesNotMatch(sent[0]?.markdown ?? '', /qualified-candidate/);
  });

  it('uses latest-run routing facts even when the current Boss screening switch is changed', async () => {
    const jobKey = `boss-routing-current-switch-${Date.now()}`;
    const { store } = await seedBossRoutedRun(jobKey, [
      { candidateId: 'qualified-candidate', classification: 'qualified' },
      { candidateId: 'rejected-candidate', classification: 'rejected' },
    ]);
    const current = await store.readJobRecord('boss', jobKey);
    await store.saveJobRecord('boss', {
      ...current,
      bossScreening: current.bossScreening ? { ...current.bossScreening, enabled: false } : undefined,
    });

    const sent: Array<{ recipient: string; markdown: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, markdown, subject }) => {
      sent.push({ recipient, markdown });
      return { recipient, subject };
    };

    const result = await sendJobReport('boss', jobKey);

    assert.equal(result.audience, 'primary');
    assert.deepStrictEqual(sent.map((item) => item.recipient), ['primary@example.com']);
    assert.match(sent[0]?.markdown ?? '', /qualified-candidate/);
    assert.doesNotMatch(sent[0]?.markdown ?? '', /rejected-candidate/);
  });

  it('uses immutable report recipients and CC from the latest Boss run after job settings change', async () => {
    const jobKey = `boss-routing-immutable-delivery-${Date.now()}`;
    const { store } = await seedBossRoutedRun(jobKey, [{ candidateId: 'qualified-candidate', classification: 'qualified' }]);
    const current = await store.readJobRecord('boss', jobKey);
    await store.saveJobRecord('boss', {
      ...current,
      recipientEmail: 'changed-after-run@example.com',
      ccEmails: ['changed-after-run-cc@example.com'],
      bossScreening: current.bossScreening
        ? { ...current.bossScreening, secondaryDelivery: { recipientEmail: 'changed-secondary@example.com', ccEmails: ['changed-secondary-cc@example.com'] } }
        : undefined,
    });

    const sent: Array<{ recipient: string; ccEmails?: string[] }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, ccEmails, subject }) => {
      sent.push({ recipient, ccEmails });
      return { recipient, subject };
    };

    await sendBossRoutedReports(jobKey);
    assert.deepStrictEqual(sent, [{
      recipient: 'primary@example.com',
      ccEmails: ['immutable-primary-cc@example.com'],
    }]);
  });

  it('fails closed before SMTP when Boss routing facts do not cover the current routing index', async () => {
    const jobKey = `boss-routing-missing-fact-${Date.now()}`;
    const { store } = await seedBossRoutedRun(jobKey, [{ candidateId: 'rejected-candidate', classification: 'rejected' }]);
    const routingDir = path.join(tempDir, 'boss', 'jobs', jobKey, 'routing', 'artifacts');
    const files = await fs.readdir(routingDir);
    await fs.unlink(path.join(routingDir, files[0]!));
    let sendAttempted = false;
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sendAttempted = true;
      return { recipient, subject };
    };

    await assert.rejects(() => sendBossRoutedReports(jobKey), /Boss routing facts does not match the current run/);
    assert.equal(sendAttempted, false);
    assert.ok(store);
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

  it('routes non-Boss Liepin reports by model result without invoking native forwarding', async () => {
    const jobKey = `liepin-routing-report-${Date.now()}`;
    const { store } = await seedJobRecord(jobKey, {
      recipientEmail: 'primary@example.com',
      ccEmails: ['primary-cc@example.com'],
    }, 'liepin');
    const current = await store.readJobRecord('liepin', jobKey);
    await store.saveJobRecord('liepin', {
      ...current,
      postScoreRouting: {
        enabled: true,
        policyVersion: 2,
        decisionMode: 'reject-on-any-missing',
        requirements: [{
          id: 'requirement-1', enabled: true, kind: 'modelRequirement', requirement: '测试要求',
          criteria: ['明确证据'], insufficientEvidence: ['无证据'],
        }],
        secondaryDelivery: { recipientEmail: 'secondary@example.com', ccEmails: ['secondary-cc@example.com'] },
      },
    });
    const qualified = bossScoreArtifact('qualified-liepin');
    const rejected = { ...bossScoreArtifact('rejected-liepin'), scoredAt: '2026-07-31T00:00:02.000Z' };
    await store.saveCandidateScoreArtifact('liepin', jobKey, qualified);
    await store.saveCandidateScoreArtifact('liepin', jobKey, rejected);
    const saveRoutingArtifact = async (artifact: CandidateRoutingArtifact) => store.saveCandidateRoutingArtifact('liepin', jobKey, artifact);
    await saveRoutingArtifact({
      routingDecisionId: 'liepin-routing-qualified', candidateId: qualified.candidateId, fetchedAt: '2026-07-31T00:00:00.000Z', scoredAt: qualified.scoredAt, decidedAt: '2026-07-31T00:00:03.000Z', policyHash: 'liepin-policy', scoreStatus: 'success', classification: 'qualified', audience: 'primary', requirementEvaluations: [{ requirementId: 'requirement-1', outcome: 'satisfied', evidence: ['明确证据'], missingCriteria: [], reason: 'ok' }], matchedRequirementIds: [], unknownRequirementIds: [], reason: '满足',
    });
    await saveRoutingArtifact({
      routingDecisionId: 'liepin-routing-rejected', candidateId: rejected.candidateId, fetchedAt: '2026-07-31T00:00:00.000Z', scoredAt: rejected.scoredAt, decidedAt: '2026-07-31T00:00:04.000Z', policyHash: 'liepin-policy', scoreStatus: 'success', classification: 'rejected', audience: 'secondary', requirementEvaluations: [{ requirementId: 'requirement-1', outcome: 'missing', evidence: [], missingCriteria: ['明确证据'], reason: 'missing' }], matchedRequirementIds: ['requirement-1'], unknownRequirementIds: [], reason: '明确否定',
    });
    await store.saveRunResult('liepin', jobKey, {
      jobKey, platform: 'liepin', fetchedAt: '2026-07-31T00:00:00.000Z', totalCandidates: 2,
      capturedCandidateIds: [qualified.candidateId, rejected.candidateId], runResultVersion: 2,
      scoredCandidates: [qualified.candidateId, rejected.candidateId], failedCandidates: [],
      postScoreRouting: {
        enabled: true, policyHash: 'liepin-policy',
        reportDelivery: {
          primary: { recipientEmail: 'primary@example.com', ccEmails: ['primary-cc@example.com'] },
          secondary: { recipientEmail: 'secondary@example.com', ccEmails: ['secondary-cc@example.com'] },
        },
        qualifiedCandidateIds: [qualified.candidateId], reviewCandidateIds: [], rejectedCandidateIds: [rejected.candidateId],
      },
    });
    const sent: Array<{ recipient: string; ccEmails?: string[]; subject: string; markdown: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, ccEmails, subject, markdown }) => {
      sent.push({ recipient, ccEmails, subject, markdown });
      return { recipient, subject };
    };
    const result = await sendPostScoreRoutedReports('liepin', jobKey);
    assert.equal(result.reportDeliveries.primary.delivered, true);
    assert.equal(result.reportDeliveries.secondary.delivered, true);
    assert.deepEqual(sent.map((item) => item.recipient), ['primary@example.com', 'secondary@example.com']);
    assert.match(sent[0]!.subject, /^【猎聘】/);
    assert.match(sent[0]!.markdown, /qualified-liepin/);
    assert.doesNotMatch(sent[0]!.markdown, /rejected-liepin/);
    assert.match(sent[1]!.markdown, /rejected-liepin/);
  });
});
