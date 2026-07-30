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
  openAndReadBossPositionDetail,
  openBossJobList,
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

  it('reads stable IDs and JD text from the current Boss v2 job-list and edit iframes', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    try {
      await page.route('**/web/chat/job/list*', async (route) => route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `
          <iframe src="https://www.zhipin.com/web/frame/job_v2/list?jobversion=test"></iframe>
          <div class="dialog-wrap active" data-type="boss-dialog">
            <div class="dialog-hunter-daily-task-guide" style="position:fixed;z-index:2">
              <div class="close-btn" style="width:20px;height:20px" onclick="this.closest('.dialog-wrap').remove()"></div>
            </div>
            <div class="boss-layer__wrapper" style="position:fixed;inset:0;z-index:1"></div>
          </div>
        `,
      }));
      await page.route('**/web/frame/job_v2/list*', async (route) => route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `
          <div id="app"></div>
          <ul class="job-list-content">
            <li class="job-item-container"><span class="job-title-box"><span class="job-name">全铝箱包设计</span><span>普</span><span>匿名</span></span><span class="job-area">肇庆</span><span class="status-box status-opening">开放中</span><span class="operate-btn" onclick="parent.location.href='https://www.zhipin.com/web/chat/job/edit?encryptId=job-v2-1'">编辑</span></li>
            <li class="job-item-container"><span class="job-name">待开放职位</span><span class="status-box status-wait-open">待开放</span></li>
            <li class="job-item-container"><span class="job-name">失效职位</span><span class="status-box status-invalid">已失效</span></li>
          </ul>
          <script>
            document.getElementById('app').__vue_app__ = { config: { globalProperties: { $pinia: { state: { value: {
              'job-list-page': { jobList: [
                { encryptId: 'job-v2-1', encryptJobId: 'job-v2-1', positionName: '全铝箱包设计', locationName: '肇庆' },
                { encryptId: 'job-v2-2', encryptJobId: 'job-v2-2', positionName: '待开放职位' },
                { encryptId: 'job-v2-3', encryptJobId: 'job-v2-3', positionName: '失效职位' }
              ] }
            } } } } } };
          </script>
        `,
      }));
      await page.route('**/web/chat/job/edit*', async (route) => route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<iframe src="https://www.zhipin.com/web/frame/job/edit?encryptId=job-v2-1"></iframe>',
      }));
      await page.route('**/web/frame/job/edit*', async (route) => route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `
          <input name="jobName" value="全铝箱包设计">
          <textarea placeholder="请勿填写QQ、微信、电话等联系方式及违反劳动法相关内容"></textarea>
          <div class="job-department"><input class="job-department-input" value="设计部"></div>
          <div class="job-address"><input class="ipt" value="肇庆"></div>
          <script>setTimeout(() => { document.querySelector('textarea').value = '负责全铝箱包产品设计与工艺落地'; }, 100)</script>
        `,
      }));

      await page.goto('https://www.zhipin.com/web/chat/job/list');
      await openBossJobList(page);
      const positions = await readBossPositionSummaries(page);
      assert.deepEqual(positions, [
        { bossJobId: 'job-v2-1', name: '全铝箱包设计', status: 'open', location: '肇庆' },
        { bossJobId: 'job-v2-2', name: '待开放职位', status: 'pending', location: undefined },
        { bossJobId: 'job-v2-3', name: '失效职位', status: 'closed', location: undefined },
      ]);
      const detail = await openAndReadBossPositionDetail(page, positions[0]!);
      assert.equal(detail.rawJd, '负责全铝箱包产品设计与工艺落地');
      assert.equal(detail.department, '设计部');
      assert.equal(detail.location, '肇庆');
      assert.match(page.url(), /\/web\/chat\/job\/list/);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
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
