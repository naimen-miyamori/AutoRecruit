import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import {
  assertScheduleId,
  assertScheduleRunId,
  isScheduleId,
  isScheduleRunId,
} from './schedule-identifiers.js';
import type { ScheduleDefinition, ScheduleRunRecord, ScheduleSummary } from './types.js';

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function resolveContainedPath(rootDir: string, ...segments: string[]): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Schedule storage path must remain inside its configured directory');
  }
  return resolved;
}

function toSummary(schedule: ScheduleDefinition): ScheduleSummary {
  return {
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    status: schedule.status,
    timeZone: schedule.timeZone,
    dailyWindow: schedule.dailyWindow,
    repeat: schedule.repeat,
    taskCount: schedule.tasks.filter((task) => task.enabled).length,
    activeRunId: schedule.activeRunId,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    consecutiveFailures: schedule.consecutiveFailures,
    updatedAt: schedule.updatedAt,
  };
}

export class ScheduleStore {
  private readonly schedulesDir: string;
  private readonly runsDir: string;

  constructor(dataDir = config.dataDir) {
    const runtimeDir = path.join(dataDir, 'runtime');
    this.schedulesDir = path.join(runtimeDir, 'schedules');
    this.runsDir = path.join(runtimeDir, 'schedule-runs');
  }

  async listSchedules(): Promise<ScheduleDefinition[]> {
    await ensureDir(this.schedulesDir);
    const entries = await fs.readdir(this.schedulesDir);
    const schedules = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json') && isScheduleId(entry.slice(0, -'.json'.length)))
      .sort()
      .map((entry) => readJsonFile<ScheduleDefinition>(resolveContainedPath(this.schedulesDir, entry))));
    return schedules.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listScheduleSummaries(): Promise<ScheduleSummary[]> {
    return (await this.listSchedules()).map(toSummary);
  }

  async readSchedule(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    assertScheduleId(scheduleId);
    try {
      return await readJsonFile<ScheduleDefinition>(resolveContainedPath(this.schedulesDir, `${scheduleId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async saveSchedule(schedule: ScheduleDefinition): Promise<void> {
    assertScheduleId(schedule.scheduleId);
    await writeJsonAtomically(resolveContainedPath(this.schedulesDir, `${schedule.scheduleId}.json`), schedule);
  }

  async readRun(scheduleId: string, runId: string): Promise<ScheduleRunRecord | undefined> {
    assertScheduleId(scheduleId);
    assertScheduleRunId(runId);
    try {
      return await readJsonFile<ScheduleRunRecord>(resolveContainedPath(this.runsDir, scheduleId, `${runId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async listRuns(scheduleId: string): Promise<ScheduleRunRecord[]> {
    assertScheduleId(scheduleId);
    const dir = resolveContainedPath(this.runsDir, scheduleId);
    try {
      const entries = await fs.readdir(dir);
      const runs = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json') && isScheduleRunId(entry.slice(0, -'.json'.length)))
        .sort()
        .map((entry) => readJsonFile<ScheduleRunRecord>(resolveContainedPath(dir, entry))));
      return runs.sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async saveRun(run: ScheduleRunRecord): Promise<void> {
    assertScheduleId(run.scheduleId);
    assertScheduleRunId(run.runId);
    await writeJsonAtomically(resolveContainedPath(this.runsDir, run.scheduleId, `${run.runId}.json`), run);
  }
}
