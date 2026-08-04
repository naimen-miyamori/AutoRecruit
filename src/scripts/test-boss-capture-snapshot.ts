import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  snapshotBossBatchCaptureSettings,
  snapshotBossCaptureSettings,
  hashBossCaptureTaskSnapshot,
} from '../server/boss-capture-snapshot.js';
import {
  normalizeBatchTask,
  normalizeResumeCaptureTask,
} from '../server/task-normalizers.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import type { JobRecord } from '../types/job.js';
import { JobConfigConflictError, JobStore } from '../storage/job-store.js';
import { fingerprintSavedSearchConditionIdentity } from '../platforms/boss/saved-search-identity.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-snapshot-'));
}

function resolverFor(planOverrides: Record<string, unknown> = {}) {
  return async (input: { jobName: string; bossJobId?: string }) => ({
    platform: 'boss' as const,
    jobKey: '全铝箱包设计-boss-position-1',
    bossJobId: input.bossJobId ?? 'boss-position-1',
    expectedJobName: input.jobName,
    search: {
      source: 'direct' as const,
      pageKeyword: '铝箱包',
      keywordSource: 'run-override' as const,
      conditions: [{ kind: 'keyword', value: '铝箱包' }],
      selectedFieldsFingerprint: 'catalog-v1',
      ...planOverrides,
    },
    jobRecord: {
      jobKey: '全铝箱包设计-boss-position-1',
      platform: 'boss' as const,
      revision: 7,
      searchKeyword: input.jobName,
      rawText: 'JD',
      normalizedJob: {
        title: input.jobName,
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-08-01T00:00:00.000Z',
    } satisfies JobRecord,
  });
}

function noConditionSetService(): Pick<SearchConditionSetService, 'resolve'> {
  return { resolve: async () => { throw new Error('condition set should not be resolved'); } };
}

describe('Boss capture task snapshots', () => {
  it('pins identity, complete search plan, source revision, and canonical hash', async () => {
    const normalized = normalizeResumeCaptureTask({
      platform: 'boss',
      keyword: '全铝箱包设计',
      bossJobId: 'boss-position-1',
      bossSearchKeyword: '铝箱包',
      searchSource: 'direct',
      email: 'primary@example.com',
      cc: [],
    });
    const snapshot = await snapshotBossCaptureSettings(normalized, {
      resolveBossCapturePlan: resolverFor(),
      searchConditionSets: noConditionSetService(),
    });
    const taskSnapshot = snapshot.input.bossCaptureTaskSnapshot;
    assert.ok(taskSnapshot);
    assert.equal(taskSnapshot.version, 3);
    assert.equal(taskSnapshot.sourceJobRevision, 7);
    assert.equal(taskSnapshot.jobIdentity.bossJobId, 'boss-position-1');
    assert.equal(taskSnapshot.searchPlan.pageKeyword, '铝箱包');
    assert.deepEqual(taskSnapshot.searchPlan.conditions, [{ kind: 'keyword', value: '铝箱包' }]);
    assert.deepEqual(taskSnapshot.deliveryAndScreening.primaryDelivery.ccEmails, []);
    const { snapshotHash, ...unsigned } = taskSnapshot;
    assert.equal(snapshotHash, hashBossCaptureTaskSnapshot(unsigned));
    assert.equal(snapshotHash, hashBossCaptureTaskSnapshot({ ...unsigned, resolvedAt: '2026-08-02T00:00:00.000Z' }));
    assert.equal(snapshot.inputSummary.bossCaptureTaskSnapshotHash, snapshotHash);
  });

  it('clears an incompatible stored saved-search reference when the queued task explicitly switches to direct', async () => {
    const normalized = normalizeResumeCaptureTask({
      platform: 'boss',
      keyword: '全铝箱包设计',
      bossJobId: 'boss-position-1',
      bossSearchKeyword: '铝箱包',
      searchSource: 'direct',
    });
    const snapshot = await snapshotBossCaptureSettings(normalized, {
      resolveBossCapturePlan: resolverFor(),
      searchConditionSets: noConditionSetService(),
    });
    assert.equal(snapshot.input.bossCaptureTaskSnapshot?.canonicalPatch?.searchSource, 'direct');
    assert.equal(snapshot.input.bossCaptureTaskSnapshot?.canonicalPatch?.savedSearch, null);
  });

  it('materializes batch-relative paths and records source item identity', async () => {
    const dataDir = await makeTempDir();
    const jobsDir = path.join(dataDir, 'jobs');
    const jobsFile = path.join(jobsDir, 'jobs.json');
    await fs.mkdir(jobsDir, { recursive: true });
    await fs.mkdir(path.join(jobsDir, 'filters'), { recursive: true });
    await fs.writeFile(path.join(jobsDir, 'filters', 'selected.json'), '{}', 'utf8');
    await fs.writeFile(jobsFile, JSON.stringify([{
      keyword: '全铝箱包设计',
      bossJobId: 'boss-position-1',
      bossSearchKeyword: '铝箱包',
      searchSource: 'direct',
      applicationFilterInputFile: './filters/selected.json',
    }]), 'utf8');

    const normalized = normalizeBatchTask({
      platform: 'boss',
      jobsFile,
      searchSource: 'direct',
    });
    const snapshot = await snapshotBossBatchCaptureSettings(normalized, {
      dataDir,
      resolveBossCapturePlan: resolverFor(),
      searchConditionSets: noConditionSetService(),
    });
    assert.notEqual(snapshot.input.jobsFile, jobsFile);
    const materialized = JSON.parse(await fs.readFile(snapshot.input.jobsFile, 'utf8')) as Array<Record<string, unknown>>;
    assert.equal(materialized.length, 1);
    assert.equal(materialized[0]?.applicationFilterInputFile, path.join(jobsDir, 'filters', 'selected.json'));
    const taskSnapshot = materialized[0]?.bossCaptureTaskSnapshot as { sourceJobsFile?: string; sourceItemIndex?: number };
    assert.equal(taskSnapshot.sourceJobsFile, path.resolve(jobsFile));
    assert.equal(taskSnapshot.sourceItemIndex, 0);
  });

  it('passes a complete per-item Boss saved-search reference into batch plan resolution', async () => {
    const dataDir = await makeTempDir();
    const jobsFile = path.join(dataDir, 'jobs.json');
    const conditionIdentity = {
      jobScope: '全铝箱包设计',
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'batch-subscription-1',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };
    await fs.writeFile(jobsFile, JSON.stringify([{
      keyword: '全铝箱包设计',
      bossJobId: 'boss-position-1',
      searchSource: 'saved',
      bossSavedSearchReference: savedSearch,
    }]), 'utf8');
    const normalized = normalizeBatchTask({ platform: 'boss', jobsFile });
    let observedReference: unknown;
    const baseResolver = resolverFor({
      source: 'saved',
      pageKeyword: savedSearch.expectedKeyword,
      keywordSource: 'run-override',
      conditions: [],
      savedSearch,
      sortPolicy: 'match-priority',
    });
    const snapshot = await snapshotBossBatchCaptureSettings(normalized, {
      dataDir,
      resolveBossCapturePlan: async (input) => {
        observedReference = input.savedSearchReference;
        return baseResolver(input);
      },
      searchConditionSets: noConditionSetService(),
    });
    assert.deepEqual(observedReference, savedSearch);
    const materialized = JSON.parse(await fs.readFile(snapshot.input.jobsFile, 'utf8')) as Array<{
      bossCaptureTaskSnapshot?: { searchPlan?: { savedSearch?: unknown } };
    }>;
    assert.deepEqual(materialized[0]?.bossCaptureTaskSnapshot?.searchPlan?.savedSearch, savedSearch);
  });
});

describe('JobStore job configuration CAS', () => {
  it('persists explicit empty CC and rejects stale revisions', async () => {
    const dataDir = await makeTempDir();
    const store = new JobStore(dataDir);
    const job: JobRecord = {
      jobKey: 'cas-job',
      platform: 'boss',
      searchKeyword: 'CAS 测试',
      recipientEmail: 'primary@example.com',
      ccEmails: ['old@example.com'],
      rawText: 'JD',
      normalizedJob: {
        title: 'CAS 测试',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    await store.saveJobRecord('boss', job);
    const first = await store.readJobRecord('boss', 'cas-job');
    assert.equal(first.revision, 1);
    const updated = await store.applyJobConfigPatch('boss', 'cas-job', 1, { ccEmails: [] });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.ccEmails, []);
    await assert.rejects(
      () => store.applyJobConfigPatch('boss', 'cas-job', 1, { ccEmails: ['stale@example.com'] }),
      (error: unknown) => error instanceof JobConfigConflictError
        && error.expectedRevision === 1
        && error.actualRevision === 2,
    );
    assert.deepEqual((await store.readJobRecord('boss', 'cas-job')).ccEmails, []);
  });

  it('writes routing artifacts by decision ID idempotently and rejects content conflicts', async () => {
    const dataDir = await makeTempDir();
    const store = new JobStore(dataDir);
    const artifact = {
      routingDecisionId: 'decision-1',
      candidateId: 'candidate-1',
      fetchedAt: '2026-08-01T00:00:00.000Z',
      decidedAt: '2026-08-01T00:00:01.000Z',
      policyHash: 'a'.repeat(64),
      scoreStatus: 'success' as const,
      classification: 'qualified' as const,
      audience: 'primary' as const,
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: 'ok',
      forwarding: { status: 'pending' as const, mode: 'email' as const, recipient: 'primary@example.com' },
    };
    const first = await store.saveBossCandidateRoutingArtifact('boss', 'cas-routing', artifact);
    const second = await store.saveBossCandidateRoutingArtifact('boss', 'cas-routing', artifact);
    assert.equal(second, first);
    await assert.rejects(
      () => store.saveBossCandidateRoutingArtifact('boss', 'cas-routing', { ...artifact, reason: 'changed' }),
      /already exists with different content/,
    );
  });
});
