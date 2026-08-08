import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Page } from 'playwright';
import { config } from '../config.js';
import { fiftyOneJobAdapter } from '../platforms/51job-adapter.js';
import {
  advance51jobToNextCandidateBatch,
  extract51jobCandidateList,
  read51jobCurrentCandidateBatch,
} from '../platforms/51job/actions/candidate-actions.js';
import {
  apply51jobViewedCandidatePolicy,
  collectStable51jobCandidateList,
  submit51jobDirectSearch,
} from '../platforms/51job/actions/result-actions.js';
import {
  click51jobControlWithDomEvents,
  create51jobActionContext,
  remaining51jobActionMs,
  with51jobActionPage,
} from '../platforms/51job/actions/context.js';
import {
  apply51jobSearchCondition,
  discover51jobSearchFilters,
} from '../platforms/51job/actions/filter-actions.js';
import {
  assert51jobAuthenticated,
  fiftyOneJobLoginUrl,
  fiftyOneJobSubscribeSearchUrl,
  open51jobAuthenticatedHome,
  open51jobLoginPage,
} from '../platforms/51job/actions/navigation-actions.js';
import {
  estimate51jobSearchTimeoutMs,
  openPageLevelSearchRef,
  open51jobDirectSearch,
  open51jobSubscribeSearch,
  prepare51jobSearchCondition,
  read51jobSearchConditionResultTotal,
  savePrepared51jobSearchCondition,
} from '../platforms/51job/actions/search-actions.js';
import {
  open51jobResumeDetail,
  parse51jobResumeDetail,
  read51jobCandidateProfileDetail,
} from '../platforms/51job/actions/resume-actions.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixtureCandidateCard(anchorId = 'no_interested_10001'): string {
  return `<div class="talent-card"><span class="name">测试候选</span><span>测试公司</span><span>测试经理</span><div id="${anchorId}"></div></div>`;
}

async function withFast51jobResultActionConfig<T>(run: () => Promise<T>): Promise<T> {
  const originalMin = config.playwright.actionDelayMinMsByPlatform['51job'];
  const originalMax = config.playwright.actionDelayMaxMsByPlatform['51job'];
  const originalStable = config.playwright.emptyResultsStableMs;
  config.playwright.actionDelayMinMsByPlatform['51job'] = 0;
  config.playwright.actionDelayMaxMsByPlatform['51job'] = 0;
  config.playwright.emptyResultsStableMs = 40;
  try {
    return await run();
  } finally {
    config.playwright.actionDelayMinMsByPlatform['51job'] = originalMin;
    config.playwright.actionDelayMaxMsByPlatform['51job'] = originalMax;
    config.playwright.emptyResultsStableMs = originalStable;
  }
}

function pageListenerCount(page: Page, eventName: string): number {
  return (page as unknown as { listenerCount(name: string): number }).listenerCount(eventName);
}

