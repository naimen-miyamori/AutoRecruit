import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { MainRunSummary } from '../index.js';
import { normalizeScheduleCreate } from '../server/schedule-normalizers.js';
import { ScheduleStore, type ScheduleTransactionDecision } from '../server/schedule-store.js';
import { getWindowState, resolveNextEligibleStart } from '../server/schedule-time.js';
import { TaskScheduler } from '../server/task-scheduler.js';
import { TaskQueue } from '../server/task-queue.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import type { BossCapturePlanResolver } from '../server/boss-capture-snapshot.js';
import type { BossCaptureSettingsSnapshot } from '../types/job.js';
import type { PersistedScheduleDefinition } from '../server/types.js';

const cardOnlyMappingPath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.card-only.example.json', import.meta.url));
const detailMappingPath = fileURLToPath(new URL('../../fixtures/talent-mapping/retail-operations.example.json', import.meta.url));

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-task-scheduler-'));
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function output(): MainRunSummary {
  return {
    jobKey: 'scheduled-job',
    totalCandidates: 0,
    captureAttempts: 0,
    capturedCandidates: 0,
    newCandidates: 0,
    scoredCandidates: 0,
    failedCandidates: 0,
    resultPath: '/tmp/scheduled-result.json',
    emailAttempted: false,
    emailDelivered: false,
    sampleCandidateIds: [],
  };
}

function takeBossCaptureSettingsSnapshot(argv: readonly string[]): {
  argv: string[];
  snapshot?: BossCaptureSettingsSnapshot;
} {
  let visible = [...argv];
  let snapshot: BossCaptureSettingsSnapshot | undefined;
  const settingsIndex = visible.indexOf('--boss-capture-settings-json');
  if (settingsIndex >= 0) {
    const raw = visible[settingsIndex + 1];
    assert.ok(raw);
    snapshot = JSON.parse(raw) as BossCaptureSettingsSnapshot;
    visible = [...visible.slice(0, settingsIndex), ...visible.slice(settingsIndex + 2)];
  }
  const taskIndex = visible.indexOf('--boss-capture-task-snapshot-json');
  if (taskIndex >= 0) {
    assert.ok(visible[taskIndex + 1]);
    visible = [...visible.slice(0, taskIndex), ...visible.slice(taskIndex + 2)];
  }
  return { argv: visible, ...(snapshot ? { snapshot } : {}) };
}

function acceptingSearchConditionSetService(): SearchConditionSetService {
  return {
    resolve: async () => undefined,
  } as unknown as SearchConditionSetService;
}

function savedBossCapturePlanResolver(getRevision: () => number): BossCapturePlanResolver {
  return async (input) => ({
    platform: 'boss',
    jobKey: '全铝箱包设计-boss-position-1',
    bossJobId: input.bossJobId ?? 'boss-position-1',
    expectedJobName: input.jobName,
    search: {
      source: 'direct',
      pageKeyword: '铝',
      keywordSource: 'condition-set-default',
      conditions: [],
      conditionSetRef: {
        conditionSetId: 'scs-aluminum-luggage',
        platform: 'boss',
        revision: getRevision(),
      },
      selectedFieldsFingerprint: `catalog-${getRevision()}`,
    },
  });
}

function baseSchedule(tasks: unknown[]) {
  return {
    name: '夜间自动运行',
    timeZone: 'Asia/Shanghai',
    dailyWindow: { start: '00:00', end: '23:59' },
    repeat: { mode: 'after-completion', delaySeconds: 3600, failureDelaySeconds: 300 },
    failurePolicy: 'stop-round',
    pauseAfterConsecutiveFailures: 3,
    tasks,
  };
}

function legacyBossAutoChatTask(taskKey: string, scoreThreshold: number) {
  return {
    taskKey,
    name: `Boss ${scoreThreshold}`,
    kind: 'boss-auto-chat',
    input: {
      platform: 'boss',
      scoreThreshold,
    },
  };
}

function bossJobSyncTask(taskKey: string) {
  return {
    taskKey,
    name: 'Boss 职位同步',
    kind: 'boss-job-sync',
    input: { platform: 'boss', includeClosed: true },
  };
}

function mappingTask(taskKey: string, talentMappingFile = cardOnlyMappingPath, mappingStage = 'scan') {
  return {
    taskKey,
    name: '人才地图市场扫描',
    kind: 'talent-mapping',
    input: {
      platform: 'all',
      talentMappingFile,
      mappingStage,
    },
  };
}

