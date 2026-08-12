import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main as runCliMain, type MainResult } from '../index.js';
import { config, resolveStorageStatePath } from '../config.js';
import {
  closeBrowserSessionRef,
  openAuthenticatedSubscribePageRef,
  openLoginSessionRef,
  persistBrowserSessionRef,
  verifyPublishedBrowserRuntimeRef,
} from '../browser/session.js';
import { waitForManualLoginAndPersistSession } from '../browser/manual-login-refresh.js';
import { runRagOpsTask } from './rag-ops-runner.js';
import { runTalentMappingClassificationTask } from './talent-mapping-classification-runner.js';
import { normalizeFailureMessage, summarizeFailureMessage } from './failure-summary.js';
import { SearchSubscriptionRunError } from '../search/search-subscription.js';
import type {
  LoginRefreshTaskInput,
  LoginRefreshTaskOutput,
  RagOpsTaskInput,
  TalentMappingClassificationTaskInput,
  TaskQueueHealth,
  TaskDetail,
  TaskKind,
  TaskLogEntry,
  TaskLogLevel,
  TaskOutput,
  TaskRecord,
  ScheduledTaskMetadata,
  TaskSummary,
  TaskInput,
  WorkflowFailurePolicy,
} from './types.js';
import type { SearchSubscriptionSummary } from '../types/job.js';
import { PlatformRuntimeError } from '../browser/platform-runtime-inspector.js';

export type TaskRunner = (argv: readonly string[], task: TaskRecord) => Promise<MainResult>;
export type LoginRefreshRunner = (input: LoginRefreshTaskInput, task: TaskRecord) => Promise<LoginRefreshTaskOutput>;
export type RagOpsRunner = (input: RagOpsTaskInput, task: TaskRecord) => Promise<TaskOutput>;
export type TalentMappingClassificationRunner = (
  input: TalentMappingClassificationTaskInput,
  task: TaskRecord,
) => Promise<TaskOutput>;

export interface QueueTaskDefinition {
  kind: TaskKind;
  input: TaskInput;
  inputSummary: Record<string, unknown>;
  executionEnvelope?: TaskRecord['executionEnvelope'];
  argv: string[];
  schedule: ScheduledTaskMetadata;
}

interface QueuedTaskGroup {
  groupId: string;
  scheduleId: string;
  taskIds: string[];
  failurePolicy: WorkflowFailurePolicy;
  fingerprint: string;
  stopRequested: boolean;
}

interface TaskGroupManifest {
  version: 1;
  groupId: string;
  taskIds: string[];
  failurePolicy: WorkflowFailurePolicy;
  fingerprint: string;
  scheduleId: string;
  createdAt: string;
}

export type TaskTerminalListener = (task: TaskDetail) => void;

export interface TaskQueueOptions {
  taskDir?: string;
  runner?: TaskRunner;
  loginRefreshRunner?: LoginRefreshRunner;
  ragOpsRunner?: RagOpsRunner;
  talentMappingClassificationRunner?: TalentMappingClassificationRunner;
  beforeTaskFileWrite?: (task: Readonly<TaskRecord>) => Promise<void> | void;
  beforeGroupManifestWrite?: (manifest: Readonly<TaskGroupManifest>) => Promise<void> | void;
}

export class TaskGroupConflictError extends Error {
  readonly code = 'task-group-conflict' as const;

  constructor(readonly groupId: string) {
    super(`Task group identity conflicts with a different payload: ${groupId}`);
    this.name = 'TaskGroupConflictError';
  }
}

export class TaskGroupPersistenceError extends Error {
  readonly code = 'task-group-persistence-failed' as const;

