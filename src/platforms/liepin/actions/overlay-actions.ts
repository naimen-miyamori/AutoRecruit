import type { Page } from 'playwright';
import {
  moveMouseToLocatorCenter,
  pressPlatformKey,
  waitOnPageOrTimer,
} from '../../../browser/pacing.js';
import { waitLiepinActionPace } from './context.js';
import { clickLiepinLocatorWithForceFallback } from './compatibility.js';

const liepinPlatform = 'liepin';

export async function hasVisibleLiepinBlockingOverlay(page: Page): Promise<boolean> {
  const hasOverlay = await page.evaluate(() => {
    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };

    return [
      ...document.querySelectorAll('.ant-modal-mask, .ant-modal-wrap, [role="dialog"]'),
    ].some((element) => isVisible(element));
  }).catch(() => false);

  return hasOverlay === true;
}

async function dispatchLiepinBlockingOverlayCloseEvents(page: Page): Promise<boolean> {
  const targets = page.locator([
    '.ant-modal-wrap .city-modal-close',
    '.ant-modal-root .city-modal-close',
    '[role="dialog"] .city-modal-close',
    '.ant-modal-wrap [class*="city-modal-close"]',
    '.ant-modal-root [class*="city-modal-close"]',
    '.ant-modal-wrap .antd-fd-industry-modal-close',
    '.ant-modal-root .antd-fd-industry-modal-close',
    '.ant-modal-wrap .antd-jobs-modal-close',
    '.ant-modal-root .antd-jobs-modal-close',
    '.ant-modal-wrap .ant-modal-close',
    '.ant-modal-root .ant-modal-close',
    '[role="dialog"] .ant-modal-close',
    '[role="dialog"] [aria-label="Close"]',
    '[role="dialog"] [aria-label="close"]',
    '.ant-modal-wrap [class*="modal-close"]',
    '.ant-modal-root [class*="modal-close"]',
  ].join(', '));
  let dispatched = false;
  for (let index = await targets.count() - 1; index >= 0; index -= 1) {
    const target = targets.nth(index);
    if (!await target.isVisible().catch(() => false)) continue;
    await waitLiepinActionPace(page);
    await moveMouseToLocatorCenter(target, page, 1000).catch(() => false);
    dispatched = await target.evaluate((element) => {
      const eventInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new MouseEvent('pointerdown', eventInit));
      element.dispatchEvent(new MouseEvent('mousedown', eventInit));
      element.dispatchEvent(new MouseEvent('mouseup', eventInit));
      element.dispatchEvent(new MouseEvent('click', eventInit));
      if (element instanceof HTMLElement) element.click();
      return true;
    }).catch(() => false) || dispatched;
  }
  return dispatched;
}

export async function closeLiepinBlockingOverlays(page: Page, timeoutMs = 1000): Promise<void> {
  await pressPlatformKey(page, liepinPlatform, 'Escape').catch(() => undefined);
  await waitOnPageOrTimer(page, 200);
  if (!(await hasVisibleLiepinBlockingOverlay(page))) {
    return;
  }

  const closeSelectors = [
    '.ant-modal-wrap .city-modal-close',
    '.ant-modal-root .city-modal-close',
    '[role="dialog"] .city-modal-close',
    '.ant-modal-wrap [class*="city-modal-close"]',
    '.ant-modal-root [class*="city-modal-close"]',
    '.ant-modal-root .antd-fd-industry-modal-close',
    '.ant-modal-wrap .antd-fd-industry-modal-close',
    '.ant-modal-root .antd-jobs-modal-close',
    '.ant-modal-wrap .antd-jobs-modal-close',
    '.ant-modal-root .ant-modal-close',
    '.ant-modal-wrap .ant-modal-close',
    '[role="dialog"] .antd-fd-industry-modal-close',
    '[role="dialog"] .antd-jobs-modal-close',
    '[role="dialog"] .ant-modal-close',
    '[role="dialog"] [aria-label="Close"]',
    '[role="dialog"] [aria-label="close"]',
    '.ant-modal-wrap [class*="modal-close"]',
    '.ant-modal-root [class*="modal-close"]',
  ];

  for (let pass = 0; pass < 3; pass += 1) {
    for (const selector of closeSelectors) {
      const closeTargets = page.locator(selector);
      const closeTargetCount = await closeTargets.count().catch(() => 0);
      for (let index = Math.max(closeTargetCount - 1, 0); index >= 0; index -= 1) {
        const closeTarget = closeTargetCount > 0 ? closeTargets.nth(index) : closeTargets.first();
        if (!(await closeTarget.isVisible({ timeout: 300 }).catch(() => false))) {
          continue;
        }

        if (await clickLiepinLocatorWithForceFallback(closeTarget, page, timeoutMs).catch(() => false)) {
          await waitOnPageOrTimer(page, 300);
          if (!(await hasVisibleLiepinBlockingOverlay(page))) {
            return;
          }
        }
      }
    }

    if (await dispatchLiepinBlockingOverlayCloseEvents(page)) {
      await waitOnPageOrTimer(page, 300);
      if (!(await hasVisibleLiepinBlockingOverlay(page))) {
        return;
      }
    }

    await pressPlatformKey(page, liepinPlatform, 'Escape').catch(() => undefined);
    await waitOnPageOrTimer(page, 300);
    if (!(await hasVisibleLiepinBlockingOverlay(page))) {
      return;
    }
  }
}
