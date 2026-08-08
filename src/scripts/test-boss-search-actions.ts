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
  readBossDirectSearchVerificationSummary,
  resetBossSearchFilters,
  restoreBossSearchFilterState,
  snapshotBossSearchFilterState,
} from '../platforms/boss/actions/filter-actions.js';
import {
  applyBossSearchKeyword,
  prepareBossSearchConditionPage,
} from '../platforms/boss/actions/search-actions.js';
import {
  openBossDirectSearch,
  openBossSubscribeSearch,
} from '../platforms/boss/actions/search-entry-actions.js';
import { extractBossCandidateList } from '../platforms/boss/actions/candidate-actions.js';
import {
  openBossResumeDetail,
  visitBossSeenCandidateDetail,
} from '../platforms/boss/actions/candidate-detail-actions.js';
import {
  buildBossSavedSearchReference,
  openBossSavedSubscriptionSearch,
  readBossSavedSubscriptions,
  saveBossSearchCondition,
} from '../platforms/boss/actions/subscription-actions.js';
import { fingerprintSavedSearchConditionIdentity } from '../platforms/boss/saved-search-identity.js';
import { parseBossSmokeKeyword } from './smoke-boss-search-flow.js';
import {
  assertBossResumeTarget,
  BossForwardPreConfirmationError,
  BossForwardUncertainError,
  closeExistingBossResumeDialog,
  closeBossResumeDetailStrict,
  forwardBossResumeAction,
  parseBossResumeDetail,
  readBossColleagueCommunicationFlag,
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
    (window as unknown as { __bossForwardConfirmClicks: number }).__bossForwardConfirmClicks = 0;
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
        (window as unknown as { __bossForwardConfirmClicks: number }).__bossForwardConfirmClicks += 1;
        share.style.display = 'none';
        if (fixtureMode === 'success') {
          const success = document.createElement('div');
          success.className = 'toast';
          success.innerHTML = '<div class="toast-con">转发成功</div>';
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

async function installNativeBossResumeFactory(page: Page, options: {
  communicationState?: 'present' | 'delayed-present' | 'stale-then-empty' | 'empty';
  communicationInitiallySelected?: boolean;
} = {}): Promise<void> {
  await page.evaluate((factoryOptions) => {
    const host = window as unknown as {
      __nativeResumeShareClicks: number;
      __nativeResumeReportClicks: number;
      __nativeResumeConfirmClicks: number;
      __nativeCommunicationTabClicks: number;
      __openNativeResume: (candidateId: string) => void;
    };
    host.__nativeResumeShareClicks = 0;
    host.__nativeResumeReportClicks = 0;
    host.__nativeResumeConfirmClicks = 0;
    host.__nativeCommunicationTabClicks = 0;
    host.__openNativeResume = (candidateId: string) => {
      const detail = document.createElement('div');
      detail.className = 'dialog-wrap active';
      detail.style.cssText = 'display:block;width:900px;height:638px';
      const communicationPanel = factoryOptions.communicationState
        ? `<div class="resume-right-side" style="display:block;width:260px;height:240px">
            <div class="chat-history-process" style="display:block;width:260px;height:220px">
              <div class="tab-hd" style="display:flex;width:240px;height:28px">
                <span class="item${factoryOptions.communicationInitiallySelected ? ' selected' : ''}"
                  style="display:block;width:80px;height:24px">同事沟通</span>
                <span class="item${factoryOptions.communicationInitiallySelected ? '' : ' selected'}"
                  style="display:block;width:80px;height:24px">我的沟通</span>
              </div>
              <ul class="record" style="display:block;width:240px;height:100px">
                ${factoryOptions.communicationState === 'present' || factoryOptions.communicationState === 'stale-then-empty'
                  ? '<li style="display:block;width:220px;height:40px"><p class="action" style="display:block;width:200px;height:20px">已有沟通记录</p></li>'
                  : ''}
              </ul>
            </div>
          </div>`
        : '';
      detail.innerHTML = `
        <div class="boss-dialog__wrapper dialog-lib-resume anonymous" style="display:block;width:900px;height:638px">
          <button type="button" class="boss-popup__close" style="display:block;width:20px;height:20px">关闭</button>
          <div class="lib-resume-anonymous lib-standard-resume with-footer">
            <div class="resume-layout-wrap">
              <div class="resume-detail-wrap" style="display:block;width:816px;height:500px">
                <div class="resume-section geek-base-info-wrap" style="display:block;width:816px;height:158px">
                  <div class="toolbar" style="display:flex;width:160px;height:24px">
                    <div class="interested" aria-label="收藏牛人" style="display:block;width:24px;height:20px"></div>
                    <div class="unsuitable" aria-label="不合适" style="display:block;width:24px;height:20px"></div>
                    <div class="report" aria-label="举报" style="display:block;width:24px;height:20px"></div>
                    <div class="share" aria-label="转发牛人" style="display:block;width:24px;height:20px"><i class="iboss-zhuanfa"></i></div>
                  </div>
                </div>
              </div>
              <div class="resume-footer-wrap" style="display:block;width:900px;height:59px">
                <button type="button" class="prop-card-chat">搜索畅聊卡(1/15)</button>
              </div>
              ${communicationPanel}
            </div>
          </div>
        </div>`;
      const resumeRoot = detail.querySelector<HTMLElement>('.resume-detail-wrap')! as HTMLElement & {
        __vue__?: unknown;
      };
      resumeRoot.__vue__ = {
        $options: { name: 'LibStandardResume' },
        $props: { resumeInfo: { expectId: candidateId, geekBaseInfo: {} } },
        $parent: {
          $options: { name: 'ResumeRoot' },
          $data: { loading: false, resumeInfo: { expectId: candidateId, geekBaseInfo: {} } },
        },
      };
      detail.querySelector('.boss-popup__close')?.addEventListener('click', () => detail.remove());
      detail.querySelector('.report')?.addEventListener('click', () => { host.__nativeResumeReportClicks += 1; });
      detail.querySelectorAll('.chat-history-process .tab-hd .item').forEach((tab) => {
        tab.addEventListener('click', () => {
          if ((tab.textContent ?? '').trim() === '同事沟通') host.__nativeCommunicationTabClicks += 1;
          detail.querySelectorAll('.chat-history-process .tab-hd .item')
            .forEach((item) => item.classList.toggle('selected', item === tab));
          if ((tab.textContent ?? '').trim() === '同事沟通'
            && factoryOptions.communicationState === 'delayed-present') {
            window.setTimeout(() => {
              const records = detail.querySelector('.chat-history-process ul.record');
              if (records) {
                records.innerHTML = '<li style="display:block;width:220px;height:40px"><p class="action" style="display:block;width:200px;height:20px">延迟沟通记录</p></li>';
              }
            }, 1_200);
          }
          if ((tab.textContent ?? '').trim() === '同事沟通'
            && factoryOptions.communicationState === 'stale-then-empty') {
            window.setTimeout(() => {
              const records = detail.querySelector('.chat-history-process ul.record');
              if (records) records.innerHTML = '';
            }, 600);
          }
        });
      });
      detail.querySelector('.share')?.addEventListener('click', () => {
        host.__nativeResumeShareClicks += 1;
        if (detail.querySelector('.c-share-box')) return;
        const forward = document.createElement('div');
        forward.className = 'c-share-box';
        forward.style.cssText = 'display:block;width:480px;height:240px';
        forward.innerHTML = `
          <div class="nav-list"><span class="item cur">邮件转发</span><span class="item">站内同事</span></div>
          <input placeholder="请输入收件人邮箱">
          <textarea placeholder="请输入留言"></textarea>
          <a ka="geek_coop_forward" style="display:block;width:80px;height:24px">转发</a>`;
        forward.querySelector('[ka="geek_coop_forward"]')?.addEventListener('click', () => { host.__nativeResumeConfirmClicks += 1; });
        detail.appendChild(forward);
      });
      document.body.appendChild(detail);
      // A parent-page resource can belong to a previous native detail. The
      // current Vue state, not this stale timing entry, is authoritative.
      void fetch('/wapi/zpitem/web/boss/search/geek/info?expectId=stale-native-resource');
    };
  }, options);
}

describe('Boss normal-search actions', () => {
  it('keeps omitted Boss smoke keywords read-only and requires explicit keywords to be non-empty', () => {
    assert.equal(parseBossSmokeKeyword([]), undefined);
    assert.equal(parseBossSmokeKeyword(['--keyword', '  测试关键词  ']), '测试关键词');
    assert.throws(
      () => parseBossSmokeKeyword(['--keyword', '  ']),
      /omit it to inspect the current visible result list without submitting a search/i,
    );
  });

  it('canonicalizes saved condition identity independently of field order and keeps viewed in the fingerprint', () => {
    const identity = {
      jobScope: '全铝箱包设计',
      city: '广东',
      cityOptions: ['深圳', '广州'],
      inline: { education: ['本科及以上', '大专'] },
      more: { salary: '10-20K' },
      toggles: { filter_recent_viewed: false },
    };
    const reordered = {
      jobScope: '全铝箱包设计',
      city: '广东',
      cityOptions: ['广州', '深圳'],
      inline: { education: ['大专', '本科及以上'] },
      more: { salary: '10-20K' },
      toggles: { filter_recent_viewed: false },
    };
    assert.equal(fingerprintSavedSearchConditionIdentity(identity), fingerprintSavedSearchConditionIdentity(reordered));
    assert.notEqual(
      fingerprintSavedSearchConditionIdentity(identity),
      fingerprintSavedSearchConditionIdentity({ ...identity, toggles: { filter_recent_viewed: true } }),
    );
  });

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

  it('reads and strictly closes a hydrated parent-DOM Boss resume without treating its chat-card footer as a purchase dialog', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="boss-candidate-1" href="#resume" onclick="parent.__openNativeResume(\'boss-candidate-1\'); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人甲</div></a></div>'),
    });
    try {
      await installNativeBossResumeFactory(page);
      const { candidates } = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.equal(candidates.length, 1);
      const deadline = Date.now() + 10_000;
      await openBossResumeDetail(page.context(), page, candidates[0]!, { deadline });
      const resume = await parseBossResumeDetail(page, candidates[0]!, { deadline });
      assert.equal(resume.candidateId, 'boss-candidate-1');
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(.dialog-lib-resume .resume-detail-wrap)').count(), 1);
      await closeBossResumeDetailStrict(page, deadline, { pace: false });
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(.resume-detail-wrap)').count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('detects a colleague communication record on the verified open Boss detail', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page, {
        communicationState: 'delayed-present',
        communicationInitiallySelected: false,
      });
      await page.evaluate(() => (window as unknown as { __openNativeResume: (candidateId: string) => void })
        .__openNativeResume('boss-candidate-1'));

      const result = await readBossColleagueCommunicationFlag(
        page,
        { candidateId: 'boss-candidate-1' },
        { deadline: Date.now() + 10_000 },
      );

      assert.deepEqual(result, { hasColleagueCommunication: true });
      assert.equal(await page.evaluate(() =>
        (window as unknown as { __nativeCommunicationTabClicks: number }).__nativeCommunicationTabClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('returns false only after the selected colleague communication list is stably empty', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page, {
        communicationState: 'empty',
        communicationInitiallySelected: true,
      });
      await page.evaluate(() => (window as unknown as { __openNativeResume: (candidateId: string) => void })
        .__openNativeResume('boss-candidate-1'));

      const result = await readBossColleagueCommunicationFlag(
        page,
        { candidateId: 'boss-candidate-1' },
        { deadline: Date.now() + 10_000 },
      );

      assert.deepEqual(result, { hasColleagueCommunication: false });
      assert.equal(await page.evaluate(() =>
        (window as unknown as { __nativeCommunicationTabClicks: number }).__nativeCommunicationTabClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('does not treat stale rows retained during colleague-tab hydration as a communication record', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page, {
        communicationState: 'stale-then-empty',
        communicationInitiallySelected: false,
      });
      await page.evaluate(() => (window as unknown as { __openNativeResume: (candidateId: string) => void })
        .__openNativeResume('boss-candidate-1'));

      const result = await readBossColleagueCommunicationFlag(
        page,
        { candidateId: 'boss-candidate-1' },
        { deadline: Date.now() + 10_000 },
      );

      assert.deepEqual(result, { hasColleagueCommunication: false });
      assert.equal(await page.evaluate(() =>
        (window as unknown as { __nativeCommunicationTabClicks: number }).__nativeCommunicationTabClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed when the open detail exposes more than one colleague communication panel', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page, {
        communicationState: 'present',
        communicationInitiallySelected: true,
      });
      await page.evaluate(() => {
        (window as unknown as { __openNativeResume: (candidateId: string) => void })
          .__openNativeResume('boss-candidate-1');
        const panel = document.querySelector('.resume-right-side');
        panel?.parentElement?.appendChild(panel.cloneNode(true));
      });

      await assert.rejects(() => readBossColleagueCommunicationFlag(
        page,
        { candidateId: 'boss-candidate-1' },
        { deadline: Date.now() + 10_000 },
      ), /Expected one Boss colleague communication panel, found 2/);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed when the detail identity changes while communication records hydrate', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page, {
        communicationState: 'delayed-present',
        communicationInitiallySelected: false,
      });
      await page.evaluate(() => {
        (window as unknown as { __openNativeResume: (candidateId: string) => void })
          .__openNativeResume('boss-candidate-1');
        const tab = [...document.querySelectorAll('.chat-history-process .tab-hd .item')]
          .find((element) => (element.textContent ?? '').trim() === '同事沟通');
        tab?.addEventListener('click', () => {
          const resumeRoot = document.querySelector<HTMLElement>('.resume-detail-wrap') as HTMLElement & {
            __vue__?: {
              $props?: { resumeInfo?: { expectId?: string } };
              $parent?: { $data?: { resumeInfo?: { expectId?: string } } };
            };
          };
          if (resumeRoot.__vue__?.$props?.resumeInfo) {
            resumeRoot.__vue__.$props.resumeInfo.expectId = 'different-candidate';
          }
          if (resumeRoot.__vue__?.$parent?.$data?.resumeInfo) {
            resumeRoot.__vue__.$parent.$data.resumeInfo.expectId = 'different-candidate';
          }
        });
      });

      await assert.rejects(() => readBossColleagueCommunicationFlag(
        page,
        { candidateId: 'boss-candidate-1' },
        { deadline: Date.now() + 10_000 },
      ), /does not match requested candidate boss-candidate-1/);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('opens the unique rightmost native share action and adds the simple colleague-communication email note', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page);
      await page.evaluate(() => (window as unknown as { __openNativeResume: (candidateId: string) => void })
        .__openNativeResume('boss-candidate-1'));
      await forwardBossResumeAction(page, {
        candidateId: 'boss-candidate-1',
        mode: 'email',
        recipient: 'recipient@example.com',
        actionMode: 'prepare-only',
        hasColleagueCommunication: true,
        deadline: Date.now() + 10_000,
      });
      const evidence = await page.evaluate(() => ({
        shareClicks: (window as unknown as { __nativeResumeShareClicks: number }).__nativeResumeShareClicks,
        reportClicks: (window as unknown as { __nativeResumeReportClicks: number }).__nativeResumeReportClicks,
        confirmClicks: (window as unknown as { __nativeResumeConfirmClicks: number }).__nativeResumeConfirmClicks,
      }));
      assert.deepEqual(evidence, { shareClicks: 1, reportClicks: 0, confirmClicks: 0 });
      assert.equal(await page.locator('.c-share-box input[placeholder="请输入收件人邮箱"]').inputValue(), 'recipient@example.com');
      assert.equal(
        await page.locator('.c-share-box textarea[placeholder="请输入留言"]').inputValue(),
        'boss-candidate-1\n同事已沟通',
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails before dispatch when the native share action is no longer the rightmost toolbar control', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page);
      await page.evaluate(() => {
        (window as unknown as { __openNativeResume: (candidateId: string) => void })
          .__openNativeResume('boss-candidate-1');
        const toolbar = document.querySelector('.geek-base-info-wrap .toolbar');
        const share = toolbar?.querySelector('.share');
        const report = toolbar?.querySelector('.report');
        if (toolbar && share && report) toolbar.insertBefore(share, report);
      });
      await assert.rejects(() => forwardBossResumeAction(page, {
        candidateId: 'boss-candidate-1',
        mode: 'email',
        recipient: 'recipient@example.com',
        actionMode: 'prepare-only',
        deadline: Date.now() + 10_000,
      }), /not the rightmost item/);
      assert.equal(await page.evaluate(() =>
        (window as unknown as { __nativeResumeShareClicks: number }).__nativeResumeShareClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails before dispatch when the native toolbar exposes duplicate share actions', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page);
      await page.evaluate(() => {
        (window as unknown as { __openNativeResume: (candidateId: string) => void })
          .__openNativeResume('boss-candidate-1');
        const toolbar = document.querySelector('.geek-base-info-wrap .toolbar');
        const share = toolbar?.querySelector('.share');
        if (toolbar && share) toolbar.appendChild(share.cloneNode(true));
      });
      await assert.rejects(() => forwardBossResumeAction(page, {
        candidateId: 'boss-candidate-1',
        mode: 'email',
        recipient: 'recipient@example.com',
        actionMode: 'prepare-only',
        deadline: Date.now() + 10_000,
      }), /Expected one visible Boss resume forward action, found 2/);
      assert.equal(await page.evaluate(() =>
        (window as unknown as { __nativeResumeShareClicks: number }).__nativeResumeShareClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
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

  it('accepts the current Boss legacy toast container as forwarding success evidence', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installForwardReceiptFixture(page, 'success');
      await forwardBossResumeAction(page, {
        candidateId: 'candidate-legacy-toast-success',
        mode: 'email',
        recipient: 'primary@example.com',
        actionMode: 'confirm',
        deadline: Date.now() + 3_000,
      });
      assert.equal(await page.locator('.toast-con').filter({ hasText: '转发成功' }).count(), 1);
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
          deadline: Date.now() + 3_000,
        }),
        (error: unknown) => error instanceof BossForwardUncertainError
          && /success evidence|completion is uncertain/.test(error.message),
      );
      assert.equal(await page.evaluate(() => (
        window as unknown as { __bossForwardConfirmClicks: number }
      ).__bossForwardConfirmClicks), 1);
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

  it('rejects an explicit empty saved-search keyword before page mutation or final submit', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const cases = ['', '  \n  '];
    try {
      for (const target of cases) {
        const fixture = await createSearchFixture({ body: searchBody('<div class="geek-info-card">candidate card</div>') });
        try {
          const frame = fixture.page.frame({ name: 'searchFrame' });
          assert.ok(frame);
          await frame.locator('.search-input').fill('历史关键词');

          await assert.rejects(
            () => openBossSubscribeSearch(fixture.page, target, { deadline: Date.now() + 5_000 }),
            /requires a non-empty keyword/i,
          );

          assert.equal(await frame.locator('.search-input').inputValue(), '历史关键词');
          assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchEnterPresses), 0);
          assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
        } finally {
          await fixture.browser.close();
        }
      }
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
    }
  });

  it('rejects an explicit empty direct-search keyword before page mutation or final submit', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);

      await assert.rejects(
        () => applyBossDirectSearch(page, '', [], { deadline: Date.now() + 5_000 }),
        /requires a non-empty keyword/i,
      );

      assert.equal(await frame.locator('.search-input').inputValue(), '测试关键词');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('restores an explicit empty keyword without submitting a search', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="void 0">清空筛选</span>
        <div class="search-job-list-C"><div class="ui-dropmenu-list"><ul><li class="active">不限职位</li></ul></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div>
        <div class="experience-select"><span class="exp-item active">不限</span></div>
        <div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container"></div>
        <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox">过滤近14天查看</label>
        <label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label>
        <div class="geek-info-card">candidate card</div>`),
    });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-input').fill('');
      const emptyState = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      assert.equal(emptyState.jobScopeIndex, 0);
      await frame.locator('.search-input').fill('历史关键词');

      await restoreBossSearchFilterState(page, emptyState, Date.now() + 5_000);

      assert.equal(await frame.locator('.search-input').inputValue(), '');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies an explicit empty keyword in the non-submitting exact-state action', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: searchBody('<div class="geek-info-card">candidate card</div>') });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-input').fill('历史关键词');

      await applyBossSearchKeyword(page, '', Date.now() + 5_000);

      assert.equal(await frame.locator('.search-input').inputValue(), '');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails before final submit when an explicit empty keyword cannot be retained', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`<div class="geek-info-card">candidate card</div><script>
      const guardedKeyword = document.querySelector('.search-input');
      guardedKeyword.addEventListener('input', () => {
        if (!guardedKeyword.value) guardedKeyword.value = '页面恢复值';
      });
    </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await assert.rejects(
        () => applyBossSearchKeyword(page, '', Date.now() + 5_000),
        /could not be cleared before simulated typing/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
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

  it('waits for the live Boss subscription region to hydrate and reads native Vue card identity', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div id="subscription-region-mount"></div>
      <script>
        setTimeout(() => {
          const mount = document.querySelector('#subscription-region-mount');
          if (!mount) return;
          mount.innerHTML = '<div class="subscribe-card-right"><div ka="search_change_subscribe_card" class="subscribe-card" style="display:block;width:320px;height:100px"><span class="title-text">铝镁合金</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">广东</span><span class="info-labels-item">大专-博士</span><span class="info-labels-item">35岁-46岁</span><span class="info-labels-item">牛人期望此职位</span><span class="info-labels-item">近14天没有看过</span></div></div>';
          const card = mount.querySelector('[ka="search_change_subscribe_card"]');
          card.__vue__ = { $props: { info: {
            encryptId: 'native-subscription-1',
            encryptJobId: 'native-job-1',
            jobName: '全铝箱包设计',
            subName: '铝镁合金',
            conditions: { keywords: '铝镁合金 拉杆箱' },
            searchLabelEntries: [
              { key: 'keywords', label: '铝镁合金 拉杆箱' },
              { key: 'city', label: '广东' },
              { key: 'degree', label: '大专-博士' },
              { key: 'age', label: '35岁-46岁' },
              { key: 'geekJobRequirements', label: '牛人期望此职位' },
              { key: 'viewResume', label: '近14天没有看过' },
            ],
          } } };
        }, 800);
      </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const cards = await readBossSavedSubscriptions(page, { deadline: Date.now() + 5_000 });
      assert.deepEqual(cards.map((card) => ({
        name: card.name,
        keyword: card.expectedKeyword,
        nativeId: card.nativeId,
        nativeJobId: card.nativeJobId,
        jobScope: card.expectedJobScope,
      })), [{
        name: '铝镁合金',
        keyword: '铝镁合金 拉杆箱',
        nativeId: 'native-subscription-1',
        nativeJobId: 'native-job-1',
        jobScope: '全铝箱包设计',
      }]);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('matches the live Boss card evidence and waits for complete range hydration before one final submit', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"></ul></div>
      <div class="degree-ui">
        <span class="degree-item">不限</span><span class="degree-select-custom-label">自定义</span>
        <div class="degree-select-custom-slider"><div class="ui-slider ui-slider-range"><input type="hidden" value="4,7"></div></div>
        <div class="degree-select-custom-content">大专-博士</div>
      </div>
      <div class="school-ui"><span class="degree-item active">不限</span></div>
      <div class="experience-select"><span class="exp-item active">不限</span></div>
      <div class="age-select">
        <span class="age-item">不限</span><span class="custom">自定义</span>
        <div class="age-custom" style="display:block;width:220px;height:32px">
          <div class="dropdown-wrap"><input type="text" class="ipt" value="35岁"><input type="hidden" value="35"></div>
          <div class="dropdown-wrap"><input type="text" class="ipt" value="46岁"><input type="hidden" value="46"></div>
        </div>
      </div>
      <div class="more-filter-container">
        <div class="filter-2-item"></div><div class="filter-2-item"></div><div class="filter-2-item"></div>
        <div class="filter-2-item"></div><div class="filter-2-item"></div>
        <div class="filter-2-item"><span class="defalut-select">牛人期望此职位</span></div>
      </div>
      <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox" checked>过滤近14天查看</label>
      <label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" class="subscribe-card" style="display:block;width:320px;height:120px">
          <span class="title-text">铝镁合金</span><span class="keywords-text">铝镁合金 拉杆箱</span>
          <span class="info-labels-item">广东</span><span class="info-labels-item">大专-博士</span>
          <span class="info-labels-item">35岁-46岁</span><span class="info-labels-item">牛人期望此职位</span>
          <span class="info-labels-item">近14天没有看过</span>
        </div>
      </div>
      <div class="sort-controls"><span class="search-label active">综合排序</span><span class="search-label">匹配度优先</span></div>
      <script>
        const card = document.querySelector('[ka="search_change_subscribe_card"]');
        card.__vue__ = { $props: { info: {
          encryptId: 'native-live-subscription', encryptJobId: 'native-live-job', jobName: '全铝箱包设计', subName: '铝镁合金',
          conditions: { keywords: '铝镁合金 拉杆箱' },
          searchLabelEntries: [
            { key: 'keywords', label: '铝镁合金 拉杆箱' }, { key: 'city', label: '广东' },
            { key: 'degree', label: '大专-博士' }, { key: 'age', label: '35岁-46岁' },
            { key: 'geekJobRequirements', label: '牛人期望此职位' }, { key: 'viewResume', label: '近14天没有看过' },
          ],
        } } };
        window.__subscriptionClicks = 0;
        card.addEventListener('click', () => {
          window.__subscriptionClicks += 1;
          setTimeout(() => {
            document.querySelector('.search-current-job').textContent = '全铝箱包设计';
            document.querySelector('.search-input').value = '铝镁合金 拉杆箱';
            document.querySelector('.city-wrap .city').textContent = '广东';
            document.querySelector('[ka="search_change_view_resume"] input').checked = true;
          }, 20);
          setTimeout(() => {
            const degreeSlider = document.querySelector('.degree-ui .ui-slider');
            degreeSlider.classList.remove('custom-slider-disabled');
            degreeSlider.querySelector('input[type="hidden"]').value = '4,7';
            document.querySelector('.degree-select-custom-content').textContent = '大专-博士';
            const ageCustom = document.querySelector('.age-custom');
            ageCustom.style.display = 'block';
            ageCustom.querySelectorAll('input[type="hidden"]')[0].value = '35';
            ageCustom.querySelectorAll('input[type="hidden"]')[1].value = '46';
            document.querySelectorAll('.age-custom input.ipt')[0].value = '35岁';
            document.querySelectorAll('.age-custom input.ipt')[1].value = '46岁';
            document.querySelector('.more-filter-container .filter-2-item:nth-child(6) .defalut-select').textContent = '牛人期望此职位';
          }, 100);
        });
        document.querySelectorAll('.search-label').forEach((label) => label.addEventListener('click', () => {
          document.querySelectorAll('.search-label').forEach((item) => item.classList.remove('active'));
          label.classList.add('active');
        }));
      </script><div class="geek-info-card">candidate card</div>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      const hydratedState = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      assert.deepEqual(hydratedState.inline.education, ['custom:大专-博士']);
      assert.deepEqual(hydratedState.inline.age, ['custom:35-46']);
      const cards = await readBossSavedSubscriptions(page, { deadline: Date.now() + 5_000 });
      const target = buildBossSavedSearchReference('铝镁合金', hydratedState, cards[0]?.nativeId);

      await frame.evaluate(() => {
        document.querySelector<HTMLElement>('.search-current-job')!.textContent = '不限职位';
        (document.querySelector<HTMLInputElement>('.search-input')!).value = '';
        document.querySelector<HTMLElement>('.city-wrap .city')!.textContent = '全国';
        const degreeSlider = document.querySelector<HTMLElement>('.degree-ui .ui-slider')!;
        degreeSlider.classList.add('custom-slider-disabled');
        degreeSlider.querySelector<HTMLInputElement>('input[type="hidden"]')!.value = '1,1';
        document.querySelector<HTMLElement>('.degree-select-custom-content')!.textContent = '';
        const ageCustom = document.querySelector<HTMLElement>('.age-custom')!;
        ageCustom.style.display = 'none';
        ageCustom.querySelectorAll<HTMLInputElement>('input[type="hidden"]').forEach((input) => { input.value = ''; });
        document.querySelector<HTMLInputElement>('[ka="search_change_view_resume"] input')!.checked = false;
        document.querySelector<HTMLElement>('.more-filter-container .filter-2-item:nth-child(6) .defalut-select')!.textContent = '';
      });

      await openBossSavedSubscriptionSearch(page, target, { deadline: Date.now() + 5_000, sortPolicy: 'match-priority' });
      const finalState = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      assert.deepEqual(finalState.inline.education, ['custom:大专-博士']);
      assert.deepEqual(finalState.inline.age, ['custom:35-46']);
      assert.equal(finalState.more.牛人职位要求, '牛人期望此职位');
      assert.equal(await frame.locator('.search-label.active').innerText(), '匹配度优先');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__subscriptionClicks), 1);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects a unique native subscription by complete identity, hydrates it, sorts, and submits once', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"><li><span class="city-checkbox status1">广东</span></li></ul></div>
      <div class="degree-ui"><label class="degree-item"><input type="checkbox" checked><span>本科及以上</span></label></div>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" data-subscribe-id="subscription-1" style="display:block;width:320px;height:100px">
          <span class="title-text">铝镁合金</span>
          <span class="keywords-text">铝镁合金 拉杆箱</span>
          <span class="info-labels-item">全铝箱包设计 广东 本科及以上</span>
        </div>
      </div>
      <div class="sort-controls"><span class="search-label active">综合排序</span><span class="search-label">匹配度优先</span></div>
      <script>
        const subscriptionCard = document.querySelector('[ka="search_change_subscribe_card"]');
        subscriptionCard?.addEventListener('click', () => {
          document.querySelector('.search-current-job').textContent = '全铝箱包设计';
          document.querySelector('.search-input').value = '铝镁合金 拉杆箱';
        });
        document.querySelectorAll('.search-label').forEach((label) => label.addEventListener('click', () => {
          document.querySelectorAll('.search-label').forEach((item) => item.classList.remove('active'));
          label.classList.add('active');
        }));
      </script><div class="geek-info-card">candidate card</div>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      const state = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      const target = buildBossSavedSearchReference('铝镁合金', state, 'subscription-1');
      const cards = await readBossSavedSubscriptions(page, { deadline: Date.now() + 5_000 });
      assert.deepEqual(cards.map((card) => ({ name: card.name, keyword: card.expectedKeyword, nativeId: card.nativeId })), [
        { name: '铝镁合金', keyword: '铝镁合金 拉杆箱', nativeId: 'subscription-1' },
      ]);
      await openBossSavedSubscriptionSearch(page, target, { deadline: Date.now() + 5_000, sortPolicy: 'match-priority' });
      assert.equal(await frame.locator('.search-current-job').innerText(), '全铝箱包设计');
      assert.equal(await frame.locator('.search-label.active').innerText(), '匹配度优先');
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('rechecks match-priority after the viewed override and fails before final submit when it was reset', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <label class="high_search_checkbox" ka="search_change_view_resume" style="display:block;width:200px;height:24px"><input type="checkbox">过滤近14天查看</label>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" data-subscribe-id="subscription-sort-reset" style="display:block;width:320px;height:100px">
          <span class="title-text">铝镁合金</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">全铝箱包设计</span>
        </div>
      </div>
      <div class="sort-controls"><span class="search-label active">综合排序</span><span class="search-label">匹配度优先</span></div>
      <script>
        const viewed = document.querySelector('[ka="search_change_view_resume"] input');
        document.querySelector('[ka="search_change_subscribe_card"]')?.addEventListener('click', () => {
          document.querySelector('.search-current-job').textContent = '全铝箱包设计';
          document.querySelector('.search-input').value = '铝镁合金 拉杆箱';
        });
        document.querySelectorAll('.search-label').forEach((label) => label.addEventListener('click', () => {
          document.querySelectorAll('.search-label').forEach((item) => item.classList.remove('active'));
          label.classList.add('active');
        }));
        viewed?.addEventListener('change', () => {
          const epoch = document.querySelector('#boss-search-submit-epoch');
          epoch?.setAttribute('data-boss-search-result-version', String(Number(epoch.getAttribute('data-boss-search-result-version') || '0') + 1));
          document.querySelectorAll('.search-label').forEach((item) => item.classList.toggle('active', item.textContent.trim() === '综合排序'));
        });
      </script><div class="geek-info-card">candidate card</div>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      const state = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      const target = buildBossSavedSearchReference('铝镁合金', state, 'subscription-sort-reset');
      await assert.rejects(
        () => openBossSavedSubscriptionSearch(page, target, {
          deadline: Date.now() + 5_000,
          includeViewedCandidates: false,
          sortPolicy: 'match-priority',
        }),
        /sort-postcondition-failed/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('rejects a saved search when final submit resets the requested viewed policy', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <label class="high_search_checkbox" ka="search_change_view_resume" style="display:block;width:200px;height:24px"><input type="checkbox">过滤近14天查看</label>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" data-subscribe-id="subscription-viewed-reset" style="display:block;width:320px;height:100px">
          <span class="title-text">铝镁合金</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">全铝箱包设计</span>
        </div>
      </div>
      <div class="sort-controls"><span class="search-label active">综合排序</span><span class="search-label">匹配度优先</span></div>
      <script>
        const viewed = document.querySelector('[ka="search_change_view_resume"] input');
        document.querySelector('[ka="search_change_subscribe_card"]')?.addEventListener('click', () => {
          document.querySelector('.search-current-job').textContent = '全铝箱包设计';
          document.querySelector('.search-input').value = '铝镁合金 拉杆箱';
        });
        document.querySelectorAll('.search-label').forEach((label) => label.addEventListener('click', () => {
          document.querySelectorAll('.search-label').forEach((item) => item.classList.remove('active'));
          label.classList.add('active');
        }));
        viewed?.addEventListener('change', () => {
          const epoch = document.querySelector('#boss-search-submit-epoch');
          epoch?.setAttribute('data-boss-search-result-version', String(Number(epoch.getAttribute('data-boss-search-result-version') || '0') + 1));
        });
        document.querySelector('.search-btn')?.addEventListener('click', () => { viewed.checked = false; });
      </script><div class="geek-info-card">candidate card</div>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      const state = await snapshotBossSearchFilterState(page, Date.now() + 5_000);
      const target = buildBossSavedSearchReference('铝镁合金', state, 'subscription-viewed-reset');
      await assert.rejects(
        () => openBossSavedSubscriptionSearch(page, target, {
          deadline: Date.now() + 5_000,
          includeViewedCandidates: false,
          sortPolicy: 'match-priority',
        }),
        /viewed-policy-failed/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__bossSearchClicks), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('never renames a pre-existing same-keyword card when a new save card is unproven', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"><li><span class="city-checkbox status1">广东</span></li></ul></div>
      <div class="degree-ui"><label class="degree-item"><input type="checkbox" checked><span>本科及以上</span></label></div>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" data-subscribe-id="old-card" style="display:block;width:320px;height:100px">
          <span class="title-text">旧订阅</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">全铝箱包设计 浙江</span>
          <button class="edit-btn" type="button">编辑</button>
        </div>
        <button ka="search_subscribe_card" type="button" style="display:block;width:100px;height:30px">订阅</button>
      </div>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      await assert.rejects(
        () => saveBossSearchCondition(page, '铝镁合金', { deadline: Date.now() + 5_000 }),
        /save-new-card-unproven/i,
      );
      assert.equal(await frame.locator('.title-text').innerText(), '旧订阅');
      assert.equal(await frame.locator('.edit-btn').count(), 1);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('never treats another keyword with the same visible filters as the current saved condition', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"><li><span class="city-checkbox status1">广东</span></li></ul></div>
      <div class="degree-ui"><label class="degree-item"><input type="checkbox" checked><span>本科及以上</span></label></div>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" data-subscribe-id="other-keyword" style="display:block;width:320px;height:100px">
          <span class="title-text">其他订阅</span><span class="keywords-text">铝门窗</span><span class="info-labels-item">全铝箱包设计 广东 本科及以上</span>
          <button class="edit-btn" type="button" onclick="window.__editClicks += 1">编辑</button>
        </div>
        <button ka="search_subscribe_card" type="button" style="display:block;width:100px;height:30px">订阅</button>
      </div><script>window.__editClicks = 0;</script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      await assert.rejects(() => saveBossSearchCondition(page, '铝镁合金', { deadline: Date.now() + 1_500 }));
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__editClicks), 0);
      assert.equal(await frame.locator('.title-text').innerText(), '其他订阅');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('does not classify a rehydrated pre-existing no-ID card as the card created by this save click', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"><li><span class="city-checkbox status1">广东</span></li></ul></div>
      <div class="degree-ui"><label class="degree-item"><input type="checkbox" checked><span>本科及以上</span></label></div>
      <div class="subscribe-card-right">
        <div ka="search_change_subscribe_card" style="display:block;width:320px;height:100px">
          <span class="title-text">旧订阅</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">全铝箱包设计 浙江</span>
          <button class="edit-btn" type="button">编辑</button>
        </div>
        <button ka="search_subscribe_card" type="button" style="display:block;width:100px;height:30px">订阅</button>
      </div>
      <script>
        window.__editClicks = 0;
        document.querySelector('[ka="search_subscribe_card"]')?.addEventListener('click', () => {
          document.querySelector('.info-labels-item').textContent = '全铝箱包设计 广东 本科及以上';
        });
        document.querySelector('.edit-btn')?.addEventListener('click', () => { window.__editClicks += 1; });
      </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      await assert.rejects(
        () => saveBossSearchCondition(page, '铝镁合金', { deadline: Date.now() + 5_000 }),
        /save-new-card-unproven/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__editClicks), 0);
      assert.equal(await frame.locator('.title-text').innerText(), '旧订阅');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('revalidates the complete current condition after pointer movement and before save dispatch', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="subscribe-card-right"><button ka="search_subscribe_card" type="button" style="display:block;width:100px;height:30px">订阅</button></div>
      <script>
        window.__createClicks = 0;
        document.addEventListener('mousemove', () => { document.querySelector('.search-input').value = '漂移后的关键词'; }, { once: true });
        document.querySelector('[ka="search_subscribe_card"]')?.addEventListener('click', () => { window.__createClicks += 1; });
      </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      await assert.rejects(
        () => saveBossSearchCondition(page, '铝镁合金', { deadline: Date.now() + 1_500 }),
        /condition changed before dispatch/i,
      );
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__createClicks), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('proves a newly created native card before renaming it and returns renamed evidence', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const body = searchBody(`
      <div class="city-wrap"><div class="city">广东</div><div class="city-box" style="display:none;width:200px;height:40px"></div><ul class="dropdown-province"><li><span class="city-checkbox status1">广东</span></li></ul></div>
      <div class="degree-ui"><label class="degree-item"><input type="checkbox" checked><span>本科及以上</span></label></div>
      <div class="subscribe-card-right">
        <button ka="search_subscribe_card" type="button" style="display:block;width:100px;height:30px">订阅</button>
      </div>
      <script>
        document.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (target.matches('[ka="search_subscribe_card"]')) {
            document.querySelector('.subscribe-card-right')?.insertAdjacentHTML('afterbegin', '<div ka="search_change_subscribe_card" data-subscribe-id="new-card" style="display:block;width:320px;height:100px"><span class="title-text">系统订阅</span><span class="keywords-text">铝镁合金 拉杆箱</span><span class="info-labels-item">全铝箱包设计 广东 本科及以上</span><button class="edit-btn" type="button">编辑</button></div>');
          }
          if (target.matches('.edit-btn')) {
            parent.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap active"><input value="系统订阅"><button type="button">确定</button></div>');
            const dialog = parent.document.querySelector('.dialog-wrap.active');
            const input = dialog?.querySelector('input');
            dialog?.querySelector('button')?.addEventListener('click', () => {
              const card = document.querySelector('[data-subscribe-id="new-card"] .title-text');
              if (card && input) card.textContent = input.value;
              dialog?.remove();
            });
          }
        });
      </script>`);
    const { browser, page } = await createSearchFixture({ body });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      await frame.locator('.search-current-job').evaluate((element) => { element.textContent = '全铝箱包设计'; });
      await frame.locator('.search-input').fill('铝镁合金 拉杆箱');
      const result = await saveBossSearchCondition(page, '铝镁合金', { deadline: Date.now() + 5_000 });
      assert.equal(result.outcome, 'renamed');
      assert.equal(result.savedSearch.name, '铝镁合金');
      assert.equal(result.savedSearch.nativeId, 'new-card');
      assert.equal(result.savedSearch.expectedKeyword, '铝镁合金 拉杆箱');
      assert.match(result.savedSearch.conditionFingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(await frame.locator('[data-subscribe-id="new-card"] .title-text').innerText(), '铝镁合金');
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

  it('closes a visible forwarding overlay before closing the resume detail', async () => {
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
        detail.innerHTML = '<button class="boss-popup__close" style="display:block;width:24px;height:24px"></button><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe><div class="c-share-box" style="display:block;width:320px;height:180px">转发</div>';
        detail.querySelector('.boss-popup__close')?.addEventListener('click', () => {
          detail.style.display = 'none';
        });
        document.body.appendChild(detail);
      });
      await closeBossResumeDetailStrict(page, Date.now() + 10_000, { pace: false });
      assert.equal(await page.locator('.dialog-wrap.active:visible:has(iframe[src*="/web/frame/c-resume/"])').count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('dismisses the native no-close forwarding dialog through its proven layer without using Escape', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      await installNativeBossResumeFactory(page);
      await page.evaluate(() => {
        const host = window as unknown as {
          __openNativeResume: (candidateId: string) => void;
          __nativeForwardLayerClicks: number;
          __nativeForwardEscapePresses: number;
        };
        host.__openNativeResume('boss-candidate-1');
        host.__nativeForwardLayerClicks = 0;
        host.__nativeForwardEscapePresses = 0;
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') host.__nativeForwardEscapePresses += 1;
        });
        const forward = document.createElement('div');
        forward.className = 'dialog-wrap active';
        forward.dataset.type = 'boss-dialog';
        forward.style.cssText = 'display:block;position:fixed;inset:0;width:100vw;height:100vh';
        forward.innerHTML = `
          <div class="boss-popup__wrapper boss-dialog boss-dialog__wrapper dialog-default-v2 c-share-box"
            style="display:block;position:fixed;left:300px;top:100px;width:500px;height:300px;z-index:2"></div>
          <div class="boss-layer__wrapper"
            style="display:block;position:fixed;inset:0;width:100vw;height:100vh;z-index:1"></div>`;
        forward.querySelector('.boss-layer__wrapper')?.addEventListener('click', () => {
          host.__nativeForwardLayerClicks += 1;
          forward.remove();
        });
        document.body.appendChild(forward);
      });
      await closeExistingBossResumeDialog(page, Date.now() + 10_000, {
        pace: false,
        allowEscapeFallback: true,
      });
      const evidence = await page.evaluate(() => ({
        layerClicks: (window as unknown as { __nativeForwardLayerClicks: number }).__nativeForwardLayerClicks,
        escapePresses: (window as unknown as { __nativeForwardEscapePresses: number }).__nativeForwardEscapePresses,
      }));
      assert.deepEqual(evidence, { layerClicks: 1, escapePresses: 0 });
      assert.equal(await page.locator('.dialog-wrap.active:visible').count(), 0);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails closed when the detail payload identity is missing or belongs to another candidate', () => {
    const candidate = {
      candidateId: 'boss-candidate-1',
      sourceText: 'data-expect=boss-candidate-1 data-jid=boss-candidate-1',
    };
    assert.equal(assertBossResumeTarget({ code: 0, zpData: { expectId: 'boss-candidate-1' } }, candidate), 'boss-candidate-1');
    assert.throws(
      () => assertBossResumeTarget({ code: 0, zpData: {} }, candidate),
      /detail payload omitted expectId/,
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
