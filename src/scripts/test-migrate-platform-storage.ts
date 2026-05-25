import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../config.js';
import { JobStore } from '../storage/job-store.js';
import type { JobRecord, RunResult } from '../types/job.js';
import { migrateStoredPlatforms } from './migrate-platform-storage.js';

let tempDir: string;
let originalDataDir: string;

function buildJobPath(platform: '51job' | 'liepin', jobKey: string, ...segments: string[]): string {
  return path.join(config.dataDir, platform, 'jobs', jobKey, ...segments);
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-platform-migration-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('migrateStoredPlatforms', () => {
  it('fills missing platform fields in legacy job records and run results', async () => {
    const jobKey = 'legacy-platform-job';
    const store = new JobStore();
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: '东南亚 销售',
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
    const runResult: RunResult = {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-1'],
      scoredCandidates: ['cand-1'],
      failedCandidates: [],
    };

    await store.saveJobRecord('51job', jobRecord);
    await store.saveRunResult('51job', jobKey, runResult);

    const jobRecordPath = buildJobPath('51job', jobKey, 'jd.json');
    const runResultPath = buildJobPath('51job', jobKey, 'results', '2026-04-21T00-00-02-000Z.json');

    await fs.writeFile(
      jobRecordPath,
      `${JSON.stringify({
        jobKey: jobRecord.jobKey,
        searchKeyword: jobRecord.searchKeyword,
        rawText: jobRecord.rawText,
        normalizedJob: jobRecord.normalizedJob,
        createdAt: jobRecord.createdAt,
      }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      runResultPath,
      `${JSON.stringify({
        jobKey: runResult.jobKey,
        fetchedAt: runResult.fetchedAt,
        totalCandidates: runResult.totalCandidates,
        newCandidateIds: runResult.newCandidateIds,
        scoredCandidates: runResult.scoredCandidates,
        failedCandidates: runResult.failedCandidates,
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateStoredPlatforms();

    assert.deepStrictEqual(result, {
      jobsScanned: 1,
      jobRecordsUpdated: 1,
      runResultsUpdated: 1,
      legacyJobDirectoriesMoved: 0,
    });

    const migratedJobRecord = JSON.parse(await fs.readFile(jobRecordPath, 'utf8')) as JobRecord;
    const migratedRunResult = JSON.parse(await fs.readFile(runResultPath, 'utf8')) as RunResult;

    assert.equal(migratedJobRecord.platform, '51job');
    assert.equal(migratedRunResult.platform, '51job');
  });

  it('leaves already-migrated files unchanged', async () => {
    const jobKey = 'current-platform-job';
    const store = new JobStore();
    const jobRecord: JobRecord = {
      jobKey,
      platform: '51job',
      searchKeyword: '东南亚 销售',
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
    const runResult: RunResult = {
      jobKey,
      platform: '51job',
      fetchedAt: '2026-04-21T00:00:02.000Z',
      totalCandidates: 1,
      newCandidateIds: ['cand-1'],
      scoredCandidates: ['cand-1'],
      failedCandidates: [],
    };

    await store.saveJobRecord('51job', jobRecord);
    await store.saveRunResult('51job', jobKey, runResult);

    const result = await migrateStoredPlatforms();

    assert.deepStrictEqual(result, {
      jobsScanned: 1,
      jobRecordsUpdated: 0,
      runResultsUpdated: 0,
      legacyJobDirectoriesMoved: 0,
    });
  });

  it('moves legacy data/jobs entries into the 51job platform directory', async () => {
    const jobKey = 'legacy-directory-job';
    const legacyJobDir = path.join(config.dataDir, 'jobs', jobKey);
    const migratedJobDir = path.join(config.dataDir, '51job', 'jobs', jobKey);

    await fs.mkdir(path.join(legacyJobDir, 'results'), { recursive: true });
    await fs.writeFile(
      path.join(legacyJobDir, 'jd.json'),
      `${JSON.stringify({
        jobKey,
        searchKeyword: '东南亚 销售',
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
      }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(legacyJobDir, 'results', '2026-04-21T00-00-02-000Z.json'),
      `${JSON.stringify({
        jobKey,
        fetchedAt: '2026-04-21T00:00:02.000Z',
        totalCandidates: 1,
        newCandidateIds: ['cand-1'],
        scoredCandidates: ['cand-1'],
        failedCandidates: [],
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateStoredPlatforms();

    assert.deepStrictEqual(result, {
      jobsScanned: 1,
      jobRecordsUpdated: 1,
      runResultsUpdated: 1,
      legacyJobDirectoriesMoved: 1,
    });
    await assert.rejects(() => fs.stat(legacyJobDir), /ENOENT/);
    assert.equal((await fs.stat(migratedJobDir)).isDirectory(), true);
    const migratedJobRecord = JSON.parse(await fs.readFile(path.join(migratedJobDir, 'jd.json'), 'utf8')) as JobRecord;
    assert.equal(migratedJobRecord.platform, '51job');
  });
});
