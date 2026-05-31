import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { config } from '../config.js';
import { buildJobKey } from '../parsers/jd-parser.js';
import type { RunResult } from '../types/job.js';
import { clearTodayLiepinSeenIdsForKeyword } from './smoke-liepin-flow.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function localDatePrefix(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function useTempDataDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-liepin-smoke-'));
  tempDirs.push(tempDir);
  (config as { dataDir: string }).dataDir = tempDir;
  return tempDir;
}

after(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('liepin smoke validation clears candidate ids from today run results only', async () => {
  const dataDir = await useTempDataDir();
  const keyword = '优衣库';
  const jobKey = buildJobKey(keyword, '');
  const jobDir = path.join(dataDir, 'liepin', 'jobs', jobKey);
  const resultsDir = path.join(jobDir, 'results');
  const now = new Date(2026, 4, 29, 12, 0, 0);
  const yesterday = new Date(2026, 4, 28, 12, 0, 0);
  const today = localDatePrefix(now);

  await writeJson(path.join(jobDir, 'seen-ids.json'), [
    'today-new',
    'today-scored',
    'today-failed',
    'legacy-file-id',
    'yesterday-id',
    'unrelated-id',
  ]);

  await writeJson(path.join(resultsDir, 'today-with-fetched-at.json'), {
    jobKey,
    platform: 'liepin',
    fetchedAt: now.toISOString(),
    totalCandidates: 3,
    newCandidateIds: ['today-new'],
    scoredCandidates: ['today-scored'],
    failedCandidates: [{ candidateId: 'today-failed', error: 'forward failed' }],
  } satisfies RunResult);
  await writeJson(path.join(resultsDir, `${today}Tlegacy-no-fetched-at.json`), {
    newCandidateIds: ['legacy-file-id'],
    scoredCandidates: [],
    failedCandidates: [],
  });
  await writeJson(path.join(resultsDir, 'yesterday-with-fetched-at.json'), {
    jobKey,
    platform: 'liepin',
    fetchedAt: yesterday.toISOString(),
    totalCandidates: 1,
    newCandidateIds: ['yesterday-id'],
    scoredCandidates: [],
    failedCandidates: [],
  } satisfies RunResult);

  const summary = await clearTodayLiepinSeenIdsForKeyword(keyword, now);
  const nextSeenIds = JSON.parse(await fs.readFile(path.join(jobDir, 'seen-ids.json'), 'utf8')) as string[];

  assert.deepStrictEqual(nextSeenIds, ['yesterday-id', 'unrelated-id']);
  assert.deepStrictEqual(summary, {
    stage: 'clearTodayLiepinSeenIds',
    keyword,
    jobKey,
    today,
    todayResultIds: 4,
    before: 6,
    after: 2,
    removed: 4,
  });
});
