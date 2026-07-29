import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTalentMappingPlanFile } from '../talent-mapping/plan.js';
import {
  buildMappingProfileObservationId,
  buildPlatformCandidateKey,
  createMappingCandidateObservation,
} from '../talent-mapping/normalization.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import { buildMappingRunContract } from '../talent-mapping/run-contract.js';
import type { MappingProfileObservation, MappingRunRecord } from '../types/talent-mapping.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.example.json', import.meta.url));

function emptyResume(candidateId: string) {
  return {
    candidateId,
    regions: [],
    pr: [],
    workExperiences: [],
    projectExperiences: [],
    educationExperiences: [],
    skill: [],
    certificates: [],
  };
}

describe('TalentMappingStore', () => {
  it('keeps project writes stable and appends card/profile observations idempotently with platform isolation', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-store-'));
    const now = new Date('2026-07-28T02:00:00.000Z');
    const store = new TalentMappingStore({ dataDir, now: () => now });
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });

    try {
      const firstSave = await store.saveProject(plan, fixturePath);
      const secondSave = await store.saveProject(plan, fixturePath);
      assert.equal(firstSave.changed, true);
      assert.equal(secondSave.changed, false);
      assert.deepStrictEqual(secondSave.project, firstSave.project);

      const observation51job = createMappingCandidateObservation({
        candidate: {
          candidateId: 'candidate-1',
          name: '候选人甲',
          currentCompany: '示例零售（中国）有限公司',
          currentTitle: '区域运营经理',
          cardText: '上海',
        },
        plan,
        runId: 'run-1',
        sliceId: plan.slices[0].sliceId,
        platform: '51job',
        observedAt: now.toISOString(),
        batchIdentity: 'batch-1',
        batchNumber: 1,
        rankInBatch: 1,
      });
      const observationLiepin = createMappingCandidateObservation({
        candidate: { candidateId: 'candidate-1', name: '候选人乙' },
        plan,
        runId: 'run-1',
        sliceId: plan.slices[0].sliceId,
        platform: 'liepin',
        observedAt: now.toISOString(),
        batchIdentity: 'batch-1',
        batchNumber: 1,
        rankInBatch: 1,
      });

      assert.equal(await store.appendCandidateObservation(observation51job), true);
      assert.equal(await store.appendCandidateObservation(observation51job), false);
      assert.equal(await store.appendCandidateObservation(observationLiepin), true);
      const observations = await store.readCandidateObservations(plan.mappingKey);
      assert.equal(observations.length, 2);
      assert.deepStrictEqual(new Set(observations.map((item) => item.platform)), new Set(['51job', 'liepin']));

      const profileObservation: MappingProfileObservation = {
        profileObservationId: buildMappingProfileObservationId({
          runId: 'run-1',
          platform: '51job',
          candidateId: 'candidate-1',
        }),
        runId: 'run-1',
        mappingKey: plan.mappingKey,
        sliceId: plan.slices[0].sliceId,
        platform: '51job',
        platformCandidateKey: buildPlatformCandidateKey('51job', 'candidate-1'),
        candidateId: 'candidate-1',
        observedAt: now.toISOString(),
        resume: emptyResume('candidate-1'),
        source: 'resume-detail',
        detailOpenSideEffect: 'may-mark-viewed',
        selectionReason: ['target-company-tier:A'],
      };
      const profileFirst = await store.appendProfileObservation(profileObservation, { rawText: '脱敏详情文本' });
      const profileSecond = await store.appendProfileObservation(profileObservation, { rawText: '脱敏详情文本' });
      const profileConflict = await store.appendProfileObservation(profileObservation, { rawText: '内容不同的重试详情文本' });
      assert.equal(profileFirst.appended, true);
      assert.equal(profileSecond.appended, false);
      assert.equal(profileConflict.appended, false);
      assert.match(profileFirst.observation.rawSnapshotPath ?? '', /^platforms\/51job\/snapshots\//);
      assert.match(profileFirst.observation.rawSnapshotPath ?? '', /[a-f0-9]{64}\.txt$/);
      assert.equal(profileFirst.observation.rawSnapshotSha256?.length, 64);
      assert.equal(profileConflict.observation.rawSnapshotSha256, profileFirst.observation.rawSnapshotSha256);
      assert.equal((await store.readProfileSnapshotConflicts(plan.mappingKey)).length, 1);
      assert.equal((await store.readProfileObservations(plan.mappingKey)).length, 1);

      await store.saveCheckpoint({
        runId: 'run-1',
        mappingKey: plan.mappingKey,
        sliceId: plan.slices[0].sliceId,
        platform: '51job',
        batchIdentity: 'batch-1',
        batchNumber: 1,
        observedCards: 1,
        savedAt: now.toISOString(),
      });

      const run: MappingRunRecord = {
        runId: 'run-1',
        mappingKey: plan.mappingKey,
        mappingName: plan.name,
        stage: 'all',
        platformSelection: 'all',
        status: 'completed',
        detailOpenConfirmed: true,
        detailOpenSideEffect: 'may-mark-viewed',
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        sliceRuns: [{
          runId: 'run-1',
          mappingKey: plan.mappingKey,
          sliceId: plan.slices[0].sliceId,
          platform: '51job',
          status: 'completed',
          reportedResultTotal: 1,
          reportedResultTotalSource: 'page',
          scannedBatches: 1,
          observedCards: 1,
          uniquePlatformProfiles: 1,
          eligibleForDetail: 1,
          enrichedProfiles: 1,
          failedProfiles: [],
          terminationReason: 'end-reached',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        }],
      };
      await store.saveRun(run);
      const views = await store.rebuildDerivedViews(plan.mappingKey);
      assert.equal(views.candidates.length, 2);
      assert.equal(views.candidates.find((item) => item.platform === '51job')?.detailStatus, 'enriched');
      assert.equal(views.coverage[0].coverageStatus, 'complete');

      assert.equal(await fs.stat(path.join(dataDir, 'talent-mapping', plan.mappingKey, 'runs', 'run-1.json')).then(() => true), true);
      await assert.rejects(() => fs.stat(path.join(dataDir, '51job', 'jobs')), /ENOENT/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('creates a new run ID for recovery instead of extending a failed run identity', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-run-id-'));
    try {
      const store = new TalentMappingStore({ dataDir });
      const first = store.createRunId();
      const second = store.createRunId();
      assert.notEqual(first, second);
      assert.doesNotMatch(first, /[/:]/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('persists an immutable, hashed plan snapshot for each run', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-contract-'));
    const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
    try {
      const store = new TalentMappingStore({ dataDir });
      const contract = buildMappingRunContract({
        plan,
        runId: 'contract-run',
        platformSelection: 'all',
        capturedAt: '2026-07-28T04:00:00.000Z',
      });
      await store.saveRunContract(contract);
      assert.deepStrictEqual(await store.readRunContract(plan.mappingKey, 'contract-run'), contract);
      await assert.rejects(
        () => store.saveRunContract({ ...contract, scanContractHash: 'tampered' }),
        /immutable and does not match the existing snapshot/,
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