describe('51job semantic actions', () => {
  it('keeps the public adapter contract wired to semantic action modules', () => {
    assert.equal(fiftyOneJobAdapter.subscribeSearchUrl, fiftyOneJobSubscribeSearchUrl);
    assert.equal(fiftyOneJobAdapter.loginUrl, fiftyOneJobLoginUrl);
    assert.equal(fiftyOneJobAdapter.openLoginPage, open51jobLoginPage);
    assert.equal(fiftyOneJobAdapter.openAuthenticatedHome, open51jobAuthenticatedHome);
    assert.equal(fiftyOneJobAdapter.assertAuthenticated, assert51jobAuthenticated);
    assert.equal(fiftyOneJobAdapter.openSubscribeSearch, open51jobSubscribeSearch);
    assert.equal(fiftyOneJobAdapter.estimateSearchTimeoutMs, estimate51jobSearchTimeoutMs);
    assert.equal(fiftyOneJobAdapter.openDirectSearch, open51jobDirectSearch);
    assert.equal(fiftyOneJobAdapter.prepareSearchConditionPage, prepare51jobSearchCondition);
    assert.equal(fiftyOneJobAdapter.discoverSearchFilters, discover51jobSearchFilters);
    assert.equal(fiftyOneJobAdapter.applySearchCondition, apply51jobSearchCondition);
    assert.equal(fiftyOneJobAdapter.readSearchConditionResultTotal, read51jobSearchConditionResultTotal);
    assert.equal(fiftyOneJobAdapter.saveSearchCondition, savePrepared51jobSearchCondition);
    assert.equal(fiftyOneJobAdapter.extractCandidateList, extract51jobCandidateList);
    assert.equal(fiftyOneJobAdapter.readCurrentCandidateBatch, read51jobCurrentCandidateBatch);
    assert.equal(fiftyOneJobAdapter.advanceToNextCandidateBatch, advance51jobToNextCandidateBatch);
    assert.equal(fiftyOneJobAdapter.openResumeDetail, open51jobResumeDetail);
    assert.equal(fiftyOneJobAdapter.parseResumeDetail, parse51jobResumeDetail);
    assert.equal(fiftyOneJobAdapter.readCandidateProfileDetail, read51jobCandidateProfileDetail);
  });

  it('preserves the recruiter subscribe URL for login and saved search entry', () => {
    assert.equal(fiftyOneJobLoginUrl, 'https://ehire.51job.com/Revision/talent/subscribe');
    assert.equal(fiftyOneJobSubscribeSearchUrl, fiftyOneJobLoginUrl);
  });

  it('estimates one 51job deadline that covers paced entry and all stable-result checks', () => {
    const pacingUpperBound = config.playwright.actionDelayMaxMsByPlatform['51job'];
    const stableWindowMs = config.playwright.emptyResultsStableMs;
    const savedEstimate = estimate51jobSearchTimeoutMs({
      source: 'saved',
      conditions: [],
      includeViewedCandidates: false,
    });
    const directEstimate = estimate51jobSearchTimeoutMs({
      source: 'direct',
      conditions: [{ kind: 'keyword', value: '测试' }],
      includeViewedCandidates: false,
    });

    assert.equal(savedEstimate, Math.max(
      config.playwright.searchPageTimeoutMs,
      24_000 + 2 * stableWindowMs + 4 * pacingUpperBound,
    ));
    assert.equal(directEstimate, Math.max(
      config.playwright.searchPageTimeoutMs,
      24_000 + 3 * stableWindowMs + 11 * pacingUpperBound,
    ));
    assert.ok(directEstimate > savedEstimate);
  });

  it('skips non-application conditions before attempting page controls', async () => {
    const condition = { kind: 'keyword', value: 'Java工程师' } as const;
    const result = await apply51jobSearchCondition({} as Page, condition);

    assert.deepEqual(result, {
      platform: '51job',
      condition,
      status: 'skipped',
      message: 'Search condition kind "keyword" is not implemented for 51job yet.',
    });
  });

  it('preserves action deadlines across pages and moves before a DOM compatibility click', async () => {
    const firstPage = {} as Page;
    const secondPage = {} as Page;
    const context = create51jobActionContext(firstPage, 1_000, 'fixture action');
    const moved = with51jobActionPage(context, secondPage);
    assert.equal(moved.page, secondPage);
    assert.equal(moved.deadline, context.deadline);
    assert.ok(remaining51jobActionMs(moved) > 0);
    assert.throws(
      () => remaining51jobActionMs({ ...moved, deadline: Date.now() - 1 }),
      /51job fixture action exceeded its action deadline/,
    );

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform['51job'];
    const originalMax = config.playwright.actionDelayMaxMsByPlatform['51job'];
    config.playwright.actionDelayMinMsByPlatform['51job'] = 0;
    config.playwright.actionDelayMaxMsByPlatform['51job'] = 0;
    try {
      await page.setContent('<button id="target" onclick="this.dataset.clicked=\'true\'">执行</button>');
      const button = page.locator('#target');
      await click51jobControlWithDomEvents(
        create51jobActionContext(page, 3_000, 'fixture DOM click'),
        button,
      );
      assert.equal(await button.getAttribute('data-clicked'), 'true');
    } finally {
      config.playwright.actionDelayMinMsByPlatform['51job'] = originalMin;
      config.playwright.actionDelayMaxMsByPlatform['51job'] = originalMax;
      await browser.close();
    }
  });

  it('waits for the clicked viewed-filter request, loading completion, and a stable replacement before returning', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requestSeen = createDeferred<void>();
    const releaseResponse = createDeferred<void>();
    let settled = false;
    let responseAt = 0;
    const listenerCountBefore = pageListenerCount(page, 'request');

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/commercial/recommend', async (route) => {
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          requestSeen.resolve();
          await releaseResponse.promise;
          responseAt = Date.now();
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div id="loading" class="el-loading-mask" style="display:none">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              const input = document.querySelector('#viewed-filter input');
              setTimeout(() => { input.checked = !input.checked; }, 0);
              document.querySelector('#loading').style.display = 'block';
              fetch('https://fixture.test/commercial/recommend', { method: 'POST' });
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                setTimeout(() => {
                  document.querySelector('#results').innerHTML = '${fixtureCandidateCard('no_interested_20002')}';
                  document.querySelector('#loading').style.display = 'none';
                  window.__fixtureResultRenderedAt = performance.now();
                }, 30);
              });
            });
          </script>
        `);

        const action = apply51jobViewedCandidatePolicy(page, {
          deadline: Date.now() + 10_000,
        }).then((result) => {
          settled = true;
          return result;
        });
        await requestSeen.promise;
        await page.waitForTimeout(20);
        assert.equal(settled, false, 'old cards under the loading mask must not complete the action');
        releaseResponse.resolve();

        const result = await action;
        assert.deepStrictEqual(result, {
          status: 'applied',
          resultState: 'candidates',
          candidateCount: 1,
        });
        assert.ok(Date.now() >= responseAt);
        assert.equal(await page.locator('#no_interested_10001').count(), 0);
        assert.equal(await page.locator('#no_interested_20002').count(), 1);
        assert.equal(await page.locator('#loading').isVisible(), false);
        assert.equal(await page.locator('#viewed-filter input').isChecked(), true);
        assert.deepStrictEqual(
          (await extract51jobCandidateList(page, { deadline: Date.now() + 10_000 })).candidates.map((candidate) => candidate.candidateId),
          ['20002'],
          'only the refreshed primary search list is eligible for extraction',
        );
        assert.equal(pageListenerCount(page, 'request'), listenerCountBefore, 'request listener must be removed after the action');
        assert.equal(await page.evaluate(() => (window as Window & {
          __autorecruit51jobResultObserver?: unknown;
        }).__autorecruit51jobResultObserver), undefined, 'DOM observer must be removed after the action');
      });
    } finally {
      await browser.close();
    }
  });

  it('maps includeViewedCandidates=true to an unchecked filter and accepts an unchanged result set only after its own refresh', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requestSeen = createDeferred<void>();
    const releaseResponse = createDeferred<void>();
    let settled = false;

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          requestSeen.resolve();
          await releaseResponse.promise;
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox is-checked"><input type="checkbox" checked>我已看</label>
          <div id="loading" class="base-page-loading" style="display:none">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              const input = document.querySelector('#viewed-filter input');
              setTimeout(() => { input.checked = !input.checked; }, 0);
              document.querySelector('#loading').style.display = 'block';
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                setTimeout(() => { document.querySelector('#loading').style.display = 'none'; }, 20);
              });
            });
          </script>
        `);

        const action = apply51jobViewedCandidatePolicy(page, {
          includeViewedCandidates: true,
          deadline: Date.now() + 10_000,
        }).then((result) => {
          settled = true;
          return result;
        });
        await requestSeen.promise;
        await page.waitForTimeout(20);
        assert.equal(settled, false, 'a successful response alone is not enough while loading remains visible');
        releaseResponse.resolve();
        assert.deepStrictEqual(await action, {
          status: 'applied',
          resultState: 'candidates',
          candidateCount: 1,
        });
        assert.equal(await page.locator('#viewed-filter input').isChecked(), false);
        assert.equal(await page.locator('#no_interested_10001').count(), 1);
      });
    } finally {
      await browser.close();
    }
  });

  it('excludes recommendation cards after the explicit 51job no-more-results boundary', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.setContent(`
          <label class="el-checkbox is-checked"><input type="checkbox" checked>我已看</label>
          <div class="list-box">
            <div class="virtual_list" id="search-results"></div>
            <div class="recall_tip_wrapper">未找到更多，为你推荐人才</div>
            <div class="virtual_list" id="recommendations">${fixtureCandidateCard('no_interested_70007')}</div>
          </div>
        `);

        assert.deepStrictEqual(await apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 10_000 }), {
          status: 'already-satisfied',
          resultState: 'explicit-empty',
          candidateCount: 0,
        });
        assert.deepStrictEqual(
          (await collectStable51jobCandidateList(page, { deadline: Date.now() + 10_000 })).map((candidate) => candidate.candidateId),
          [],
        );

        await page.setContent(`
          <div class="list-box">
            <div class="virtual_list">${fixtureCandidateCard('no_interested_80008')}</div>
            <div class="recall_tip_wrapper">未找到更多，为你推荐人才</div>
            <div class="virtual_list">${fixtureCandidateCard('no_interested_90009')}</div>
          </div>
        `);
        assert.deepStrictEqual(
          (await collectStable51jobCandidateList(page, { deadline: Date.now() + 10_000 })).map((candidate) => candidate.candidateId),
          ['80008'],
          'only cards before the recommendation boundary belong to the search result',
        );
      });
    } finally {
      await browser.close();
    }
  });

  it('keeps an already-satisfied viewed filter idempotent but still waits for an in-progress result render', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let settled = false;

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox is-checked"><input type="checkbox" checked>我已看</label>
          <div id="loading" class="el-loading-mask">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>window.__fixtureClicks = 0; document.querySelector('#viewed-filter').addEventListener('click', () => { window.__fixtureClicks += 1; });</script>
        `);
        const action = apply51jobViewedCandidatePolicy(page, {
          deadline: Date.now() + 10_000,
        }).then((result) => {
          settled = true;
          return result;
        });
        await page.waitForTimeout(30);
        assert.equal(settled, false);
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#loading')!.style.display = 'none';
        });
        assert.deepStrictEqual(await action, {
          status: 'already-satisfied',
          resultState: 'candidates',
          candidateCount: 1,
        });
        assert.equal(await page.evaluate(() => (window as Window & { __fixtureClicks?: number }).__fixtureClicks), 0);
      });
    } finally {
      await browser.close();
    }
  });

  it('fails closed for a missing primary refresh request', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div class="virtual_list">${fixtureCandidateCard()}</div>
          <script>document.querySelector('#viewed-filter').addEventListener('click', (event) => { event.preventDefault(); setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0); });</script>
        `);
        await assert.rejects(
          () => apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 5_000 }),
          /refresh-start/,
        );
      });
    } finally {
      await browser.close();
    }
  });

  it('treats only a visible explicit empty result as zero candidates', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requestSeen = createDeferred<void>();

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          requestSeen.resolve();
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div id="loading" class="el-loading-mask" style="display:none">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0);
              document.querySelector('#loading').style.display = 'block';
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                document.querySelector('#results').innerHTML = '';
                document.querySelector('#loading').style.display = 'none';
                document.body.insertAdjacentHTML('beforeend', '<div class="el-empty">没有搜索到相关的人才</div>');
              });
            });
          </script>
        `);
        const result = await apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 10_000 });
        await requestSeen.promise;
        assert.deepStrictEqual(result, {
          status: 'applied',
          resultState: 'explicit-empty',
          candidateCount: 0,
        });
      });
    } finally {
      await browser.close();
    }
  });

  it('does not mistake unrelated page text for an explicit empty candidate result', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <aside>没有搜索到相关的人才</aside>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0);
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                document.querySelector('#results').innerHTML = '';
              });
            });
          </script>
        `);

        await assert.rejects(
          () => apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 5_000 }),
          /result-render/,
        );
      });
    } finally {
      await browser.close();
    }
  });

  it('fails closed when the primary response fails or the rendered result never stabilizes', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          await route.fulfill({ status: 500, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div class="virtual_list">${fixtureCandidateCard()}</div>
          <script>document.querySelector('#viewed-filter').addEventListener('click', (event) => { event.preventDefault(); setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0); fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }); });</script>
        `);
        await assert.rejects(
          () => apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 10_000 }),
          /refresh-response/,
        );

        await page.unroute('**/resume/search/talent_hunt_resume_list');
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div id="loading" class="el-loading-mask" style="display:none">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard('no_interested_50005')}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0);
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                let next = 0;
                window.__fixtureMutationTimer = setInterval(() => {
                  next += 1;
                  document.querySelector('#results').innerHTML = '${fixtureCandidateCard('no_interested_50005')}' + '<span data-version="' + next + '"></span>';
                }, 20);
              });
            });
          </script>
        `);
        try {
          await assert.rejects(
            // The full suite runs several Playwright-heavy files concurrently.
            // Leave enough budget for the click/request phase so this case
            // deterministically exercises the intended never-stable result.
            () => apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 2_500 }),
            /result-stability/,
          );
        } finally {
          await page.evaluate(() => clearInterval((window as Window & { __fixtureMutationTimer?: number }).__fixtureMutationTimer));
        }

        await page.setContent(`
          <label id="viewed-filter" class="el-checkbox"><input type="checkbox">我已看</label>
          <div class="virtual_list" id="results">${fixtureCandidateCard('no_interested_60006')}</div>
          <script>
            document.querySelector('#viewed-filter').addEventListener('click', (event) => {
              event.preventDefault();
              setTimeout(() => { document.querySelector('#viewed-filter input').checked = true; }, 0);
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                document.querySelector('#results').innerHTML = '';
              });
            });
          </script>
        `);
        await assert.rejects(
          () => apply51jobViewedCandidatePolicy(page, { deadline: Date.now() + 5_000 }),
          /result-render/,
        );
      });
    } finally {
      await browser.close();
    }
  });

  it('uses a stable candidate snapshot and gives direct search submit its own verified refresh cycle', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let directRequestCount = 0;

    try {
      await withFast51jobResultActionConfig(async () => {
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          directRequestCount += 1;
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label class="el-checkbox is-checked"><input type="checkbox" checked>我已看</label>
          <button id="direct-submit" class="search-btn">搜索</button>
          <div id="loading" class="base-page-loading" style="display:none">加载中</div>
          <div class="virtual_list" id="results">${fixtureCandidateCard()}</div>
          <script>
            document.querySelector('#direct-submit').addEventListener('click', () => {
              document.querySelector('#loading').style.display = 'block';
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' }).then(() => {
                setTimeout(() => {
                  document.querySelector('#results').innerHTML = '${fixtureCandidateCard('no_interested_30003')}';
                  document.querySelector('#loading').style.display = 'none';
                }, 20);
              });
            });
          </script>
        `);

        assert.deepStrictEqual(await submit51jobDirectSearch(page, { deadline: Date.now() + 10_000 }), {
          resultState: 'candidates',
          candidateCount: 1,
        });
        assert.equal(directRequestCount, 1);
        assert.deepStrictEqual(
          (await extract51jobCandidateList(page, { deadline: Date.now() + 10_000 })).candidates.map((candidate) => candidate.candidateId),
          ['30003'],
        );

        await page.setContent(`<div class="virtual_list">${fixtureCandidateCard('no_interested_40004')}${fixtureCandidateCard('no_interested_40004')}</div>`);
        await assert.rejects(
          () => collectStable51jobCandidateList(page, { deadline: Date.now() + 10_000 }),
          /candidate-card identities are duplicated/,
        );
      });
    } finally {
      await browser.close();
    }
  });

  it('keeps an internally created direct-search deadline through preparation and final result submission', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalOpenPageLevelSearch = openPageLevelSearchRef.fn;
    let preparationDeadline: number | undefined;

    try {
      await withFast51jobResultActionConfig(async () => {
        openPageLevelSearchRef.fn = async (_page, options) => {
          preparationDeadline = options?.deadline;
          return page;
        };
        await page.route('**/resume/search/talent_hunt_resume_list', async (route) => {
          await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*' } });
        });
        await page.setContent(`
          <label class="el-checkbox is-checked"><input type="checkbox" checked>我已看</label>
          <div class="talent_search_keywords_input"><input class="el-input__inner"></div>
          <button class="search-btn" id="direct-submit">搜索</button>
          <button class="more">更多</button>
          <div class="virtual_list" id="results">${fixtureCandidateCard('no_interested_70007')}</div>
          <script>
            document.querySelector('#direct-submit').addEventListener('click', () => {
              fetch('https://fixture.test/resume/search/talent_hunt_resume_list', { method: 'POST' });
            });
          </script>
        `);

        const beganAt = Date.now();
        await open51jobDirectSearch(page, '测试关键词', []);

        assert.ok(preparationDeadline !== undefined, 'preparation must receive the direct action deadline');
        assert.ok(preparationDeadline > beganAt, 'preparation must receive an absolute future deadline');
      });
    } finally {
      openPageLevelSearchRef.fn = originalOpenPageLevelSearch;
      await browser.close();
    }
  });

  it('reads and advances exact Mapping candidate batches with a verified terminal postcondition', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform['51job'];
    const originalMax = config.playwright.actionDelayMaxMsByPlatform['51job'];
    const originalStable = config.playwright.emptyResultsStableMs;
    config.playwright.actionDelayMinMsByPlatform['51job'] = 0;
    config.playwright.actionDelayMaxMsByPlatform['51job'] = 0;
    config.playwright.emptyResultsStableMs = 0;
    try {
      await page.setContent(`
        <div class="virtual_list" id="results">
          <div class="talent-card"><span class="name">候选人甲</span><span>示例公司</span><span>运营经理</span><div id="no_interested_12345"></div></div>
        </div>
        <ul class="el-pager"><li class="active" id="active-page">1</li></ul>
        <div class="el-pagination"><button class="btn-next" id="next" onclick="
          document.querySelector('#results').innerHTML = '<div class=&quot;talent-card&quot;><span class=&quot;name&quot;>候选人乙</span><span>示例公司</span><span>高级经理</span><div id=&quot;no_interested_67890&quot;></div></div>';
          document.querySelector('#active-page').textContent = '2';
          this.classList.add('disabled');
          this.disabled = true;
        ">下一页</button></div>
      `);
      const deadline = Date.now() + 5_000;
      const first = await read51jobCurrentCandidateBatch(page, { deadline });
      assert.deepStrictEqual(first.candidates.map((item) => item.candidateId), ['12345']);
      assert.equal(first.batchNumber, 1);
      assert.equal(first.endReached, false);
      assert.equal(first.terminalEvidence, 'not-terminal');

      await assert.rejects(
        () => advance51jobToNextCandidateBatch(page, {
          expectedCurrentBatchIdentity: 'stale-batch',
          deadline,
        }),
        /changed before advance/i,
      );
      const advanced = await advance51jobToNextCandidateBatch(page, {
        expectedCurrentBatchIdentity: first.batchIdentity,
        deadline,
      });
      assert.equal(advanced.status, 'advanced');
      if (advanced.status === 'advanced') {
        assert.deepStrictEqual(advanced.batch.candidates.map((item) => item.candidateId), ['67890']);
        assert.equal(advanced.batch.batchNumber, 2);
        assert.equal(advanced.batch.endReached, true);
        assert.equal(advanced.batch.terminalEvidence, 'explicit-pagination-end');
        assert.notEqual(advanced.batch.batchIdentity, first.batchIdentity);
        assert.deepStrictEqual(
          await advance51jobToNextCandidateBatch(page, {
            expectedCurrentBatchIdentity: advanced.batch.batchIdentity,
            deadline,
          }),
          { status: 'end-reached', terminalEvidence: 'explicit-pagination-end' },
        );
      }
    } finally {
      config.playwright.actionDelayMinMsByPlatform['51job'] = originalMin;
      config.playwright.actionDelayMaxMsByPlatform['51job'] = originalMax;
      config.playwright.emptyResultsStableMs = originalStable;
      await browser.close();
    }
  });
});
