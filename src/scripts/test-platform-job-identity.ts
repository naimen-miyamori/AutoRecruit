import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  inspectPlatformJobIdentity,
  resolvePlatformJobIdentityView,
} from '../storage/job-identity.js';
import { JobConfigConflictError, JobStore } from '../storage/job-store.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';

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

function coreJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobKey: '铝镁合金',
    platform: '51job',
    revision: 1,
    searchKeyword: '铝镁合金',
    rawText: '岗位 JD',
    normalizedJob,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-job-identity-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('platform job identity inspection', () => {
  it('keeps a missing identity as an explicit non-mutating legacy view', () => {
    const record = coreJob();
    const view = resolvePlatformJobIdentityView(record);

    assert.deepEqual(view, {
      kind: 'legacy-derived',
      expectedJobName: '铝镁合金',
    });
    assert.equal(record.jobIdentity, undefined);
  });

  it('normalizes a complete core identity and rejects malformed or forged native identity', () => {
    const valid = inspectPlatformJobIdentity({
      version: 1,
      expectedJobName: '  全铝  包装设计  ',
      nameAuthority: 'user-confirmed',
    }, { platform: '51job' });
    assert.deepEqual(valid.executableIdentity, {
      version: 1,
      expectedJobName: '全铝 包装设计',
      nameAuthority: 'user-confirmed',
    });
    assert.deepEqual(valid.issues, []);

    const malformed = inspectPlatformJobIdentity({
      version: 1,
      expectedJobName: '',
      nameAuthority: 'user-confirmed',
    }, { platform: '51job' });
    assert.equal(malformed.executableIdentity, undefined);
    assert.ok(malformed.issues.some((issue) => issue.code === 'job-identity-name-invalid'));

    const forged = inspectPlatformJobIdentity({
      version: 1,
      expectedJobName: '全铝包装设计',
      nameAuthority: 'user-confirmed',
      nativePositionId: 'forged-core-id',
    }, { platform: '51job' });
    assert.equal(forged.executableIdentity, undefined);
    assert.ok(forged.issues.some((issue) => issue.code === 'job-identity-native-id-not-supported'));
  });

  it('requires platform-sync Boss identity to match the authoritative position ID', () => {
    const mismatch = inspectPlatformJobIdentity({
      version: 1,
      expectedJobName: '全铝箱包设计',
      nameAuthority: 'platform-sync',
      nativePositionId: 'boss-id-other',
    }, {
      platform: 'boss',
      bossPositionId: 'boss-id-current',
    });

    assert.equal(mismatch.executableIdentity, undefined);
    assert.ok(mismatch.issues.some((issue) => issue.code === 'job-identity-native-id-mismatch'));
  });
});

describe('JobStore identity CAS', () => {
  it('updates only identity and revision while preserving key, keyword, JD, and search settings', async () => {
    const store = new JobStore(tempDir);
    const original = coreJob({
      searchSettings: {
        source: 'saved',
        pageKeyword: '铝镁合金',
        conditions: [],
      },
    });
    await store.saveJobRecord('51job', original);

    const updated = await store.updateJobIdentityIfRevision(
      '51job',
      '铝镁合金',
      1,
      {
        version: 1,
        expectedJobName: '全铝包装设计',
        nameAuthority: 'user-confirmed',
      },
      { authority: 'core-maintenance' },
    );

    assert.equal(updated.revision, 2);
    assert.equal(updated.jobKey, original.jobKey);
    assert.equal(updated.searchKeyword, original.searchKeyword);
    assert.equal(updated.rawText, original.rawText);
    assert.deepEqual(updated.normalizedJob, original.normalizedJob);
    assert.deepEqual(updated.searchSettings, original.searchSettings);
    assert.deepEqual(updated.jobIdentity, {
      version: 1,
      expectedJobName: '全铝包装设计',
      nameAuthority: 'user-confirmed',
    });

    await assert.rejects(
      () => store.updateJobIdentityIfRevision(
        '51job',
        '铝镁合金',
        1,
        {
          version: 1,
          expectedJobName: '另一个名称',
          nameAuthority: 'user-confirmed',
        },
        { authority: 'core-maintenance' },
      ),
      JobConfigConflictError,
    );
  });

  it('rejects a malformed persisted identity instead of silently deriving searchKeyword', async () => {
    const store = new JobStore(tempDir);
    await store.saveJobRecord('51job', coreJob());
    const filePath = path.join(tempDir, '51job', 'jobs', '铝镁合金', 'jd.json');
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    raw.jobIdentity = {
      version: 1,
      expectedJobName: '',
      nameAuthority: 'user-confirmed',
    };
    await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await assert.rejects(
      () => store.readJobRecord('51job', '铝镁合金'),
      /job-identity-name-invalid/,
    );
  });

  it('does not let the core maintenance owner rename a synchronized Boss position', async () => {
    const store = new JobStore(tempDir);
    await store.saveJobRecord('boss', {
      ...coreJob({
        jobKey: '全铝箱包设计-boss-id',
        platform: 'boss',
        searchKeyword: '全铝箱包设计',
        normalizedJob: { ...normalizedJob, title: '全铝箱包设计' },
      }),
      bossPosition: {
        bossJobId: 'boss-id',
        status: 'open',
        syncedAt: '2026-08-11T00:00:00.000Z',
        sourceHash: 'source-hash',
      },
      jobIdentity: {
        version: 1,
        expectedJobName: '全铝箱包设计',
        nameAuthority: 'platform-sync',
        nativePositionId: 'boss-id',
      },
    }, { identityWriteAuthority: 'boss-position-sync' });

    await assert.rejects(
      () => store.updateJobIdentityIfRevision(
        'boss',
        '全铝箱包设计-boss-id',
        1,
        {
          version: 1,
          expectedJobName: '全铝包装设计',
          nameAuthority: 'platform-sync',
          nativePositionId: 'boss-id',
        },
        { authority: 'core-maintenance' },
      ),
      /core-maintenance.*51job, liepin, or zhilian/i,
    );
  });
});
