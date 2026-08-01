import type { Frame, Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import {
  createPlatformActionContext,
  remainingPlatformActionMs,
  withPlatformActionPage,
  type PlatformActionContext,
} from '../../../browser/platform-action-context.js';
import {
  clickPlatformLocator,
  getPlatformActionPaceDelayMs,
  moveMouseToLocatorPosition,
  waitOnPageOrTimer,
  waitPlatformActionPace,
  type MousePointerPoint,
} from '../../../browser/pacing.js';

export type BossActionContext = PlatformActionContext;

export interface BossControlClickOptions {
  force?: boolean;
  pace?: boolean;
  position?: MousePointerPoint;
  deadline?: number;
  cleanupReserveMs?: number;
  /** Revalidate the semantic target after pointer movement and immediately before dispatch. */
  beforeClick?: () => Promise<void>;
}

export function bossActionPaceUpperBoundMs(): number {
  return Math.max(config.playwright.actionDelayMaxMsByPlatform.boss, 0);
}

export async function waitBossActionPaceWithinDeadline(
  page: Page,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  const paceMs = getPlatformActionPaceDelayMs('boss');
  const reserve = Math.max(cleanupReserveMs, 0);
  if (Date.now() + paceMs + reserve >= deadline) {
    throw new Error(`Boss action pace would exceed its deadline while preserving ${reserve}ms for cleanup.`);
  }
  await waitOnPageOrTimer(page, paceMs);
  if (Date.now() + reserve >= deadline) {
    throw new Error(`Boss action deadline was exhausted while preserving ${reserve}ms for cleanup.`);
  }
}

export async function runBossActionWithinDeadline<T>(
  page: Page,
  deadline: number,
  action: () => Promise<T>,
  cleanupReserveMs = 0,
): Promise<T> {
  await waitBossActionPaceWithinDeadline(page, deadline, cleanupReserveMs);
  return action();
}

export function createBossActionContext(
  page: Page,
  timeoutMs: number,
  operation: string,
): BossActionContext {
  return createPlatformActionContext(page, timeoutMs, `Boss ${operation}`);
}

export function withBossActionPage(
  context: BossActionContext,
  page: Page,
  deadline = context.deadline,
): BossActionContext {
  return withPlatformActionPage(context, page, deadline);
}

export function remainingBossActionMs(context: BossActionContext, minimumMs = 1): number {
  return remainingPlatformActionMs(context, minimumMs);
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
  options: Pick<BossControlClickOptions, 'position' | 'pace' | 'deadline' | 'cleanupReserveMs' | 'beforeClick'> = {},
): Promise<void> {
  if (options.deadline !== undefined) {
    if (options.pace !== false) {
      await waitBossActionPaceWithinDeadline(page, options.deadline, options.cleanupReserveMs ?? 0);
    }
  } else if (options.pace !== false) {
    await waitPlatformActionPace(page, 'boss');
  }
  const effectiveTimeout = options.deadline === undefined
    ? timeoutMs
    : Math.max(options.deadline - Date.now() - Math.max(options.cleanupReserveMs ?? 0, 0), 1);
  const moved = await moveMouseToLocatorPosition(locator, page, effectiveTimeout, options.position).catch(() => false);
  if (!moved) {
    throw new Error('Boss native click could not move the shared pointer to its target.');
  }
  await options.beforeClick?.();
  await locator.click({ timeout: effectiveTimeout, position: options.position });
}

export async function clickBossControlWithDomEvent(
  page: Page,
  locator: Locator,
  timeoutMs: number,
  options: Pick<BossControlClickOptions, 'position' | 'pace' | 'deadline' | 'cleanupReserveMs' | 'beforeClick'> = {},
): Promise<void> {
  if (options.deadline !== undefined) {
    if (options.pace !== false) {
      await waitBossActionPaceWithinDeadline(page, options.deadline, options.cleanupReserveMs ?? 0);
    }
  } else if (options.pace !== false) {
    await waitPlatformActionPace(page, 'boss');
  }
  const effectiveTimeout = options.deadline === undefined
    ? timeoutMs
    : Math.max(options.deadline - Date.now() - Math.max(options.cleanupReserveMs ?? 0, 0), 1);
  const moved = await moveMouseToLocatorPosition(locator, page, effectiveTimeout, options.position).catch(() => false);
  if (!moved) {
    throw new Error('Boss DOM-event click could not move the shared pointer to its target.');
  }
  await options.beforeClick?.();
  await locator.evaluate((element) => (element as HTMLElement).click());
}
