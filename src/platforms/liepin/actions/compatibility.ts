import type { Locator, Page } from 'playwright';
import { clickPagePointWithMouse, moveMouseToLocatorCenter } from '../../../browser/pacing.js';
import { clickLiepinLocator } from './context.js';

export async function clickLiepinLocatorWithForceFallback(
  locator: Locator,
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await locator.isVisible({ timeout: timeoutMs }).catch(() => false))) {
    return false;
  }

  try {
    await clickLiepinLocator(locator, page, timeoutMs);
    return true;
  } catch {
    await moveMouseToLocatorCenter(locator, page, timeoutMs).catch(() => false);
    const forceClicked = await locator.click({ timeout: timeoutMs, force: true }).then(() => true).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unexpected argument|too many arguments/i.test(message)) {
        return false;
      }

      return locator.click().then(() => true).catch(() => false);
    });
    if (forceClicked) {
      return true;
    }

    const box = await locator.boundingBox({ timeout: timeoutMs }).catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) {
      return false;
    }

    await clickPagePointWithMouse(page, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    }).catch(() => false);
    return true;
  }
}
