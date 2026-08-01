import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  clickBossControlWithDomEvent,
  createBossActionContext,
  remainingBossActionMs,
  runBossFrameAction,
  waitBossActionPaceWithinDeadline,
  withBossActionPage,
} from '../platforms/boss/actions/context.js';

describe('Boss action context', () => {
  it('preserves the phase deadline across page changes and rejects expired work', async () => {
    const firstPage = {} as never;
    const secondPage = {} as never;
    const context = createBossActionContext(firstPage, 5_000, 'fixture action');
    const moved = withBossActionPage(context, secondPage);
    assert.equal(moved.page, secondPage);
    assert.equal(moved.deadline, context.deadline);
    assert.ok(remainingBossActionMs(moved) > 0);
    assert.throws(
      () => remainingBossActionMs({ ...moved, deadline: Date.now() - 1 }),
      /Boss fixture action exceeded its action deadline/,
    );
  });

  it('paces Frame actions through their owning page and moves before a DOM click', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    try {
      await page.setContent('<button id="target" onclick="this.dataset.clicked=\'true\'">执行</button><iframe></iframe>');
      const button = page.locator('#target');
      await clickBossControlWithDomEvent(page, button, 3_000);
      assert.equal(await button.getAttribute('data-clicked'), 'true');
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      assert.ok(frame);
      let ran = false;
      await runBossFrameAction(frame!, async () => { ran = true; });
      assert.equal(ran, true);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('refuses to spend action pace when the deadline must be reserved for cleanup', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 25;
    config.playwright.actionDelayMaxMsByPlatform.boss = 25;
    try {
      await assert.rejects(
        () => waitBossActionPaceWithinDeadline(page, Date.now() + 20, 10),
        /would exceed its deadline.*10ms for cleanup/i,
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });
});