  constructor(readonly groupId: string, cause: unknown) {
    super(`Task group could not be committed: ${groupId}`, { cause });
    this.name = 'TaskGroupPersistenceError';
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tempPath, filePath);
    await fs.unlink(tempPath).catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

function groupFingerprint(
  tasks: readonly QueueTaskDefinition[],
  failurePolicy: WorkflowFailurePolicy,
): string {
  const payload = canonicalize({
    failurePolicy,
    tasks: tasks.map((task) => ({
      kind: task.kind,
      input: task.input,
      inputSummary: task.inputSummary,
      executionEnvelope: task.executionEnvelope,
      argv: task.argv,
      schedule: task.schedule,
    })),
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function toTaskFileName(taskId: string): string {
  return `${taskId}.json`;
}

function summarizeTask(task: TaskRecord): TaskSummary {
  return {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    inputSummary: task.inputSummary,
    outputSummary: task.outputSummary,
    error: task.error,
    failureCode: task.failureCode,
    failureClass: task.failureClass,
  };
}

function toTaskDetail(task: TaskRecord): TaskDetail {
  return {
    ...summarizeTask(task),
    input: task.input,
    output: task.output,
    logs: task.logs,
    schedule: task.schedule,
  };
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }

    if (arg instanceof Error) {
      return arg.stack ?? arg.message;
    }

    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ').slice(0, 8000);
}

function findPlatformRuntimeError(error: unknown): PlatformRuntimeError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof PlatformRuntimeError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

/**
 * Keep capture output summaries lightweight while making the distinction
 * between the persisted job and the Boss talent-page query auditable.  The
 * CLI owns the exact search-execution contract; the queue only projects its
 * scalar evidence for task list/detail consumers.
 */
function summarizeCaptureSearchExecution(output: TaskOutput): Record<string, unknown> {
  if (!('searchExecution' in output)) {
    return {};
  }

  const execution = output.searchExecution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return {};
  }

  const value = execution as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of [
    'source',
    'pageKeyword',
    'keywordSource',
    'conditionSetRef',
    'selectedFieldsFingerprint',
    'includeViewedCandidates',
    'savedSearch',
    'sortPolicy',
  ]) {
    if (value[field] !== undefined) {
      summary[field] = value[field];
    }
  }
  return Object.keys(summary).length > 0 ? { searchExecution: summary } : {};
}

function isSearchSubscriptionSummary(value: unknown): value is SearchSubscriptionSummary {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'resultTotal' in value
    && 'saveRequested' in value
    && 'conditionStatusCounts' in value;
}

function buildOutputSummary(output: TaskOutput): Record<string, unknown> {
  if ('storageStatePath' in output) {
    return {
      platform: output.platform,
      storageStatePath: output.storageStatePath,
      refreshedAt: output.refreshedAt,
    };
  }

  if ('action' in output && 'summary' in output) {
    return {
      action: output.action,
      status: output.status,
      platform: output.platform,
      jobKey: output.jobKey,
      file: output.file,
      outputPath: output.outputPath,
      ...output.summary,
    };
  }

  if ('mode' in output && output.mode === 'talent-mapping-classification') {
    return {
      mode: output.mode,
      mappingKey: output.mappingKey,
      model: output.model,
      consideredCandidates: output.consideredCandidates,
      generatedSuggestions: output.generatedSuggestions,
      skippedCandidates: output.skippedCandidates,
    };
  }

  if ('mode' in output && output.mode === 'search-subscription' && output.status === 'failed') {
    return {
      mode: output.mode,
      status: output.status,
      completedPlatforms: output.completedPlatforms,
      stoppedPlatform: output.stoppedPlatform,
      error: output.error,
      results: output.results.map((item) => ({
        platform: item.platform,
        keyword: item.keyword,
        resultTotal: item.resultTotal,
        saveRequested: item.saveRequested,
        saved: item.saved,
        ...(item.saveOutcome ? { saveOutcome: item.saveOutcome } : {}),
      })),
    };
  }

  if ('source' in output && 'candidates' in output && 'matched' in output) {
    return {
      platform: output.platform,
      source: output.source,
      matched: output.matched,
      candidateCount: output.candidates.length,
    };
  }

  if ('greeted' in output && 'candidateId' in output) {
    return {
      platform: output.platform,
      candidateId: output.candidateId,
      greeted: output.greeted,
      alreadyContacted: output.alreadyContacted,
    };
  }

  if ('action' in output && 'changed' in output) {
    return {
      platform: output.platform,
      action: output.action,
      conversationId: output.conversationId,
      changed: output.changed,
      conversationCount: output.conversations?.length,
      messageCount: output.messages?.length,
      receiptPath: output.receiptPath,
    };
  }

  if ('created' in output && 'updated' in output && 'unchanged' in output && 'failed' in output) {
    return {
      platform: output.platform,
      created: output.created,
      updated: output.updated,
      unchanged: output.unchanged,
      failed: output.failed,
      resultPath: output.resultPath,
    };
  }

  if (Array.isArray(output)) {
    const subscriptionResults = output.filter(isSearchSubscriptionSummary);
    if (subscriptionResults.length !== output.length) {
      return {
        itemCount: output.length,
        platforms: [...new Set(output.map((item) => 'platform' in item ? item.platform : undefined).filter(Boolean))],
      };
    }
    return {
      itemCount: output.length,
      platforms: [...new Set(subscriptionResults.map((item) => item.platform))],
      results: subscriptionResults.map((item) => ({
        platform: item.platform,
        keyword: item.keyword,
        resultTotal: item.resultTotal,
        resultTotalSource: item.resultTotalSource,
        saveRequested: item.saveRequested,
        saved: item.saved,
        allConditionsApplied: item.allConditionsApplied,
        conditionStatusCounts: item.conditionStatusCounts,
        ...(item.savedSearch ? { savedSearch: item.savedSearch } : {}),
        ...(item.saveOutcome ? { saveOutcome: item.saveOutcome } : {}),
        ...(item.sortPolicy ? { sortPolicy: item.sortPolicy } : {}),
      })),
    };
  }

  if ('mode' in output && output.mode === 'talent-mapping') {
    return {
      mode: output.mode,
      mappingKey: output.mappingKey,
      runId: output.runId,
      stage: output.stage,
      status: output.status,
      observedCards: output.observedCards,
      uniquePlatformProfiles: output.uniquePlatformProfiles,
      enrichedProfiles: output.enrichedProfiles,
      failedProfiles: output.failedProfiles,
      cappedSlices: output.cappedSlices,
      exportDir: output.exportDir,
      runPath: output.runPath,
      detailOpenSideEffect: output.detailOpenSideEffect,
    };
  }

  if ('totalCandidates' in output) {
    return {
      jobKey: output.jobKey,
      totalCandidates: output.totalCandidates,
      captureAttempts: output.captureAttempts,
      capturedCandidates: output.capturedCandidates,
      newCandidates: output.newCandidates,
      scoredCandidates: output.scoredCandidates,
      failedCandidates: output.failedCandidates,
      resultPath: output.resultPath,
      ...('bossRouting' in output && output.bossRouting ? { bossRouting: output.bossRouting } : {}),
      ...('rejectionEmails' in output && output.rejectionEmails ? { rejectionEmails: output.rejectionEmails } : {}),
      ...('bossSeenViewSync' in output && output.bossSeenViewSync ? { bossSeenViewSync: output.bossSeenViewSync } : {}),
      ...summarizeCaptureSearchExecution(output),
    };
  }

  if ('resultTotal' in output) {
    return {
      platform: output.platform,
      keyword: output.keyword,
      resultTotal: output.resultTotal,
      resultTotalSource: output.resultTotalSource,
      saveRequested: output.saveRequested,
      saved: output.saved,
      allConditionsApplied: output.allConditionsApplied,
      conditionStatusCounts: output.conditionStatusCounts,
      ...(output.savedSearch ? { savedSearch: output.savedSearch } : {}),
      ...(output.saveOutcome ? { saveOutcome: output.saveOutcome } : {}),
      ...(output.sortPolicy ? { sortPolicy: output.sortPolicy } : {}),
    };
  }

  if ('unreadConversations' in output) {
    return {
      platform: output.platform,
      unreadConversations: output.unreadConversations,
      reviewedConversations: output.reviewedConversations,
      matchedCandidates: output.matchedCandidates,
      previouslyChattedConversations: output.previouslyChattedConversations,
      firstContactConversations: output.firstContactConversations,
      followUpConversations: output.followUpConversations,
      newReplyMessages: output.newReplyMessages,
      chatMessagesSent: output.chatMessagesSent,
      phoneExchangeRequests: output.phoneExchangeRequests,
      forwardedCandidates: output.forwardedCandidates,
      failedConversations: output.failedConversations,
      resultPath: output.resultPath,
      summaryEmailRecipient: output.summaryEmailRecipient,
      summaryEmailSubject: output.summaryEmailSubject,
    };
  }

  if ('question' in output) {
    return {
      platform: output.platform,
      jobKey: output.jobKey,
      answered: output.answered,
      confidence: output.confidence,
      noAnswerReason: output.noAnswerReason,
    };
  }

  return {};
}

export class TaskQueue {
  private readonly taskDir: string;
  private readonly taskGroupDir: string;
  private readonly runner: TaskRunner;
  private readonly loginRefreshRunner: LoginRefreshRunner;
  private readonly ragOpsRunner: RagOpsRunner;
  private readonly talentMappingClassificationRunner: TalentMappingClassificationRunner;
  private readonly beforeTaskFileWrite?: TaskQueueOptions['beforeTaskFileWrite'];
  private readonly beforeGroupManifestWrite?: TaskQueueOptions['beforeGroupManifestWrite'];
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly pendingTaskIds: string[] = [];
  private readonly persistChains = new Map<string, Promise<void>>();
  private readonly groups = new Map<string, QueuedTaskGroup>();
  private readonly taskTerminalListeners = new Set<TaskTerminalListener>();
  private loading: Promise<void>;
  private admissionSerial: Promise<void> = Promise.resolve();
  private drainPromise?: Promise<void>;
  private runningTaskId?: string;

