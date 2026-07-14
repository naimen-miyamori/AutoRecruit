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
  verifyPersistedBrowserSessionRef,
} from '../browser/session.js';
import { waitForManualLoginAndPersistSession } from '../browser/manual-login-refresh.js';
import { runRagOpsTask } from './rag-ops-runner.js';
import { normalizeFailureMessage, summarizeFailureMessage } from './failure-summary.js';
import type {
  LoginRefreshTaskInput,
  LoginRefreshTaskOutput,
  RagOpsTaskInput,
  TaskQueueHealth,
  TaskDetail,
  TaskKind,
  TaskLogEntry,
  TaskLogLevel,
  TaskOutput,
  TaskRecord,
  TaskSummary,
  TaskInput,
} from './types.js';

export type TaskRunner = (argv: readonly string[], task: TaskRecord) => Promise<MainResult>;
export type LoginRefreshRunner = (input: LoginRefreshTaskInput, task: TaskRecord) => Promise<LoginRefreshTaskOutput>;
export type RagOpsRunner = (input: RagOpsTaskInput, task: TaskRecord) => Promise<TaskOutput>;

interface TaskQueueOptions {
  taskDir?: string;
  runner?: TaskRunner;
  loginRefreshRunner?: LoginRefreshRunner;
  ragOpsRunner?: RagOpsRunner;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
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
  };
}

function toTaskDetail(task: TaskRecord): TaskDetail {
  return {
    ...summarizeTask(task),
    input: task.input,
    output: task.output,
    logs: task.logs,
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

  if (Array.isArray(output)) {
    return {
      itemCount: output.length,
      platforms: [...new Set(output.map((item) => 'platform' in item ? item.platform : undefined).filter(Boolean))],
    };
  }

  if ('totalCandidates' in output) {
    return {
      jobKey: output.jobKey,
      totalCandidates: output.totalCandidates,
      newCandidates: output.newCandidates,
      scoredCandidates: output.scoredCandidates,
      failedCandidates: output.failedCandidates,
      resultPath: output.resultPath,
    };
  }

  if ('resultTotal' in output) {
    return {
      platform: output.platform,
      keyword: output.keyword,
      resultTotal: output.resultTotal,
      allConditionsApplied: output.allConditionsApplied,
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
  private readonly runner: TaskRunner;
  private readonly loginRefreshRunner: LoginRefreshRunner;
  private readonly ragOpsRunner: RagOpsRunner;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly pendingTaskIds: string[] = [];
  private readonly persistChains = new Map<string, Promise<void>>();
  private loading: Promise<void>;
  private drainPromise?: Promise<void>;
  private runningTaskId?: string;

  constructor(options: TaskQueueOptions = {}) {
    this.taskDir = options.taskDir ?? path.join(config.dataDir, 'runtime', 'tasks');
    this.runner = options.runner ?? ((argv) => runCliMain(argv));
    this.ragOpsRunner = options.ragOpsRunner ?? runRagOpsTask;
    this.loginRefreshRunner = options.loginRefreshRunner ?? (async (input) => {
      await waitForManualLoginAndPersistSession(input.platform, {
        openLoginSession: openLoginSessionRef.fn,
        openAuthenticatedHome: openAuthenticatedSubscribePageRef.fn,
        persistBrowserSession: persistBrowserSessionRef.fn,
        verifyPersistedBrowserSession: verifyPersistedBrowserSessionRef.fn,
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
    argv: string[];
  }): Promise<TaskDetail> {
    await this.loading;

    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: crypto.randomUUID(),
      kind: options.kind,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      input: options.input,
      inputSummary: options.inputSummary,
      argv: options.argv,
      logs: [{
        at: now,
        level: 'info',
        message: 'Task queued',
      }],
    };

    this.tasks.set(task.taskId, task);
    this.pendingTaskIds.push(task.taskId);
    await this.persistTask(task);
    this.scheduleDrain();
    return toTaskDetail(task);
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
    const entries = await fs.readdir(this.taskDir);
    const files = entries.filter((entry) => entry.endsWith('.json')).sort();

    for (const file of files) {
      const filePath = path.join(this.taskDir, file);
      const task = await readJsonFile<TaskRecord>(filePath);
      if (task.status === 'queued' || task.status === 'running') {
        this.appendLog(task, 'error', 'Task was interrupted before completion');
        task.status = 'failed';
        task.error = 'Task was interrupted before completion';
        task.finishedAt = task.finishedAt ?? new Date().toISOString();
        task.updatedAt = task.finishedAt;
        await this.persistTask(task);
      }
      this.tasks.set(task.taskId, task);
    }
  }

  private scheduleDrain(): void {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
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
    } catch (error) {
      const finishedAt = new Date().toISOString();
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.finishedAt = finishedAt;
      task.updatedAt = finishedAt;
      this.appendLog(task, 'error', task.error);
      await this.persistTask(task);
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
    await ensureDir(this.taskDir);
    const filePath = path.join(this.taskDir, toTaskFileName(task.taskId));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  }
}
