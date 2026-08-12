import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  JobIdentityMigrationService,
  type JobIdentityMigrationTarget,
} from '../storage/job-identity-migration.js';
import { JobStore } from '../storage/job-store.js';
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

function record(platform: '51job' | 'liepin', jobKey = '铝镁合金'): JobRecord {
  return {
    platform,
    jobKey,
    revision: 1,
    searchKeyword: jobKey,
    searchSettings: { source: 'saved', pageKeyword: jobKey, conditions: [] },
    rawText: 'JD',
    normalizedJob,
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

const targets: JobIdentityMigrationTarget[] = [
  {
    platform: '51job',
    jobKey: '铝镁合金',
    expectedJobName: '全铝包装设计',
    nameAuthority: 'user-confirmed',
  },
  {
    platform: 'liepin',
    jobKey: '铝镁合金',
    expectedJobName: '全铝包装设计',
    nameAuthority: 'user-confirmed',
  },
];

let tempDir: string;
let store: JobStore;
let service: JobIdentityMigrationService;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-job-identity-migration-'));
  store = new JobStore(tempDir);
  service = new JobIdentityMigrationService({ dataDir: tempDir, store });
  await store.saveJobRecord('51job', record('51job'));
  await store.saveJobRecord('liepin', record('liepin'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('job identity migration manifest', () => {
  it('keeps preview read-only and requires the exact preview hash to prepare', async () => {
    const preview = await service.preview(targets);
    assert.equal(preview.executable, true);
    assert.equal(preview.items.length, 2);
    assert.equal(preview.items[0]?.platform, '51job');
    assert.equal(preview.items[1]?.platform, 'liepin');
    assert.match(preview.planHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.manifestId, `job-identity-${preview.planHash}`);
    await assert.rejects(() => fs.access(path.join(tempDir, 'maintenance')), /ENOENT/);

    await assert.rejects(
      () => service.prepare(targets, 'wrong-hash'),
      /confirmation hash does not match/i,
    );
    const prepared = await service.prepare(targets, preview.planHash);
    assert.equal(prepared.journal.status, 'prepared');
    assert.deepEqual(prepared.journal.items.map((item) => item.status), ['pending', 'pending']);
    assert.equal((await store.readJobRecord('51job', '铝镁合金')).jobIdentity, undefined);
  });

  it('persists partial progress before a crash and resumes idempotently to a verified final commit', async () => {
    const preview = await service.preview(targets);
    const prepared = await service.prepare(targets, preview.planHash);
    let committed = 0;

    await assert.rejects(
      () => service.commit(prepared.manifestId, prepared.planHash, {
        afterItemCommitted: () => {
          committed += 1;
          if (committed === 1) throw new Error('simulated crash');
        },
      }),
      /simulated crash/,
    );

    const partial = await service.readManifest(prepared.manifestId);
    assert.equal(partial.journal.status, 'partially-committed');
    assert.equal(partial.journal.items[0]?.status, 'committed');
    assert.equal(partial.journal.items[1]?.status, 'pending');
    assert.equal((await store.readJobRecord('51job', '铝镁合金')).jobIdentity?.expectedJobName, '全铝包装设计');
    assert.equal((await store.readJobRecord('liepin', '铝镁合金')).jobIdentity, undefined);

    const complete = await service.commit(prepared.manifestId, prepared.planHash);
    assert.equal(complete.journal.status, 'committed');
    assert.equal(complete.journal.finalCommit?.verifiedPlanHash, prepared.planHash);
    assert.equal((await store.readJobRecord('liepin', '铝镁合金')).jobIdentity?.expectedJobName, '全铝包装设计');

    const repeated = await service.commit(prepared.manifestId, prepared.planHash);
    assert.deepEqual(repeated, complete);
  });

  it('stops at the first stale source record and never reports a partial migration as complete', async () => {
    const preview = await service.preview(targets);
    const prepared = await service.prepare(targets, preview.planHash);
    await store.applyJobConfigPatch('liepin', '铝镁合金', 1, { recipientEmail: 'new@example.test' });

    await assert.rejects(
      () => service.commit(prepared.manifestId, prepared.planHash),
      /source (revision|record hash).*conflict/i,
    );
    const partial = await service.readManifest(prepared.manifestId);
    assert.equal(partial.journal.status, 'conflicted');
    assert.equal(partial.journal.items[0]?.status, 'committed');
    assert.equal(partial.journal.items[1]?.status, 'conflicted');
    assert.equal(partial.journal.finalCommit, undefined);
    assert.equal((await store.readJobRecord('liepin', '铝镁合金')).jobIdentity, undefined);
  });

  it('fails closed when a prepared manifest is tampered', async () => {
    const preview = await service.preview(targets);
    const prepared = await service.prepare(targets, preview.planHash);
    const manifestPath = service.manifestPath(prepared.manifestId);
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const intent = raw.intent as { items: Array<Record<string, unknown>> };
    intent.items[0]!.jobKey = 'tampered';
    await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await assert.rejects(
      () => service.commit(prepared.manifestId, prepared.planHash),
      /manifest plan hash does not match its immutable intent/i,
    );
  });

  it('lists active task references in preview and rechecks them before commit', async () => {
    const taskDir = path.join(tempDir, 'runtime', 'tasks');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'active-task.json'), JSON.stringify({
      taskId: 'active-task',
      kind: 'resume-capture',
      status: 'queued',
      input: { platform: 'all', keyword: '铝镁合金' },
    }), 'utf8');
    const blockedPreview = await service.preview(targets);
    assert.equal(blockedPreview.executable, false);
    assert.deepEqual(blockedPreview.activeTaskReferences[0]?.references, [
      { platform: '51job', jobKey: '铝镁合金' },
      { platform: 'liepin', jobKey: '铝镁合金' },
    ]);

    await fs.rm(path.join(taskDir, 'active-task.json'));
    const preview = await service.preview(targets);
    const prepared = await service.prepare(targets, preview.planHash);
    await fs.writeFile(path.join(taskDir, 'running-task.json'), JSON.stringify({
      taskId: 'running-task',
      kind: 'resume-capture',
      status: 'running',
      input: { platform: '51job', keyword: '铝镁合金' },
    }), 'utf8');
    await assert.rejects(
      () => service.commit(prepared.manifestId, prepared.planHash),
      /blocked by active queued\/running tasks: running-task/i,
    );
    assert.equal((await store.readJobRecord('51job', '铝镁合金')).jobIdentity, undefined);
  });
});
