import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { MainRunSummary } from '../index.js';
import { getWindowState, resolveNextEligibleStart } from '../server/schedule-time.js';
import { TaskScheduler } from '../server/task-scheduler.js';
import { TaskQueue } from '../server/task-queue.js';

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
    newCandidates: 0,
    scoredCandidates: 0,
    failedCandidates: 0,
    resultPath: '/tmp/scheduled-result.json',
    emailAttempted: false,
    emailDelivered: false,
    sampleCandidateIds: [],
  };
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

describe('TaskScheduler', () => {
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
});
