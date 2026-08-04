import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { MainRunSummary } from '../index.js';
import { normalizeScheduleCreate } from '../server/schedule-normalizers.js';
import { ScheduleStore } from '../server/schedule-store.js';
import { getWindowState, resolveNextEligibleStart } from '../server/schedule-time.js';
import { TaskScheduler } from '../server/task-scheduler.js';
import { TaskQueue } from '../server/task-queue.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import type { BossCapturePlanResolver } from '../server/boss-capture-snapshot.js';
import type { BossCaptureSettingsSnapshot } from '../types/job.js';

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

function bossTask(taskKey: string, scoreThreshold: number) {
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
      ...baseSchedule([bossTask('boss-review', 70)]),
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
      listSchedules: async () => {
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

  it('starts an ordered round and calculates the next run from round completion', async () => {
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
        bossTask('first', 71),
        bossTask('second', 82),
      ]));
      const run = await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'successful scheduled round');
      const updated = await scheduler.getSchedule(schedule.scheduleId);

      assert.deepStrictEqual(calls, [
        ['--platform', 'boss', '--boss-auto-chat', 'true', '--boss-chat-score-threshold', '71'],
        ['--platform', 'boss', '--boss-auto-chat', 'true', '--boss-chat-score-threshold', '82'],
      ]);
      assert.equal(run.taskIds.length, 2);
      assert.equal(updated?.activeRunId, undefined);
      assert.equal(updated?.nextRunAt, '2026-07-20T03:00:00.000Z');
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
        ['--platform', 'all', '--keyword', '店长'],
        ['--platform', 'all', '--keyword', '店长', '--include-boss', 'true', '--search-source', 'direct'],
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
        '--platform', 'all',
        '--search-subscription-file', './subscription.json',
        '--include-boss', 'true',
      ]]);
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
          '--platform', 'boss',
          '--keyword', '全铝箱包设计',
          '--boss-job-id', 'boss-position-1',
          '--boss-search-keyword', '铝',
          '--boss-search-condition-set', 'scs-aluminum-luggage@1',
        ],
        [
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

  it('chains scheduled Boss job sync before auto-chat review', async () => {
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
        bossJobSyncTask('sync-jobs'),
        bossTask('review-chat', 70),
      ]));
      await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'succeeded');
      }, 'Boss sync and review round');
      assert.deepStrictEqual(calls, [
        ['--platform', 'boss', '--boss-job-sync', 'true', '--boss-include-closed-jobs', 'true'],
        ['--platform', 'boss', '--boss-auto-chat', 'true', '--boss-chat-score-threshold', '70'],
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
        bossTask('first', 71),
        bossTask('second', 82),
      ]));
      await waitFor(async () => calls.length === 1 ? true : undefined, 'first scheduled task start');
      const stopping = await scheduler.stopScheduleAfterCurrentTask(schedule.scheduleId);
      assert.equal(stopping?.status, 'stop_requested');
      releaseFirstTask?.();

      const run = await waitFor(async () => {
        const runs = await scheduler.listRuns(schedule.scheduleId);
        return runs.find((item) => item.status === 'stopped');
      }, 'stopped scheduled round');
      const updated = await scheduler.getSchedule(schedule.scheduleId);

      assert.equal(calls.length, 1);
      assert.equal(run.cancelledTaskIds.length, 1);
      assert.equal(updated?.status, 'stopped');
      assert.equal(updated?.nextRunAt, undefined);
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
        ...baseSchedule([bossTask('boss-review', 70)]),
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