  constructor(options: TaskQueueOptions = {}) {
    this.taskDir = options.taskDir ?? path.join(config.dataDir, 'runtime', 'tasks');
    this.taskGroupDir = path.join(path.dirname(this.taskDir), 'task-groups');
    this.runner = options.runner ?? ((argv, task) => runCliMain(argv, {
      reportSearchMode: (message) => console.log(message),
      captureExecutionEnvelope: task.executionEnvelope,
    }));
    this.ragOpsRunner = options.ragOpsRunner ?? runRagOpsTask;
    this.talentMappingClassificationRunner = options.talentMappingClassificationRunner
      ?? ((input) => runTalentMappingClassificationTask(input));
    this.beforeTaskFileWrite = options.beforeTaskFileWrite;
    this.beforeGroupManifestWrite = options.beforeGroupManifestWrite;
    this.loginRefreshRunner = options.loginRefreshRunner ?? (async (input) => {
      await waitForManualLoginAndPersistSession(input.platform, {
        openLoginSession: openLoginSessionRef.fn,
        openAuthenticatedHome: openAuthenticatedSubscribePageRef.fn,
        persistBrowserSession: persistBrowserSessionRef.fn,
        verifyPublishedBrowserRuntime: verifyPublishedBrowserRuntimeRef.fn,
        closeBrowserSession: closeBrowserSessionRef.fn,
      }, { keepOpen: false });

      return {
        platform: input.platform,
        storageStatePath: resolveStorageStatePath(input.platform),
        refreshedAt: new Date().toISOString(),
      };
    });
    this.loading = this.loadPersistedTasks();
  }

