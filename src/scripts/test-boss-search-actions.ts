import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { config } from '../config.js';
import {
  applyBossDirectSearch,
  applyBossViewedCandidatePolicy,
  applyBossSearchCondition,
  assertBossSearchFilterStateRestorable,
  discoverBossSearchFilters,
  extractBossCandidateList,
  openBossDirectSearch,
  openBossResumeDetail,
  openBossSubscribeSearch,
  prepareBossSearchConditionPage,
  readBossDirectSearchVerificationSummary,
  resetBossSearchFilters,
  snapshotBossSearchFilterState,
  visitBossSeenCandidateDetail,
} from '../platforms/boss/actions/search-actions.js';
import {
  assertBossResumeTarget,
  BossForwardPreConfirmationError,
  BossForwardUncertainError,
  closeBossResumeDetailStrict,
  forwardBossResumeAction,
} from '../platforms/boss/actions/resume-detail-actions.js';

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
      body: '<!doctype html><html><body><canvas id="resume" width="320" height="480"></canvas><script src="/wapi/zpitem/web/boss/search/geek/info?expectId=boss-candidate-1"></script><script>void fetch("/wapi/zpitem/web/boss/search/geek/info?expectId=boss-candidate-1");</script></body></html>',
    });
  });
  await page.route('https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info**', async (route) => {
    const expectId = new URL(route.request().url()).searchParams.get('expectId') ?? 'boss-candidate-1';
    await route.fulfill({
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ code: 0, zpData: { expectId }, geek: { expectId } }),
    });
  });
  await page.goto('https://www.zhipin.com/web/chat/search');
  return { browser, page };
}

function searchBody(content: string): string {
  return `<!doctype html><html><body>
    <div class="search-job-list-C"><span class="search-current-job">不限职位</span></div>
    <input class="search-input" value="测试关键词" />
    <button type="button" class="search-btn" aria-label="搜索">搜索</button>
    <div class="search-result-list" id="boss-search-submit-epoch" data-boss-search-result-version="0"></div>
    <script>
      window.__bossSearchClicks = 0;
      window.__bossSearchEnterPresses = 0;
      const bossSearchSubmitButton = document.querySelector('.search-btn');
      document.querySelector('.search-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') window.__bossSearchEnterPresses += 1; });
      bossSearchSubmitButton?.addEventListener('click', () => {
        window.__bossSearchClicks += 1;
        const epoch = document.querySelector('#boss-search-submit-epoch');
        if (epoch) epoch.setAttribute('data-boss-search-result-version', String(Number(epoch.getAttribute('data-boss-search-result-version') || '0') + 1));
      });
    </script>
    <script>
      function openResume() {
        parent.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap active" data-type="boss-dialog"><button class="boss-popup__close" onclick="this.parentElement.remove()"></button><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe></div>');
      }
    </script>
    ${content}
  </body></html>`;
}

