import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from '../server/routes.js';
import { normalizeTalentMappingTask } from '../server/task-normalizers.js';
import { TaskQueue } from '../server/task-queue.js';
import { loadTalentMappingPlanFile } from '../talent-mapping/plan.js';
import { createMappingCandidateObservation } from '../talent-mapping/normalization.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import type { TaskDetail } from '../server/types.js';
import type { MappingClassificationSuggestion, MappingRunRecord, TalentMappingRunSummary } from '../types/talent-mapping.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.example.json', import.meta.url));

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-server-'));
}

async function waitForTask(queue: TaskQueue, taskId: string): Promise<TaskDetail> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const task = await queue.getTask(taskId);
    if (task && task.status !== 'queued' && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

function buildSummary(): TalentMappingRunSummary {
  return {
    mode: 'talent-mapping',
    mappingKey: 'retail-operations-shanghai',
    runId: 'mapping-run-1',
    stage: 'scan',
    status: 'completed-with-gaps',
    platformSelection: 'all',
    observedCards: 8,
    uniquePlatformProfiles: 6,
    enrichedProfiles: 0,
    failedProfiles: 0,
    cappedSlices: 1,
    exportDir: '/tmp/mapping/export',
    runPath: '/tmp/mapping/run.json',
    detailOpenSideEffect: 'none',
  };
}

describe('Talent Mapping server contracts', () => {
  it('normalizes only isolated core-platform Mapping tasks and requires current-run detail confirmation', async () => {
    const normalized = await normalizeTalentMappingTask({
      platform: 'all',
      talentMappingFile: fixturePath,
      mappingStage: 'scan',
    });
    assert.deepStrictEqual(normalized.argv, [
      '--platform', 'all',
      '--talent-mapping-file', fixturePath,
      '--mapping-stage', 'scan',
    ]);
    assert.equal(normalized.inputSummary.confirmedDetailOpen, false);

    const enrich = await normalizeTalentMappingTask({
      platform: '51job',
      talentMappingFile: fixturePath,
      mappingStage: 'enrich',
      mappingRunId: 'scan-run-1',
      confirmedDetailOpen: true,
    });
    assert.deepStrictEqual(enrich.argv.slice(-4), [
      '--mapping-confirm-detail-open', 'true', '--mapping-run-id', 'scan-run-1',
    ]);

    await assert.rejects(() => normalizeTalentMappingTask({
      platform: 'boss', talentMappingFile: fixturePath, mappingStage: 'scan',
    }), /51job, liepin, zhilian, or all/);
    await assert.rejects(() => normalizeTalentMappingTask({
      platform: 'all', talentMappingFile: fixturePath, mappingStage: 'all',
    }), /confirmedDetailOpen=true/);
    await assert.rejects(() => normalizeTalentMappingTask({
      platform: 'all', talentMappingFile: fixturePath, mappingStage: 'scan', confirmedDetailOpen: true,
    }), /valid only with mappingStage enrich or all/);
    await assert.rejects(() => normalizeTalentMappingTask({
      platform: 'all', talentMappingFile: fixturePath, mappingStage: 'all', mappingRunId: 'scan-run-1', confirmedDetailOpen: true,
    }), /mappingRunId is valid only with mappingStage enrich/);
    await assert.rejects(() => normalizeTalentMappingTask({
      platform: 'all', talentMappingFile: fixturePath, mappingStage: 'scan', apiKey: 'must-not-pass',
    }), /cannot include apiKey/);
  });

  it('queues Mapping through TaskQueue with authoritative argv and highlights completed-with-gaps output', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return buildSummary();
      },
    });
    try {
      const response = await handleApiRequest({
        method: 'POST',
        pathname: '/api/tasks/talent-mapping',
        body: { platform: 'all', talentMappingFile: fixturePath, mappingStage: 'scan' },
        taskQueue: queue,
        dataDir,
      });
      assert.equal(response.statusCode, 202);
      const task = await waitForTask(queue, (response.body as TaskDetail).taskId);
      assert.equal(task.status, 'succeeded');
      assert.deepStrictEqual(calls[0], [
        '--platform', 'all', '--talent-mapping-file', fixturePath, '--mapping-stage', 'scan',
      ]);
      assert.equal(task.outputSummary?.status, 'completed-with-gaps');
      assert.equal(task.outputSummary?.cappedSlices, 1);
      assert.equal(task.outputSummary?.detailOpenSideEffect, 'none');
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('assistant confirmation re-normalizes Mapping input and never executes argvPreview', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return buildSummary();
      },
    });
    try {
      const response = await handleApiRequest({
        method: 'POST',
        pathname: '/api/assistant/confirm',
        taskQueue: queue,
        dataDir,
        body: {
          draft: {
            kind: 'talent-mapping',
            input: { platform: '51job', talentMappingFile: fixturePath, mappingStage: 'scan' },
            missingFields: [],
            warnings: [],
            argvPreview: ['--platform', 'boss', '--jd', 'must-never-execute'],
          },
        },
      });
      assert.equal(response.statusCode, 200);
      const task = await waitForTask(queue, (response.body as { task: TaskDetail }).task.taskId);
      assert.equal(task.status, 'succeeded');
      assert.deepStrictEqual(calls, [[
        '--platform', '51job', '--talent-mapping-file', fixturePath, '--mapping-stage', 'scan',
      ]]);

      const rejectedRisk = await handleApiRequest({
        method: 'POST',
        pathname: '/api/assistant/confirm',
        taskQueue: queue,
        dataDir,
        body: {
          draft: {
            kind: 'talent-mapping',
            input: {
              platform: '51job', talentMappingFile: fixturePath, mappingStage: 'enrich',
              mappingRunId: 'scan-run-1', confirmedDetailOpen: true,
            },
            missingFields: [],
            warnings: [],
            argvPreview: [],
          },
          riskAccepted: false,
        },
      });
      assert.equal(rejectedRisk.statusCode, 400);
      assert.match(JSON.stringify(rejectedRisk.body), /riskAccepted is required/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serves persisted Mapping facts and derived views without executing a browser task', async () => {
    const dataDir = await makeTempDir();
    let runnerCalls = 0;
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async () => {
        runnerCalls += 1;
        throw new Error('GET read model must not execute TaskQueue');
      },
    });
    const observedAt = '2026-07-28T05:00:00.000Z';
    try {
      const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
      const store = new TalentMappingStore({ dataDir, now: () => new Date(observedAt) });
      await store.saveProject(plan, fixturePath);
      await store.appendCandidateObservation(createMappingCandidateObservation({
        candidate: {
          candidateId: 'candidate-1',
          name: '候选人甲',
          currentCompany: '示例零售（中国）有限公司',
          currentTitle: '区域运营经理',
          cardText: '上海',
        },
        plan,
        runId: 'scan-run-1',
        sliceId: plan.slices[0]!.sliceId,
        platform: '51job',
        observedAt,
        batchIdentity: 'batch-1',
        batchNumber: 1,
        rankInBatch: 1,
      }));
      const run: MappingRunRecord = {
        runId: 'scan-run-1',
        mappingKey: plan.mappingKey,
        mappingName: plan.name,
        stage: 'scan',
        platformSelection: '51job',
        status: 'completed',
        detailOpenConfirmed: false,
        detailOpenSideEffect: 'none',
        startedAt: observedAt,
        finishedAt: observedAt,
        sliceRuns: [{
          runId: 'scan-run-1',
          mappingKey: plan.mappingKey,
          sliceId: plan.slices[0]!.sliceId,
          platform: '51job',
          status: 'completed',
          reportedResultTotal: 1,
          reportedResultTotalSource: 'page',
          scannedBatches: 1,
          observedCards: 1,
          uniquePlatformProfiles: 1,
          eligibleForDetail: 0,
          enrichedProfiles: 0,
          failedProfiles: [],
          terminationReason: 'end-reached',
          startedAt: observedAt,
          finishedAt: observedAt,
        }],
      };
      await store.saveRun(run);
      await store.rebuildDerivedViews(plan.mappingKey);

      const requests = [
        ['/api/talent-mappings', 'mappings'],
        [`/api/talent-mappings/${plan.mappingKey}/runs`, 'runs'],
        [`/api/talent-mappings/${plan.mappingKey}/candidates`, 'candidates'],
        [`/api/talent-mappings/${plan.mappingKey}/companies`, 'companies'],
        [`/api/talent-mappings/${plan.mappingKey}/coverage`, 'coverage'],
      ] as const;
      for (const [pathname, field] of requests) {
        const response = await handleApiRequest({ method: 'GET', pathname, dataDir, taskQueue: queue });
        assert.equal(response.statusCode, 200, pathname);
        assert.equal((response.body as Record<string, unknown[]>)[field]?.length, 1, pathname);
      }

      const detail = await handleApiRequest({
        method: 'GET', pathname: `/api/talent-mappings/${plan.mappingKey}`, dataDir, taskQueue: queue,
      });
      assert.equal(detail.statusCode, 200);
      const body = detail.body as {
        summary: { candidateCount: number };
        detailSelection: { available: boolean; candidateCount: number; sourceScanRunId?: string };
        identityPolicy: { crossPlatformAutoMerge: boolean };
      };
      assert.equal(body.summary.candidateCount, 1);
      assert.equal(body.detailSelection.available, true);
      assert.equal(body.detailSelection.candidateCount, 1);
      assert.equal(body.detailSelection.sourceScanRunId, 'scan-run-1');
      assert.equal(body.identityPolicy.crossPlatformAutoMerge, false);
      assert.equal(runnerCalls, 0);

      const missing = await handleApiRequest({
        method: 'GET', pathname: '/api/talent-mappings/missing', dataDir, taskQueue: queue,
      });
      assert.equal(missing.statusCode, 404);
      const traversal = await handleApiRequest({
        method: 'GET', pathname: '/api/talent-mappings/%2E%2E/candidates', dataDir, taskQueue: queue,
      });
      assert.equal(traversal.statusCode, 400);
      assert.match(JSON.stringify(traversal.body), /mappingKey must be a non-empty path-safe value/);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serves M4 change, entity-review, classification-review, and queued suggestion contracts', async () => {
    const dataDir = await makeTempDir();
    const classificationInputs: Array<{ mappingKey: string; limit?: number }> = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async () => buildSummary(),
      talentMappingClassificationRunner: async (input) => {
        classificationInputs.push(input);
        return {
          mode: 'talent-mapping-classification',
          mappingKey: input.mappingKey,
          model: 'test-model',
          consideredCandidates: 1,
          generatedSuggestions: 1,
          skippedCandidates: 0,
          suggestionIds: ['suggestion-generated'],
        };
      },
    });
    try {
      const plan = await loadTalentMappingPlanFile(fixturePath, { platformSelection: 'all' });
      const store = new TalentMappingStore({ dataDir, now: () => new Date('2026-07-29T05:00:00.000Z') });
      await store.saveProject(plan, fixturePath);
      const createObservation = (input: {
        runId: string;
        platform: '51job' | 'liepin' | 'zhilian';
        candidateId: string;
        observedAt: string;
        name: string;
        currentCompany?: string;
        currentTitle?: string;
        cardText?: string;
      }) => createMappingCandidateObservation({
        candidate: input,
        plan,
        runId: input.runId,
        sliceId: plan.slices[0]!.sliceId,
        platform: input.platform,
        observedAt: input.observedAt,
        batchIdentity: `${input.runId}-batch`,
        rankInBatch: 1,
      });
      await store.appendCandidateObservation(createObservation({
        runId: 'scan-run-1', platform: '51job', candidateId: 'candidate-1',
        observedAt: '2026-07-28T05:00:00.000Z', name: '候选人甲',
        currentCompany: '示例零售（中国）有限公司', currentTitle: '区域经理', cardText: '上海',
      }));
      await store.appendCandidateObservation(createObservation({
        runId: 'scan-run-2', platform: '51job', candidateId: 'candidate-1',
        observedAt: '2026-07-29T05:00:00.000Z', name: '候选人甲',
        currentCompany: '示例零售（中国）有限公司', currentTitle: '大区经理', cardText: '上海',
      }));
      await store.appendCandidateObservation(createObservation({
        runId: 'scan-run-2', platform: 'liepin', candidateId: 'candidate-2',
        observedAt: '2026-07-29T05:00:00.000Z', name: '候选人甲',
        currentCompany: '示例零售（中国）有限公司', currentTitle: '大区经理', cardText: '上海',
      }));
      await store.appendCandidateObservation(createObservation({
        runId: 'scan-run-2', platform: 'zhilian', candidateId: 'candidate-3',
        observedAt: '2026-07-29T05:00:00.000Z', name: '候选人乙',
        currentCompany: '待归类公司', currentTitle: '待归类岗位',
      }));
      const makeRun = (runId: string, at: string): MappingRunRecord => ({
        runId, mappingKey: plan.mappingKey, mappingName: plan.name, stage: 'scan', platformSelection: 'all',
        status: 'completed', detailOpenConfirmed: false, detailOpenSideEffect: 'none',
        startedAt: at, finishedAt: at, sliceRuns: [],
      });
      await store.saveRun(makeRun('scan-run-1', '2026-07-28T05:00:00.000Z'));
      await store.saveRun(makeRun('scan-run-2', '2026-07-29T05:00:00.000Z'));
      await store.rebuildDerivedViews(plan.mappingKey);

      const changes = await handleApiRequest({
        method: 'GET', pathname: `/api/talent-mappings/${plan.mappingKey}/changes`, dataDir, taskQueue: queue,
      });
      assert.equal(changes.statusCode, 200);
      assert.equal((changes.body as { changes: { changedProfiles: unknown[] } }).changes.changedProfiles.length, 1);

      const entityReview = await handleApiRequest({
        method: 'GET', pathname: `/api/talent-mappings/${plan.mappingKey}/entity-links`, dataDir, taskQueue: queue,
      });
      const suggestion = (entityReview.body as { entityLinks: { suggestions: Array<{ platformCandidateKeys: string[] }> } }).entityLinks.suggestions[0]!;
      const confirmed = await handleApiRequest({
        method: 'POST', pathname: `/api/talent-mappings/${plan.mappingKey}/entity-links`, dataDir, taskQueue: queue,
        body: { platformCandidateKeys: suggestion.platformCandidateKeys, confirmedBy: '审核员', evidence: '人工核对证据' },
      });
      assert.equal(confirmed.statusCode, 201);

      const sourceObservationId = (await store.readCandidateObservations(plan.mappingKey))
        .find((item) => item.candidateId === 'candidate-3')!.observationId;
      const classificationSuggestion: MappingClassificationSuggestion = {
        suggestionId: 'suggestion-1',
        mappingKey: plan.mappingKey,
        platformCandidateKey: 'zhilian:candidate-3',
        sourceObservationId,
        createdAt: '2026-07-29T05:00:00.000Z',
        model: 'test-model',
        promptVersion: 1,
        proposed: { companyKey: 'sample-retail-a' },
        rationale: '待人工审核',
        evidence: [{ field: 'currentCompany', rawValue: '待归类公司', observationId: sourceObservationId }],
      };
      await store.appendClassificationSuggestion(classificationSuggestion);
      const reviewed = await handleApiRequest({
        method: 'POST', pathname: `/api/talent-mappings/${plan.mappingKey}/classification-suggestions/suggestion-1/review`,
        dataDir, taskQueue: queue, body: { decision: 'accepted', reviewedBy: '分类审核员' },
      });
      assert.equal(reviewed.statusCode, 200);
      assert.equal((reviewed.body as { decision: string }).decision, 'accepted');

      const generated = await handleApiRequest({
        method: 'POST', pathname: `/api/talent-mappings/${plan.mappingKey}/classification-suggestions/generate`,
        dataDir, taskQueue: queue, body: { limit: 12, apiKey: 'must-not-pass' },
      });
      assert.equal(generated.statusCode, 400);
      const queued = await handleApiRequest({
        method: 'POST', pathname: `/api/talent-mappings/${plan.mappingKey}/classification-suggestions/generate`,
        dataDir, taskQueue: queue, body: { limit: 12 },
      });
      assert.equal(queued.statusCode, 202);
      const task = await waitForTask(queue, (queued.body as TaskDetail).taskId);
      assert.equal(task.kind, 'talent-mapping-classification');
      assert.equal(task.outputSummary?.generatedSuggestions, 1);
      assert.deepStrictEqual(classificationInputs, [{ mappingKey: plan.mappingKey, limit: 12 }]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