describe('TaskScheduler', () => {
  it('rejects unsafe schedule and run identifiers in the storage layer', async () => {
    const dataDir = await makeTempDir();
    const store = new ScheduleStore(dataDir);
    const schedule = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('boss-sync')]),
      enabled: false,
    });

    await assert.rejects(
      () => store.saveSchedule({ ...schedule, scheduleId: '../../escaped' }),
      /scheduleId must be a UUID/,
    );
    await assert.rejects(
      () => store.readRun(schedule.scheduleId, '../escaped'),
      /runId must be a UUID/,
    );
    assert.equal(await fs.access(path.join(dataDir, 'escaped.json')).then(() => true, () => false), false);
  });

  it('serializes schedule transactions across independent store instances', async () => {
    const dataDir = await makeTempDir();
    const firstStore = new ScheduleStore(dataDir);
    const secondStore = new ScheduleStore(dataDir);
    const schedule = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('boss-sync')]),
      enabled: true,
    });
    await firstStore.saveSchedule(schedule);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const firstAcquiredPromise = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });
    const firstTransaction = firstStore.transactSchedule(schedule.scheduleId, async (current) => {
      assert.ok(current);
      firstAcquired();
      await firstGate;
      return {
        schedule: { ...current, name: 'first transaction' },
        value: undefined,
      };
    });
    await firstAcquiredPromise;
    const secondTransaction = secondStore.transactSchedule(schedule.scheduleId, (current) => {
      assert.ok(current);
      return {
        schedule: { ...current, status: 'paused', nextRunAt: undefined },
        value: current.name,
      };
    });
    releaseFirst();

    await firstTransaction;
    assert.equal(await secondTransaction, 'first transaction');
    const persisted = await firstStore.readSchedule(schedule.scheduleId);
    assert.equal(persisted?.name, 'first transaction');
    assert.equal(persisted?.status, 'paused');

    const firstSnapshot = await firstStore.readSchedule(schedule.scheduleId);
    const staleSnapshot = await secondStore.readSchedule(schedule.scheduleId);
    assert.ok(firstSnapshot);
    assert.ok(staleSnapshot);
    firstSnapshot.name = 'newest name';
    await firstStore.saveSchedule(firstSnapshot);
    staleSnapshot.status = 'enabled';
    await assert.rejects(
      () => secondStore.saveSchedule(staleSnapshot),
      (error: unknown) => (error as { code?: string }).code === 'schedule-write-conflict',
    );
    const afterConflict = await firstStore.readSchedule(schedule.scheduleId);
    assert.equal(afterConflict?.name, 'newest name');
    assert.equal(afterConflict?.status, 'paused');
  });

  it('waits for an active cross-process lease and requires explicit offline recovery for a dead owner', async () => {
    const dataDir = await makeTempDir();
    const store = new ScheduleStore(dataDir);
    const schedule = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('boss-sync')]),
      enabled: false,
    });
    await store.saveSchedule(schedule);
    const childScript = `
      import { ScheduleStore } from './src/server/schedule-store.ts';
      const [dataDir, scheduleId] = process.argv.slice(1);
      const store = new ScheduleStore(dataDir);
      await store.transactSchedule(scheduleId, async (current) => {
        process.stdout.write('lease-acquired\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
        return { schedule: { ...current, name: 'child committed first' }, value: undefined };
      });
    `;
    const child = spawn(process.execPath, [
      '--import', './scripts/node-ts-hooks.mjs',
      '--input-type=module',
      '-e', childScript,
      dataDir,
      schedule.scheduleId,
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const childExit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    let childOutput = '';
    let childError = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      childOutput += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      childError += chunk;
    });

    try {
      await waitFor(async () => childOutput.includes('lease-acquired') ? true : undefined, 'child schedule lease');
      const parentWrite = store.transactSchedule(schedule.scheduleId, (current) => {
        assert.ok(current);
        return {
          schedule: { ...current, status: 'enabled' },
          value: current.name,
        };
      });
      child.stdin.write('release\n');
      child.stdin.end();
      assert.equal(await parentWrite, 'child committed first');
      const exitCode = await childExit;
      assert.equal(exitCode, 0, childError);
      const afterChild = await store.readSchedule(schedule.scheduleId);
      assert.equal(afterChild?.name, 'child committed first');
      assert.equal(afterChild?.status, 'enabled');

      const lockDir = path.join(dataDir, 'runtime', 'schedule-locks');
      const lockPath = path.join(lockDir, `${schedule.scheduleId}.lock`);
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockPath, `${JSON.stringify({ token: 'dead-owner', pid: 999_999_999, acquiredAt: '2026-08-08T00:00:00.000Z' })}\n`, 'utf8');
      await assert.rejects(
        () => store.transactSchedule(schedule.scheduleId, (current) => ({
          schedule: { ...current!, name: 'must not reclaim online' },
          value: undefined,
        })),
        (error: unknown) => (error as { code?: string }).code === 'schedule-lease-recovery-required',
      );
      assert.equal((await store.readSchedule(schedule.scheduleId))?.name, 'child committed first');
      assert.equal(await fs.access(lockPath).then(() => true, () => false), true);

      const competingStore = new ScheduleStore(dataDir);
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const token = `dead-owner-${iteration}`;
        if (iteration > 0) {
          await fs.writeFile(lockPath, `${JSON.stringify({
            version: 1,
            token,
            pid: 999_999_999,
            acquiredAt: '2026-08-08T00:00:00.000Z',
          })}\n`, 'utf8');
        } else {
          const firstOwner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token: string };
          firstOwner.token = token;
          await fs.writeFile(lockPath, `${JSON.stringify(firstOwner)}\n`, 'utf8');
        }
        const recoveries = await Promise.all([
          store.recoverScheduleLease(schedule.scheduleId, { processesStopped: true, confirmedToken: token }),
          competingStore.recoverScheduleLease(schedule.scheduleId, { processesStopped: true, confirmedToken: token }),
        ]);
        assert.equal(recoveries.filter((item) => item.recovered).length, 1);
        assert.equal(recoveries.filter((item) => !item.recovered).length, 1);
      }
      assert.equal(await fs.access(lockPath).then(() => true, () => false), false);

      await store.transactSchedule(schedule.scheduleId, (current) => ({
        schedule: { ...current!, name: 'recovered offline' },
        value: undefined,
      }));
      assert.equal((await store.readSchedule(schedule.scheduleId))?.name, 'recovered offline');
      assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  });

  it('does not write or release another owner lock after lease ownership is lost', async () => {
    const dataDir = await makeTempDir();
    const store = new ScheduleStore(dataDir);
    const schedule = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('ownership-loss')]),
      enabled: false,
    });
    await store.saveSchedule(schedule);
    const lockPath = path.join(dataDir, 'runtime', 'schedule-locks', `${schedule.scheduleId}.lock`);

    await assert.rejects(
      () => store.transactSchedule(schedule.scheduleId, async (current) => {
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, `${JSON.stringify({
          version: 1,
          token: 'replacement-owner',
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        })}\n`, 'utf8');
        return {
          schedule: { ...current!, name: 'must not commit after ownership loss' },
          value: undefined,
        };
      }),
      (error: unknown) => (error as { code?: string }).code === 'schedule-lease-ownership-lost',
    );
    assert.equal((await store.readSchedule(schedule.scheduleId))?.name, schedule.name);
    assert.equal(
      (JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token: string }).token,
      'replacement-owner',
    );
    await fs.unlink(lockPath);
  });

  it('commits scheduled task groups atomically and rejects conflicting idempotent retries', async () => {
    const dataDir = await makeTempDir();
    const groupId = crypto.randomUUID();
    const scheduleId = crypto.randomUUID();
    let writeAttempt = 0;
    let injectFailure = true;
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      beforeTaskFileWrite: () => {
        writeAttempt += 1;
        if (injectFailure && writeAttempt === 2) {
          throw new Error('injected second task persistence failure');
        }
      },
      runner: async (argv) => {
        calls.push([...argv]);
        await runnerGate;
        return output();
      },
    });
    const definitions = ['first', 'second'].map((taskKey, scheduleTaskIndex) => ({
      kind: 'boss-job-sync' as const,
      input: { platform: 'boss' as const, includeClosed: true },
      inputSummary: { platform: 'boss' },
      argv: ['--platform', 'boss', '--boss-job-sync', 'true'],
      schedule: {
        scheduleId,
        scheduleRunId: groupId,
        scheduleTaskKey: taskKey,
        scheduleTaskIndex,
      },
    }));

    await assert.rejects(
      () => queue.enqueueGroupIfIdle({ groupId, tasks: definitions, failurePolicy: 'stop-round' }),
      (error: unknown) => (error as { code?: string }).code === 'task-group-persistence-failed',
    );
    assert.deepStrictEqual(await queue.listTasks(), []);
    assert.equal(await queue.isIdle(), true);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(
      (await fs.readdir(path.join(dataDir, 'runtime', 'tasks'))).filter((item) => item.endsWith('.json')),
      [],
    );
    assert.deepStrictEqual(
      (await fs.readdir(path.join(dataDir, 'runtime', 'task-groups'))).filter((item) => item.endsWith('.json')),
      [],
    );

    injectFailure = false;
    const accepted = await queue.enqueueGroupIfIdle({
      groupId,
      tasks: definitions,
      failurePolicy: 'stop-round',
    });
    assert.equal(accepted.accepted, true);
    const repeated = await queue.enqueueGroupIfIdle({
      groupId,
      tasks: definitions,
      failurePolicy: 'stop-round',
    });
    assert.deepStrictEqual(repeated, accepted);
    await assert.rejects(
      () => queue.enqueueGroupIfIdle({
        groupId,
        tasks: definitions.map((item, index) => index === 0
          ? { ...item, argv: [...item.argv, '--changed'] }
          : item),
        failurePolicy: 'stop-round',
      }),
      (error: unknown) => (error as { code?: string }).code === 'task-group-conflict',
    );

    releaseRunner();
    await waitFor(async () => await queue.isIdle() ? true : undefined, 'committed task group drain');
    assert.equal(calls.length, 2);
    assert.equal((await fs.readdir(path.join(dataDir, 'runtime', 'task-groups'))).filter((item) => item.endsWith('.json')).length, 1);

    assert.equal(accepted.accepted, true);
    if (accepted.accepted) {
      const firstTaskPath = path.join(dataDir, 'runtime', 'tasks', `${accepted.taskIds[0]}.json`);
      const corruptedTask = JSON.parse(await fs.readFile(firstTaskPath, 'utf8')) as { argv: string[] };
      corruptedTask.argv.push('--corrupted-after-commit');
      await fs.writeFile(firstTaskPath, `${JSON.stringify(corruptedTask, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(dataDir, 'runtime', 'task-groups', 'malformed.json'), '{', 'utf8');
      const recoveredQueue = new TaskQueue({
        taskDir: path.join(dataDir, 'runtime', 'tasks'),
        runner: async () => output(),
      });
      await recoveredQueue.listTasks();
      assert.equal(await recoveredQueue.getTaskGroup(groupId), undefined);
    }
  });

  it('does not count task-group admission persistence failures as schedule failures', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      beforeGroupManifestWrite: () => {
        throw new Error('injected group manifest failure');
      },
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      dataDir,
      now: () => new Date('2026-07-20T02:00:00.000Z'),
    });

    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('manifest-failure')]),
        enabled: false,
      });
      await scheduler.startSchedule(schedule.scheduleId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const current = await scheduler.getSchedule(schedule.scheduleId);
      assert.equal(current?.status, 'enabled');
      assert.equal(current?.consecutiveFailures, 0);
      assert.equal(current?.activeRunId, undefined);
      assert.deepStrictEqual(await scheduler.listRuns(schedule.scheduleId), []);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(await queue.listTasks(), []);
    } finally {
      scheduler.close();
    }
  });

  it('continues processing other schedules when one lease requires offline recovery', async () => {
    const dataDir = await makeTempDir();
    const store = new ScheduleStore(dataDir);
    const locked = normalizeScheduleCreate(baseSchedule([bossJobSyncTask('locked-sync')]));
    const runnable = normalizeScheduleCreate(baseSchedule([bossJobSyncTask('runnable-sync')]));
    await store.saveSchedule(locked);
    await store.saveSchedule(runnable);
    const lockDir = path.join(dataDir, 'runtime', 'schedule-locks');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, `${locked.scheduleId}.lock`), `${JSON.stringify({
      version: 1,
      token: 'dead-owner',
      pid: 999_999_999,
      acquiredAt: '2026-08-08T00:00:00.000Z',
    })}\n`, 'utf8');
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir });

    try {
      await waitFor(async () => {
        const runs = await scheduler.listRuns(runnable.scheduleId);
        return runs.some((run) => run.status === 'succeeded') ? true : undefined;
      }, 'unlocked schedule while another lease needs recovery');
      assert.equal((await scheduler.getSchedule(locked.scheduleId))?.consecutiveFailures, 0);
      assert.deepStrictEqual(await scheduler.listRuns(locked.scheduleId), []);
      assert.equal(calls.length, 1);
    } finally {
      scheduler.close();
    }
  });

  it('does not recreate its wake timer after close while startup processing is in flight', async () => {
    const dataDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async () => output(),
    });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let listCalls = 0;
    const store = {
      listScheduleEntries: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          await recoveryGate;
        }
        return [];
      },
    } as unknown as ScheduleStore;
    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir });
    const schedulerState = scheduler as unknown as { timer?: NodeJS.Timeout };

    try {
      await waitFor(
        async () => schedulerState.timer === undefined ? true : undefined,
        'startup scheduler processing',
      );
      scheduler.close();
      releaseRecovery();
      await waitFor(async () => listCalls >= 2 ? true : undefined, 'closed scheduler processing completion');
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(schedulerState.timer, undefined);
    } finally {
      releaseRecovery();
      scheduler.close();
    }
  });

  it('starts an ordered Boss job-sync round and calculates the next run from round completion', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });

    try {
      const schedule = await scheduler.createSchedule(baseSchedule([
        bossJobSyncTask('first'),
        bossJobSyncTask('second'),
      ]));
      const run = await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'successful scheduled round');
      const updated = await waitFor(async () => {
        const current = await scheduler.getSchedule(schedule.scheduleId);
        return current?.activeRunId === undefined ? current : undefined;
      }, 'completed schedule state');

      assert.deepStrictEqual(calls, [
        ['--platform', 'boss', '--boss-job-sync', 'true', '--boss-include-closed-jobs', 'true'],
        ['--platform', 'boss', '--boss-job-sync', 'true', '--boss-include-closed-jobs', 'true'],
      ]);
      assert.equal(run.taskIds.length, 2);
      assert.equal(updated?.activeRunId, undefined);
      assert.equal(updated?.nextRunAt, '2026-07-20T03:00:00.000Z');
    } finally {
      scheduler.close();
    }
  });

  it('rejects new and updated Boss auto-chat templates without writing or queueing them', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => new Date('2026-07-20T02:00:00.000Z') });
    const legacyTask = legacyBossAutoChatTask('legacy-review', 70);

    try {
      await assert.rejects(
        () => scheduler.createSchedule({ ...baseSchedule([legacyTask]), enabled: false }),
        /scheduled-task-kind-not-allowed: boss-auto-chat/,
      );
      await assert.rejects(
        () => scheduler.createSchedule({
          ...baseSchedule([
            bossJobSyncTask('safe-sync'),
            { ...legacyTask, taskKey: 'disabled-legacy-review', enabled: false },
          ]),
          enabled: false,
        }),
        /scheduled-task-kind-not-allowed: boss-auto-chat/,
      );
      assert.deepStrictEqual(await fs.readdir(path.join(dataDir, 'runtime', 'schedules')), []);

      const safe = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('safe-sync')]),
        enabled: false,
      });
      const schedulePath = path.join(dataDir, 'runtime', 'schedules', `${safe.scheduleId}.json`);
      const before = await fs.readFile(schedulePath, 'utf8');
      await assert.rejects(
        () => scheduler.updateSchedule(safe.scheduleId, { tasks: [legacyTask] }),
        /scheduled-task-kind-not-allowed: boss-auto-chat/,
      );
      assert.equal(await fs.readFile(schedulePath, 'utf8'), before);
      assert.deepStrictEqual(calls, []);
    } finally {
      scheduler.close();
    }
  });

  it('quarantines legacy and unknown persisted templates during recovery and control requests', async () => {
    const dataDir = await makeTempDir();
    const now = new Date('2026-07-20T02:00:00.000Z');
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const store = new ScheduleStore(dataDir);
    const legacy = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('safe-sync')]),
      enabled: false,
    }, now) as PersistedScheduleDefinition;
    const activeRunId = crypto.randomUUID();
    legacy.status = 'enabled';
    legacy.nextRunAt = now.toISOString();
    legacy.activeRunId = activeRunId;
    legacy.tasks = [
      { ...bossJobSyncTask('safe-sync'), enabled: true },
      { ...legacyBossAutoChatTask('legacy-disabled', 70), enabled: false },
      {
        taskKey: 'future-kind',
        name: '未知历史任务',
        enabled: false,
        kind: 'future-scheduler-task',
        input: {},
      },
    ];
    await store.saveSchedule(legacy);
    await store.saveRun({
      runId: activeRunId,
      scheduleId: legacy.scheduleId,
      cycleNumber: 1,
      status: 'running',
      scheduledAt: now.toISOString(),
      taskIds: [],
      completedTaskIds: [],
      cancelledTaskIds: [],
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir, now: () => now });

    try {
      const quarantined = await waitFor(async () => {
        const schedule = await scheduler.getSchedule(legacy.scheduleId);
        return schedule?.status === 'paused' && schedule.validationIssues?.length === 2 ? schedule : undefined;
      }, 'legacy schedule quarantine');
      assert.equal(quarantined.activeRunId, undefined);
      assert.equal(quarantined.nextRunAt, undefined);
      assert.deepStrictEqual(quarantined.validationIssues, [
        {
          code: 'scheduled-task-kind-not-allowed',
          taskKey: 'legacy-disabled',
          kind: 'boss-auto-chat',
          message: 'scheduled-task-kind-not-allowed: boss-auto-chat; run it manually or through an assistant-confirmed task',
        },
        {
          code: 'scheduled-task-kind-unknown',
          taskKey: 'future-kind',
          kind: 'future-scheduler-task',
          message: 'scheduled-task-kind-unknown: future-scheduler-task; replace it with a supported recurring schedule task',
        },
      ]);
      const interrupted = await store.readRun(legacy.scheduleId, activeRunId);
      assert.equal(interrupted?.status, 'interrupted');
      assert.equal((await scheduler.listRuns(legacy.scheduleId)).length, 1);
      await assert.rejects(() => scheduler.startSchedule(legacy.scheduleId), /scheduled-task-kind-not-allowed: boss-auto-chat/);
      await assert.rejects(() => scheduler.runScheduleNow(legacy.scheduleId), /scheduled-task-kind-not-allowed: boss-auto-chat/);
      assert.deepStrictEqual(calls, []);

      const beforeSecondRecovery = await fs.readFile(path.join(dataDir, 'runtime', 'schedules', `${legacy.scheduleId}.json`), 'utf8');
      scheduler.close();
      const recoveredAgain = new TaskScheduler({ taskQueue: queue, store, dataDir, now: () => now });
      try {
        await waitFor(async () => {
          const current = await recoveredAgain.getSchedule(legacy.scheduleId);
          return current?.validationIssues?.length === 2 ? current : undefined;
        }, 'idempotent legacy schedule recovery');
        assert.equal(await fs.readFile(path.join(dataDir, 'runtime', 'schedules', `${legacy.scheduleId}.json`), 'utf8'), beforeSecondRecovery);

        const repaired = await recoveredAgain.updateSchedule(legacy.scheduleId, {
          tasks: [bossJobSyncTask('replacement-sync')],
        });
        assert.equal(repaired?.status, 'paused');
        assert.equal(repaired?.validationIssues, undefined);
        await recoveredAgain.startSchedule(legacy.scheduleId);
        await waitFor(async () => {
          const runs = await recoveredAgain.listRuns(legacy.scheduleId);
          return runs.find((run) => run.status === 'succeeded');
        }, 'repaired job-sync schedule');
        assert.deepStrictEqual(calls, [[
          '--platform', 'boss', '--boss-job-sync', 'true', '--boss-include-closed-jobs', 'true',
        ]]);
      } finally {
        recoveredAgain.close();
      }
    } finally {
      scheduler.close();
    }
  });

  it('keeps structurally malformed persisted templates readable without rewriting raw tasks', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const store = new ScheduleStore(dataDir);
    const malformedNullTasks = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('safe-sync')]),
      enabled: false,
    });
    (malformedNullTasks as unknown as { tasks: unknown }).tasks = null;
    const malformedNullItem = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('safe-sync')]),
      enabled: false,
    });
    (malformedNullItem as unknown as { tasks: unknown }).tasks = [null];
    const safe = normalizeScheduleCreate({
      ...baseSchedule([bossJobSyncTask('safe-sync-2')]),
      enabled: false,
    });
    await store.saveSchedule(malformedNullTasks);
    await store.saveSchedule(malformedNullItem);
    await store.saveSchedule(safe);

    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir });
    try {
      const nullTasks = await waitFor(async () => {
        const current = await scheduler.getSchedule(malformedNullTasks.scheduleId);
        return current?.validationIssues?.some((issue) => issue.code === 'scheduled-task-template-invalid')
          ? current
          : undefined;
      }, 'structurally malformed schedule quarantine');
      const nullItem = await scheduler.getSchedule(malformedNullItem.scheduleId);
      assert.ok(nullItem?.validationIssues?.some((issue) => issue.code === 'scheduled-task-template-invalid'));
      assert.deepStrictEqual(nullTasks.tasks, []);
      assert.deepStrictEqual(nullItem?.tasks, [{
        taskKey: 'task-1',
        name: 'Historical task 1',
        enabled: false,
        kind: '<missing>',
        input: {},
      }]);

      const summaries = await scheduler.listSchedules();
      assert.equal(summaries.length, 3);
      assert.equal(summaries.find((item) => item.scheduleId === safe.scheduleId)?.taskCount, 1);
      assert.equal(summaries.find((item) => item.scheduleId === malformedNullTasks.scheduleId)?.taskCount, 0);
      assert.deepStrictEqual((await store.readSchedule(malformedNullTasks.scheduleId))?.tasks, null);
      assert.deepStrictEqual((await store.readSchedule(malformedNullItem.scheduleId))?.tasks, [null]);
      assert.deepStrictEqual(calls, []);
    } finally {
      scheduler.close();
    }
  });

  it('derives read-time blocking issues for legacy templates written after recovery', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const store = new ScheduleStore(dataDir);
    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir });

    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('safe-sync')]),
        enabled: false,
      });
      const externallyChanged = await store.readSchedule(schedule.scheduleId);
      assert.ok(externallyChanged);
      externallyChanged.tasks = [legacyBossAutoChatTask('external-review', 70)];
      delete externallyChanged.validationIssues;
      await store.saveSchedule(externallyChanged);

      const beforeRead = await fs.readFile(path.join(dataDir, 'runtime', 'schedules', `${schedule.scheduleId}.json`), 'utf8');
      const read = await scheduler.getSchedule(schedule.scheduleId);
      assert.equal(read?.status, 'paused');
      assert.deepStrictEqual(read?.validationIssues?.map((issue) => issue.kind), ['boss-auto-chat']);
      assert.deepStrictEqual((await scheduler.listSchedules()).find((item) => item.scheduleId === schedule.scheduleId)?.validationIssues?.map((issue) => issue.kind), ['boss-auto-chat']);
      assert.equal(await fs.readFile(path.join(dataDir, 'runtime', 'schedules', `${schedule.scheduleId}.json`), 'utf8'), beforeRead);
      await assert.rejects(() => scheduler.startSchedule(schedule.scheduleId), /scheduled-task-kind-not-allowed: boss-auto-chat/);
      assert.deepStrictEqual(calls, []);
    } finally {
      scheduler.close();
    }
  });

  it('rechecks the latest record when a control waits behind another store transaction', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir });
    const externalStore = new ScheduleStore(dataDir);

    try {
      const created = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('safe-sync')]),
        enabled: false,
      });
      let releaseExternal!: () => void;
      const externalGate = new Promise<void>((resolve) => {
        releaseExternal = resolve;
      });
      let externalAcquired!: () => void;
      const externalAcquiredPromise = new Promise<void>((resolve) => {
        externalAcquired = resolve;
      });
      const externalWrite = externalStore.transactSchedule(created.scheduleId, async (current) => {
        assert.ok(current);
        externalAcquired();
        await externalGate;
        return {
          schedule: {
            ...current,
            name: 'external latest name',
            tasks: [{ ...legacyBossAutoChatTask('external-review', 70), enabled: true }],
          },
          value: undefined,
        };
      });
      await externalAcquiredPromise;
      const startAttempt = scheduler.startSchedule(created.scheduleId);
      releaseExternal();
      await externalWrite;
      await assert.rejects(startAttempt, /scheduled-task-kind-not-allowed: boss-auto-chat/);

      const persisted = await externalStore.readSchedule(created.scheduleId);
      assert.equal(persisted?.name, 'external latest name');
      assert.deepStrictEqual(persisted?.tasks, [{ ...legacyBossAutoChatTask('external-review', 70), enabled: true }]);
      assert.equal(persisted?.status, 'paused');
      assert.equal(persisted?.consecutiveFailures, 0);
      assert.deepStrictEqual(await scheduler.listRuns(created.scheduleId), []);
      assert.deepStrictEqual(calls, []);
    } finally {
      scheduler.close();
    }
  });

  it('abandons normalized work when another store replaces the schedule before the final lease', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    let releaseNormalization!: () => void;
    const normalizationGate = new Promise<void>((resolve) => {
      releaseNormalization = resolve;
    });
    let normalizationStarted!: () => void;
    const normalizationStartedPromise = new Promise<void>((resolve) => {
      normalizationStarted = resolve;
    });
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      dataDir,
      searchConditionSetService: acceptingSearchConditionSetService(),
      bossCapturePlanResolver: async (input) => {
        normalizationStarted();
        await normalizationGate;
        return savedBossCapturePlanResolver(() => 1)(input);
      },
    });
    const externalStore = new ScheduleStore(dataDir);

    try {
      const created = await scheduler.createSchedule({
        ...baseSchedule([{
          taskKey: 'boss-capture',
          name: 'Boss 抓取',
          kind: 'resume-capture',
          input: {
            platform: 'boss',
            keyword: '全铝箱包设计',
            bossJobId: 'boss-position-1',
            bossSearchKeyword: '铝',
            searchSource: 'direct',
          },
        }]),
        enabled: false,
      });
      await scheduler.startSchedule(created.scheduleId);
      await normalizationStartedPromise;
      const latest = await externalStore.readSchedule(created.scheduleId);
      assert.ok(latest);
      latest.name = 'replacement while normalizing';
      latest.status = 'paused';
      latest.nextRunAt = undefined;
      latest.tasks = [{ ...bossJobSyncTask('replacement-sync'), enabled: true }];
      await externalStore.saveSchedule(latest);
      releaseNormalization();

      const persisted = await waitFor(async () => {
        const current = await externalStore.readSchedule(created.scheduleId);
        return current?.name === 'replacement while normalizing' ? current : undefined;
      }, 'replacement schedule preservation');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(persisted.status, 'paused');
      assert.deepStrictEqual(persisted.tasks, [{ ...bossJobSyncTask('replacement-sync'), enabled: true }]);
      assert.equal(persisted.consecutiveFailures, 0);
      assert.deepStrictEqual(await scheduler.listRuns(created.scheduleId), []);
      assert.deepStrictEqual(calls, []);
    } finally {
      releaseNormalization();
      scheduler.close();
    }
  });

  it('reuses one run identity when dispatch persistence fails after enqueue', async () => {
    class FailingActiveRunCommitStore extends ScheduleStore {
      failNextActiveRunCommit = false;
      onInjectedFailure?: () => void;

      override async transactSchedule<T>(
        scheduleId: string,
        operation: (
          current: PersistedScheduleDefinition | undefined,
        ) => Promise<ScheduleTransactionDecision<T>> | ScheduleTransactionDecision<T>,
      ): Promise<T> {
        if (!this.failNextActiveRunCommit) {
          return super.transactSchedule(scheduleId, operation);
        }
        const current = await this.readSchedule(scheduleId);
        const decision = await operation(current);
        if (decision.schedule?.activeRunId) {
          this.failNextActiveRunCommit = false;
          this.onInjectedFailure?.();
          throw new Error('injected active-run commit failure');
        }
        return super.transactSchedule(scheduleId, operation);
      }
    }

    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        await taskGate;
        return output();
      },
    });
    const store = new FailingActiveRunCommitStore(dataDir);
    const now = new Date('2026-07-20T02:00:00.000Z');
    let scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir, now: () => now });

    try {
      const created = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('single-dispatch')]),
        enabled: false,
      });
      let failureObserved!: () => void;
      const failureObservedPromise = new Promise<void>((resolve) => {
        failureObserved = resolve;
      });
      store.onInjectedFailure = failureObserved;
      store.failNextActiveRunCommit = true;
      await scheduler.startSchedule(created.scheduleId);
      await failureObservedPromise;
      (scheduler as unknown as { requestProcess(delayMs: number): void }).requestProcess(0);
      await waitFor(async () => {
        const current = await scheduler.getSchedule(created.scheduleId);
        return current?.activeRunId ? true : undefined;
      }, 'retried active run reservation');
      releaseTask();
      const completed = await waitFor(async () => {
        const runs = await scheduler.listRuns(created.scheduleId);
        return runs.find((run) => run.status === 'succeeded');
      }, 'retried schedule dispatch persistence');

      assert.equal(completed.cycleNumber, 1, 'the recovered run keeps its original cycle number');
      assert.equal((await scheduler.listRuns(created.scheduleId)).length, 1, 'recovery must not create a second run record');
      assert.equal(calls.length, 1, 'the accepted task group must not execute twice');
      assert.equal((await scheduler.getSchedule(created.scheduleId))?.consecutiveFailures, 0);
    } finally {
      releaseTask();
      scheduler.close();
    }
  });

  it('uses a final scheduler gate when a persisted schedule changes after creation', async () => {
    const dataDir = await makeTempDir();
    let now = new Date('2026-07-20T02:00:00.000Z');
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const store = new ScheduleStore(dataDir);
    const scheduler = new TaskScheduler({ taskQueue: queue, store, dataDir, now: () => now });

    try {
      const created = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('safe-sync')]),
        enabled: false,
        dailyWindow: { start: '20:00', end: '21:00' },
      });
      await scheduler.startSchedule(created.scheduleId);
      const externallyChanged = await store.readSchedule(created.scheduleId);
      assert.ok(externallyChanged);
      externallyChanged.tasks = [{ ...legacyBossAutoChatTask('externally-added-review', 70), enabled: true }];
      await store.saveSchedule(externallyChanged);
      now = new Date('2026-07-20T12:30:00.000Z');
      (scheduler as unknown as { requestProcess(delayMs: number): void }).requestProcess(0);

      const quarantined = await waitFor(async () => {
        const schedule = await scheduler.getSchedule(created.scheduleId);
        return schedule?.status === 'paused' && schedule.validationIssues?.[0]?.kind === 'boss-auto-chat' ? schedule : undefined;
      }, 'final template validation gate');
      assert.equal(quarantined.nextRunAt, undefined);
      assert.deepStrictEqual(await scheduler.listRuns(created.scheduleId), []);
      assert.deepStrictEqual(calls, []);
    } finally {
      scheduler.close();
    }
  });

  it('keeps legacy all schedules core-only and requires explicit Boss opt-in', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });

    try {
      const schedule = await scheduler.createSchedule(baseSchedule([
        {
          taskKey: 'legacy-all',
          name: '历史三平台抓取',
          kind: 'resume-capture',
          input: { platform: 'all', keyword: '店长' },
        },
        {
          taskKey: 'opt-in-boss',
          name: '含直猎邦抓取',
          kind: 'resume-capture',
          input: { platform: 'all', includeBoss: true, keyword: '店长', searchSource: 'direct' },
        },
      ]));
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'core and opt-in capture schedule');

      const captured = calls.map(takeBossCaptureSettingsSnapshot);
      assert.equal(captured[1]?.snapshot?.sourceJobKey, '店长');
      assert.deepStrictEqual(captured.map((item) => item.argv), [
        ['--mode-id', 'capture.reuse-job-settings', '--platform', 'all', '--keyword', '店长'],
        ['--mode-id', 'capture.direct-search', '--platform', 'all', '--keyword', '店长', '--include-boss', 'true', '--search-source', 'direct'],
      ]);
    } finally {
      scheduler.close();
    }
  });

  it('preserves explicit Boss opt-in for scheduled search-subscription tasks', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => new Date('2026-07-20T02:00:00.000Z') });

    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([{
          taskKey: 'search-subscription-boss',
      name: '全平台订阅管理',
          kind: 'search-subscription',
          input: {
            platform: 'all',
            includeBoss: true,
            searchSubscriptionFile: './subscription.json',
          },
        }]),
        enabled: false,
      });
      assert.equal((schedule.tasks[0]?.input as { includeBoss?: boolean }).includeBoss, true);

      await scheduler.startSchedule(schedule.scheduleId);
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((run) => run.status === 'succeeded');
      }, 'scheduled search-subscription Boss opt-in round');
      assert.deepEqual(calls, [[
        '--mode-id', 'subscription.manage',
        '--platform', 'all',
        '--search-subscription-file', './subscription.json',
        '--include-boss', 'true',
      ]]);
    } finally {
      scheduler.close();
    }
  });

  it('rejects subscription-saving schedule templates on create and update', async () => {
    const dataDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async () => output(),
    });
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => new Date('2026-07-20T02:00:00.000Z') });
    const savingTask = {
      taskKey: 'saving-subscription',
      name: '循环保存订阅',
      kind: 'search-subscription',
      input: {
        platform: '51job',
        searchSubscriptionFile: './subscription.json',
        saveSearchSubscription: true,
      },
    };

    try {
      await assert.rejects(
        () => scheduler.createSchedule({ ...baseSchedule([savingTask]), enabled: false }),
        /Scheduled search-subscription tasks cannot save or rename platform subscriptions/,
      );
      await assert.rejects(
        () => scheduler.createSchedule({
          ...baseSchedule([{
            ...savingTask,
            input: {
              ...savingTask.input,
              saveSearchSubscription: false,
              searchSubscriptionName: '循环改名',
            },
          }]),
          enabled: false,
        }),
        /Scheduled search-subscription tasks cannot save or rename platform subscriptions/,
      );

      const safeSchedule = await scheduler.createSchedule({
        ...baseSchedule([{ ...savingTask, input: { ...savingTask.input, saveSearchSubscription: false } }]),
        enabled: false,
      });
      await assert.rejects(
        () => scheduler.updateSchedule(safeSchedule.scheduleId, { tasks: [savingTask] }),
        /Scheduled search-subscription tasks cannot save or rename platform subscriptions/,
      );
    } finally {
      scheduler.close();
    }
  });

  it('stores fixed condition-set revision mappings in schedules without legacy filter paths', async () => {
    const dataDir = await makeTempDir();
    const resolvedReferences: unknown[] = [];
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      dataDir,
      bossCapturePlanResolver: savedBossCapturePlanResolver(() => 4),
      searchConditionSetService: {
        resolve: async (reference: unknown) => {
          resolvedReferences.push(reference);
          return undefined;
        },
      } as unknown as SearchConditionSetService,
    });
    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([{
          taskKey: 'boss-condition-set',
          name: '固定版 Boss 搜索条件',
          kind: 'resume-capture',
          input: {
            platform: 'boss',
            keyword: '全铝箱包设计',
            bossJobId: 'boss-position-1',
            bossSearchKeyword: '铝',
            searchSource: 'direct',
            searchConditionSetRefs: {
              boss: { conditionSetId: 'scs-aluminum-luggage', platform: 'boss', revision: 4 },
            },
          },
        }]),
        enabled: false,
      });

      assert.deepStrictEqual(schedule.tasks[0]?.input, {
        platform: 'boss',
        keyword: '全铝箱包设计',
        bossJobId: 'boss-position-1',
        bossSearchKeyword: '铝',
        searchSource: 'direct',
        searchConditionSetRefs: {
          boss: { conditionSetId: 'scs-aluminum-luggage', platform: 'boss', revision: 4 },
        },
      });
      assert.equal(resolvedReferences.length, 1, 'schedule creation must preflight the pinned revision');

      await scheduler.startSchedule(schedule.scheduleId);
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((run) => run.status === 'succeeded');
      }, 'scheduled condition-set round');
      assert.equal(resolvedReferences.length, 2, 'every scheduled round must recheck the same pinned revision');
      const captured = calls.map(takeBossCaptureSettingsSnapshot);
      assert.equal(captured[0]?.snapshot?.sourceJobKey, '全铝箱包设计-boss-position-1');
      assert.deepStrictEqual(captured.map((item) => item.argv), [[
        '--mode-id', 'capture.direct-search',
        '--platform', 'boss',
        '--keyword', '全铝箱包设计',
        '--boss-job-id', 'boss-position-1',
        '--boss-search-keyword', '铝',
        '--search-source', 'direct',
        '--search-condition-set', 'scs-aluminum-luggage@4',
      ]]);
    } finally {
      scheduler.close();
    }
  });

  it('resolves reusable Boss settings at each scheduled round into a Boss-only immutable snapshot', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    let revision = 1;
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      dataDir,
      now: () => now,
      searchConditionSetService: acceptingSearchConditionSetService(),
      bossCapturePlanResolver: savedBossCapturePlanResolver(() => revision),
    });

    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([{
          taskKey: 'saved-boss-settings',
          name: '复用 Boss 保存搜索设置',
          kind: 'resume-capture',
          input: {
            platform: 'boss',
            keyword: '全铝箱包设计',
            bossJobId: 'boss-position-1',
          },
        }]),
        enabled: false,
      });
      assert.deepStrictEqual(schedule.tasks[0]?.input, {
        platform: 'boss',
        keyword: '全铝箱包设计',
        bossJobId: 'boss-position-1',
      }, 'the mutable saved setting is not frozen at schedule creation');

      await scheduler.startSchedule(schedule.scheduleId);
      const firstRun = await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((run) => run.status === 'succeeded');
      }, 'first saved-settings round');
      const firstTask = await queue.getTask(firstRun.taskIds[0]!);
      assert.deepStrictEqual((firstTask?.input as { bossSearchConditionSetRef?: unknown }).bossSearchConditionSetRef, {
        conditionSetId: 'scs-aluminum-luggage',
        platform: 'boss',
        revision: 1,
      });

      revision = 2;
      await scheduler.runScheduleNow(schedule.scheduleId);
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((run) => run.status === 'succeeded' && run.runId !== firstRun.runId);
      }, 'second saved-settings round');

      const captured = calls.map(takeBossCaptureSettingsSnapshot);
      assert.deepStrictEqual(captured.map((item) => item.snapshot?.sourceJobKey), [
        '全铝箱包设计-boss-position-1',
        '全铝箱包设计-boss-position-1',
      ]);
      assert.deepStrictEqual(captured.map((item) => item.argv), [
        [
          '--mode-id', 'capture.reuse-job-settings',
          '--platform', 'boss',
          '--keyword', '全铝箱包设计',
          '--boss-job-id', 'boss-position-1',
          '--boss-search-keyword', '铝',
          '--boss-search-condition-set', 'scs-aluminum-luggage@1',
        ],
        [
          '--mode-id', 'capture.reuse-job-settings',
          '--platform', 'boss',
          '--keyword', '全铝箱包设计',
          '--boss-job-id', 'boss-position-1',
          '--boss-search-keyword', '铝',
          '--boss-search-condition-set', 'scs-aluminum-luggage@2',
        ],
      ]);
    } finally {
      scheduler.close();
    }
  });

  it('keeps Boss job sync schedulable without adding an auto-chat review', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });
    try {
      const schedule = await scheduler.createSchedule(baseSchedule([bossJobSyncTask('sync-jobs')]));
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'Boss job-sync round');
      assert.deepStrictEqual(calls, [
        ['--platform', 'boss', '--boss-job-sync', 'true', '--boss-include-closed-jobs', 'true'],
      ]);
    } finally {
      scheduler.close();
    }
  });

  it('schedules only card-only Talent Mapping scans and rejects detail-capable plans or stages', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });
    try {
      const schedule = await scheduler.createSchedule(baseSchedule([mappingTask('mapping-scan')]));
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'card-only Mapping scheduled round');
      assert.deepStrictEqual(calls, [[
        '--platform', 'all',
        '--talent-mapping-file', cardOnlyMappingPath,
        '--mapping-stage', 'scan',
      ]]);

      await assert.rejects(
        () => scheduler.createSchedule(baseSchedule([mappingTask('detail-plan', detailMappingPath)])),
        /requires a card-only plan/,
      );
      await assert.rejects(
        () => scheduler.createSchedule(baseSchedule([mappingTask('detail-stage', cardOnlyMappingPath, 'all')])),
        /requires mappingStage scan/,
      );
    } finally {
      scheduler.close();
    }
  });

  it('stops after the current task and cancels the remaining tasks in its round', async () => {
    const dataDir = await makeTempDir();
    const calls: string[][] = [];
    let releaseFirstTask: (() => void) | undefined;
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async (argv) => {
        calls.push([...argv]);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstTask = resolve;
          });
        }
        return output();
      },
    });
    const now = new Date('2026-07-20T02:00:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });

    try {
      const schedule = await scheduler.createSchedule(baseSchedule([
        bossJobSyncTask('first'),
        bossJobSyncTask('second'),
      ]));
      await waitFor(async () => calls.length === 1 ? true : undefined, 'first scheduled task start');
      const stopping = await scheduler.stopScheduleAfterCurrentTask(schedule.scheduleId);
      assert.equal(stopping?.status, 'stop_requested');
      releaseFirstTask?.();

      const stopped = await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        const run = runs.find((item) => item.status === 'stopped');
        const current = await scheduler.getSchedule(schedule.scheduleId);
        return run && current?.status === 'stopped' ? { run, current } : undefined;
      }, 'stopped scheduled round');

      assert.equal(calls.length, 1);
      assert.equal(stopped.run.cancelledTaskIds.length, 1);
      assert.equal(stopped.current.status, 'stopped');
      assert.equal(stopped.current.nextRunAt, undefined);
    } finally {
      scheduler.close();
    }
  });

  it('handles daily and cross-midnight window calculations', () => {
    const daytime = getWindowState(new Date('2026-07-20T02:00:00.000Z'), {
      start: '09:00',
      end: '18:00',
    }, 'Asia/Shanghai');
    const overnight = getWindowState(new Date('2026-07-20T20:00:00.000Z'), {
      start: '22:00',
      end: '06:00',
    }, 'Asia/Shanghai');
    const next = resolveNextEligibleStart(new Date('2026-07-20T09:30:00.000Z'), 3600, {
      start: '09:00',
      end: '18:00',
    }, 'Asia/Shanghai');

    assert.equal(daytime.within, true);
    assert.equal(overnight.within, true);
    assert.equal(next.toISOString(), '2026-07-21T01:00:00.000Z');
  });

  it('uses future real instants across daylight-saving gaps and repeated hours', () => {
    const beforeSpringGap = new Date('2026-03-08T06:40:00.000Z');
    const springWindow = { start: '02:30', end: '04:00' };
    const beforeSpringGapState = getWindowState(beforeSpringGap, springWindow, 'America/New_York');
    const atSpringBoundaryState = getWindowState(new Date('2026-03-08T07:00:00.000Z'), springWindow, 'America/New_York');
    const skippedSpringWindow = getWindowState(beforeSpringGap, { start: '02:30', end: '03:00' }, 'America/New_York');
    const repeatedHourState = getWindowState(new Date('2026-11-01T06:20:00.000Z'), { start: '01:30', end: '02:30' }, 'America/New_York');

    assert.equal(beforeSpringGapState.within, false);
    assert.equal(beforeSpringGapState.nextStartAt.toISOString(), '2026-03-08T07:00:00.000Z');
    assert.ok(beforeSpringGapState.nextStartAt.getTime() > beforeSpringGap.getTime());
    assert.equal(atSpringBoundaryState.within, true);
    assert.equal(atSpringBoundaryState.endAt?.toISOString(), '2026-03-08T08:00:00.000Z');
    assert.equal(skippedSpringWindow.within, false);
    assert.equal(skippedSpringWindow.nextStartAt.toISOString(), '2026-03-09T06:30:00.000Z');
    assert.ok(skippedSpringWindow.nextStartAt.getTime() > beforeSpringGap.getTime());
    assert.equal(repeatedHourState.within, true);
    assert.equal(repeatedHourState.endAt?.toISOString(), '2026-11-01T07:30:00.000Z');
  });

  it('persists a future scheduler wake-up instead of retrying a spring-forward gap', async () => {
    const dataDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir: path.join(dataDir, 'runtime', 'tasks'),
      runner: async () => output(),
    });
    const now = new Date('2026-03-08T06:40:00.000Z');
    const scheduler = new TaskScheduler({ taskQueue: queue, dataDir, now: () => now });

    try {
      const schedule = await scheduler.createSchedule({
        ...baseSchedule([bossJobSyncTask('boss-sync')]),
        timeZone: 'America/New_York',
        dailyWindow: { start: '02:30', end: '04:00' },
      });
      const updated = await waitFor(async () => {
        const current = await scheduler.getSchedule(schedule.scheduleId);
        return current?.nextRunAt === '2026-03-08T07:00:00.000Z' ? current : undefined;
      }, 'a future DST scheduler wake-up');

      assert.equal(updated.activeRunId, undefined);
      assert.equal(updated.nextRunAt, '2026-03-08T07:00:00.000Z');
    } finally {
      scheduler.close();
    }
  });
});
