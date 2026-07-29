import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { config } from '../config.js';
import {
  extractBossCandidateList,
  openBossResumeDetail,
} from '../platforms/boss/actions/search-actions.js';

type SearchFixtureOptions = {
  body: string;
};

async function createSearchFixture(options: SearchFixtureOptions): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.route('https://www.zhipin.com/web/chat/search', async (route) => {
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><iframe name="searchFrame" src="https://www.zhipin.com/web/frame/search/"></iframe></body></html>',
    });
  });
  await page.route('https://www.zhipin.com/web/frame/search/', async (route) => {
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: options.body });
  });
  await page.route('https://www.zhipin.com/web/frame/c-resume/', async (route) => {
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><canvas id="resume" width="320" height="480"></canvas></body></html>',
    });
  });
  await page.goto('https://www.zhipin.com/web/chat/search');
  return { browser, page };
}

function searchBody(content: string): string {
  return `<!doctype html><html><body>
    <div class="search-job-list-C"><span class="search-current-job">不限职位</span></div>
    <input class="search-input" value="测试关键词" />
    <script>
      function openResume() {
        parent.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap active" data-type="boss-dialog"><button class="boss-popup__close" onclick="this.parentElement.remove()"></button><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe></div>');
      }
    </script>
    ${content}
  </body></html>`;
}

describe('Boss normal-search actions', () => {
  it('returns an explicit empty result instead of treating it as a failed extraction', async () => {
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>暂无相关人才</p>') });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.match(await frame.locator('body').innerText(), /暂无相关人才/);
      const result = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.deepEqual(result.candidates, []);
    } finally {
      await browser.close();
    }
  });

  it('refuses to treat an unresolved search iframe as an empty result', async () => {
    const originalTimeout = config.playwright.searchPageTimeoutMs;
    config.playwright.searchPageTimeoutMs = 50;
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>正在加载</p>') });
    try {
      await assert.rejects(
        () => extractBossCandidateList(page),
        /Timeout|timeout/i,
      );
    } finally {
      config.playwright.searchPageTimeoutMs = originalTimeout;
      await browser.close();
    }
  });

  it('fails when the page reports a Boss data-loading error', async () => {
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>数据加载异常</p>') });
    try {
      await assert.rejects(
        () => extractBossCandidateList(page, { deadline: Date.now() + 3_000 }),
        /Boss search reported a data-loading error/,
      );
    } finally {
      await browser.close();
    }
  });

  it('opens a detail only for the exact stable Boss candidate identity', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="boss-candidate-1" href="#resume" onclick="openResume(); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人甲</div></a></div>'),
    });
    try {
      const { candidates } = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.candidateId, 'boss-candidate-1');

      await openBossResumeDetail(page.context(), page, candidates[0]!);
      assert.equal(await page.locator('.dialog-wrap.active[data-type="boss-dialog"]').count(), 1);

      await assert.rejects(
        () => openBossResumeDetail(page.context(), page, { candidateId: 'missing-candidate' }),
        /Could not uniquely find Boss candidate card for missing-candidate; matched 0/,
      );
      await assert.rejects(
        () => openBossResumeDetail(page.context(), page, { candidateId: 'boss-card-unstable' }),
        /card has no stable Boss identity/,
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });
});
