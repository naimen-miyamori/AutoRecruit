import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../config.js';
import {
  resolveBossCapturePlan,
  type BossCapturePlanStore,
} from '../platforms/boss/capture-plan.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';
import { JobStore } from '../storage/job-store.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';

const conditionSetRef: SearchConditionSetReference = {
  conditionSetId: 'scs-aluminium',
  platform: 'boss',
  revision: 1,
};

const normalizedJob: NormalizedJob = {
  title: '全铝箱包设计',
  majors: [],
  languageRequirements: [],
  responsibilities: [],
  hardRequirements: [],
  preferredRequirements: [],
  regionPreferences: [],
  industryTags: [],
};

function storedJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobKey: '全铝箱包设计-554cbe84c293028b0nJ72NW7FlJV',
    platform: 'boss',
    searchKeyword: '全铝箱包设计',
    rawText: '岗位 JD',
    normalizedJob,
    createdAt: '2026-07-30T00:00:00.000Z',
    bossPosition: {
      bossJobId: '554cbe84c293028b0nJ72NW7FlJV',
      status: 'open',
      syncedAt: '2026-07-30T00:00:00.000Z',
      sourceHash: 'hash',
    },
    searchSettings: {
      source: 'direct',
      conditions: [],
      conditionSetRef,
      resolution: { selectedFieldsFingerprint: 'stored-fingerprint' },
    },
    ...overrides,
  };
}

