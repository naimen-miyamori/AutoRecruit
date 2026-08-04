import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import { hashBossScreeningPolicy } from '../scoring/boss-screening.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossForwardingOutboxEntry,
  BossRejectionEmailOutboxEntry,
  JobRecord,
} from '../types/job.js';
import { migrateBossModelScreeningPolicy } from './migrate-boss-model-screening.js';
import { migrateBossRejectionEmailContract } from './migrate-boss-rejection-email.js';

let tempDir: string;
let originalDataDir: string;

const normalizedJob = {
  title: '全铝箱包设计',
  majors: [],
  languageRequirements: [],
  responsibilities: [],
  hardRequirements: [],
  preferredRequirements: [],
  regionPreferences: [],
  industryTags: [],
};

function rawJob(jobKey: string, withSecondaryDelivery = true): Record<string, unknown> {
  return {
    jobKey,
    platform: 'boss',
    searchKeyword: '全铝箱包设计',
    rawText: 'JD',
    normalizedJob,
    createdAt: '2026-08-01T00:00:00.000Z',
    revision: 1,
    recipientEmail: 'primary@example.test',
    bossForwarding: { mode: 'email', recipient: 'primary-forward@example.test' },
    bossScreening: {
      enabled: true,
      policyVersion: 2,
      decisionMode: 'reject-on-any-missing',
      requirements: [{
        id: 'requirement-1',
        enabled: true,
        kind: 'modelRequirement',
        requirement: '要求',
        criteria: ['标准'],
        insufficientEvidence: ['证据不足'],
      }],
      secondaryForwarding: { mode: 'email', recipient: 'legacy-forward@example.test' },
      ...(withSecondaryDelivery ? { secondaryDelivery: { recipientEmail: 'secondary@example.test', ccEmails: [] } } : {}),
    },
  };
}

function rejectedOutbox(): BossForwardingOutboxEntry {
  return {
    candidateId: 'rejected-candidate',
    policyHash: 'old-policy',
    classification: 'rejected',
    audience: 'secondary',
    createdAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    forwarding: {
      status: 'pending',
      mode: 'email',
      recipient: 'legacy-forward@example.test',
    },
  };
}

function currentJob(jobKey: string): JobRecord {
  const value = rawJob(jobKey, true);
  const screening = value.bossScreening as Record<string, unknown>;
  delete screening.secondaryForwarding;
  return value as unknown as JobRecord;
}

function rejectionEmailOutbox(
  candidateId: string,
  status: BossRejectionEmailOutboxEntry['status'],
  policyHash = 'old-policy',
): BossRejectionEmailOutboxEntry {
  const decidedAt = '2026-08-01T02:00:00.000Z';
  const routingDecisionId = `decision-${candidateId}`;
  return {
    version: 1,
    deliveryId: `delivery-${candidateId}`,
    candidateId,
    routingDecisionId,
    routingArtifact: {
      routingDecisionId,
      candidateId,
      fetchedAt: decidedAt,
      decidedAt,
      policyHash,
      scoreStatus: 'success',
      classification: 'rejected',
      audience: 'secondary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '明确否定。',
      deliveryKind: 'rejection-email',
    },
    policyHash,
    recipientEmail: 'secondary@outlook.com',
    ccEmails: [],
    messageId: `<delivery-${candidateId}@autorecruit.local>`,
    subject: '明确否定',
    markdown: '完整简历',
    contentHash: 'immutable-content-hash',
    status,
    createdAt: decidedAt,
    updatedAt: decidedAt,
    ...(status === 'sent' ? { completedAt: decidedAt } : {}),
  };
}

function oldSettingsSnapshot(jobKey: string): Record<string, unknown> {
  return {
    version: 2,
    sourceJobKey: jobKey,
    primaryDelivery: { ccEmails: [] },
  };
}

