import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCaptureExecutionPlan,
  buildCaptureExecutionEnvelope,
  assertCaptureExecutionEnvelope,
  buildPlatformCaptureTargetRequest,
  resolvePlatformCaptureTarget,
} from '../mode-runners/capture-targets.js';
import { hashBossCaptureTaskSnapshot } from '../platforms/boss/capture-snapshot.js';
import {
  buildCoreSavedSearchTarget,
  buildZhilianNativeSavedSearchTarget,
} from '../search/saved-search-target.js';
import { normalizeResumeCaptureTask } from '../server/task-normalizers.js';
import type { BossCaptureTaskSnapshot, JobRecord } from '../types/job.js';
import type { RunnableJobInput, SinglePlatformCliInput } from '../mode-runners/types.js';

const baseInput: RunnableJobInput = {
  searchKeyword: '铝镁合金',
  bossJobId: 'boss-position-1',
  bossSearchKeyword: '铝镁合金 拉杆箱',
  includeViewedCandidates: false,
  includeBoss: true,
  searchSource: 'saved',
  searchSourceExplicit: false,
};

function coreInput(platform: '51job' | 'liepin' | 'zhilian'): SinglePlatformCliInput {
  return {
    platform,
    searchKeyword: '铝镁合金',
    includeViewedCandidates: false,
    searchSource: 'saved',
    searchSourceExplicit: false,
  };
}

