import type { Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import {
  clickLocatorWithMouse,
  clickPlatformLocator,
  fillPlatformLocator,
  randomIntBetween,
  waitPlatformActionPace,
  waitPlatformActionPaceWithoutPage,
} from '../../../browser/pacing.js';
import type { SearchWaitOptions } from '../../types.js';

export function createLiepinActionDeadline(
  timeoutMs = config.playwright.resumeDetailTimeoutMs,
): number {
  return Date.now() + Math.max(timeoutMs, 1);
}

export function createLiepinSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? createLiepinActionDeadline(config.playwright.searchPageTimeoutMs);
}

export function remainingLiepinActionMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

export function boundedLiepinActionMs(
  deadline: number,
  maxTimeoutMs = Number.POSITIVE_INFINITY,
): number {
  return Math.max(1, Math.min(remainingLiepinActionMs(deadline), maxTimeoutMs));
}

export function liepinActionTimeoutMs(): number {
  return randomIntBetween(
    config.playwright.actionDelayMinMsByPlatform.liepin,
    config.playwright.actionDelayMaxMsByPlatform.liepin,
  );
}

export async function waitLiepinActionPace(page: Page): Promise<void> {
  await waitPlatformActionPace(page, 'liepin');
}

export async function waitLiepinActionPaceWithoutPage(): Promise<void> {
  await waitPlatformActionPaceWithoutPage('liepin');
}

export async function clickLiepinLocatorWithMouse(
  locator: Locator,
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  return clickLocatorWithMouse(locator, page, timeoutMs);
}

export async function clickLiepinLocator(
  locator: Locator,
  page: Page,
  timeoutMs: number,
): Promise<void> {
  await clickPlatformLocator(locator, page, 'liepin', timeoutMs);
}

export async function fillLiepinLocator(
  locator: Locator,
  page: Page,
  value: string,
  timeoutMs: number,
): Promise<void> {
  await fillPlatformLocator(locator, page, 'liepin', value, timeoutMs);
}
