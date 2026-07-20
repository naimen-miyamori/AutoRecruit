import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
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
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => readJsonFile<ScheduleDefinition>(path.join(this.schedulesDir, entry))));
    return schedules.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listScheduleSummaries(): Promise<ScheduleSummary[]> {
    return (await this.listSchedules()).map(toSummary);
  }

  async readSchedule(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    try {
      return await readJsonFile<ScheduleDefinition>(path.join(this.schedulesDir, `${scheduleId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async saveSchedule(schedule: ScheduleDefinition): Promise<void> {
    await writeJsonAtomically(path.join(this.schedulesDir, `${schedule.scheduleId}.json`), schedule);
  }

  async readRun(scheduleId: string, runId: string): Promise<ScheduleRunRecord | undefined> {
    try {
      return await readJsonFile<ScheduleRunRecord>(path.join(this.runsDir, scheduleId, `${runId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async listRuns(scheduleId: string): Promise<ScheduleRunRecord[]> {
    const dir = path.join(this.runsDir, scheduleId);
    try {
      const entries = await fs.readdir(dir);
      const runs = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .sort()
        .map((entry) => readJsonFile<ScheduleRunRecord>(path.join(dir, entry))));
      return runs.sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async saveRun(run: ScheduleRunRecord): Promise<void> {
    await writeJsonAtomically(path.join(this.runsDir, run.scheduleId, `${run.runId}.json`), run);
  }
}
