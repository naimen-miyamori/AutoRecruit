import crypto from 'node:crypto';

import { config } from '../config.js';
import type { BossCapturePlanStore } from '../platforms/boss/capture-plan.js';
import { SearchConditionSetService } from '../search/search-condition-sets.js';
import {
  snapshotBossBatchCaptureSettings,
  snapshotBossCaptureSettings,
  type BossCapturePlanResolver,
} from './boss-capture-snapshot.js';
import { normalizeScheduleCreate, normalizeScheduleUpdate } from './schedule-normalizers.js';
import { inspectPersistedScheduleRecord } from './schedule-record-validation.js';
import {
  assertRecurringScheduleTaskKind,
  inspectScheduleTemplates,
  mergeScheduleValidationIssues,
  ScheduleTemplateValidationError,
  validateScheduleTemplates,
} from './schedule-template-validation.js';
import { preflightTaskSearchConditionSets } from './search-condition-set-preflight.js';
import { buildServerCaptureExecutionEnvelope } from './capture-execution-envelope.js';
import { resolveNextEligibleStart, getWindowState } from './schedule-time.js';
import {
  ScheduleLeaseOwnershipLostError,
  ScheduleLeaseRecoveryRequiredError,
  ScheduleLeaseTimeoutError,
  ScheduleStore,
  ScheduleStoreConflictError,
  toScheduleDetailView,
} from './schedule-store.js';
import { normalizeSchedulableTask } from './task-normalizers.js';
import {
  TaskGroupConflictError,
  TaskGroupPersistenceError,
  TaskQueue,
  type QueueTaskDefinition,
} from './task-queue.js';
import type {
  BatchTaskInput,
  NormalizedScheduleDefinition,
  NormalizedScheduledTaskTemplate,
  PersistedScheduleDefinition,
  ResumeCaptureTaskInput,
  ScheduleDefinition,
  ScheduleDetailView,
  ScheduleRunRecord,
  ScheduleSummary,
  ScheduleValidationIssue,
  TaskDetail,
} from './types.js';

interface TaskSchedulerOptions {
  taskQueue: TaskQueue;
  store?: ScheduleStore;
  dataDir?: string;
  now?: () => Date;
  searchConditionSetService?: SearchConditionSetService;
  bossCapturePlanResolver?: BossCapturePlanResolver;
  bossCapturePlanStore?: BossCapturePlanStore;
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

function canonicalizeSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeSnapshot);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalizeSnapshot(item)]));
}

function sameScheduleSnapshot(left: PersistedScheduleDefinition, right: PersistedScheduleDefinition): boolean {
  const scheduleId = typeof left.scheduleId === 'string'
    ? left.scheduleId
    : typeof right.scheduleId === 'string'
      ? right.scheduleId
      : undefined;
  const leftExecutable = inspectPersistedScheduleRecord(left, scheduleId).executable;
  const rightExecutable = inspectPersistedScheduleRecord(right, scheduleId).executable;
  return Boolean(leftExecutable && rightExecutable)
    && JSON.stringify(canonicalizeSnapshot(leftExecutable)) === JSON.stringify(canonicalizeSnapshot(rightExecutable));
}

function sameValidationIssues(
  left: unknown,
  right: readonly ScheduleValidationIssue[] | undefined,
): boolean {
  return JSON.stringify(mergeScheduleValidationIssues(left, [])) === JSON.stringify(right ?? []);
}

class ScheduleDispatchPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Scheduled task group was accepted but its run state was not fully persisted', { cause });
    this.name = 'ScheduleDispatchPersistenceError';
  }
}

function isSchedulerInfrastructureError(error: unknown): boolean {
  return error instanceof ScheduleDispatchPersistenceError
    || error instanceof TaskGroupPersistenceError
    || error instanceof TaskGroupConflictError
    || error instanceof ScheduleLeaseTimeoutError
    || error instanceof ScheduleLeaseRecoveryRequiredError
    || error instanceof ScheduleLeaseOwnershipLostError
    || error instanceof ScheduleStoreConflictError;
}

export class TaskScheduler {
  private readonly taskQueue: TaskQueue;
  private readonly store: ScheduleStore;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly searchConditionSetService: SearchConditionSetService;
  private readonly bossCapturePlanResolver?: BossCapturePlanResolver;
  private readonly bossCapturePlanStore?: BossCapturePlanStore;
  private readonly ready: Promise<void>;
  private readonly pendingDispatchRunIds = new Map<string, string>();
  private serial: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private timerDueAt?: number;
  private unsubscribeTaskListener?: () => void;
  private closed = false;