function storeFor(records: readonly JobRecord[]): BossCapturePlanStore {
  return {
    async findBossJobRecordByPositionId(bossJobId) {
      return records.find((record) => record.bossPosition?.bossJobId === bossJobId);
    },
    async findBossJobRecordsByName(jobName) {
      const normalizedName = jobName.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
      return records.filter((record) => [record.searchKeyword, record.normalizedJob.title]
        .some((value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN') === normalizedName));
    },
  };
}

function conditionSetService(defaultKeyword = '铝') {
  return {
    async resolve(reference: SearchConditionSetReference) {
      assert.deepEqual(reference, conditionSetRef);
      return {
        reference: { ...conditionSetRef },
        revision: {
          ...conditionSetRef,
          schemaVersion: 1 as const,
          name: '全铝箱包设计人才搜索',
          defaultKeyword,
          applicationFilterInput: { city: '广东' },
          compiledConditions: [{ kind: 'location', values: ['广东'] }],
          catalogEvidence: {
            capturedAt: '2026-07-30T00:00:00.000Z',
            selectedFieldsFingerprint: 'current-fingerprint',
          },
          status: 'active' as const,
          createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
        applicationFilterInput: { city: '广东' },
        conditions: [{ kind: 'location', values: ['广东'] }],
        catalogEvidence: {
          capturedAt: '2026-07-30T00:00:00.000Z',
          selectedFieldsFingerprint: 'current-fingerprint',
        },
        catalogChanged: false,
      };
    },
  };
}

describe('Boss saved capture plan resolver', () => {
  it('uses explicit Boss ID before name lookup and resolves a stored fixed revision without a browser', async () => {
    const record = storedJob();
    let nameLookups = 0;
    const store: BossCapturePlanStore = {
      ...storeFor([record]),
      async findBossJobRecordsByName(jobName) {
        nameLookups += 1;
        return storeFor([record]).findBossJobRecordsByName(jobName);
      },
    };

    const plan = await resolveBossCapturePlan({
      jobName: '全铝箱包设计',
      bossJobId: '554cbe84c293028b0nJ72NW7FlJV',
    }, {
      store,
      searchConditionSets: conditionSetService(),
    });

    assert.equal(nameLookups, 0);
    assert.equal(plan.jobKey, record.jobKey);
    assert.equal(plan.bossJobId, record.bossPosition?.bossJobId);
    assert.equal(plan.search.source, 'direct');
    assert.equal(plan.search.pageKeyword, '铝');
    assert.equal(plan.search.keywordSource, 'condition-set-default');
    assert.deepEqual(plan.search.conditionSetRef, conditionSetRef);
    assert.equal(plan.search.selectedFieldsFingerprint, 'current-fingerprint');
    assert.deepEqual(plan.search.conditions, [{ kind: 'location', values: ['广东'] }]);
    assert.deepEqual(plan.jobRecordWithResolvedSearchSettings?.searchSettings, {
      source: 'direct',
      pageKeyword: '铝',
      applicationFilterInput: { city: '广东' },
      conditions: [{ kind: 'location', values: ['广东'] }],
      conditionSetRef,
      resolution: { selectedFieldsFingerprint: 'current-fingerprint' },
    });
  });

  it('requires a matching name for an explicit Boss ID and never falls back to a same-name record', async () => {
    const record = storedJob();
    let nameLookups = 0;
    const store: BossCapturePlanStore = {
      ...storeFor([record]),
      async findBossJobRecordsByName(jobName) {
        nameLookups += 1;
        return storeFor([record]).findBossJobRecordsByName(jobName);
      },
    };

    await assert.rejects(
      () => resolveBossCapturePlan({
        jobName: '其他职位',
        bossJobId: record.bossPosition!.bossJobId,
      }, { store, searchConditionSets: conditionSetService() }),
      /belongs to stored job 全铝箱包设计, not expected job 其他职位/,
    );
    assert.equal(nameLookups, 0);
  });

  it('uses a unique name fallback, rejects ambiguous names, and keeps a true new job legacy-keyed', async () => {
    const record = storedJob();
    const unique = await resolveBossCapturePlan({ jobName: '  全铝箱包设计 ' }, {
      store: storeFor([record]),
      searchConditionSets: conditionSetService(),
    });
    assert.equal(unique.jobKey, record.jobKey);
    assert.equal(unique.bossJobId, record.bossPosition?.bossJobId);

    await assert.rejects(
      () => resolveBossCapturePlan({ jobName: '全铝箱包设计' }, {
        store: storeFor([record, { ...record, jobKey: 'legacy-全铝箱包设计', bossPosition: undefined }]),
        searchConditionSets: conditionSetService(),
      }),
      /Ambiguous stored Boss JD.*provide --boss-job-id/,
    );

    const newJob = await resolveBossCapturePlan({ jobName: '新岗位' }, {
      store: storeFor([]),
      searchConditionSets: conditionSetService(),
    });
    assert.equal(newJob.jobKey, '新岗位');
    assert.equal(newJob.jobRecord, undefined);
    assert.equal(newJob.bossJobId, undefined);
    assert.equal(newJob.search.pageKeyword, '新岗位');
    assert.equal(newJob.search.keywordSource, 'legacy-job-keyword');
  });

  it('uses the documented page keyword precedence without using it as the job identity', async () => {
    const record = storedJob({
      searchSettings: {
        source: 'direct',
        pageKeyword: '保存的查询词',
        conditions: [],
        conditionSetRef,
      },
    });
    const stored = await resolveBossCapturePlan({ jobName: '全铝箱包设计' }, {
      store: storeFor([record]),
      searchConditionSets: conditionSetService(),
    });
    assert.equal(stored.jobKey, record.jobKey);
    assert.equal(stored.search.pageKeyword, '保存的查询词');
    assert.equal(stored.search.keywordSource, 'stored-setting');

    const sourceOverride = await resolveBossCapturePlan({
      jobName: '全铝箱包设计',
      searchSource: 'saved',
      searchSourceExplicit: true,
    }, {
      store: storeFor([record]),
      searchConditionSets: conditionSetService(),
    });
    assert.equal(sourceOverride.search.pageKeyword, '保存的查询词');
    assert.equal(sourceOverride.search.keywordSource, 'stored-setting');

    const override = await resolveBossCapturePlan({
      jobName: '全铝箱包设计',
      bossSearchKeyword: '本次覆盖',
    }, {
      store: storeFor([record]),
      searchConditionSets: conditionSetService(),
    });
    assert.equal(override.search.pageKeyword, '本次覆盖');
    assert.equal(override.search.keywordSource, 'run-override');

    const explicitSet = await resolveBossCapturePlan({
      jobName: '全铝箱包设计',
      searchConditionSetRef: conditionSetRef,
    }, {
      store: storeFor([record]),
      searchConditionSets: conditionSetService('新条件集默认词'),
    });
    assert.equal(explicitSet.search.pageKeyword, '新条件集默认词');
    assert.equal(explicitSet.search.keywordSource, 'condition-set-default');
  });

  it('preserves the fixed revision and fails closed when current catalog resolution drifts', async () => {
    const record = storedJob();
    const driftError = new Error('filter catalog drift');
    const service = {
      async resolve(reference: SearchConditionSetReference) {
        assert.equal(reference.revision, 1);
        throw driftError;
      },
    };
    await assert.rejects(
      () => resolveBossCapturePlan({ jobName: '全铝箱包设计' }, {
        store: storeFor([record]),
        searchConditionSets: service,
      }),
      (error: unknown) => error === driftError,
    );
  });

  it('persists normalized page keyword and only lightweight search execution evidence', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-capture-plan-'));
    const originalDataDir = config.dataDir;
    (config as { dataDir: string }).dataDir = tempDir;
    try {
      const store = new JobStore();
      const record = storedJob({
        searchSettings: {
          source: 'direct',
          pageKeyword: '  铝  ',
          conditions: [],
          conditionSetRef,
        },
      });
      await store.saveJobRecord('boss', record);
      assert.equal((await store.readJobRecord('boss', record.jobKey)).searchSettings?.pageKeyword, '铝');

      await store.saveRunResult('boss', record.jobKey, {
        jobKey: record.jobKey,
        platform: 'boss',
        fetchedAt: '2026-07-30T00:00:00.000Z',
        totalCandidates: 0,
        newCandidateIds: [],
        scoredCandidates: [],
        failedCandidates: [],
        searchExecution: {
          source: 'direct',
          pageKeyword: '铝',
          keywordSource: 'condition-set-default',
          conditionSetRef,
          selectedFieldsFingerprint: 'fingerprint',
          includeViewedCandidates: false,
        },
      });
      const [run] = await store.listRunResults('boss', record.jobKey);
      assert.deepEqual(run?.searchExecution, {
        source: 'direct',
        pageKeyword: '铝',
        keywordSource: 'condition-set-default',
        conditionSetRef,
        selectedFieldsFingerprint: 'fingerprint',
        includeViewedCandidates: false,
      });
    } finally {
      (config as { dataDir: string }).dataDir = originalDataDir;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
