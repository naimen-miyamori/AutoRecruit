import type { Frame, Locator, Page } from 'playwright';
import {
  clickPlatformLocator,
  moveMouseToLocatorPosition,
  waitPlatformActionPace,
  type MousePointerPoint,
} from '../../../browser/pacing.js';

export interface BossActionContext {
  page: Page;
  deadline: number;
  operation: string;
}

export interface BossControlClickOptions {
  force?: boolean;
  pace?: boolean;
  position?: MousePointerPoint;
}

export function createBossActionContext(
  page: Page,
  timeoutMs: number,
  operation: string,
): BossActionContext {
  return {
    page,
    deadline: Date.now() + Math.max(1, timeoutMs),
    operation,
  };
}

export function withBossActionPage(
  context: BossActionContext,
  page: Page,
  deadline = context.deadline,
): BossActionContext {
  return { ...context, page, deadline };
}

export function remainingBossActionMs(context: BossActionContext, minimumMs = 1): number {
  const remaining = context.deadline - Date.now();
  if (remaining < minimumMs) {
    throw new Error(`Boss ${context.operation} exceeded its action deadline.`);
  }
  return remaining;
}

export async function runBossAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await waitPlatformActionPace(page, 'boss');
  return action();
}

export async function runBossFrameAction<T>(frame: Frame, action: () => Promise<T>): Promise<T> {
  return runBossAction(frame.page(), action);
}

export async function runBossContextAction<T>(
  context: BossActionContext,
  action: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  await waitPlatformActionPace(context.page, 'boss');
  return action(remainingBossActionMs(context));
}

export async function clickBossControl(
  locator: Locator,
  page: Page,
  timeoutMs: number,
  options: BossControlClickOptions = {},
): Promise<void> {
  await clickPlatformLocator(locator, page, 'boss', timeoutMs, options);
}

export async function clickBossControlNatively(
  page: Page,
  locator: Locator,
  timeoutMs: number,
  options: Pick<BossControlClickOptions, 'position'> = {},
): Promise<void> {
  await waitPlatformActionPace(page, 'boss');
  await moveMouseToLocatorPosition(locator, page, timeoutMs, options.position).catch(() => false);
  await locator.click({ timeout: timeoutMs, position: options.position });
}

export async function clickBossControlWithDomEvent(
  page: Page,
  locator: Locator,
  timeoutMs: number,
  options: Pick<BossControlClickOptions, 'position'> = {},
): Promise<void> {
  await waitPlatformActionPace(page, 'boss');
  await moveMouseToLocatorPosition(locator, page, timeoutMs, options.position).catch(() => false);
  await locator.evaluate((element) => (element as HTMLElement).click());
}
