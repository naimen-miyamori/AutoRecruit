import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import { bindCoreSavedSearchTarget } from '../mode-runners/saved-search-binding-runner.js';
import { verifyCoreSavedSearchTarget } from '../mode-runners/saved-search-verification-runner.js';
import {
  assertPlatformSavedSearchOpenEvidence,
  assertCoreSavedSearchTarget,
  buildCoreSavedSearchTarget,
  buildSavedSearchOpenEvidence,
  buildZhilianNativeSavedSearchOpenEvidence,
  buildZhilianNativeSavedSearchTarget,
} from '../search/saved-search-target.js';
import { JobConfigConflictError, JobStore } from '../storage/job-store.js';
import { SavedSearchEvidenceStore } from '../search/saved-search-evidence-store.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';
import type { BrowserSession } from '../browser/session.js';
import type { CoreSavedSearchVerificationRequest, PlatformAdapter } from '../platforms/types.js';

const normalizedJob: NormalizedJob = {
  title: '全铝箱包产品技术负责人',
  majors: [],
  languageRequirements: [],
  responsibilities: [],
  hardRequirements: [],
  preferredRequirements: [],
  regionPreferences: [],
  industryTags: [],
};

function job(): JobRecord {
  return {
    platform: '51job',
    jobKey: '铝镁合金',
    revision: 1,
    jobIdentity: {
      version: 1,
      expectedJobName: '全铝包装设计',
      nameAuthority: 'user-confirmed',
    },
    searchKeyword: '铝镁合金',
    searchSettings: { source: 'saved', pageKeyword: '铝镁合金', conditions: [] },
    rawText: 'JD',
    normalizedJob,
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

function zhilianJob(): JobRecord {
  return {
    ...job(),
    platform: 'zhilian',
    revision: 2,
    searchSettings: {
      source: 'saved',
      pageKeyword: '铝镁合金 拉杆箱',
      conditions: [],
    },
  };
}

let tempDir: string;
let store: JobStore;
let evidenceStore: SavedSearchEvidenceStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-saved-search-binding-'));
  store = new JobStore(tempDir);
  evidenceStore = new SavedSearchEvidenceStore({ dataDir: tempDir });
  await store.saveJobRecord('51job', job(), { identityWriteAuthority: 'migration-backfill' });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('core saved-search target and evidence', () => {
  it('keeps binding revision outside the semantic target fingerprint', () => {
    const first = buildCoreSavedSearchTarget({
      platform: '51job',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    });
    const second = buildCoreSavedSearchTarget({ ...first, bindingRevision: 2 });
    assert.equal(first.targetFingerprint, second.targetFingerprint);
    assert.deepEqual(assertCoreSavedSearchTarget(first, {
      platform: '51job',
      boundJobKey: '铝镁合金',
    }), first);
  });

  it('creates evidence only for an exact observed name, keyword, and bound job', () => {
    const target = buildCoreSavedSearchTarget({
      platform: '51job',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    });
    const evidence = buildSavedSearchOpenEvidence(target, {
      boundJobKey: '铝镁合金',
      observedName: '铝镁合金',
      observedKeyword: '铝镁合金',
      verifiedAt: '2026-08-11T01:00:00.000Z',
    });
    assert.equal(evidence.targetFingerprint, target.targetFingerprint);
    assert.equal(evidence.postcondition, 'opened-and-verified');

    assert.throws(() => buildSavedSearchOpenEvidence(target, {
      boundJobKey: '其他岗位',
      observedName: '铝镁合金',
      observedKeyword: '铝镁合金',
    }), /belongs to job/);
    assert.throws(() => buildSavedSearchOpenEvidence(target, {
      boundJobKey: '铝镁合金',
      observedName: '铝镁合金-近似',
      observedKeyword: '铝镁合金',
    }), /does not exactly match/);
  });

  it('models Zhilian by native condition identity without claiming an observed remote name', () => {
    const target = buildZhilianNativeSavedSearchTarget({
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      nativeConditionId: '44303402',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionFingerprint: 'a'.repeat(64),
    });
    const nextRevision = buildZhilianNativeSavedSearchTarget({ ...target, bindingRevision: 2 });
    assert.equal(target.targetFingerprint, nextRevision.targetFingerprint);
    assert.deepEqual(assertCoreSavedSearchTarget(target, {
      platform: 'zhilian',
      boundJobKey: '铝镁合金',
    }), target);

    const evidence = buildZhilianNativeSavedSearchOpenEvidence(target, {
      boundJobKey: '铝镁合金',
      observedNativeConditionId: '44303402',
      observedKeyword: '铝镁合金 拉杆箱',
      observedConditionFingerprint: 'a'.repeat(64),
      verifiedAt: '2026-08-12T01:00:00.000Z',
    });
    assert.equal(evidence.identityKind, 'zhilian-native-condition');
    assert.equal(evidence.uniqueness, 'unique-native-condition-match');
    assert.equal('observedName' in evidence, false);
    assert.deepEqual(assertPlatformSavedSearchOpenEvidence(evidence), evidence);
    assert.throws(() => assertPlatformSavedSearchOpenEvidence({
      ...evidence,
      observedNativeConditionId: '44303403',
    }), /hash|tampered/i);
  });

  it('rejects legacy exact-name Zhilian targets as migration-required', () => {
    const legacy = {
      version: 1,
      targetKind: 'core-exact-name-keyword',
      platform: 'zhilian',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金 拉杆箱',
      targetFingerprint: 'a'.repeat(64),
    };
    assert.throws(
      () => assertCoreSavedSearchTarget(legacy),
      /Zhilian.*native-condition.*migration/i,
    );
  });
});

describe('confirmed core saved-search binding', () => {
  it('verifies and stores page evidence without modifying the JobRecord or candidates', async () => {
    let closed = false;
    let receivedDeadline: number | undefined;
    const now = new Date('2026-08-11T00:00:00.000Z');
    const page = {} as BrowserSession['page'];
    const session = { page } as BrowserSession;
    const openBoundSavedSearch: NonNullable<PlatformAdapter['openBoundSavedSearch']> = async (
      _page,
      target,
      options,
    ) => {
      receivedDeadline = options.deadline;
      return {
        page,
        evidence: buildSavedSearchOpenEvidence(target, {
          boundJobKey: options.boundJobKey,
          observedName: target.name,
          observedKeyword: target.expectedKeyword,
          verifiedAt: '2026-08-11T01:00:00.000Z',
        }),
      };
    };
    const summary = await verifyCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '铝镁合金',
      expectedRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    }, {
      store,
      evidenceStore,
      preflightRuntimes: async () => undefined,
      openSession: async () => session,
      closeSession: async () => { closed = true; },
      resolveAdapter: () => ({
        platform: '51job',
        estimateSearchTimeoutMs: () => config.playwright.searchPageTimeoutMs + 60_000,
        openBoundSavedSearch,
      } as unknown as PlatformAdapter),
      now: () => now,
    });
    assert.equal(summary.candidateSideEffects, false);
    assert.equal(summary.jobRecordModified, false);
    assert.equal(closed, true);
    assert.equal(receivedDeadline, now.getTime() + config.playwright.searchPageTimeoutMs + 60_000);
    const storedEvidence = await evidenceStore.read(summary.evidenceHash);
    assert.equal('observedName' in storedEvidence ? storedEvidence.observedName : undefined, '铝镁合金');
    const unchanged = await store.readJobRecord('51job', '铝镁合金');
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.searchSettings?.coreSavedSearchTarget, undefined);
  });

  it('binds page evidence with JobRecord CAS and remains idempotent', async () => {
    const target = buildCoreSavedSearchTarget({
      platform: '51job',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    });
    const evidence = buildSavedSearchOpenEvidence(target, {
      boundJobKey: '铝镁合金',
      observedName: target.name,
      observedKeyword: target.expectedKeyword,
      verifiedAt: '2026-08-11T01:00:00.000Z',
    });
    await evidenceStore.save(evidence);

    const bound = await bindCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '铝镁合金',
      expectedRevision: 1,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore });
    assert.equal(bound.revision, 2);
    assert.deepEqual(bound.searchSettings?.coreSavedSearchTarget, target);

    const repeated = await bindCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '铝镁合金',
      expectedRevision: 2,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore });
    assert.equal(repeated.revision, 2);
  });

  it('rejects missing confirmation, stale revisions, and cross-job evidence', async () => {
    const target = buildCoreSavedSearchTarget({
      platform: '51job',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    });
    const evidence = buildSavedSearchOpenEvidence(target, {
      boundJobKey: '铝镁合金',
      observedName: target.name,
      observedKeyword: target.expectedKeyword,
    });
    await evidenceStore.save(evidence);

    await assert.rejects(() => bindCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '铝镁合金',
      expectedRevision: 1,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: false,
    }, { store, evidenceStore }), /confirmed=true/);

    await store.applyJobConfigPatch('51job', '铝镁合金', 1, { recipientEmail: 'changed@example.test' });
    await assert.rejects(() => bindCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '铝镁合金',
      expectedRevision: 1,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore }), JobConfigConflictError);

    await assert.rejects(() => bindCoreSavedSearchTarget({
      platform: '51job',
      jobKey: '其他岗位',
      expectedRevision: 1,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore }), /evidence belongs to job/);
  });

  it('drops all saved-only target state on an explicit direct patch', async () => {
    const target = buildCoreSavedSearchTarget({
      platform: '51job',
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金',
    });
    await store.applyJobConfigPatch('51job', '铝镁合金', 1, {
      coreSavedSearchTarget: target,
      searchSource: 'saved',
    });
    const direct = await store.applyJobConfigPatch('51job', '铝镁合金', 2, {
      searchSource: 'direct',
    });
    assert.equal(direct.searchSettings?.coreSavedSearchTarget, undefined);
    assert.equal(direct.searchSettings?.savedSearch, undefined);
    assert.equal(direct.searchSettings?.sortPolicy, undefined);
  });

  it('verifies a Zhilian native condition read-only and stores evidence without changing the job', async () => {
    await store.saveJobRecord('zhilian', zhilianJob(), { identityWriteAuthority: 'migration-backfill' });
    const page = {} as BrowserSession['page'];
    const session = { page } as BrowserSession;
    const target = buildZhilianNativeSavedSearchTarget({
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      nativeConditionId: '44303402',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionFingerprint: 'b'.repeat(64),
    });
    let openedBoundTarget = false;
    const summary = await verifyCoreSavedSearchTarget({
      platform: 'zhilian',
      jobKey: '铝镁合金',
      expectedRevision: 2,
      name: '铝镁合金',
      expectedKeyword: '铝镁合金 拉杆箱',
    }, {
      store,
      evidenceStore,
      preflightRuntimes: async () => undefined,
      openSession: async () => session,
      closeSession: async () => undefined,
      resolveAdapter: () => ({
        platform: 'zhilian',
        verifySavedSearchTarget: async (_page: BrowserSession['page'], request: CoreSavedSearchVerificationRequest) => {
          assert.equal(request.name, '铝镁合金');
          assert.equal(request.expectedKeyword, '铝镁合金 拉杆箱');
          return {
            page,
            target,
            evidence: buildZhilianNativeSavedSearchOpenEvidence(target, {
              boundJobKey: request.boundJobKey,
              observedNativeConditionId: target.nativeConditionId,
              observedKeyword: target.expectedKeyword,
              observedConditionFingerprint: target.conditionFingerprint,
              verifiedAt: '2026-08-12T01:00:00.000Z',
            }),
          };
        },
        openBoundSavedSearch: async () => {
          openedBoundTarget = true;
          throw new Error('verify must discover the prospective native target');
        },
      } as unknown as PlatformAdapter),
    });
    assert.equal(openedBoundTarget, false);
    assert.equal(summary.targetKind, 'zhilian-native-condition');
    assert.equal(summary.nativeConditionId, '44303402');
    assert.equal(summary.conditionFingerprint, 'b'.repeat(64));
    assert.equal(summary.candidateSideEffects, false);
    assert.equal(summary.jobRecordModified, false);
    const unchanged = await store.readJobRecord('zhilian', '铝镁合金');
    assert.equal(unchanged.revision, 2);
    assert.equal(unchanged.searchSettings?.coreSavedSearchTarget, undefined);
  });

  it('binds Zhilian native evidence with CAS and remains idempotent', async () => {
    await store.saveJobRecord('zhilian', zhilianJob(), { identityWriteAuthority: 'migration-backfill' });
    const target = buildZhilianNativeSavedSearchTarget({
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      nativeConditionId: '44303402',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionFingerprint: 'c'.repeat(64),
    });
    const evidence = buildZhilianNativeSavedSearchOpenEvidence(target, {
      boundJobKey: target.boundJobKey,
      observedNativeConditionId: target.nativeConditionId,
      observedKeyword: target.expectedKeyword,
      observedConditionFingerprint: target.conditionFingerprint,
    });
    await evidenceStore.save(evidence);

    const bound = await bindCoreSavedSearchTarget({
      platform: 'zhilian',
      jobKey: '铝镁合金',
      expectedRevision: 2,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore });
    assert.equal(bound.revision, 3);
    assert.deepEqual(bound.searchSettings?.coreSavedSearchTarget, target);

    const repeated = await bindCoreSavedSearchTarget({
      platform: 'zhilian',
      jobKey: '铝镁合金',
      expectedRevision: 3,
      name: target.name,
      expectedKeyword: target.expectedKeyword,
      evidenceHash: evidence.evidenceHash,
      confirmed: true,
    }, { store, evidenceStore });
    assert.equal(repeated.revision, 3);
  });

  it('drops a bound Zhilian native target when the job explicitly switches to direct', async () => {
    await store.saveJobRecord('zhilian', zhilianJob(), { identityWriteAuthority: 'migration-backfill' });
    const target = buildZhilianNativeSavedSearchTarget({
      boundJobKey: '铝镁合金',
      bindingRevision: 1,
      name: '铝镁合金',
      nativeConditionId: '44303402',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionFingerprint: 'e'.repeat(64),
    });
    await store.applyJobConfigPatch('zhilian', '铝镁合金', 2, {
      searchSource: 'saved',
      coreSavedSearchTarget: target,
    });
    const direct = await store.applyJobConfigPatch('zhilian', '铝镁合金', 3, {
      searchSource: 'direct',
    });
    assert.equal(direct.searchSettings?.coreSavedSearchTarget, undefined);
  });
});