  constructor(options: TaskSchedulerOptions) {
    this.taskQueue = options.taskQueue;
    this.store = options.store ?? new ScheduleStore(options.dataDir ?? config.dataDir);
    this.dataDir = options.dataDir ?? config.dataDir;
    this.now = options.now ?? (() => new Date());
    this.searchConditionSetService = options.searchConditionSetService
      ?? new SearchConditionSetService({ dataDir: this.dataDir });
    this.bossCapturePlanResolver = options.bossCapturePlanResolver;
    this.bossCapturePlanStore = options.bossCapturePlanStore;
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

  async getSchedule(scheduleId: string): Promise<ScheduleDetailView | undefined> {
    await this.ready;
    const schedule = await this.store.readSchedule(scheduleId);
    return schedule ? toScheduleDetailView(schedule, scheduleId) : undefined;
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
      await this.store.transactSchedule(schedule.scheduleId, (current) => {
        if (current) {
          throw new Error(`Schedule already exists: ${schedule.scheduleId}`);
        }
        return { schedule, value: undefined };
      });
      this.requestProcess(0);
      return schedule;
    });
  }

  async updateSchedule(scheduleId: string, payload: unknown): Promise<ScheduleDefinition | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const updated = await this.store.transactSchedule(scheduleId, async (current) => {
        if (!current) return { value: undefined };
        const next = normalizeScheduleUpdate(current, payload, this.now(), scheduleId);
        next.tasks = await this.normalizeTemplates(next);
        return { schedule: next, value: next };
      });
      if (!updated) return undefined;
      this.requestProcess(0);
      return updated;
    });
  }

  async startSchedule(scheduleId: string): Promise<ScheduleDetailView | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const result = await this.store.transactSchedule<{
        view?: ScheduleDetailView;
        issues?: ScheduleValidationIssue[];
      }>(scheduleId, (schedule) => {
        if (!schedule) return { value: {} };
        const inspected = inspectPersistedScheduleRecord(schedule, scheduleId);
        if (!inspected.executable) {
          const validationIssues = inspected.issues;
          const quarantined = this.quarantinedSchedule(
            { ...schedule, scheduleId },
            validationIssues,
            this.now(),
          );
          return {
            ...(quarantined.changed ? { schedule: quarantined.schedule } : {}),
            value: { view: toScheduleDetailView(quarantined.schedule, scheduleId), issues: validationIssues },
          };
        }
        const executable = inspected.executable;
        if (executable.activeRunId) {
          throw new Error('Cannot start a schedule while a round is active');
        }
        const timestamp = this.now().toISOString();
        const updated = {
          ...executable,
          status: 'enabled' as const,
          stopRequestedAt: undefined,
          nextRunAt: timestamp,
          updatedAt: timestamp,
        };
        return { schedule: updated, value: { view: toScheduleDetailView(updated, scheduleId) } };
      });
      if (result.issues) throw new ScheduleTemplateValidationError(result.issues);
      if (!result.view) return undefined;
      this.requestProcess(0);
      return result.view;
    });
  }

  async pauseSchedule(scheduleId: string): Promise<ScheduleDetailView | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const view = await this.store.transactSchedule<ScheduleDetailView | undefined>(scheduleId, (schedule) => {
        if (!schedule) return { value: undefined };
        const updated = {
          ...schedule,
          scheduleId,
          status: 'paused' as const,
          nextRunAt: undefined,
          updatedAt: this.now().toISOString(),
        };
        return { schedule: updated, value: toScheduleDetailView(updated, scheduleId) };
      });
      if (!view) return undefined;
      this.requestProcess(0);
      return view;
    });
  }

  async stopScheduleAfterCurrentTask(scheduleId: string): Promise<ScheduleDetailView | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const result = await this.store.transactSchedule<{
        view?: ScheduleDetailView;
        activeRunId?: string;
      }>(scheduleId, (schedule) => {
        if (!schedule) return { value: {} };
        const inspected = inspectPersistedScheduleRecord(schedule, scheduleId);
        const now = this.now().toISOString();
        const updated = {
          ...schedule,
          scheduleId,
          status: inspected.detail.activeRunId ? 'stop_requested' as const : 'stopped' as const,
          stopRequestedAt: now,
          nextRunAt: undefined,
          updatedAt: now,
        };
        return {
          schedule: updated,
          value: { view: toScheduleDetailView(updated, scheduleId), activeRunId: inspected.detail.activeRunId },
        };
      });
      if (!result.view) return undefined;
      const run = result.activeRunId
        ? await this.store.readRun(scheduleId, result.activeRunId)
        : undefined;
      if (run) {
        run.status = 'stopping';
        run.stopRequestedAt = this.now().toISOString();
        await this.store.saveRun(run);
        await this.taskQueue.requestGroupStopAfterCurrentTask(run.runId);
      }
      this.requestProcess(0);
      return result.view;
    });
  }

  async stopAllAfterCurrentTask(): Promise<ScheduleSummary[]> {
    return this.runSerialized(async () => {
      await this.ready;
      const schedules = await this.store.listScheduleEntries();
      for (const entry of schedules) {
        const inspected = inspectPersistedScheduleRecord(entry.record, entry.scheduleId);
        if (inspected.detail.status === 'stopped') {
          continue;
        }
        await this.stopScheduleAfterCurrentTaskWithinLock(entry.record, entry.scheduleId);
      }
      this.requestProcess(0);
      return this.store.listScheduleSummaries();
    });
  }

  async runScheduleNow(scheduleId: string): Promise<ScheduleDetailView | undefined> {
    return this.runSerialized(async () => {
      await this.ready;
      const result = await this.store.transactSchedule<{
        view?: ScheduleDetailView;
        issues?: ScheduleValidationIssue[];
      }>(scheduleId, (schedule) => {
        if (!schedule) return { value: {} };
        const inspected = inspectPersistedScheduleRecord(schedule, scheduleId);
        if (!inspected.executable) {
          const validationIssues = inspected.issues;
          const quarantined = this.quarantinedSchedule(
            { ...schedule, scheduleId },
            validationIssues,
            this.now(),
          );
          return {
            ...(quarantined.changed ? { schedule: quarantined.schedule } : {}),
            value: { view: toScheduleDetailView(quarantined.schedule, scheduleId), issues: validationIssues },
          };
        }
        const executable = inspected.executable;
        if (executable.activeRunId) {
          throw new Error('Cannot start a new round while the previous round is active');
        }
        if (executable.status !== 'enabled') {
          throw new Error('Schedule must be enabled before it can run');
        }
        const timestamp = this.now().toISOString();
        const updated = { ...executable, nextRunAt: timestamp, updatedAt: timestamp };
        return { schedule: updated, value: { view: toScheduleDetailView(updated, scheduleId) } };
      });
      if (result.issues) throw new ScheduleTemplateValidationError(result.issues);
      if (!result.view) return undefined;
      this.requestProcess(0);
      return result.view;
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.timerDueAt = undefined;
    }
    this.unsubscribeTaskListener?.();
    this.unsubscribeTaskListener = undefined;
  }

  private async recover(): Promise<void> {
    const schedules = await this.store.listScheduleEntries();
    const now = this.now().toISOString();
    for (const listed of schedules) {
      try {
        await this.store.transactSchedule(listed.scheduleId, async (current) => {
        if (!current) return { value: undefined };
        const inspected = inspectPersistedScheduleRecord(current, listed.scheduleId);
        let updated: PersistedScheduleDefinition = inspected.executable
          ? { ...inspected.executable }
          : { ...current, scheduleId: listed.scheduleId };
        let changed = false;
        const activeRunId = inspected.detail.activeRunId;
        if (activeRunId) {
          const run = await this.store.readRun(listed.scheduleId, activeRunId);
          if (run) {
            const status = inspected.detail.status === 'stop_requested' ? 'stopped' : 'interrupted';
            const runChanged = run.status !== status
              || run.finishedAt === undefined
              || run.error === undefined;
            run.status = status;
            run.finishedAt ??= now;
            run.error ??= 'Scheduler restarted before the round completed';
            if (runChanged) await this.store.saveRun(run);
          }
          updated.activeRunId = undefined;
          changed = true;
        }
        const validationIssues = inspectPersistedScheduleRecord(updated, listed.scheduleId).issues;
        if (validationIssues.length > 0) {
          const quarantined = this.quarantinedSchedule(
            updated,
            validationIssues,
            new Date(now),
            changed,
          );
          return {
            ...(quarantined.changed ? { schedule: quarantined.schedule } : {}),
            value: undefined,
          };
        }
        if (updated.validationIssues !== undefined) {
          delete updated.validationIssues;
          changed = true;
        }
        if (updated.status === 'stop_requested') {
          updated.status = 'stopped';
          updated.nextRunAt = undefined;
          changed = true;
        } else if (updated.status === 'enabled' && !updated.nextRunAt) {
          updated.nextRunAt = now;
          changed = true;
        }
        if (changed) updated.updatedAt = now;
        return { ...(changed ? { schedule: updated } : {}), value: undefined };
        });
      } catch (error) {
        if (!isSchedulerInfrastructureError(error)) throw error;
      }
    }
  }

  private requestProcess(delayMs: number): void {
    if (this.closed) {
      return;
    }
    const boundedDelay = Math.max(0, Math.min(delayMs, 2_147_000_000));
    const dueAt = Date.now() + boundedDelay;
    if (this.timer && this.timerDueAt !== undefined && this.timerDueAt <= dueAt) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = undefined;
      void this.runSerialized(async () => {
        await this.ready;
        try {
          await this.processSchedules();
        } catch (error) {
          if (!isSchedulerInfrastructureError(error)) throw error;
          this.requestProcess(1000);
        }
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
    const schedules = await this.store.listScheduleEntries();
    let nextWakeAt = now.getTime() + 60_000;

    for (const entry of schedules) {
      try {
        const inspected = inspectPersistedScheduleRecord(entry.record, entry.scheduleId);
      if (!inspected.executable) {
        await this.quarantineSchedule(entry.record, inspected.issues, now, false, entry.scheduleId);
        continue;
      }
      const schedule = inspected.executable;
      if (schedule.activeRunId) {
        await this.reconcileActiveRun(schedule, now);
      }
      if (schedule.activeRunId || schedule.status !== 'enabled') {
        continue;
      }

      const window = getWindowState(now, schedule.dailyWindow, schedule.timeZone);
      if (!window.within) {
        if (schedule.nextRunAt !== window.nextStartAt.toISOString()) {
          const updated = {
            ...schedule,
            nextRunAt: window.nextStartAt.toISOString(),
            updatedAt: now.toISOString(),
          } satisfies PersistedScheduleDefinition;
          if (!(await this.store.saveScheduleIfUnchanged(schedule, updated))) {
            nextWakeAt = Math.min(nextWakeAt, now.getTime() + 100);
            continue;
          }
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
        const pendingRunId = this.pendingDispatchRunIds.get(schedule.scheduleId);
        const pendingGroup = pendingRunId
          ? await this.taskQueue.getTaskGroup(pendingRunId)
          : undefined;
        if (!pendingGroup) {
          nextWakeAt = Math.min(nextWakeAt, now.getTime() + 1000);
          continue;
        }
      }

      try {
        await this.startRound(schedule, now);
      } catch (error) {
        if (error instanceof ScheduleTemplateValidationError) {
          continue;
        }
        if (error instanceof ScheduleDispatchPersistenceError) {
          nextWakeAt = Math.min(nextWakeAt, now.getTime() + 100);
          continue;
        }
        if (error instanceof TaskGroupConflictError) {
          this.pendingDispatchRunIds.delete(schedule.scheduleId);
          await this.store.transactSchedule(schedule.scheduleId, (current) => {
            if (!current || !sameScheduleSnapshot(current, schedule)) return { value: undefined };
            return {
              schedule: {
                ...current,
                status: 'paused',
                nextRunAt: undefined,
                updatedAt: now.toISOString(),
              },
              value: undefined,
            };
          });
          continue;
        }
        if (error instanceof TaskGroupPersistenceError
          || error instanceof ScheduleLeaseTimeoutError
          || error instanceof ScheduleLeaseRecoveryRequiredError
          || error instanceof ScheduleLeaseOwnershipLostError
          || error instanceof ScheduleStoreConflictError) {
          nextWakeAt = Math.min(nextWakeAt, now.getTime() + 1000);
          continue;
        }
        await this.store.transactSchedule(schedule.scheduleId, (current) => {
          if (!current || !sameScheduleSnapshot(current, schedule)) return { value: undefined };
          const updated = {
            ...current,
            consecutiveFailures: current.consecutiveFailures + 1,
            updatedAt: now.toISOString(),
          };
          if (updated.consecutiveFailures >= updated.pauseAfterConsecutiveFailures) {
            updated.status = 'paused';
            updated.nextRunAt = undefined;
          } else {
            updated.nextRunAt = resolveNextEligibleStart(now, updated.repeat.failureDelaySeconds, updated.dailyWindow, updated.timeZone).toISOString();
          }
          return { schedule: updated, value: undefined };
        });
      }
      } catch (error) {
        if (!isSchedulerInfrastructureError(error)) throw error;
        nextWakeAt = Math.min(nextWakeAt, now.getTime() + 1000);
      }
    }

    this.requestProcess(Math.max(100, nextWakeAt - this.now().getTime()));
  }

  private async startRound(schedule: PersistedScheduleDefinition, now: Date): Promise<void> {
    const persisted = await this.store.readSchedule(schedule.scheduleId);
    if (!persisted) {
      return;
    }
    const recordInspection = inspectPersistedScheduleRecord(persisted, schedule.scheduleId);
    if (!recordInspection.executable) {
      await this.quarantineSchedule(persisted, recordInspection.issues, now, false, schedule.scheduleId);
      throw new ScheduleTemplateValidationError(recordInspection.issues);
    }
    schedule = recordInspection.executable;
    if (schedule.activeRunId || schedule.status !== 'enabled') {
      return;
    }
    const inspection = inspectScheduleTemplates(schedule.tasks);
    const validationIssues = recordInspection.issues;
    if (validationIssues.length > 0) {
      await this.quarantineSchedule(schedule, validationIssues, now, false, schedule.scheduleId);
      throw new ScheduleTemplateValidationError(validationIssues);
    }
    const enabledTasks = inspection.recurringTasks.filter((task) => task.enabled);
    if (enabledTasks.length === 0) {
      await this.store.transactSchedule(schedule.scheduleId, (latest) => {
        if (!latest || !sameScheduleSnapshot(latest, schedule)) return { value: undefined };
        return {
          schedule: {
            ...latest,
            status: 'paused',
            nextRunAt: undefined,
            updatedAt: now.toISOString(),
          },
          value: undefined,
        };
      });
      return;
    }
    const previousRunsBeforeNormalization = await this.store.listRuns(schedule.scheduleId);
    const orphanRun = previousRunsBeforeNormalization.find((run) => run.status === 'running');
    const runId = this.pendingDispatchRunIds.get(schedule.scheduleId)
      ?? orphanRun?.runId
      ?? crypto.randomUUID();
    const normalized = await Promise.all(enabledTasks.map(async (template, index) => {
      const baseTask = await normalizeSchedulableTask(
        assertRecurringScheduleTaskKind(template.kind, template.taskKey),
        template.input,
        this.dataDir,
      );
      const task = baseTask.kind === 'resume-capture'
        ? {
          kind: baseTask.kind,
          ...await snapshotBossCaptureSettings({
            input: baseTask.input as ResumeCaptureTaskInput,
            argv: baseTask.argv,
            inputSummary: baseTask.inputSummary,
          }, {
            dataDir: this.dataDir,
            ...(this.bossCapturePlanResolver ? { resolveBossCapturePlan: this.bossCapturePlanResolver } : {}),
            ...(this.bossCapturePlanStore ? { store: this.bossCapturePlanStore } : {}),
            searchConditionSets: this.searchConditionSetService,
          }),
        }
        : baseTask.kind === 'batch'
          ? {
            kind: baseTask.kind,
            ...await snapshotBossBatchCaptureSettings({
              input: baseTask.input as BatchTaskInput,
              argv: baseTask.argv,
              inputSummary: baseTask.inputSummary,
            }, {
              dataDir: this.dataDir,
              ...(this.bossCapturePlanResolver ? { resolveBossCapturePlan: this.bossCapturePlanResolver } : {}),
              ...(this.bossCapturePlanStore ? { store: this.bossCapturePlanStore } : {}),
              searchConditionSets: this.searchConditionSetService,
            }),
          }
          : baseTask;
      await preflightTaskSearchConditionSets(task.input, this.searchConditionSetService);
      const executionEnvelope = task.kind === 'resume-capture' || task.kind === 'batch'
        ? await buildServerCaptureExecutionEnvelope(task.kind, task.input as ResumeCaptureTaskInput | BatchTaskInput, {
          dataDir: this.dataDir,
          searchConditionSets: this.searchConditionSetService,
        })
        : undefined;
      return {
        kind: task.kind,
        input: task.input,
        inputSummary: task.inputSummary,
        executionEnvelope,
        argv: task.argv,
        schedule: {
          scheduleId: schedule.scheduleId,
          scheduleRunId: runId,
          scheduleTaskKey: template.taskKey,
          scheduleTaskIndex: index,
        },
      } satisfies QueueTaskDefinition;
    }));
    let dispatchAccepted = false;
    let outcome: { started: boolean; issues?: ScheduleValidationIssue[] };
    try {
      outcome = await this.store.transactSchedule<{
        started: boolean;
        issues?: ScheduleValidationIssue[];
      }>(schedule.scheduleId, async (latest) => {
        if (!latest) {
          return { value: { started: false } };
        }
        const latestInspection = inspectPersistedScheduleRecord(latest, schedule.scheduleId);
        if (!latestInspection.executable) {
          const latestValidationIssues = latestInspection.issues;
          const quarantined = this.quarantinedSchedule(
            { ...latest, scheduleId: schedule.scheduleId },
            latestValidationIssues,
            now,
          );
          return {
            ...(quarantined.changed ? { schedule: quarantined.schedule } : {}),
            value: { started: false, issues: latestValidationIssues },
          };
        }
        const executableLatest = latestInspection.executable;
        if (executableLatest.activeRunId || executableLatest.status !== 'enabled') {
          return { value: { started: false } };
        }
        if (!sameScheduleSnapshot(latest, schedule)) {
          return { value: { started: false } };
        }
        const enqueued = await this.taskQueue.enqueueGroupIfIdle({
          groupId: runId,
          tasks: normalized,
          failurePolicy: executableLatest.failurePolicy,
        });
        if (!enqueued.accepted) return { value: { started: false } };
        dispatchAccepted = true;
        this.pendingDispatchRunIds.set(schedule.scheduleId, runId);

        const timestamp = now.toISOString();
        const previousRuns = await this.store.listRuns(executableLatest.scheduleId);
        const existingRun = await this.store.readRun(executableLatest.scheduleId, runId);
        const run: ScheduleRunRecord = {
          runId,
          scheduleId: executableLatest.scheduleId,
          cycleNumber: existingRun?.cycleNumber ?? previousRuns.length + 1,
          status: 'running',
          scheduledAt: timestamp,
          startedAt: timestamp,
          taskIds: enqueued.taskIds,
          completedTaskIds: [],
          cancelledTaskIds: [],
        };
        await this.store.saveRun(run);
        return {
          schedule: {
            ...executableLatest,
            activeRunId: runId,
            lastRunAt: timestamp,
            nextRunAt: undefined,
            updatedAt: timestamp,
          },
          value: { started: true },
        };
      });
    } catch (error) {
      if (dispatchAccepted) throw new ScheduleDispatchPersistenceError(error);
      throw error;
    }
    if (outcome.issues) throw new ScheduleTemplateValidationError(outcome.issues);
    if (!outcome.started) {
      this.pendingDispatchRunIds.delete(schedule.scheduleId);
      return;
    }
    this.pendingDispatchRunIds.delete(schedule.scheduleId);
    this.requestProcess(0);
  }

  private async reconcileActiveRun(schedule: PersistedScheduleDefinition, now: Date): Promise<void> {
    const runId = schedule.activeRunId;
    if (!runId) {
      return;
    }
    const run = await this.store.readRun(schedule.scheduleId, runId);
    if (!run) {
      await this.store.transactSchedule(schedule.scheduleId, (current) => {
        if (!current || current.activeRunId !== runId) return { value: undefined };
        return {
          schedule: {
            ...current,
            activeRunId: undefined,
            status: 'paused',
            nextRunAt: undefined,
            updatedAt: now.toISOString(),
          },
          value: undefined,
        };
      });
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
    await this.store.transactSchedule(schedule.scheduleId, async (current) => {
      if (!current || current.activeRunId !== runId) return { value: undefined };
      const updated = { ...current, activeRunId: undefined, updatedAt: timestamp };
      if (current.status === 'stop_requested') {
        run.status = 'stopped';
        updated.status = 'stopped';
        updated.nextRunAt = undefined;
      } else if (current.status === 'paused') {
        run.status = hasFailed(tasks) ? 'failed' : 'succeeded';
        updated.nextRunAt = undefined;
      } else if (hasFailed(tasks)) {
        run.status = 'failed';
        run.error = tasks.find((task) => task?.error)?.error ?? 'One or more scheduled tasks failed';
        updated.consecutiveFailures += 1;
        if (updated.consecutiveFailures >= updated.pauseAfterConsecutiveFailures) {
          updated.status = 'paused';
          updated.nextRunAt = undefined;
        } else {
          updated.nextRunAt = resolveNextEligibleStart(now, updated.repeat.failureDelaySeconds, updated.dailyWindow, updated.timeZone).toISOString();
        }
      } else {
        run.status = 'succeeded';
        updated.consecutiveFailures = 0;
        updated.nextRunAt = resolveNextEligibleStart(now, updated.repeat.delaySeconds, updated.dailyWindow, updated.timeZone).toISOString();
      }
      await this.store.saveRun(run);
      return { schedule: updated, value: undefined };
    });
  }

  private async normalizeTemplates(schedule: NormalizedScheduleDefinition): Promise<NormalizedScheduledTaskTemplate[]> {
    const validationIssues = validateScheduleTemplates(schedule.tasks);
    if (validationIssues.length > 0) {
      throw new ScheduleTemplateValidationError(validationIssues);
    }
    return Promise.all(schedule.tasks.map(async (template) => {
      const normalized = await normalizeSchedulableTask(
        assertRecurringScheduleTaskKind(template.kind, template.taskKey),
        template.input,
        this.dataDir,
      );
      await preflightTaskSearchConditionSets(normalized.input, this.searchConditionSetService);
      return {
        ...template,
        input: serialize(normalized.input),
      };
    }));
  }

  private async stopScheduleAfterCurrentTaskWithinLock(
    schedule: PersistedScheduleDefinition,
    expectedScheduleId = schedule.scheduleId,
  ): Promise<void> {
    const now = this.now().toISOString();
    const activeRunId = await this.store.transactSchedule<string | undefined>(expectedScheduleId, (current) => {
      if (!current) return { value: undefined };
      const inspected = inspectPersistedScheduleRecord(current, expectedScheduleId);
      return {
        schedule: {
          ...current,
          scheduleId: expectedScheduleId,
          status: inspected.detail.activeRunId ? 'stop_requested' : 'stopped',
          stopRequestedAt: now,
          nextRunAt: undefined,
          updatedAt: now,
        },
        value: inspected.detail.activeRunId,
      };
    });
    if (!activeRunId) return;
    const run = await this.store.readRun(expectedScheduleId, activeRunId);
    if (run) {
      run.status = 'stopping';
      run.stopRequestedAt = now;
      await this.store.saveRun(run);
      await this.taskQueue.requestGroupStopAfterCurrentTask(run.runId);
    }
  }

  private async quarantineSchedule(
    schedule: PersistedScheduleDefinition,
    _validationIssues: readonly ScheduleValidationIssue[],
    now: Date,
    forceSave = false,
    expectedScheduleId = schedule.scheduleId,
  ): Promise<boolean> {
    return this.store.transactSchedule(expectedScheduleId, (current) => {
      if (!current) return { value: false };
      const latestIssues = this.scheduleValidationIssues(current, expectedScheduleId);
      if (latestIssues.length === 0) return { value: false };
      const quarantined = this.quarantinedSchedule(
        { ...current, scheduleId: expectedScheduleId },
        latestIssues,
        now,
        forceSave,
      );
      return {
        ...(quarantined.changed ? { schedule: quarantined.schedule } : {}),
        value: quarantined.changed,
      };
    });
  }

  private scheduleValidationIssues(
    schedule: PersistedScheduleDefinition,
    expectedScheduleId = schedule.scheduleId,
  ): ScheduleValidationIssue[] {
    return inspectPersistedScheduleRecord(schedule, expectedScheduleId).issues;
  }

  private quarantinedSchedule(
    schedule: PersistedScheduleDefinition,
    validationIssues: readonly ScheduleValidationIssue[],
    now: Date,
    forceSave = false,
  ): { schedule: PersistedScheduleDefinition; changed: boolean } {
    const changed = schedule.status !== 'paused'
      || schedule.nextRunAt !== undefined
      || !sameValidationIssues(schedule.validationIssues, validationIssues);
    return {
      schedule: {
        ...schedule,
        status: 'paused',
        nextRunAt: undefined,
        validationIssues: [...validationIssues],
        ...((changed || forceSave) ? { updatedAt: now.toISOString() } : {}),
      },
      changed: changed || forceSave,
    };
  }
}