function recentViewedSearchBody(options: { refreshOnChange?: boolean } = {}): string {
  const refreshOnChange = options.refreshOnChange !== false;
  return searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetSearch()">清空筛选</span>
    <label class="high_search_checkbox" ka="search_change_view_resume" style="display:block;width:200px;height:24px"><input type="checkbox">过滤近14天查看</label>
    <label class="high_search_checkbox" ka="search_change_exchange_resume" style="display:block;width:240px;height:24px"><input type="checkbox">近30天未和同事交换简历</label>
    <section id="boss-results" data-boss-search-result-version="0"><div class="geek-info-card">candidate card</div></section>
    <script>
      window.__recentViewedChanges = 0;
      window.__recentViewedResetCalls = 0;
      const recentViewedInput = document.querySelector('.high_search_checkbox[ka="search_change_view_resume"] input');
      function refreshResults() {
        const results = document.querySelector('#boss-results');
        results.dataset.bossSearchResultVersion = String(Number(results.dataset.bossSearchResultVersion || '0') + 1);
        results.innerHTML = '<div class="geek-info-card">candidate card</div>';
      }
      recentViewedInput.addEventListener('change', () => {
        window.__recentViewedChanges += 1;
        ${refreshOnChange ? 'refreshResults();' : ''}
      });
      function resetSearch() {
        window.__recentViewedResetCalls += 1;
        recentViewedInput.checked = false;
        refreshResults();
      }
    </script>`);
}

async function installForwardReceiptFixture(page: Page, mode: 'success' | 'uncertain' | 'pre-confirmation'): Promise<void> {
  await page.evaluate((fixtureMode) => {
    const detail = document.createElement('div');
    detail.className = 'dialog-wrap active';
    detail.dataset.type = 'boss-dialog';
    const iframe = document.createElement('iframe');
    iframe.src = 'https://www.zhipin.com/web/frame/c-resume/';
    detail.appendChild(iframe);
    const forwardButton = document.createElement('button');
    forwardButton.className = 'btn-coop-forward';
    forwardButton.style.cssText = 'display:block;width:120px;height:24px';
    forwardButton.addEventListener('click', () => {
      const share = document.createElement('div');
      share.className = 'c-share-box';
      share.style.cssText = 'display:block;width:480px;height:240px';
      share.innerHTML = '<div class="nav-list"><span class="item cur">邮件转发</span></div><input placeholder="请输入收件人邮箱"><textarea placeholder="请输入留言"></textarea><a ka="geek_coop_forward" style="display:block;width:80px;height:24px">转发</a>';
      const confirm = share.querySelector<HTMLAnchorElement>('a[ka="geek_coop_forward"]')!;
      confirm.addEventListener('click', () => {
        share.style.display = 'none';
        if (fixtureMode === 'success') {
          const success = document.createElement('div');
          success.dataset.bossForwardSuccess = 'true';
          success.textContent = '转发成功';
          success.style.cssText = 'display:block;width:80px;height:20px';
          document.body.appendChild(success);
        }
      });
      detail.appendChild(share);
      if (fixtureMode === 'pre-confirmation') {
        document.addEventListener('mousemove', () => {
          if (confirm.isConnected) confirm.remove();
        }, { once: true });
      }
    });
    detail.appendChild(forwardButton);
    document.body.appendChild(detail);
  }, mode);
}

describe('Boss normal-search actions', () => {
  it('rejects CC for colleague forwarding before touching the page', async () => {
    await assert.rejects(() => forwardBossResumeAction({} as Page, {
      candidateId: 'candidate-colleague-cc',
      mode: 'colleague',
      recipient: '招聘同事',
      ccEmails: ['audit@example.com'],
      actionMode: 'prepare-only',
      deadline: Date.now() + 1_000,
    }), /CC is only supported for email forwarding/);
  });

  it('reopens the recipient-only dialog for each deduplicated copy and writes the candidate ID to every message', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await page.evaluate(() => {
        (window as unknown as { __bossForwardDialogOpenCount: number }).__bossForwardDialogOpenCount = 0;
        (window as unknown as { __bossForwards: Array<{ recipient: string; message: string }> }).__bossForwards = [];
        (window as unknown as { __bossContactClicks: number }).__bossContactClicks = 0;
        (window as unknown as { __bossPurchaseCloses: number }).__bossPurchaseCloses = 0;
        const detail = document.createElement('div');
        detail.className = 'dialog-wrap active';
        detail.dataset.type = 'boss-dialog';
        const iframe = document.createElement('iframe');
        iframe.src = 'https://www.zhipin.com/web/frame/c-resume/';
        detail.appendChild(iframe);
        const forwardButton = document.createElement('button');
        forwardButton.className = 'btn-coop-forward';
        forwardButton.style.cssText = 'display:block;width:120px;height:24px';
        forwardButton.addEventListener('click', () => {
          (window as unknown as { __bossForwardDialogOpenCount: number }).__bossForwardDialogOpenCount += 1;
          const share = document.createElement('div');
          share.className = 'c-share-box';
          share.style.cssText = 'display:block;width:480px;height:240px';
          share.innerHTML = '<div class="nav-list"><span class="item cur">邮件转发</span></div><input placeholder="请输入收件人邮箱"><textarea placeholder="请输入留言"></textarea><a ka="geek_coop_forward" style="display:block;width:80px;height:24px">转发</a>';
          share.querySelector('a[ka="geek_coop_forward"]')!.addEventListener('click', () => {
            const recipient = (share.querySelector('input[placeholder="请输入收件人邮箱"]') as HTMLInputElement).value;
            const message = (share.querySelector('textarea[placeholder="请输入留言"]') as HTMLTextAreaElement).value;
            (window as unknown as { __bossForwards: Array<{ recipient: string; message: string }> }).__bossForwards.push({ recipient, message });
            share.style.display = 'none';
            const success = document.createElement('div');
            success.dataset.bossForwardSuccess = 'true';
            success.textContent = '转发成功';
            success.style.cssText = 'display:block;width:80px;height:20px';
            document.body.appendChild(success);
          });
          detail.appendChild(share);
        });
        detail.appendChild(forwardButton);
        const contactButton = document.createElement('button');
        contactButton.textContent = '联系Ta';
        contactButton.style.cssText = 'display:block;width:120px;height:24px';
        contactButton.addEventListener('click', () => {
          (window as unknown as { __bossContactClicks: number }).__bossContactClicks += 1;
        });
        detail.appendChild(contactButton);
        document.body.appendChild(detail);

      });
      await forwardBossResumeAction(page, {
        candidateId: 'candidate-cc-1',
        mode: 'email',
        recipient: 'Primary@example.com',
        ccEmails: [' primary@example.com ', ' cc-one@example.com ', 'CC-ONE@example.com', 'cc-two@example.com'],
        actionMode: 'confirm',
        deadline: Date.now() + 10_000,
      });
      const forwarded = await page.evaluate(() => ({
        openCount: (window as unknown as { __bossForwardDialogOpenCount: number }).__bossForwardDialogOpenCount,
        deliveries: (window as unknown as { __bossForwards: Array<{ recipient: string; message: string }> }).__bossForwards,
        contactClicks: (window as unknown as { __bossContactClicks: number }).__bossContactClicks,
        purchaseCloses: (window as unknown as { __bossPurchaseCloses: number }).__bossPurchaseCloses,
      }));
      assert.equal(forwarded.openCount, 3);
      assert.deepStrictEqual(forwarded.deliveries, [
        { recipient: 'Primary@example.com', message: 'candidate-cc-1' },
        { recipient: 'cc-one@example.com', message: 'candidate-cc-1' },
        { recipient: 'cc-two@example.com', message: 'candidate-cc-1' },
      ]);
      assert.equal(forwarded.contactClicks, 0);
      assert.equal(forwarded.purchaseCloses, 0);
      assert.equal(await page.locator('.dialog-wrap.active:visible').filter({ hasText: /搜索畅聊卡|立即购买/ }).count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('closes and fails safely when the forward action opens a search-chat-card purchase dialog', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await page.evaluate(() => {
        (window as unknown as { __bossPurchaseCloses: number }).__bossPurchaseCloses = 0;
        const detail = document.createElement('div');
        detail.className = 'dialog-wrap active';
        detail.dataset.type = 'boss-dialog';
        const iframe = document.createElement('iframe');
        iframe.src = 'https://www.zhipin.com/web/frame/c-resume/';
        detail.appendChild(iframe);
        const forwardButton = document.createElement('button');
        forwardButton.className = 'btn-coop-forward';
        forwardButton.style.cssText = 'display:block;width:120px;height:24px';
        forwardButton.addEventListener('click', () => {
          const purchase = document.createElement('div');
          purchase.className = 'dialog-wrap active';
          purchase.style.cssText = 'display:block;width:360px;height:180px';
          purchase.innerHTML = '<p>热搜牛人需购买搜索畅聊卡</p><div class="boss-popup__close" style="display:block;width:24px;height:24px"></div>';
          purchase.querySelector('.boss-popup__close')!.addEventListener('click', () => {
            (window as unknown as { __bossPurchaseCloses: number }).__bossPurchaseCloses += 1;
            purchase.style.display = 'none';
          });
          document.body.appendChild(purchase);
        });
        detail.appendChild(forwardButton);
        document.body.appendChild(detail);
      });

      await assert.rejects(() => forwardBossResumeAction(page, {
        candidateId: 'candidate-purchase-guard',
        mode: 'email',
        recipient: 'primary@example.com',
        actionMode: 'confirm',
        deadline: Date.now() + 10_000,
      }), /opened the search-chat-card purchase dialog.*no forwarding confirmation was attempted/);
      assert.equal(await page.evaluate(() => (window as unknown as { __bossPurchaseCloses: number }).__bossPurchaseCloses), 1);
      assert.equal(await page.locator('.c-share-box').count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('classifies a confirmation control detached before click dispatch as retryable pre-confirmation failure', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installForwardReceiptFixture(page, 'pre-confirmation');
      await assert.rejects(
        () => forwardBossResumeAction(page, {
          candidateId: 'candidate-pre-confirmation',
          mode: 'email',
          recipient: 'primary@example.com',
          actionMode: 'confirm',
          deadline: Date.now() + 3_000,
        }),
        (error: unknown) => error instanceof BossForwardPreConfirmationError
          && /did not dispatch|changed before/.test(error.message),
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('classifies a dispatched confirmation without success evidence as uncertain', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installForwardReceiptFixture(page, 'uncertain');
      await assert.rejects(
        () => forwardBossResumeAction(page, {
          candidateId: 'candidate-uncertain',
          mode: 'email',
          recipient: 'primary@example.com',
          actionMode: 'confirm',
          deadline: Date.now() + 1_000,
        }),
        (error: unknown) => error instanceof BossForwardUncertainError
          && /success evidence|completion is uncertain/.test(error.message),
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('maps the public viewed switch to the recent-viewed checkbox and proves a refresh without requiring card-count changes', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const deadline = Date.now() + 10_000;
      const defaultResult = await applyBossViewedCandidatePolicy(page, false, deadline);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.deepEqual(defaultResult, { desiredChecked: true, changed: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);
      assert.equal(await frame.locator('.geek-info-card').count(), 1);
      assert.equal(await frame.locator('#boss-results').getAttribute('data-boss-search-result-version'), '1');

      const includeResult = await applyBossViewedCandidatePolicy(page, true, deadline);
      assert.deepEqual(includeResult, { desiredChecked: false, changed: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.locator('.geek-info-card').count(), 1);
      assert.equal(await frame.locator('#boss-results').getAttribute('data-boss-search-result-version'), '2');

      const idempotentResult = await applyBossViewedCandidatePolicy(page, true, deadline);
      assert.deepEqual(idempotentResult, { desiredChecked: false, changed: false });
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('refuses a recent-viewed toggle when no post-click result refresh can be observed', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody({ refreshOnChange: false }) });
    try {
      await assert.rejects(
        () => applyBossViewedCandidatePolicy(page, false, Date.now() + 750),
        /no new search-result refresh was observed/i,
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('submits exactly once when every direct-search condition is already satisfied', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      const first = await applyBossDirectSearch(page, '测试关键词', [], { deadline: Date.now() + 5_000 });
      assert.deepEqual(first.changedFields, []);
      assert.ok(first.submission?.submitted);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);

      const second = await applyBossDirectSearch(page, '测试关键词', [], { deadline: Date.now() + 5_000 });
      assert.deepEqual(second.changedFields, []);
      assert.ok(second.submission?.submitted);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('sets a changed keyword without Enter and submits through the final search button', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: searchBody('<div class="geek-info-card">candidate card</div>') });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-input').evaluate((input) => { (input as HTMLInputElement).value = '旧关键词'; });
      await openBossSubscribeSearch(page, '新关键词', { deadline: Date.now() + 5_000 });
      assert.equal(await frame.locator('.search-input').inputValue(), '新关键词');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchEnterPresses), 0);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('enters a short keyword only once after filter refreshes can replace its value', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = recentViewedSearchBody().replace('</body>', `<script>
      window.__bossAluminumKeywordInputs = 0;
      const diagnosticKeyword = document.querySelector('.search-input');
      diagnosticKeyword.addEventListener('input', () => {
        if (diagnosticKeyword.value === '铝') window.__bossAluminumKeywordInputs += 1;
      });
      document.querySelector('.high_search_checkbox[ka="search_change_view_resume"] input').addEventListener('change', () => {
        diagnosticKeyword.value = '铝模';
      });
    </script></body>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const result = await applyBossDirectSearch(page, '铝', [], {
        deadline: Date.now() + 5_000,
        includeViewedCandidates: false,
      });
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.search-input').inputValue(), '铝');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossAluminumKeywordInputs), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
      assert.ok(result.changedFields?.includes('keyword'));
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed before clicking when the final search control is missing or ambiguous', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const missing = await createSearchFixture({ body: searchBody('<div class="geek-info-card">candidate card</div><script>document.querySelector(".search-btn")?.remove();</script>') });
    try {
      const frame = missing.page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await assert.rejects(
        () => openBossSubscribeSearch(missing.page, '测试关键词', { deadline: Date.now() + 2_000 }),
        /submit control was not found/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      await missing.browser.close();
    }

    const ambiguous = await createSearchFixture({ body: searchBody('<div class="geek-info-card">candidate card</div><script>document.body.insertAdjacentHTML("beforeend", "<button class=\\"search-btn\\">搜索</button>");</script>') });
    try {
      const frame = ambiguous.page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await assert.rejects(
        () => openBossSubscribeSearch(ambiguous.page, '测试关键词', { deadline: Date.now() + 2_000 }),
        /submit control is ambiguous/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await ambiguous.browser.close();
    }
  });

  it('does not treat an unrelated global search icon as the final Boss submit control', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<style>.search-btn{display:none !important}</style><div class="geek-info-card">candidate card</div><script>document.body.insertAdjacentHTML("beforeend", "<button class=\"icon-search\" style=\"display:block;width:120px;height:24px\">无关图标</button>"); window.__unrelatedIconClicks = 0; document.querySelector(".icon-search")?.addEventListener("click", () => { window.__unrelatedIconClicks += 1; });</script>'),
    });
    try {
      await assert.rejects(
        () => openBossSubscribeSearch(page, '测试关键词', { deadline: Date.now() + 2_000 }),
        /submit control was not found/i,
      );
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__unrelatedIconClicks ?? 0), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('uses the unique Boss icon that shares the current search-input wrapper', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`<div class="geek-info-card">candidate card</div><script>
      document.querySelector('.search-btn').remove();
      const keyword = document.querySelector('.search-input');
      const container = document.createElement('div');
      container.className = 'search-container';
      const wrapper = document.createElement('div');
      wrapper.className = 'search-input-wrap';
      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'input-warp';
      const icon = document.createElement('i');
      icon.className = 'icon-search';
      icon.style.cssText = 'display:block;width:24px;height:24px';
      inputWrapper.appendChild(keyword);
      wrapper.append(inputWrapper, icon);
      container.appendChild(wrapper);
      document.body.prepend(container);
      icon.addEventListener('click', () => {
        window.__bossSearchClicks += 1;
        const epoch = document.querySelector('#boss-search-submit-epoch');
        epoch.setAttribute('data-boss-search-result-version', String(Number(epoch.getAttribute('data-boss-search-result-version') || '0') + 1));
      });
    </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      await openBossSubscribeSearch(page, '测试关键词', { deadline: Date.now() + 5_000 });
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('does not click again when the first submit has no new result-cycle evidence', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card">candidate card</div><script>document.querySelector("#boss-search-submit-epoch")?.remove();</script>'),
    });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await assert.rejects(
        () => openBossSubscribeSearch(page, '测试关键词', { deadline: Date.now() + 900 }),
        /no observable new result cycle/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('accepts an explicit empty result only after the final submit cycle', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>暂无相关人才</p>') });
    try {
      const result = await applyBossDirectSearch(page, '测试关键词', [], { deadline: Date.now() + 5_000 });
      assert.equal(result.verification.resultTotal, 0);
      assert.equal(result.submission?.evidence, 'result-mutation');
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('keeps standalone search-condition preparation isolated from the ordinary-capture viewed policy', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const deadline = Date.now() + 10_000;
      await prepareBossSearchConditionPage(page, '测试关键词', { deadline, includeViewedCandidates: false });
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 0);

      await openBossSubscribeSearch(page, '测试关键词', { deadline, includeViewedCandidates: false });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);

      await openBossSubscribeSearch(page, '测试关键词', { deadline, includeViewedCandidates: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies the viewed policy after direct-search reset, deduplicates an agreeing condition, and rejects conflicts before page mutation', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    const agreeingCondition = {
      kind: 'applicationFilter' as const,
      fieldId: 'filter_recent_viewed',
      label: '过滤近14天查看',
      fieldKind: 'toggle' as const,
      value: true,
    };
    try {
      const deadline = Date.now() + 10_000;
      await assert.rejects(
        () => openBossDirectSearch(page, '测试关键词', [{ ...agreeingCondition, value: false }], {
          deadline,
          includeViewedCandidates: false,
        }),
        /conflicts with --include-viewed false/i,
      );
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedResetCalls), 0);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);

      await openBossDirectSearch(page, '测试关键词', [agreeingCondition], {
        deadline,
        includeViewedCandidates: false,
      });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);

      await openBossDirectSearch(page, '测试关键词', [], {
        deadline,
        includeViewedCandidates: true,
      });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('clears a residual city summary after the page reset clears its city checkmarks', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetSearch()">清空筛选</span>
        <div class="city-wrap"><div class="city" onclick="openCity()">广东</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li onclick="selectNational(this)"><div class="city-checkbox status0"></div>全国</li><li><div class="city-checkbox status1"></div>广东</li></ul><button onclick="confirmCity()">确认</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div>
        <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox">过滤近14天查看</label><label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label><div class="geek-info-card">candidate card</div>
        <script>
          function openCity() { document.querySelector('.city-box').style.display = 'block'; }
          function selectNational(item) { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); item.querySelector('.city-checkbox').className = 'city-checkbox status1'; document.querySelector('.city-wrap .city').textContent = '全国'; }
          function confirmCity() { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); document.querySelector('.city-box').style.display = 'none'; }
          function resetSearch() { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); document.querySelectorAll('.high_search_checkbox input').forEach((input) => { input.checked = false; }); }
        </script>`),
    });
    try {
      await resetBossSearchFilters(page, Date.now() + 10_000);
      const state = await snapshotBossSearchFilterState(page, Date.now() + 10_000);
      assert.equal(state.city, '');
      assert.deepEqual(state.cityOptions, []);
      assert.equal(state.toggles.filter_recent_viewed, false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('discovers city, job scope, and token-dialog filters as typed controls', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="city-wrap"><div class="city">城市</div><div class="city-box"><ul class="dropdown-province"><li data-value="a"><div class="city-checkbox status0"></div>甲</li></ul></div></div>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><div class="ui-dropmenu-list"><ul><li class="active" data-value="search_select_job">不限职位</li><li data-value="search_select_job">职位B</li></ul></div></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 6 ? 'onclick="document.querySelector(\'.major-dialog\').style.display=\'block\'"' : ''}><div class="major-input-ui">${index === 6 ? '专业' : '筛选' + index}</div></div>`).join('')}</div>
        <div class="major-dialog dialog-wrap" style="display:none"><input class="ipt"><ul><li data-value="major-a">测试专业</li></ul><button>取消</button><button>确定</button></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, { keyword: '', deadline: Date.now() + 10_000 });
      assert.equal(catalog.filters.find((item) => item.key === 'boss-city')?.options?.length, 1);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-job-scope')?.options?.length, 2);
      assert.deepEqual(catalog.filters.find((item) => item.key === 'boss-job-scope')?.options?.map((option) => option.value), ['不限职位', '职位B']);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-major')?.options?.length, 1);
      assert.equal(catalog.filters.some((item) => item.key === 'boss-qualification'), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('limits segmented discovery to the requested expandable filter without consuming its deadline on other panels', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 4 ? 'onclick="this.querySelector(\'.dropdown-menu\').style.display=\'block\'"' : ''}><span class="defalut-select">${index === 4 ? '求职状态' : '筛选' + index}</span>${index === 4 ? '<ul class="dropdown-menu" style="display:none"><li>不限</li><li>在职</li><li>离职</li></ul>' : ''}</div>`).join('')}</div>
        <div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, {
        keyword: '',
        deadline: Date.now() + 10_000,
        filterKeys: ['boss-job-status'],
      });
      assert.equal(catalog.filters.find((item) => item.key === 'boss-job-status')?.options?.length, 3);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-city')?.options, undefined);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-major')?.options, undefined);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('publishes semantic custom-slider boundaries instead of Boss internal indexes', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider"><input type="hidden" value="1,7"></div></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider"><input type="hidden" value="1,12"></div></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, { keyword: '', deadline: Date.now() + 10_000 });
      const education = catalog.filters.find((filter) => filter.key === 'boss-education');
      const workYears = catalog.filters.find((filter) => filter.key === 'boss-work-years');
      const educationOptions = education?.options?.find((option) => option.label === '自定义')?.inputSpec?.fields[0]?.options;
      const workYearsOptions = workYears?.options?.find((option) => option.label === '自定义')?.inputSpec?.fields[0]?.options;
      assert.deepEqual(educationOptions, ['中专/中技', '高中', '大专', '本科', '硕士', '博士']);
      assert.equal(workYearsOptions?.at(-1), '10年以上');
      assert.equal(workYearsOptions?.includes('12'), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('rejects unsupported entry filters before a live verifier can reset the page', () => {
    const baseline = {
      keyword: '测试关键词', jobScope: '不限职位', jobScopeIndex: 0, city: '', company: '',
      inline: { education: ['不限'], school_nature: ['不限'], work_years: ['不限'], age: ['不限'] },
      more: {},
      toggles: { filter_recent_viewed: false, no_colleague_resume_exchange: false },
    };
    assert.doesNotThrow(() => assertBossSearchFilterStateRestorable(baseline));
    assert.throws(
      () => assertBossSearchFilterStateRestorable({ ...baseline, company: 'existing-filter' }),
      /cannot safely restore a pre-existing city or company filter/i,
    );
  });

  it('applies exact school-nature sets and toggles, then resets the reusable search page', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetFilters()">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active" onclick="selectSingle(this, '.degree-ui')">不限</span><span class="degree-item" onclick="selectSingle(this, '.degree-ui')">本科及以上</span></div>
        <div class="school-ui"><span class="degree-item active" onclick="resetSchool()">不限</span><label><input type="checkbox" onchange="syncSchool()"><span class="checkbox-text">统招本科</span></label><label><input type="checkbox" onchange="syncSchool()"><span class="checkbox-text">985院校</span></label></div>
        <div class="experience-select"><span class="exp-item active" onclick="selectSingle(this, '.experience-select')">不限</span><span class="exp-item" onclick="selectSingle(this, '.experience-select')">1-3年</span></div>
        <div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container"><div class="filter-2-item"><span class="ipt">性别</span></div><div class="filter-2-item"><div class="salary-container"><span class="double-select-gray-inner-flip">薪资区间</span></div></div><div class="filter-2-item"><span class="ipt">牛人活跃度</span></div><div class="filter-2-item"><span class="ipt">跳槽频率</span></div><div class="filter-2-item"><span class="defalut-select">求职状态</span></div><div class="filter-2-item"><span class="defalut-select">牛人职位要求</span></div><div class="filter-2-item"><span class="major-input-ui">专业</span></div></div>
        <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox">过滤近14天查看</label>
        <label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label>
        <div class="geek-info-card">candidate card</div>
        <script>
          function selectSingle(target, root) { document.querySelectorAll(root + ' .active').forEach((item) => item.classList.remove('active')); target.classList.add('active'); }
          function resetSchool() { document.querySelectorAll('.school-ui input').forEach((input) => { input.checked = false; }); document.querySelector('.school-ui .degree-item').classList.add('active'); }
          function syncSchool() { document.querySelector('.school-ui .degree-item').classList.toggle('active', ![...document.querySelectorAll('.school-ui input')].some((input) => input.checked)); }
          function resetFilters() { selectSingle(document.querySelector('.degree-ui .degree-item'), '.degree-ui'); selectSingle(document.querySelector('.experience-select .exp-item'), '.experience-select'); document.querySelector('.age-select .age-item').classList.add('active'); resetSchool(); document.querySelectorAll('.high_search_checkbox input').forEach((input) => { input.checked = false; }); }
        </script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const schoolResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'school_nature', label: '院校要求', fieldKind: 'multiSelect', value: ['统招本科', '985院校'],
      }, deadline);
      assert.equal(schoolResult.status, 'applied');
      const toggleResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'filter_recent_viewed', label: '过滤近14天查看', fieldKind: 'toggle', value: true,
      }, deadline);
      assert.equal(toggleResult.status, 'applied');

      const selectedState = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(selectedState.inline.school_nature, ['统招本科', '985院校']);
      assert.equal(selectedState.toggles.filter_recent_viewed, true);

      await resetBossSearchFilters(page, deadline);
      const baseline = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(baseline.inline.school_nature, ['不限']);
      assert.equal(baseline.toggles.filter_recent_viewed, false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies a custom education slider range through paced pointer dragging', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.degree-select-custom-slider .ui-slider');
          const input = slider.querySelector('input');
          const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')];
          let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); handles[0].style.left = ((values[0] - 1) / 6 * (rect.width - 12)) + 'px'; handles[1].style.left = ((values[1] - 1) / 6 * (rect.width - 12)) + 'px'; });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '2', max: '5' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.degree-ui input[type="hidden"]').inputValue(), '2,5');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies a custom work-years slider range from within its scoped container', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div>
        <div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,12"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div>
        <div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.experience-select .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(12, Math.floor(((event.clientX - rect.left) / rect.width) * 11) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'work_years', label: '经验要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '2', max: '5' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.experience-select input[type="hidden"]').inputValue(), '2,5');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('maps semantic education and work-years boundaries to the Boss slider values and visible ranges', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content"></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div>
        <div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,12"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div><div class="experience-select-custom-content"></div></div>
        <div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          function wireSlider(rootSelector, maximum, labels, outputSelector) {
            const root = document.querySelector(rootSelector); const slider = root.querySelector('.ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
            const render = () => { const values = input.value.split(',').map(Number); root.querySelector(outputSelector).textContent = labels[values[0]] + '-' + labels[values[1]]; };
            handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
            document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(maximum, Math.floor(((event.clientX - rect.left) / rect.width) * (maximum - 1)) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); render(); });
            document.addEventListener('mouseup', () => { activeHandle = -1; });
          }
          wireSlider('.degree-ui', 7, ['', '不限', '初中及以下', '高中', '大专', '本科', '硕士', '博士'], '.degree-select-custom-content');
          wireSlider('.experience-select', 12, ['', '在校/应届', '1年', '2年', '3年', '4年', '5年', '6年', '7年', '8年', '9年', '10年', '10年以上'], '.experience-select-custom-content');
        </script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const education = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }, deadline);
      const experience = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'work_years', label: '经验要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '10年以上', max: '10年以上' } },
      }, deadline);
      assert.equal(education.status, 'applied', education.message);
      assert.equal(experience.status, 'applied', experience.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.degree-ui input[type="hidden"]').inputValue(), '4,7');
      assert.equal(await frame.locator('.degree-select-custom-content').innerText(), '大专-博士');
      assert.equal(await frame.locator('.experience-select input[type="hidden"]').inputValue(), '12,12');
      assert.equal(await frame.locator('.experience-select-custom-content').innerText(), '10年以上-10年以上');
      const state = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(state.inline.education, ['custom:大专-博士']);
      assert.deepEqual(state.inline.work_years, ['custom:10年以上-10年以上']);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails a custom slider when its visible range disagrees with the requested semantic boundary', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content">高中-博士</div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.degree-ui .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'failed');
      assert.match(result.message ?? '', /visible value did not match 大专-博士/);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('keeps a stable province value when the closed city summary omits the display suffix', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="city-wrap"><div class="city" onclick="openCity()">城市</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li data-value="广东" onclick="selectProvince(this)"><div class="city-checkbox status0"></div>广东省</li><li data-value="浙江" onclick="selectProvince(this)"><div class="city-checkbox status0"></div>浙江省</li></ul><div class="dropdown-city"><button type="button" onclick="window.__secondaryCityClicks += 1">肇庆</button></div><button type="button" onclick="confirmCity()">确认</button></div></div>
        <div class="degree-ui"><span class="degree-item active" onclick="selectEducation(this)">不限</span><span class="degree-item" onclick="selectEducation(this)">本科及以上</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          window.__cityPanelOpens = 0; window.__provinceClicks = 0; window.__cityConfirmations = 0; window.__secondaryCityClicks = 0;
          function openCity() { window.__cityPanelOpens += 1; document.querySelector('.city-box').style.display = 'block'; }
          function selectProvince(item) { window.__provinceClicks += 1; const checkbox = item.querySelector('.city-checkbox'); checkbox.className = 'city-checkbox status1'; [...document.querySelectorAll('.dropdown-province > li')].filter((entry) => entry !== item).forEach((entry) => { entry.querySelector('.city-checkbox').className = 'city-checkbox status0'; }); }
          function confirmCity() { window.__cityConfirmations += 1; const selected = [...document.querySelectorAll('.dropdown-province > li')].find((entry) => entry.querySelector('.city-checkbox').classList.contains('status1')); const summary = selected ? selected.getAttribute('data-value') : '城市'; document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); document.querySelector('.city-box').style.display = 'none'; setTimeout(() => { document.querySelector('.city-wrap .city').textContent = summary; }, 700); }
          function selectEducation(item) { document.querySelectorAll('.degree-ui .degree-item').forEach((entry) => entry.classList.remove('active')); item.classList.add('active'); }
        </script>`),
    });
    const condition = {
      kind: 'applicationFilter' as const, fieldId: 'city', label: '城市', fieldKind: 'multiSelect' as const, value: ['广东'],
    };
    try {
      const deadline = Date.now() + 10_000;
      const first = await applyBossDirectSearch(page, '测试关键词', [condition], { deadline });
      assert.equal(first.verification.conditions.find((entry) => entry.fieldId === 'city')?.verified, true);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityPanelOpens), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__provinceClicks), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityConfirmations), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__secondaryCityClicks), 0);
      assert.equal(await frame.locator('.city-box').isVisible(), false);

      const verification = await readBossDirectSearchVerificationSummary(page, '测试关键词', [condition], Date.now() + 10_000);
      assert.equal(verification.conditions.find((entry) => entry.fieldId === 'city')?.verified, true);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityPanelOpens), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityConfirmations), 1);

      const conditionsWithIndependentEducation = [condition, {
        kind: 'applicationFilter' as const, fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect' as const, value: '本科及以上',
      }];
      const independentRepair = await applyBossDirectSearch(page, '测试关键词', conditionsWithIndependentEducation, { deadline: Date.now() + 10_000 });
      assert.deepEqual(independentRepair.changedFields, ['education']);
      assert.ok(independentRepair.alreadySatisfiedFields?.includes('city'));
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityPanelOpens), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityConfirmations), 1);

      const second = await applyBossDirectSearch(page, '测试关键词', conditionsWithIndependentEducation, { deadline: Date.now() + 10_000 });
      assert.equal(second.verification.conditions.find((entry) => entry.fieldId === 'city')?.verified, true);
      assert.deepEqual(second.changedFields, []);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityPanelOpens), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__provinceClicks), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__cityConfirmations), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__secondaryCityClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('accepts a closed city summary label when the requested province uses a stable code', async () => {
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="city-wrap"><div class="city">广东省</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li data-value="guangdong"><div class="city-checkbox status0"></div>广东省</li></ul></div></div><div class="geek-info-card">candidate card</div>'),
    });
    try {
      const condition = {
        kind: 'applicationFilter' as const,
        fieldId: 'city',
        label: '城市',
        fieldKind: 'multiSelect' as const,
        value: ['guangdong'],
      };
      const verification = await readBossDirectSearchVerificationSummary(
        page,
        '测试关键词',
        [condition],
        Date.now() + 3_000,
      );
      assert.equal(verification.conditions.find((entry) => entry.fieldId === 'city')?.verified, true);
    } finally {
      await browser.close();
    }
  });

  it('keeps a semantic custom range in the final direct-search postcondition', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="city-wrap"><div class="city" onclick="document.querySelector('.city-box').style.display='block'">城市</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li data-value="guangdong" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>广东</li><li data-value="zhaoqing" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>肇庆</li></ul><button>清除</button><button onclick="confirmCity()">确认</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider ui-slider-range custom-slider-disabled" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content"></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          function toggleCity(item) { const checkbox = item.querySelector('.city-checkbox'); checkbox.classList.toggle('status0'); checkbox.classList.toggle('status1'); }
          function confirmCity() { const selected = [...document.querySelectorAll('.dropdown-province > li')].find((item) => item.querySelector('.city-checkbox').classList.contains('status1')); document.querySelector('.city-wrap .city').textContent = selected ? selected.textContent.trim() : '城市'; document.querySelector('.city-box').style.display = 'none'; }
          document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelector('.city-box').style.display = 'none'; });
          const slider = document.querySelector('.degree-ui .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; slider.classList.remove('custom-slider-disabled'); }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); document.querySelector('.degree-select-custom-content').textContent = ['', '不限', '中专/中技', '高中', '大专', '本科', '硕士', '博士'][values[0]] + '-' + ['', '不限', '中专/中技', '高中', '大专', '本科', '硕士', '博士'][values[1]]; });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      await openBossDirectSearch(page, '测试关键词', [{
        kind: 'applicationFilter', fieldId: 'city', label: '城市', fieldKind: 'multiSelect', value: ['广东'],
      }, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }], { deadline: Date.now() + 10_000 });
      const state = await snapshotBossSearchFilterState(page, Date.now() + 10_000);
      assert.deepEqual(state.inline.education, ['custom:大专-博士']);
      assert.equal(await page.frame({ name: 'searchFrame' })?.locator('.city-box').isVisible(), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects the exact Boss city option set and confirms the panel', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="city-wrap"><div class="city">城市</div><div class="city-box"><ul class="dropdown-province"><li data-value="a" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>甲</li><li data-value="b" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>乙</li></ul><button>取消</button><button onclick="confirmCity()">确定</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>function toggleCity(item) { const checkbox = item.querySelector('.city-checkbox'); checkbox.classList.toggle('status0'); checkbox.classList.toggle('status1'); } function confirmCity() { document.querySelector('.city-box').style.display = 'none'; }</script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'city', label: '城市', fieldKind: 'multiSelect', value: ['a', 'b'],
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.city-checkbox.status1').count(), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects a job scope by value and applies company text through the shared condition action', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><div class="ui-dropmenu-list"><ul><li class="active" data-value="all" onclick="selectJob(this)">不限职位</li><li data-value="job-b" onclick="selectJob(this)">职位B</li></ul></div></div></div>
        <input class="input-text" placeholder="多个公司用空格隔开"><div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>function selectJob(item) { document.querySelectorAll('.ui-dropmenu-list li').forEach((entry) => entry.classList.remove('active')); item.classList.add('active'); document.querySelector('.search-current-job').textContent = item.textContent; }</script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const jobResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'job_scope', label: '职位范围', fieldKind: 'singleSelect', value: 'job-b',
      }, deadline);
      assert.equal(jobResult.status, 'applied', jobResult.message);
      const companyResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'company', label: '公司', fieldKind: 'textInput', value: ['甲公司', '乙公司'],
      }, deadline);
      assert.equal(companyResult.status, 'applied', companyResult.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.search-current-job').first().innerText(), '职位B');
      assert.equal(await frame.locator('input.input-text').inputValue(), '甲公司 乙公司');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('accepts the exact active job-scope option when the display label remains stale', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: `<!doctype html><html><body>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><ul class="ui-dropmenu-list"><li class="active" data-value="all" onclick="selectJob(this)">不限职位</li><li data-value="target" onclick="selectJob(this)">职位B</li></ul></div></div>
        <input class="search-input" value="测试关键词" /><button type="button" class="search-btn">搜索</button><div class="search-result-list" data-boss-search-result-version="0"></div><div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>document.querySelector('.search-btn')?.addEventListener('click', () => document.querySelector('.search-result-list')?.setAttribute('data-boss-search-result-version', String(Date.now())));</script>
        <script>function selectJob(item) { document.querySelectorAll('.ui-dropmenu-list li').forEach((entry) => entry.classList.remove('active')); item.classList.add('active'); }</script>
      </body></html>`,
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'job_scope', label: '职位范围', fieldKind: 'singleSelect', value: 'target',
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.ui-dropmenu-list li.active').first().getAttribute('data-value'), 'target');
      assert.equal(await frame.locator('.search-current-job').innerText(), '不限职位');
      const direct = await applyBossDirectSearch(page, '测试关键词', [{
        kind: 'applicationFilter', fieldId: 'job_scope', label: '职位范围', fieldKind: 'singleSelect', value: 'target',
      }], { deadline: Date.now() + 10_000 });
      assert.equal(direct.verification.conditions.find((entry) => entry.fieldId === 'job_scope')?.verified, true);
      assert.ok(direct.alreadySatisfiedFields?.includes('job_scope'));
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects an exact major dialog entry and confirms the dialog', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 6 ? 'onclick="document.querySelector(\'.major-dialog\').style.display=\'block\'"' : ''}><div class="major-input-ui">${index === 6 ? '专业' : '筛选' + index}</div></div>`).join('')}</div>
        <div class="major-dialog dialog-wrap" style="display:none"><input class="ipt" placeholder="请输入专业名称"><ul><li onclick="this.classList.add('selected')">测试专业</li></ul><button>取消</button><button onclick="this.closest('.major-dialog').style.display='none'">确定</button></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'major', label: '专业', fieldKind: 'textInput', value: '测试专业',
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.major-dialog li.selected').count(), 1);
      await assert.rejects(() => frame.locator('.major-dialog').waitFor({ state: 'visible', timeout: 50 }));
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

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

  it('bounds the raw Boss card window before parsing and never promotes card 21', async () => {
    const cards = Array.from({ length: 21 }, (_, index) => `<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="candidate-${index + 1}" href="#resume"><div class="geek-info-detail">候选人${index + 1}</div></a></div>`).join('');
    const { browser, page } = await createSearchFixture({ body: searchBody(cards) });
    try {
      const result = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.equal(result.candidates.length, 20);
      assert.equal(result.candidates.at(-1)?.candidateId, 'candidate-20');
      assert.equal(result.candidates.some((candidate) => candidate.candidateId === 'candidate-21'), false);
    } finally {
      await browser.close();
    }
  });

  it('fails closed on duplicate or missing stable IDs inside the raw first-twenty window', async () => {
    const duplicateCards = [
      '<div class="geek-info-card"><a data-expect="duplicate-candidate" href="#resume">甲</a></div>',
      '<div class="geek-info-card"><a data-expect="duplicate-candidate" href="#resume">乙</a></div>',
    ].join('');
    const { browser: duplicateBrowser, page: duplicatePage } = await createSearchFixture({ body: searchBody(duplicateCards) });
    try {
      await assert.rejects(
        () => extractBossCandidateList(duplicatePage, { deadline: Date.now() + 3_000 }),
        /duplicate stable IDs inside the first twenty/i,
      );
    } finally {
      await duplicateBrowser.close();
    }

    const { browser: missingBrowser, page: missingPage } = await createSearchFixture({ body: searchBody('<div class="geek-info-card"><a href="#resume">没有稳定 ID</a></div>') });
    try {
      await assert.rejects(
        () => extractBossCandidateList(missingPage, { deadline: Date.now() + 3_000 }),
        /no stable candidate identity/i,
      );
    } finally {
      await missingBrowser.close();
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

  it('closes an unexpected purchase dialog after a detail click and reports a fatal page-safety failure', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="boss-candidate-1" href="#resume" onclick="openPurchase(); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人甲</div></a></div><script>parent.__purchaseCloses = 0; function openPurchase() { const root = parent.document; const purchase = root.createElement("div"); purchase.className = "dialog-wrap active"; purchase.style.cssText = "display:block;width:360px;height:180px"; purchase.innerHTML = "<p>购买搜索畅聊卡</p><button class=\\"boss-popup__close\\" style=\\"display:block;width:24px;height:24px\\"></button>"; purchase.querySelector(".boss-popup__close")?.addEventListener("click", () => { parent.__purchaseCloses += 1; purchase.style.display = "none"; }); root.body.appendChild(purchase); }</script>'),
    });
    try {
      await assert.rejects(
        () => visitBossSeenCandidateDetail(page, {
          candidateId: 'boss-candidate-1',
          sourceText: 'data-expect="boss-candidate-1"',
        }, { deadline: Date.now() + 10_000 }),
        (error: unknown) => error instanceof Error
          && error.name === 'BossSeenCandidateDetailError'
          && (error as { fatalCloseFailure?: boolean }).fatalCloseFailure === true
          && /purchase dialog|畅聊卡/i.test(error.message),
      );
      assert.equal(await page.evaluate(() => (window as unknown as { __purchaseCloses: number }).__purchaseCloses), 1);
      assert.equal(await page.locator('.dialog-wrap.active:visible').filter({ hasText: /搜索畅聊卡|立即购买/ }).count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('opens, verifies, and closes an already-seen card without invoking contact or forwarding', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="boss-candidate-1" href="#resume" onclick="openResume(); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人甲</div><button type="button" class="contact" onclick="window.__contactClicks=(window.__contactClicks||0)+1; return false">联系Ta</button></a></div>'),
    });
    try {
      const receipt = await visitBossSeenCandidateDetail(page, {
        candidateId: 'boss-candidate-1',
        sourceText: 'data-expect="boss-candidate-1"',
      }, { deadline: Date.now() + 10_000 });
      assert.deepEqual(receipt, {
        candidateId: 'boss-candidate-1',
        detailOpened: true,
        detailIdentityVerified: true,
        detailClosed: true,
      });
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(iframe[src*="/web/frame/c-resume/"])').count(), 0);
      assert.equal(await page.evaluate(() => (window as unknown as { __contactClicks?: number }).__contactClicks ?? 0), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('closes a history detail after identity mismatch and reports a retryable verification failure', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="other-candidate" href="#resume" onclick="openResume(); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人乙</div></a></div>'),
    });
    try {
      await assert.rejects(
        () => visitBossSeenCandidateDetail(page, {
          candidateId: 'other-candidate',
          sourceText: 'data-expect="other-candidate"',
        }, { deadline: Date.now() + 10_000 }),
        (error: unknown) => error instanceof Error
          && error.name === 'BossSeenCandidateDetailError'
          && error.message.includes('does not match requested candidate other-candidate')
          && (error as { stage?: string }).stage === 'identity-verify'
          && (error as { fatalCloseFailure?: boolean }).fatalCloseFailure === false,
      );
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(iframe[src*="/web/frame/c-resume/"])').count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed when the resume detail modal cannot be closed', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await page.evaluate(() => {
        const detail = document.createElement('div');
        detail.className = 'dialog-wrap active';
        detail.dataset.type = 'boss-dialog';
        detail.style.cssText = 'display:block;width:480px;height:360px';
        detail.innerHTML = '<button class="boss-popup__close" style="display:block;width:24px;height:24px"></button><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe>';
        document.body.appendChild(detail);
      });
      await assert.rejects(
        () => closeBossResumeDetailStrict(page, Date.now() + 10_000, { pace: false }),
        /remained visible after the close action/,
      );
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(iframe[src*="/web/frame/c-resume/"])').count(), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed when the detail API identity is missing or belongs to another candidate', () => {
    const candidate = {
      candidateId: 'boss-candidate-1',
      sourceText: 'data-expect=boss-candidate-1 data-jid=boss-candidate-1',
    };
    assert.equal(assertBossResumeTarget({ code: 0, zpData: { expectId: 'boss-candidate-1' } }, candidate), 'boss-candidate-1');
    assert.throws(
      () => assertBossResumeTarget({ code: 0, zpData: {} }, candidate),
      /detail API omitted expectId/,
    );
    assert.throws(
      () => assertBossResumeTarget({ code: 0, zpData: { expectId: 'other-candidate' } }, candidate),
      /does not match requested candidate boss-candidate-1/,
    );
  });

  it('parses quoted Boss card identity attributes when verifying detail targets', () => {
    const candidate = {
      candidateId: 'boss-candidate-quoted',
      sourceText: '<a data-expect="boss-candidate-quoted" data-jid=\'boss-candidate-quoted\'>',
    };
    assert.equal(
      assertBossResumeTarget({ code: 0, zpData: { expectId: 'boss-candidate-quoted' } }, candidate),
      'boss-candidate-quoted',
    );
  });
});
