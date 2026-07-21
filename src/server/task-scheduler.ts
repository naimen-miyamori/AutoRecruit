import crypto from 'node:crypto';

import { config } from '../config.js';
import { normalizeScheduleCreate, normalizeScheduleUpdate } from './schedule-normalizers.js';
import { resolveNextEligibleStart, getWindowState } from './schedule-time.js';
import { ScheduleStore } from './schedule-store.js';
import { normalizeSchedulableTask } from './task-normalizers.js';
import { TaskQueue, type QueueTaskDefinition } from './task-queue.js';
import type {
  ScheduleDefinition,
  ScheduleRunRecord,
  ScheduleSummary,
  TaskDetail,
} from './types.js';

interface TaskSchedulerOptions {
  taskQueue: TaskQueue;
  store?: ScheduleStore;
  dataDir?: string;
  now?: () => Date;
}

function isTerminal(status: TaskDetail['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function hasFailed(tasks: Array<TaskDetail | undefined>): boolean {
  return tasks.some((task) => task?.status === 'failed' || task?.status === 'cancelled');
}

function serialize(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export class TaskScheduler {
  private readonly taskQueue: TaskQueue;
  private readonly store: ScheduleStore;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly ready: Promise<void>;
  private serial: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private unsubscribeTaskListener?: () => void;

  constructor(options: TaskSchedulerOptions) {
    this.taskQueue = options.taskQueue;
    this.store = options.store ?? new ScheduleStore(options.dataDir ?? config.dataDir);
    this.dataDir = options.dataDir ?? config.dataDir;
    this.now = options.now ?? (() => new Date());
    this.ready = this.recover();
    this.unsubscribeTaskListener = this.taskQueue.onTaskTerminal(() => {
      this.requestProcess(0);
    });
    this.requestProcess(0);
  }

  async listSchedules(): Promise<ScheduleSummary[]> {
    await this.ready;
    return this.store.listScheduleSummaries();
  }

  async getSchedule(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    await this.ready;
    return this.store.readSchedule(scheduleId);
  }

  async listRuns(scheduleId: string): Promise<ScheduleRunRecord[]> {
    await this.ready;
    return this.store.listRuns(scheduleId);
  }

  async createSchedule(payload: unknown): Promise<ScheduleDefinition> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedule = normalizeScheduleCreate(payload, this.now());
      schedule.tasks = await this.normalizeTemplates(schedule);
      if (await this.store.readSchedule(schedule.scheduleId)) {
        throw new Error(`Schedule already exists: ${schedule.scheduleId}`);
      }
      await this.store.saveSchedule(schedule);
      this.requestProcess(0);
      return schedule;
    });
  }

  async updateSchedule(scheduleId: string, payload: unknown): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const current = await this.store.readSchedule(scheduleId);
      if (!current) {
        return undefined;
      }
      const updated = normalizeScheduleUpdate(current, payload, this.now());
      updated.tasks = await this.normalizeTemplates(updated);
      await this.store.saveSchedule(updated);
      this.requestProcess(0);
      return updated;
    });
  }

  async startSchedule(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedule = await this.store.readSchedule(scheduleId);
      if (!schedule) {
        return undefined;
      }
      if (schedule.activeRunId) {
        throw new Error('Cannot start a schedule while a round is active');
      }
      schedule.status = 'enabled';
      schedule.stopRequestedAt = undefined;
      schedule.nextRunAt = this.now().toISOString();
      schedule.updatedAt = this.now().toISOString();
      await this.store.saveSchedule(schedule);
      this.requestProcess(0);
      return schedule;
    });
  }

  async pauseSchedule(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedule = await this.store.readSchedule(scheduleId);
      if (!schedule) {
        return undefined;
      }
      schedule.status = 'paused';
      schedule.nextRunAt = undefined;
      schedule.updatedAt = this.now().toISOString();
      await this.store.saveSchedule(schedule);
      this.requestProcess(0);
      return schedule;
    });
  }

  async stopScheduleAfterCurrentTask(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedule = await this.store.readSchedule(scheduleId);
      if (!schedule) {
        return undefined;
      }
      const now = this.now().toISOString();
      if (!schedule.activeRunId) {
        schedule.status = 'stopped';
        schedule.stopRequestedAt = now;
        schedule.nextRunAt = undefined;
        schedule.updatedAt = now;
        await this.store.saveSchedule(schedule);
        return schedule;
      }

      schedule.status = 'stop_requested';
      schedule.stopRequestedAt = now;
      schedule.nextRunAt = undefined;
      schedule.updatedAt = now;
      await this.store.saveSchedule(schedule);
      const run = await this.store.readRun(scheduleId, schedule.activeRunId);
      if (run) {
        run.status = 'stopping';
        run.stopRequestedAt = now;
        await this.store.saveRun(run);
        await this.taskQueue.requestGroupStopAfterCurrentTask(run.runId);
      }
      this.requestProcess(0);
      return schedule;
    });
  }

  async stopAllAfterCurrentTask(): Promise<ScheduleSummary[]> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedules = await this.store.listSchedules();
      for (const schedule of schedules) {
        if (schedule.status === 'stopped') {
          continue;
        }
        await this.stopScheduleAfterCurrentTaskWithinLock(schedule);
      }
      this.requestProcess(0);
      return this.store.listScheduleSummaries();
    });
  }

  async runScheduleNow(scheduleId: string): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedule = await this.store.readSchedule(scheduleId);
      if (!schedule) {
        return undefined;
      }
      if (schedule.activeRunId) {
        throw new Error('Cannot start a new round while the previous round is active');
      }
      if (schedule.status !== 'enabled') {
        throw new Error('Schedule must be enabled before it can run');
      }
      schedule.nextRunAt = this.now().toISOString();
      schedule.updatedAt = this.now().toISOString();
      await this.store.saveSchedule(schedule);
      this.requestProcess(0);
      return schedule;
    });
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.unsubscribeTaskListener?.();
    this.unsubscribeTaskListener = undefined;
  }

  private async recover(): Promise<void> {
    const schedules = await this.store.listSchedules();
    const now = this.now().toISOString();
    for (const schedule of schedules) {
      if (schedule.activeRunId) {
        const run = await this.store.readRun(schedule.scheduleId, schedule.activeRunId);
        if (run) {
          run.status = schedule.status === 'stop_requested' ? 'stopped' : 'interrupted';
          run.finishedAt = run.finishedAt ?? now;
          run.error = run.error ?? 'Scheduler restarted before the round completed';
          await this.store.saveRun(run);
        }
        schedule.activeRunId = undefined;
      }
      if (schedule.status === 'stop_requested') {
        schedule.status = 'stopped';
        schedule.nextRunAt = undefined;
      } else if (schedule.status === 'enabled' && !schedule.nextRunAt) {
        schedule.nextRunAt = now;
      }
      schedule.updatedAt = now;
      await this.store.saveSchedule(schedule);
    }
  }

  private requestProcess(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const boundedDelay = Math.max(0, Math.min(delayMs, 2_147_000_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runSerialized(async () => {
        await this.ready;
        await this.processSchedules();
      });
    }, boundedDelay);
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async processSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.listSchedules();
    let nextWakeAt = now.getTime() + 60_000;

    for (const schedule of schedules) {
      if (schedule.activeRunId) {
        await this.reconcileActiveRun(schedule, now);
      }
      if (schedule.activeRunId || schedule.status !== 'enabled') {
        continue;
      }

      const window = getWindowState(now, schedule.dailyWindow, schedule.timeZone);
      if (!window.within) {
        if (schedule.nextRunAt !== window.nextStartAt.toISOString()) {
          schedule.nextRunAt = window.nextStartAt.toISOString();
          schedule.updatedAt = now.toISOString();
          await this.store.saveSchedule(schedule);
        }
        nextWakeAt = Math.min(nextWakeAt, window.nextStartAt.getTime());
        continue;
      }

      const dueAt = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : now.getTime();
      if (Number.isFinite(dueAt) && dueAt > now.getTime()) {
        nextWakeAt = Math.min(nextWakeAt, dueAt);
        continue;
      }
      if (!(await this.taskQueue.isIdle())) {
        nextWakeAt = Math.min(nextWakeAt, now.getTime() + 1000);
        continue;
      }

      try {
        await this.startRound(schedule, now);
      } catch (error) {
        schedule.consecutiveFailures += 1;
        schedule.updatedAt = now.toISOString();
        if (schedule.consecutiveFailures >= schedule.pauseAfterConsecutiveFailures) {
          schedule.status = 'paused';
          schedule.nextRunAt = undefined;
        } else {
          schedule.nextRunAt = resolveNextEligibleStart(now, schedule.repeat.failureDelaySeconds, schedule.dailyWindow, schedule.timeZone).toISOString();
        }
        await this.store.saveSchedule(schedule);
      }
    }

    this.requestProcess(Math.max(100, nextWakeAt - this.now().getTime()));
  }

  private async startRound(schedule: ScheduleDefinition, now: Date): Promise<void> {
    const enabledTasks = schedule.tasks.filter((task) => task.enabled);
    if (enabledTasks.length === 0) {
      schedule.status = 'paused';
      schedule.nextRunAt = undefined;
      schedule.updatedAt = now.toISOString();
      await this.store.saveSchedule(schedule);
      return;
    }
    const runId = crypto.randomUUID();
    const normalized = await Promise.all(enabledTasks.map(async (template, index) => {
      const task = await normalizeSchedulableTask(template.kind, template.input, this.dataDir);
      return {
        kind: task.kind,
        input: task.input,
        inputSummary: task.inputSummary,
        argv: task.argv,
        schedule: {
          scheduleId: schedule.scheduleId,
          scheduleRunId: runId,
          scheduleTaskKey: template.taskKey,
          scheduleTaskIndex: index,
        },
      } satisfies QueueTaskDefinition;
    }));
    const enqueued = await this.taskQueue.enqueueGroupIfIdle({
      groupId: runId,
      tasks: normalized,
      failurePolicy: schedule.failurePolicy,
    });
    if (!enqueued.accepted) {
      return;
    }

    const timestamp = now.toISOString();
    const previousRuns = await this.store.listRuns(schedule.scheduleId);
    const run: ScheduleRunRecord = {
      runId,
      scheduleId: schedule.scheduleId,
      cycleNumber: previousRuns.length + 1,
      status: 'running',
      scheduledAt: timestamp,
      startedAt: timestamp,
      taskIds: enqueued.taskIds,
      completedTaskIds: [],
      cancelledTaskIds: [],
    };
    schedule.activeRunId = runId;
    schedule.lastRunAt = timestamp;
    schedule.nextRunAt = undefined;
    schedule.updatedAt = timestamp;
    await Promise.all([
      this.store.saveRun(run),
      this.store.saveSchedule(schedule),
    ]);
    this.requestProcess(0);
  }

  private async reconcileActiveRun(schedule: ScheduleDefinition, now: Date): Promise<void> {
    const runId = schedule.activeRunId;
    if (!runId) {
      return;
    }
    const run = await this.store.readRun(schedule.scheduleId, runId);
    if (!run) {
      schedule.activeRunId = undefined;
      schedule.status = 'paused';
      schedule.nextRunAt = undefined;
      schedule.updatedAt = now.toISOString();
      await this.store.saveSchedule(schedule);
      return;
    }

    if (schedule.status === 'stop_requested') {
      run.status = 'stopping';
      run.stopRequestedAt ??= schedule.stopRequestedAt ?? now.toISOString();
      await this.store.saveRun(run);
      await this.taskQueue.requestGroupStopAfterCurrentTask(run.runId);
    }

    const tasks = await Promise.all(run.taskIds.map((taskId) => this.taskQueue.getTask(taskId)));
    run.currentTaskId = tasks.find((task) => task?.status === 'running')?.taskId;
    run.completedTaskIds = tasks.filter((task) => task && isTerminal(task.status) && task.status !== 'cancelled').map((task) => task!.taskId);
    run.cancelledTaskIds = tasks.filter((task) => task?.status === 'cancelled').map((task) => task!.taskId);
    if (!tasks.every((task) => task && isTerminal(task.status))) {
      await this.store.saveRun(run);
      return;
    }

    const timestamp = now.toISOString();
    run.finishedAt = timestamp;
    schedule.activeRunId = undefined;
    if (schedule.status === 'stop_requested') {
      run.status = 'stopped';
      schedule.status = 'stopped';
      schedule.nextRunAt = undefined;
    } else if (schedule.status === 'paused') {
      run.status = hasFailed(tasks) ? 'failed' : 'succeeded';
      schedule.nextRunAt = undefined;
    } else if (hasFailed(tasks)) {
      run.status = 'failed';
      run.error = tasks.find((task) => task?.error)?.error ?? 'One or more scheduled tasks failed';
      schedule.consecutiveFailures += 1;
      if (schedule.consecutiveFailures >= schedule.pauseAfterConsecutiveFailures) {
        schedule.status = 'paused';
        schedule.nextRunAt = undefined;
      } else {
        schedule.nextRunAt = resolveNextEligibleStart(now, schedule.repeat.failureDelaySeconds, schedule.dailyWindow, schedule.timeZone).toISOString();
      }
    } else {
      run.status = 'succeeded';
      schedule.consecutiveFailures = 0;
      schedule.nextRunAt = resolveNextEligibleStart(now, schedule.repeat.delaySeconds, schedule.dailyWindow, schedule.timeZone).toISOString();
    }
    schedule.updatedAt = timestamp;
    await Promise.all([
      this.store.saveRun(run),
      this.store.saveSchedule(schedule),
    ]);
  }

  private async normalizeTemplates(schedule: ScheduleDefinition): Promise<ScheduleDefinition['tasks']> {
    return Promise.all(schedule.tasks.map(async (template) => {
      const normalized = await normalizeSchedulableTask(template.kind, template.input, this.dataDir);
      return {
        ...template,
        input: serialize(normalized.input),
      };
    }));
  }

  private async stopScheduleAfterCurrentTaskWithinLock(schedule: ScheduleDefinition): Promise<void> {
    const now = this.now().toISOString();
    if (!schedule.activeRunId) {
      schedule.status = 'stopped';
      schedule.stopRequestedAt = now;
      schedule.nextRunAt = undefined;
      schedule.updatedAt = now;
      await this.store.saveSchedule(schedule);
      return;
    }
    schedule.status = 'stop_requested';
    schedule.stopRequestedAt = now;
    schedule.nextRunAt = undefined;
    schedule.updatedAt = now;
    await this.store.saveSchedule(schedule);
    const run = await this.store.readRun(schedule.scheduleId, schedule.activeRunId);
    if (run) {
      run.status = 'stopping';
      run.stopRequestedAt = now;
      await this.store.saveRun(run);
      await this.taskQueue.requestGroupStopAfterCurrentTask(run.runId);
    }
  }
}