  async enqueue(options: {
    kind: TaskKind;
    input: TaskInput;
    inputSummary: Record<string, unknown>;
    executionEnvelope?: TaskRecord['executionEnvelope'];
    argv: string[];
  }): Promise<TaskDetail> {
    await this.loading;

    const task = this.createQueuedTask(options);
    await this.persistTask(task);
    this.tasks.set(task.taskId, task);
    this.pendingTaskIds.push(task.taskId);
    this.scheduleDrain();
    return toTaskDetail(task);
  }

  async enqueueGroupIfIdle(options: {
    groupId: string;
    tasks: QueueTaskDefinition[];
    failurePolicy: WorkflowFailurePolicy;
  }): Promise<{ accepted: true; taskIds: string[] } | { accepted: false; reason: 'busy' | 'empty' }> {
    await this.loading;
    return this.runAdmissionSerialized(async () => {
      if (options.tasks.length === 0) {
        return { accepted: false as const, reason: 'empty' as const };
      }
      const scheduleId = options.tasks[0]!.schedule.scheduleId;
      if (options.tasks.some((task, index) => task.schedule.scheduleId !== scheduleId
        || task.schedule.scheduleRunId !== options.groupId
        || task.schedule.scheduleTaskIndex !== index)) {
        throw new TaskGroupConflictError(options.groupId);
      }
      const fingerprint = groupFingerprint(options.tasks, options.failurePolicy);
      const existing = this.groups.get(options.groupId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new TaskGroupConflictError(options.groupId);
        }
        if (existing.taskIds.some((taskId) => this.tasks.get(taskId)?.status === 'queued')) {
          this.scheduleDrain();
        }
        return { accepted: true as const, taskIds: [...existing.taskIds] };
      }
      if (this.runningTaskId || this.pendingTaskIds.length > 0) {
        return { accepted: false as const, reason: 'busy' as const };
      }

      const tasks = options.tasks.map((definition) => this.createQueuedTask(definition));
      const manifest: TaskGroupManifest = {
        version: 1,
        groupId: options.groupId,
        taskIds: tasks.map((task) => task.taskId),
        failurePolicy: options.failurePolicy,
        fingerprint,
        scheduleId,
        createdAt: tasks[0]!.createdAt,
      };
      try {
        const persistence = await Promise.allSettled(tasks.map((task) => this.persistTask(task)));
        const failure = persistence.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
        await this.persistGroupManifest(manifest);
      } catch (error) {
        await Promise.allSettled(tasks.map((task) => fs.unlink(this.taskPath(task.taskId))));
        throw new TaskGroupPersistenceError(options.groupId, error);
      }

      const group: QueuedTaskGroup = {
        groupId: options.groupId,
        scheduleId: manifest.scheduleId,
        taskIds: [...manifest.taskIds],
        failurePolicy: options.failurePolicy,
        fingerprint,
        stopRequested: false,
      };
      this.groups.set(options.groupId, group);
      for (const task of tasks) {
        this.tasks.set(task.taskId, task);
        this.pendingTaskIds.push(task.taskId);
      }
      this.scheduleDrain();
      return { accepted: true as const, taskIds: [...group.taskIds] };
    });
  }