function coreRecord(platform: '51job' | 'liepin' | 'zhilian'): JobRecord {
  return {
    platform,
    jobKey: '铝镁合金',
    revision: 3,
    searchKeyword: '铝镁合金',
    jobIdentity: {
      version: 1,
      expectedJobName: '全铝包装设计',
      nameAuthority: 'user-confirmed',
    },
    rawText: '职位名称：全铝箱包产品技术负责人',
    normalizedJob: {
      title: '全铝箱包产品技术负责人', majors: [], languageRequirements: [], responsibilities: [],
      hardRequirements: [], preferredRequirements: [], regionPreferences: [], industryTags: [],
    },
    searchSettings: {
      source: 'saved',
      pageKeyword: '铝镁合金',
      conditions: [],
      coreSavedSearchTarget: platform === 'zhilian'
        ? buildZhilianNativeSavedSearchTarget({
          boundJobKey: '铝镁合金',
          bindingRevision: 1,
          name: '铝镁合金',
          nativeConditionId: '44303402',
          expectedKeyword: '铝镁合金',
          conditionFingerprint: 'a'.repeat(64),
        })
        : buildCoreSavedSearchTarget({
          platform,
          boundJobKey: '铝镁合金',
          bindingRevision: 1,
          name: '铝镁合金',
          expectedKeyword: '铝镁合金',
        }),
    },
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

function bossSnapshot(): BossCaptureTaskSnapshot {
  const unsigned: Omit<BossCaptureTaskSnapshot, 'snapshotHash'> = {
    version: 4,
    resolvedAt: '2026-08-11T00:00:00.000Z',
    sourceJobKey: '全铝箱包设计-boss-position-1',
    sourceJobRevision: 4,
    jobIdentity: { bossJobId: 'boss-position-1', expectedJobName: '全铝箱包设计' },
    searchPlan: {
      source: 'saved', pageKeyword: '铝镁合金 拉杆箱', keywordSource: 'stored-setting', conditions: [],
    },
    deliveryAndScreening: { primaryDelivery: { ccEmails: [] } },
  };
  return { ...unsigned, snapshotHash: hashBossCaptureTaskSnapshot(unsigned) };
}

describe('platform capture execution targets', () => {
  it('pins a prospective Zhilian native verification request for a new saved capture', () => {
    const platformInput = {
      ...coreInput('zhilian'),
      jobDescriptionText: '职位名称：全铝包装设计',
    };
    const request = buildPlatformCaptureTargetRequest(baseInput, platformInput);
    const prospectiveRequest = {
      platform: 'zhilian' as const,
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金 拉杆箱',
    };
    const target = resolvePlatformCaptureTarget({
      request,
      platformInput,
      context: {
        jobKey: '铝镁合金',
        searchSettings: {
          source: 'saved',
          pageKeyword: '铝镁合金 拉杆箱',
          conditions: [],
        },
        pageKeyword: '铝镁合金 拉杆箱',
        prospectiveCoreSavedSearchRequest: prospectiveRequest,
      },
    });
    assert.equal(target.targetKind, 'core');
    if (target.targetKind !== 'core') return;
    assert.deepEqual(target.searchPlan.savedTargetRequest, prospectiveRequest);
    assert.equal(target.searchPlan.savedTarget, undefined);
  });

  it('keeps job name, JD title, subscription name, and page keyword independent', () => {
    const platformInput = coreInput('51job');
    const record = coreRecord('51job');
    const target = resolvePlatformCaptureTarget({
      request: buildPlatformCaptureTargetRequest(baseInput, platformInput),
      platformInput,
      context: {
        jobKey: record.jobKey,
        existingJobRecord: record,
        searchSettings: record.searchSettings!,
        pageKeyword: '铝镁合金',
      },
    });
    assert.equal(target.targetKind, 'core');
    if (target.targetKind !== 'core') return;
    assert.equal(target.identity.expectedJobName, '全铝包装设计');
    assert.equal(record.normalizedJob.title, '全铝箱包产品技术负责人');
    assert.equal(target.searchPlan.savedTarget?.name, '铝镁合金');
    assert.equal(target.searchPlan.pageKeyword, '铝镁合金');
  });

  it('builds strict core order and nests Boss v4 without copying Boss identity fields', () => {
    const targets = (['51job', 'liepin', 'zhilian'] as const).map((platform) => {
      const platformInput = coreInput(platform);
      const record = coreRecord(platform);
      return resolvePlatformCaptureTarget({
        request: buildPlatformCaptureTargetRequest(baseInput, platformInput),
        platformInput,
        context: { jobKey: record.jobKey, existingJobRecord: record, searchSettings: record.searchSettings!, pageKeyword: '铝镁合金' },
      });
    });
    const snapshot = bossSnapshot();
    const bossInput: SinglePlatformCliInput = {
      ...coreInput('51job'),
      platform: 'boss',
      bossJobId: 'boss-position-1',
      bossCaptureTaskSnapshot: snapshot,
    };
    targets.push(resolvePlatformCaptureTarget({
      request: buildPlatformCaptureTargetRequest(baseInput, bossInput),
      platformInput: bossInput,
      context: {
        jobKey: snapshot.sourceJobKey,
        searchSettings: { source: 'saved', conditions: [], pageKeyword: snapshot.searchPlan.pageKeyword },
        pageKeyword: snapshot.searchPlan.pageKeyword,
      },
    }));
    const plan = buildCaptureExecutionPlan({
      displayLabel: '铝镁合金',
      platformOrder: ['51job', 'liepin', 'zhilian', 'boss'],
      targets,
    });
    assert.deepEqual(plan.platformOrder, ['51job', 'liepin', 'zhilian', 'boss']);
    const boss = plan.targets[3];
    assert.equal(boss?.targetKind, 'boss-v4');
    assert.equal('jobKey' in boss!, false);
    assert.equal((boss as { snapshot: BossCaptureTaskSnapshot }).snapshot.jobIdentity.expectedJobName, '全铝箱包设计');
    assert.match(plan.planHash, /^[a-f0-9]{64}$/u);
    const envelope = buildCaptureExecutionEnvelope([plan]);
    assert.equal(assertCaptureExecutionEnvelope(envelope), envelope);
    envelope.plans[0]!.displayLabel = '被篡改';
    assert.throws(() => assertCaptureExecutionEnvelope(envelope), /plan hash does not match/);
  });

  it('rejects strict saved identity without a bound target and Boss without v4', () => {
    const platformInput = coreInput('51job');
    const record = coreRecord('51job');
    const searchSettings = { ...record.searchSettings!, coreSavedSearchTarget: undefined };
    assert.throws(() => resolvePlatformCaptureTarget({
      request: buildPlatformCaptureTargetRequest(baseInput, platformInput),
      platformInput,
      context: { jobKey: record.jobKey, existingJobRecord: record, searchSettings, pageKeyword: '铝镁合金' },
    }), /strict identity but no executable saved-search target/);

    const bossInput: SinglePlatformCliInput = { ...coreInput('51job'), platform: 'boss', bossJobId: 'boss-position-1' };
    assert.throws(() => resolvePlatformCaptureTarget({
      request: buildPlatformCaptureTargetRequest(baseInput, bossInput),
      platformInput: bossInput,
      context: { jobKey: 'boss-key', searchSettings: { source: 'saved', conditions: [] }, pageKeyword: '铝镁合金 拉杆箱' },
    }), /requires the authoritative version 4/);
  });

  it('rejects tampered nested Boss v4 content before building the wrapper plan', () => {
    const snapshot = bossSnapshot();
    snapshot.searchPlan.pageKeyword = '被篡改';
    const bossInput: SinglePlatformCliInput = {
      ...coreInput('51job'),
      platform: 'boss',
      bossJobId: 'boss-position-1',
      bossCaptureTaskSnapshot: snapshot,
    };
    assert.throws(() => resolvePlatformCaptureTarget({
      request: buildPlatformCaptureTargetRequest(baseInput, bossInput),
      platformInput: bossInput,
      context: {
        jobKey: snapshot.sourceJobKey,
        searchSettings: { source: 'saved', conditions: [] },
        pageKeyword: snapshot.searchPlan.pageKeyword,
      },
    }), /hash does not match its canonical content/);
  });

  it('keeps private plans, executable conditions, and per-platform targets out of public capture input', () => {
    for (const field of ['captureExecutionPlan', 'conditions', 'platformTargets']) {
      assert.throws(() => normalizeResumeCaptureTask({
        platform: '51job',
        keyword: '铝镁合金',
        [field]: field === 'conditions' ? [] : {},
      }), /cannot include/);
    }
  });
});
