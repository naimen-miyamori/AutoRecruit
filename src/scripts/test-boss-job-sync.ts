import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  buildBossSyncedJobKey,
  hashBossJd,
  readBossPositionSummaries,
  syncBossPositions,
} from '../platforms/boss-jobs.js';
import type { BossJobSyncRun, BossPositionSummary } from '../types/boss.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';
import { JobStore } from '../storage/job-store.js';

const normalizedJob: NormalizedJob = {
  title: '物业电工',
  majors: [],
  languageRequirements: [],
  responsibilities: ['负责设备维护'],
  hardRequirements: ['高低压证'],
  preferredRequirements: [],
  regionPreferences: [],
  industryTags: ['物业'],
};

describe('Boss job/JD synchronization', () => {
  it('creates distinct stable keys for same-name positions with different Boss IDs', () => {
    assert.notEqual(buildBossSyncedJobKey('物业电工', 'job-1'), buildBossSyncedJobKey('物业电工', 'job-2'));
    assert.equal(hashBossJd('物业电工\r\n负责设备维护'), hashBossJd('物业电工\n负责设备维护'));
  });

  it('parses open and closed Boss positions with exact source IDs', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="job-list">
          <div class="job-item" data-job-id="job-1"><span class="job-name">物业电工</span><span class="job-area">上海</span><span>招聘中</span></div>
          <div class="job-item" data-job-id="job-2"><span class="job-name">物业电工</span><span>已关闭</span></div>
        </div>
      `);
      assert.deepStrictEqual(await readBossPositionSummaries(page), [
        { bossJobId: 'job-1', name: '物业电工', status: 'open', location: '上海' },
        { bossJobId: 'job-2', name: '物业电工', status: 'closed', location: undefined },
      ]);
    } finally {
      await browser.close();
    }
  });

  it('resolves auto-chat JD by Boss job ID and rejects ambiguous same-name fallback', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-job-map-'));
    const originalDataDir = config.dataDir;
    (config as { dataDir: string }).dataDir = tempDir;
    try {
      const store = new JobStore();
      for (const bossJobId of ['job-1', 'job-2']) {
        const jobKey = buildBossSyncedJobKey('物业电工', bossJobId);
        await store.saveJobRecord('boss', {
          jobKey,
          platform: 'boss',
          searchKeyword: '物业电工',
          rawText: `JD ${bossJobId}`,
          normalizedJob,
          createdAt: '2026-01-01T00:00:00.000Z',
          bossPosition: {
            bossJobId,
            status: 'open',
            syncedAt: '2026-01-01T00:00:00.000Z',
            sourceHash: hashBossJd(`JD ${bossJobId}`),
          },
        });
      }
      assert.equal((await store.resolveBossConversationJobRecord({
        bossJobId: 'job-2',
        jobName: '物业电工',
      })).rawText, 'JD job-2');
      await assert.rejects(
        () => store.resolveBossConversationJobRecord({ jobName: '物业电工' }),
        /Ambiguous stored Boss JD/,
      );
    } finally {
      (config as { dataDir: string }).dataDir = originalDataDir;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not reparse or rewrite an unchanged JD', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    try {
      await page.route('https://www.zhipin.com/web/chat/job/list', async (route) => route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `
          <div class="job-list">
            <div class="job-item" data-job-id="job-1" onclick="document.querySelector('.job-detail').style.display='block'">
              <span class="job-name">物业电工</span><span>招聘中</span>
            </div>
          </div>
          <div class="job-detail" data-job-id="job-1" style="display:none">
            <h2 class="job-name">物业电工</h2><div class="job-description">负责设备维护，要求高低压证</div>
            <button class="close" onclick="this.parentElement.style.display='none'">关闭</button>
          </div>
        `,
      }));
      const rawJd = '负责设备维护，要求高低压证';
      const existing: JobRecord = {
        jobKey: buildBossSyncedJobKey('物业电工', 'job-1'),
        platform: 'boss',
        searchKeyword: '物业电工',
        rawText: rawJd,
        normalizedJob,
        createdAt: '2026-01-01T00:00:00.000Z',
        bossPosition: {
          bossJobId: 'job-1',
          status: 'open',
          syncedAt: '2026-01-01T00:00:00.000Z',
          sourceHash: hashBossJd(rawJd),
        },
      };
      let parseCalls = 0;
      let saveCalls = 0;
      const runs: BossJobSyncRun[] = [];
      const fakeStore = {
        saveBossPositionSnapshot: async (_positions: readonly BossPositionSummary[]) => 'positions.json',
        findBossJobRecordByPositionId: async () => existing,
        saveJobRecord: async () => { saveCalls += 1; },
        saveBossJobSyncRun: async (run: BossJobSyncRun) => {
          runs.push(run);
          return 'run.json';
        },
      } as unknown as JobStore;

      const run = await syncBossPositions(page, { platform: 'boss' }, {
        store: fakeStore,
        parseJd: async () => {
          parseCalls += 1;
          return normalizedJob;
        },
        now: () => new Date('2026-07-23T00:00:00.000Z'),
      });
      assert.equal(parseCalls, 0);
      assert.equal(saveCalls, 0);
      assert.equal(run.unchanged, 1);
      assert.equal(run.resultPath, 'run.json');
      assert.equal(runs.length, 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });
});