  async requestGroupStopAfterCurrentTask(groupId: string): Promise<{ runningTaskId?: string; cancelledTaskIds: string[] }> {
    await this.loading;
    const group = this.getOrCreateGroup(groupId);
    if (!group) {
      return { cancelledTaskIds: [] };
    }
    group.stopRequested = true;
    const runningTaskId = group.taskIds.find((taskId) => this.tasks.get(taskId)?.status === 'running');
    if (runningTaskId) {
      return { runningTaskId, cancelledTaskIds: [] };
    }
    return {
      cancelledTaskIds: await this.cancelQueuedGroupTasks(group, 'Schedule stop requested before task start'),
    };
  }

  onTaskTerminal(listener: TaskTerminalListener): () => void {
    this.taskTerminalListeners.add(listener);
    return () => this.taskTerminalListeners.delete(listener);
  }

  async isIdle(): Promise<boolean> {
    await this.loading;
    return !this.runningTaskId && this.pendingTaskIds.length === 0;
  }

  async findLatestScheduleTaskGroup(scheduleId: string): Promise<{
    groupId: string;
    taskIds: string[];
  } | undefined> {
    await this.loading;
    const matching = [...this.tasks.values()]
      .filter((task) => task.schedule?.scheduleId === scheduleId
        && task.schedule.scheduleRunId
        && this.groups.has(task.schedule.scheduleRunId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const groupId = matching[0]?.schedule?.scheduleRunId;
    if (!groupId) return undefined;
    const group = this.groups.get(groupId);
    return group ? { groupId, taskIds: [...group.taskIds] } : undefined;
  }

  async getTaskGroup(groupId: string): Promise<{ groupId: string; taskIds: string[] } | undefined> {
    await this.loading;
    const group = this.groups.get(groupId);
    return group ? { groupId, taskIds: [...group.taskIds] } : undefined;
  }

  async listTasks(): Promise<TaskSummary[]> {
    await this.loading;
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(summarizeTask);
  }

  async getHealth(now = new Date()): Promise<TaskQueueHealth> {
    const tasks = await this.listTasks();
    const queuedTasks = tasks.filter((task) => task.status === 'queued');
    const failedTasks = tasks
      .filter((task) => task.status === 'failed')
      .sort((left, right) => (right.finishedAt ?? right.updatedAt).localeCompare(left.finishedAt ?? left.updatedAt));
    const oldestQueued = queuedTasks
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    return {
      queued: queuedTasks.length,
      running: tasks.filter((task) => task.status === 'running').length,
      succeeded: tasks.filter((task) => task.status === 'succeeded').length,
      failed: failedTasks.length,
      oldestQueuedAgeMinutes: oldestQueued ? Math.max(0, (now.getTime() - Date.parse(oldestQueued.createdAt)) / 60_000) : undefined,
      latestFailureAt: failedTasks[0]?.finishedAt ?? failedTasks[0]?.updatedAt,
      latestFailureMessage: summarizeFailureMessage(failedTasks[0]?.error),
      latestFailureDetail: normalizeFailureMessage(failedTasks[0]?.error),
    };
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    await this.loading;
    const task = this.tasks.get(taskId);
    return task ? toTaskDetail(task) : undefined;
  }

  private async loadPersistedTasks(): Promise<void> {
    await ensureDir(this.taskDir);
    await this.loadPersistedGroups();
    const entries = await fs.readdir(this.taskDir);
    const files = entries.filter((entry) => entry.endsWith('.json')).sort();

    for (const file of files) {
      const filePath = path.join(this.taskDir, file);
      const task = await readJsonFile<TaskRecord>(filePath);
      const groupId = task.schedule?.scheduleRunId;
      const committedGroup = groupId ? this.groups.get(groupId) : undefined;
      const committedTask = !groupId || Boolean(committedGroup?.taskIds.includes(task.taskId));
      if (task.status === 'queued' || task.status === 'running') {
        this.appendLog(
          task,
          'error',
          committedTask
            ? 'Task was interrupted before completion'
            : 'Uncommitted scheduled task was isolated during recovery',
        );
        task.status = 'failed';
        task.error = committedTask
          ? 'Task was interrupted before completion'
          : 'Uncommitted scheduled task was isolated during recovery';
        task.finishedAt = task.finishedAt ?? new Date().toISOString();
        task.updatedAt = task.finishedAt;
        await this.persistTask(task);
      }
      this.tasks.set(task.taskId, task);
    }
    for (const [groupId, group] of this.groups) {
      const uniqueTaskIds = new Set(group.taskIds);
      const definitions = group.taskIds.flatMap((taskId, scheduleTaskIndex) => {
        const task = this.tasks.get(taskId);
        if (!task?.schedule
          || task.schedule.scheduleId !== group.scheduleId
          || task.schedule.scheduleRunId !== groupId
          || task.schedule.scheduleTaskIndex !== scheduleTaskIndex) {
          return [];
        }
        return [{
          kind: task.kind,
          input: task.input,
          inputSummary: task.inputSummary,
          executionEnvelope: task.executionEnvelope,
          argv: task.argv,
          schedule: task.schedule,
        } satisfies QueueTaskDefinition];
      });
      const valid = group.taskIds.length > 0
        && uniqueTaskIds.size === group.taskIds.length
        && definitions.length === group.taskIds.length
        && groupFingerprint(definitions, group.failurePolicy) === group.fingerprint;
      if (!valid) this.groups.delete(groupId);
    }
  }

  private async loadPersistedGroups(): Promise<void> {
    await ensureDir(this.taskGroupDir);
    const entries = await fs.readdir(this.taskGroupDir);
    for (const entry of entries.filter((item) => item.endsWith('.json')).sort()) {
      const value = await readJsonFile<unknown>(path.join(this.taskGroupDir, entry)).catch(() => undefined);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const manifest = value as Partial<TaskGroupManifest>;
      if (manifest.version !== 1
        || typeof manifest.groupId !== 'string'
        || !Array.isArray(manifest.taskIds)
        || !manifest.taskIds.every((taskId) => typeof taskId === 'string')
        || (manifest.failurePolicy !== 'stop-round' && manifest.failurePolicy !== 'continue')
        || typeof manifest.fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(manifest.fingerprint)
        || typeof manifest.scheduleId !== 'string'
        || path.basename(this.manifestPath(manifest.groupId)) !== entry) {
        continue;
      }
      this.groups.set(manifest.groupId, {
        groupId: manifest.groupId,
        scheduleId: manifest.scheduleId,
        taskIds: [...manifest.taskIds],
        failurePolicy: manifest.failurePolicy,
        fingerprint: manifest.fingerprint,
        stopRequested: false,
      });
    }
  }

  private scheduleDrain(): void {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
        if (!this.runningTaskId && this.pendingTaskIds.length > 0) {
          this.scheduleDrain();
        }
      });
    }
  }

  private async drain(): Promise<void> {
    await this.loading;

    while (!this.runningTaskId && this.pendingTaskIds.length > 0) {
      const taskId = this.pendingTaskIds.shift();
      if (!taskId) {
        return;
      }

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'queued') {
        continue;
      }

      this.runningTaskId = taskId;
      await this.runTask(task);
      await this.afterTaskTerminal(task);
      this.runningTaskId = undefined;
    }

    if (this.pendingTaskIds.length > 0) {
      this.scheduleDrain();
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const startedAt = new Date().toISOString();
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = startedAt;
    this.appendLog(task, 'info', 'Task started');
    await this.persistTask(task);

    try {
      const output = await this.runWithCapturedConsole(task);
      const finishedAt = new Date().toISOString();
      task.status = 'succeeded';
      task.output = output;
      task.outputSummary = buildOutputSummary(output);
      task.finishedAt = finishedAt;
      task.updatedAt = finishedAt;
      this.appendLog(task, 'info', 'Task succeeded');
      await this.persistTask(task);
      this.notifyTaskTerminal(task);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      task.status = 'failed';
      if (error instanceof SearchSubscriptionRunError) {
        task.output = error.summary;
        task.outputSummary = buildOutputSummary(error.summary);
      }
      task.error = error instanceof Error ? error.message : String(error);
      const runtimeError = findPlatformRuntimeError(error);
      task.failureCode = runtimeError?.code;
      task.failureClass = runtimeError ? 'infrastructure' : 'business';
      task.finishedAt = finishedAt;
      task.updatedAt = finishedAt;
      this.appendLog(task, 'error', task.error);
      await this.persistTask(task);
      this.notifyTaskTerminal(task);
    }
  }

  private createQueuedTask(options: {
    kind: TaskKind;
    input: TaskInput;
    inputSummary: Record<string, unknown>;
    executionEnvelope?: TaskRecord['executionEnvelope'];
    argv: string[];
    schedule?: ScheduledTaskMetadata;
  }): TaskRecord {
    const now = new Date().toISOString();
    return {
      taskId: crypto.randomUUID(),
      kind: options.kind,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      input: options.input,
      inputSummary: options.inputSummary,
      executionEnvelope: options.executionEnvelope,
      argv: options.argv,
      logs: [{
        at: now,
        level: 'info',
        message: 'Task queued',
      }],
      schedule: options.schedule,
    };
  }

  private getOrCreateGroup(groupId: string): QueuedTaskGroup | undefined {
    return this.groups.get(groupId);
  }

  private async afterTaskTerminal(task: TaskRecord): Promise<void> {
    const groupId = task.schedule?.scheduleRunId;
    if (!groupId) {
      return;
    }
    const group = this.getOrCreateGroup(groupId);
    if (!group) {
      return;
    }
    if (group.stopRequested) {
      await this.cancelQueuedGroupTasks(group, 'Schedule stop requested after current task');
      return;
    }
    if (task.status === 'failed' && group.failurePolicy === 'stop-round') {
      await this.cancelQueuedGroupTasks(group, 'Previous task failed; stopping scheduled round');
    }
  }

  private async cancelQueuedGroupTasks(group: QueuedTaskGroup, reason: string): Promise<string[]> {
    const queuedTaskIds = group.taskIds.filter((taskId) => this.tasks.get(taskId)?.status === 'queued');
    if (queuedTaskIds.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    for (const taskId of queuedTaskIds) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'queued') {
        continue;
      }
      task.status = 'cancelled';
      task.finishedAt = now;
      task.updatedAt = now;
      this.appendLog(task, 'warn', reason);
      await this.persistTask(task);
      this.notifyTaskTerminal(task);
    }
    const cancelled = new Set(queuedTaskIds);
    for (let index = this.pendingTaskIds.length - 1; index >= 0; index -= 1) {
      if (cancelled.has(this.pendingTaskIds[index]!)) {
        this.pendingTaskIds.splice(index, 1);
      }
    }
    return queuedTaskIds;
  }

  private notifyTaskTerminal(task: TaskRecord): void {
    const detail = toTaskDetail(task);
    for (const listener of this.taskTerminalListeners) {
      try {
        listener(detail);
      } catch {
        // A status listener must not interfere with task completion.
      }
    }
  }

  private async runWithCapturedConsole(task: TaskRecord): Promise<TaskOutput> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const capture = (level: TaskLogLevel, original: (...args: unknown[]) => void) => (...args: unknown[]) => {
      this.appendLog(task, level, formatConsoleArgs(args));
      void this.persistTask(task).catch(() => undefined);
      original(...args);
    };

    console.log = capture('info', originalLog);
    console.warn = capture('warn', originalWarn);
    console.error = capture('error', originalError);

    try {
      if (task.kind === 'login-refresh') {
        return await this.loginRefreshRunner(task.input as LoginRefreshTaskInput, task);
      }

      if (task.kind === 'rag-ops') {
        return await this.ragOpsRunner(task.input as RagOpsTaskInput, task);
      }

      if (task.kind === 'talent-mapping-classification') {
        return await this.talentMappingClassificationRunner(
          task.input as TalentMappingClassificationTaskInput,
          task,
        );
      }

      return await this.runner(task.argv, task);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  }

  private appendLog(task: TaskRecord, level: TaskLogLevel, message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    task.logs.push({
      at: new Date().toISOString(),
      level,
      message: trimmed,
    });
  }

  private async persistTask(task: TaskRecord): Promise<void> {
    const previous = this.persistChains.get(task.taskId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.writeTaskFile(task));
    this.persistChains.set(task.taskId, current);

    try {
      await current;
    } finally {
      if (this.persistChains.get(task.taskId) === current) {
        this.persistChains.delete(task.taskId);
      }
    }
  }

  private async writeTaskFile(task: TaskRecord): Promise<void> {
    await this.beforeTaskFileWrite?.(task);
    await ensureDir(this.taskDir);
    const filePath = this.taskPath(task.taskId);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  }

  private taskPath(taskId: string): string {
    return path.join(this.taskDir, toTaskFileName(taskId));
  }

  private manifestPath(groupId: string): string {
    const fileName = `${crypto.createHash('sha256').update(groupId).digest('hex')}.json`;
    return path.join(this.taskGroupDir, fileName);
  }

  private async persistGroupManifest(manifest: TaskGroupManifest): Promise<void> {
    await this.beforeGroupManifestWrite?.(manifest);
    await writeJsonAtomically(this.manifestPath(manifest.groupId), manifest);
  }

  private runAdmissionSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissionSerial.then(operation, operation);
    this.admissionSerial = result.then(() => undefined, () => undefined);
    return result;
  }
}
