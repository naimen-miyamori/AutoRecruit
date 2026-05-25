import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { JobRecord, RunResult } from '../types/job.js';

interface LegacyJobRecord extends Omit<JobRecord, 'platform'> {
  platform?: SupportedPlatform;
}

interface LegacyRunResult extends Omit<RunResult, 'platform'> {
  platform?: SupportedPlatform;
}

export interface PlatformMigrationSummary {
  jobsScanned: number;
  jobRecordsUpdated: number;
  runResultsUpdated: number;
  legacyJobDirectoriesMoved: number;
}

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function migrateJobRecord(jobDir: string): Promise<boolean> {
  const jobRecordPath = path.join(jobDir, 'jd.json');

  try {
    const jobRecord = await readJsonFile<LegacyJobRecord>(jobRecordPath);
    if (jobRecord.platform) {
      return false;
    }

    await writeJsonFile(jobRecordPath, {
      ...jobRecord,
      platform: '51job',
    } satisfies JobRecord);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function migrateRunResults(jobDir: string): Promise<number> {
  const resultsDir = path.join(jobDir, 'results');
  const files = await listJsonFiles(resultsDir);
  let updated = 0;

  for (const file of files) {
    const filePath = path.join(resultsDir, file);
    const runResult = await readJsonFile<LegacyRunResult>(filePath);
    if (runResult.platform) {
      continue;
    }

    await writeJsonFile(filePath, {
      ...runResult,
      platform: '51job',
    } satisfies RunResult);
    updated += 1;
  }

  return updated;
}

async function moveLegacyJobDirectories(): Promise<number> {
  const legacyJobsDir = path.join(config.dataDir, 'jobs');
  const targetJobsDir = path.join(config.dataDir, '51job', 'jobs');
  const jobKeys = await listDirectories(legacyJobsDir);
  let moved = 0;

  for (const jobKey of jobKeys) {
    const source = path.join(legacyJobsDir, jobKey);
    const target = path.join(targetJobsDir, jobKey);
    if (await pathExists(target)) {
      throw new Error(`Cannot migrate legacy job ${jobKey}: target already exists at ${target}`);
    }
    await fs.mkdir(targetJobsDir, { recursive: true });
    await fs.rename(source, target);
    moved += 1;
  }

  if (moved > 0) {
    await fs.rm(legacyJobsDir, { recursive: true, force: true });
  }

  return moved;
}

export async function migrateStoredPlatforms(): Promise<PlatformMigrationSummary> {
  const legacyJobDirectoriesMoved = await moveLegacyJobDirectories();
  let jobsScanned = 0;
  let jobRecordsUpdated = 0;
  let runResultsUpdated = 0;

  for (const platform of ['51job', 'liepin'] satisfies SupportedPlatform[]) {
    const jobsDir = path.join(config.dataDir, platform, 'jobs');
    const jobKeys = await listDirectories(jobsDir);
    jobsScanned += jobKeys.length;

    for (const jobKey of jobKeys) {
      const jobDir = path.join(jobsDir, jobKey);
      if (await migrateJobRecord(jobDir)) {
        jobRecordsUpdated += 1;
      }
      runResultsUpdated += await migrateRunResults(jobDir);
    }
  }

  return {
    jobsScanned,
    jobRecordsUpdated,
    runResultsUpdated,
    legacyJobDirectoriesMoved,
  };
}

async function main(): Promise<void> {
  const result = await migrateStoredPlatforms();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
