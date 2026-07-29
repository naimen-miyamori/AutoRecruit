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

describe('51job semantic actions', () => {
  it('keeps the public adapter contract wired to semantic action modules', () => {
    assert.equal(fiftyOneJobAdapter.subscribeSearchUrl, fiftyOneJobSubscribeSearchUrl);
    assert.equal(fiftyOneJobAdapter.loginUrl, fiftyOneJobLoginUrl);
    assert.equal(fiftyOneJobAdapter.openLoginPage, open51jobLoginPage);
    assert.equal(fiftyOneJobAdapter.openAuthenticatedHome, open51jobAuthenticatedHome);
    assert.equal(fiftyOneJobAdapter.assertAuthenticated, assert51jobAuthenticated);
    assert.equal(fiftyOneJobAdapter.openSubscribeSearch, open51jobSubscribeSearch);
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

  it('reads and advances exact Mapping candidate batches with a verified terminal postcondition', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform['51job'];
    const originalMax = config.playwright.actionDelayMaxMsByPlatform['51job'];
    config.playwright.actionDelayMinMsByPlatform['51job'] = 0;
    config.playwright.actionDelayMaxMsByPlatform['51job'] = 0;
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
      await browser.close();
    }
  });
});