function oldTaskSnapshot(jobKey: string): Record<string, unknown> {
  return {
    version: 3,
    sourceJobKey: jobKey,
    jobIdentity: { expectedJobName: '全铝箱包设计' },
    deliveryAndScreening: {},
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-rejection-migration-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('Boss rejection email contract migration', () => {
  it('dry-runs and then safely removes legacy settings and rejected forwarding', async () => {
    const jobKey = 'boss-rejection-migration';
    const store = new JobStore();
    const seed: JobRecord = {
      ...rawJob(jobKey, true),
      bossScreening: undefined,
    } as unknown as JobRecord;
    await store.saveJobRecord('boss', seed);
    const jobPath = path.join(tempDir, 'boss', 'jobs', jobKey, 'jd.json');
    await fs.writeFile(jobPath, `${JSON.stringify(rawJob(jobKey, true), null, 2)}\n`, 'utf8');
    await store.saveBossForwardingOutboxEntry('boss', jobKey, rejectedOutbox());

    const dryRun = await migrateBossRejectionEmailContract({ jobKey });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.settings.legacySecondaryForwarding, true);
    assert.equal(dryRun.settings.removed, false);
    assert.equal(dryRun.forwardingOutbox.supersededEntries, 1);
    assert.equal(dryRun.historicalEmailBackfill, 0);
    assert.equal(dryRun.receiptWritten, false);
    assert.match(await fs.readFile(jobPath, 'utf8'), /secondaryForwarding/);

    const applied = await migrateBossRejectionEmailContract({ jobKey, dryRun: false });
    assert.equal(applied.settings.removed, true);
    assert.equal(applied.receiptWritten, true);
    const migratedJob = await store.readJobRecord('boss', jobKey);
    assert.deepEqual(migratedJob.bossScreening?.secondaryDelivery, {
      recipientEmail: 'secondary@example.test',
      ccEmails: [],
    });
    assert.equal('secondaryForwarding' in (migratedJob.bossScreening ?? {}), false);
    assert.equal((await store.readBossForwardingOutboxEntry('boss', jobKey, 'rejected-candidate'))?.forwarding.status, 'superseded');

    const secondDryRun = await migrateBossRejectionEmailContract({ jobKey });
    assert.equal(secondDryRun.settings.legacySecondaryForwarding, false);
    assert.equal(secondDryRun.forwardingOutbox.supersededEntries, 0);
  });

  it('blocks an enabled legacy job when no rejection email recipient exists', async () => {
    const jobKey = 'boss-rejection-migration-blocked';
    const store = new JobStore();
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: 'JD',
      normalizedJob,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const jobPath = path.join(tempDir, 'boss', 'jobs', jobKey, 'jd.json');
    await fs.writeFile(jobPath, `${JSON.stringify(rawJob(jobKey, false), null, 2)}\n`, 'utf8');
    const result = await migrateBossRejectionEmailContract({ jobKey, dryRun: false });
    assert.equal(result.settings.blocked, true);
    assert.equal(result.receiptWritten, false);
    assert.ok(result.blockingIssues.some((issue) => issue.includes('secondaryDelivery recipient')));
    assert.match(await fs.readFile(jobPath, 'utf8'), /secondaryForwarding/);
  });

  it('supersedes unfinished old-policy rejection emails without changing terminal or current-policy delivery', async () => {
    const jobKey = 'boss-rejection-policy-migration';
    const store = new JobStore();
    const job = currentJob(jobKey);
    await store.saveJobRecord('boss', job);
    const currentPolicyHash = hashBossScreeningPolicy(job.bossScreening!);
    for (const entry of [
      rejectionEmailOutbox('old-pending', 'pending'),
      rejectionEmailOutbox('old-retryable', 'retryable-failed'),
      rejectionEmailOutbox('old-sending', 'sending'),
      rejectionEmailOutbox('old-sent', 'sent'),
      rejectionEmailOutbox('old-uncertain', 'uncertain'),
      rejectionEmailOutbox('current-pending', 'pending', currentPolicyHash),
    ]) {
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, entry);
    }

    const dryRun = await migrateBossModelScreeningPolicy({ jobKey, dryRun: true });
    assert.equal(dryRun.rejectionEmailEntries, 3);
    assert.equal(dryRun.supersededRejectionEmails, 2);
    assert.equal(dryRun.uncertainRejectionEmails, 1);
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-pending'))?.status, 'pending');

    const applied = await migrateBossModelScreeningPolicy({ jobKey, dryRun: false });
    assert.equal(applied.rejectionEmailEntries, 3);
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-pending'))?.status, 'superseded');
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-retryable'))?.status, 'superseded');
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-sending'))?.status, 'uncertain');
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-sent'))?.status, 'sent');
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-old-uncertain'))?.status, 'uncertain');
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'delivery-current-pending'))?.status, 'pending');
  });

  it('ignores terminal task history but blocks queued old snapshots for the target job', async () => {
    const jobKey = 'boss-rejection-task-scan';
    const store = new JobStore();
    await store.saveJobRecord('boss', currentJob(jobKey));
    const taskDir = path.join(tempDir, 'runtime', 'tasks');
    await fs.mkdir(taskDir, { recursive: true });
    const oldInput = {
      platform: 'boss',
      keyword: '全铝箱包设计',
      bossCaptureSettingsSnapshot: oldSettingsSnapshot(jobKey),
      bossCaptureTaskSnapshot: oldTaskSnapshot(jobKey),
      bossSecondaryForwardRecipient: 'legacy@example.test',
    };
    await fs.writeFile(
      path.join(taskDir, 'completed.json'),
      `${JSON.stringify({ status: 'succeeded', input: oldInput }, null, 2)}\n`,
      'utf8',
    );

    const terminalOnly = await migrateBossRejectionEmailContract({ jobKey });
    assert.equal(terminalOnly.snapshots.activeTaskFiles, 0);
    assert.equal(terminalOnly.snapshots.oldSettingsSnapshots, 0);
    assert.equal(terminalOnly.snapshots.oldTaskSnapshots, 0);
    assert.equal(terminalOnly.snapshots.requiresRequeue, false);

    await fs.writeFile(
      path.join(taskDir, 'queued.json'),
      `${JSON.stringify({ status: 'queued', input: oldInput }, null, 2)}\n`,
      'utf8',
    );
    const active = await migrateBossRejectionEmailContract({ jobKey });
    assert.equal(active.snapshots.activeTaskFiles, 1);
    assert.equal(active.snapshots.oldActiveSnapshots, 2);
    assert.equal(active.snapshots.oldSettingsSnapshots, 1);
    assert.equal(active.snapshots.oldTaskSnapshots, 1);
    assert.equal(active.snapshots.legacyActiveTaskInputs, 1);
    assert.equal(active.snapshots.requiresRequeue, true);
    assert.ok(active.blockingIssues.some((issue) => issue.includes('Active Boss tasks')));
  });

  it('follows only immutable batch snapshots and audits schedule templates separately', async () => {
    const jobKey = 'boss-rejection-batch-schedule-scan';
    const store = new JobStore();
    await store.saveJobRecord('boss', currentJob(jobKey));
    const snapshotPath = path.join(tempDir, 'server', 'task-snapshots', 'batch.json');
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify([{ keyword: '全铝箱包设计', bossCaptureSettingsSnapshot: oldSettingsSnapshot(jobKey) }], null, 2)}\n`,
      'utf8',
    );
    const externalJobsFile = path.join(tempDir, 'external-jobs.json');
    await fs.writeFile(
      externalJobsFile,
      `${JSON.stringify([{ keyword: '全铝箱包设计', bossCaptureTaskSnapshot: oldTaskSnapshot(jobKey) }], null, 2)}\n`,
      'utf8',
    );
    const taskDir = path.join(tempDir, 'runtime', 'tasks');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, 'batch.json'),
      `${JSON.stringify({ status: 'running', input: { platform: 'all', jobsFile: snapshotPath } }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(taskDir, 'external.json'),
      `${JSON.stringify({ status: 'queued', input: { platform: 'all', jobsFile: externalJobsFile } }, null, 2)}\n`,
      'utf8',
    );
    const scheduleDir = path.join(tempDir, 'runtime', 'schedules');
    await fs.mkdir(scheduleDir, { recursive: true });
    await fs.writeFile(
      path.join(scheduleDir, 'legacy.json'),
      `${JSON.stringify({
        tasks: [{
          input: {
            platform: 'boss',
            keyword: '全铝箱包设计',
            bossCaptureTaskSnapshot: oldTaskSnapshot(jobKey),
            bossSecondaryForwardMode: 'email',
          },
        }],
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateBossRejectionEmailContract({ jobKey });
    assert.equal(result.snapshots.activeTaskFiles, 1);
    assert.equal(result.snapshots.batchSnapshotFiles, 1);
    assert.equal(result.snapshots.scheduleTemplateFiles, 1);
    assert.equal(result.snapshots.oldSettingsSnapshots, 1);
    assert.equal(result.snapshots.oldTaskSnapshots, 1);
    assert.equal(result.snapshots.oldActiveSnapshots, 1);
    assert.equal(result.snapshots.oldScheduleSnapshots, 1);
    assert.equal(result.snapshots.legacyScheduleInputs, 1);
    assert.ok(result.blockingIssues.some((issue) => issue.includes('schedule templates contain old')));
    assert.ok(result.blockingIssues.some((issue) => issue.includes('deprecated secondary-forwarding')));
  });
});
