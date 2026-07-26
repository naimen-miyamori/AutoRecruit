import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Page } from 'playwright';
import { config } from '../config.js';
import { fiftyOneJobAdapter } from '../platforms/51job-adapter.js';
import { extract51jobCandidateList } from '../platforms/51job/actions/candidate-actions.js';
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
    assert.equal(fiftyOneJobAdapter.openResumeDetail, open51jobResumeDetail);
    assert.equal(fiftyOneJobAdapter.parseResumeDetail, parse51jobResumeDetail);
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
});
