import type { Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import {
  createPlatformActionContext,
  remainingPlatformActionMs,
  withPlatformActionPage,
  type PlatformActionContext,
} from '../../../browser/platform-action-context.js';
import {
  clickPlatformLocator,
  moveMouseToLocatorPosition,
  waitPlatformActionPace,
} from '../../../browser/pacing.js';

export interface FiftyOneJobActionContext extends PlatformActionContext {
  readinessTimeoutMs: number;
}

export function create51jobActionContext(
  page: Page,
  readinessTimeoutMs: number,
  operation: string,
): FiftyOneJobActionContext {
  const actionDelayBudgetMs = config.playwright.actionDelayMaxMsByPlatform['51job'];
  return {
    ...createPlatformActionContext(
      page,
      readinessTimeoutMs + actionDelayBudgetMs,
      `51job ${operation}`,
    ),
    readinessTimeoutMs,
  };
}

export function with51jobActionPage(
  context: FiftyOneJobActionContext,
  page: Page,
): FiftyOneJobActionContext {
  return withPlatformActionPage(context, page);
}

export function remaining51jobActionMs(context: FiftyOneJobActionContext): number {
  return Math.min(context.readinessTimeoutMs, remainingPlatformActionMs(context));
}

export async function click51jobControl(
  context: FiftyOneJobActionContext,
  locator: Locator,
): Promise<void> {
  await clickPlatformLocator(
    locator,
    context.page,
    '51job',
    remaining51jobActionMs(context),
  );
}

export async function click51jobControlWithDomEvents(
  context: FiftyOneJobActionContext,
  locator: Locator,
): Promise<void> {
  await waitPlatformActionPace(context.page, '51job');
  const timeoutMs = remaining51jobActionMs(context);
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  await moveMouseToLocatorPosition(locator, context.page, timeoutMs);
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    for (const eventName of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }
  });
}
