import type { Locator, Page } from 'playwright';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';

export function randomIntBetween(min: number, max: number): number {
  const lower = Math.max(0, Math.floor(Math.min(min, max)));
  const upper = Math.max(lower, Math.floor(Math.max(min, max)));
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function getBossWeightedPaceDelayMs(min: number, max: number): number {
  const lower = Math.max(0, Math.floor(Math.min(min, max)));
  const upper = Math.max(lower, Math.floor(Math.max(min, max)));
  if (lower === upper) {
    return lower;
  }

  const lowerRangeMax = lower + Math.floor((upper - lower) / 2);
  const useLowerRange = Math.random() < 0.8;
  return useLowerRange
    ? randomIntBetween(lower, lowerRangeMax)
    : randomIntBetween(Math.min(lowerRangeMax + 1, upper), upper);
}

export function getPlatformActionPaceDelayMs(platform: SupportedPlatform): number {
  const min = config.playwright.actionDelayMinMsByPlatform[platform];
  const max = config.playwright.actionDelayMaxMsByPlatform[platform];
  return platform === 'boss'
    ? getBossWeightedPaceDelayMs(min, max)
    : randomIntBetween(min, max);
}

export function getPlatformCandidatePaceDelayMs(platform: SupportedPlatform): number {
  const min = config.playwright.candidateDelayMinMsByPlatform[platform];
  const max = config.playwright.candidateDelayMaxMsByPlatform[platform];
  return platform === 'boss'
    ? getBossWeightedPaceDelayMs(min, max)
    : randomIntBetween(min, max);
}

export async function waitOnPageOrTimer(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }

  const waitForTimeout = (page as Partial<Pick<Page, 'waitForTimeout'>>).waitForTimeout?.bind(page);
  if (!waitForTimeout) {
    return;
  }

  await waitForTimeout(timeoutMs).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  });
}

export async function waitPlatformActionPace(page: Page, platform: SupportedPlatform): Promise<void> {
  await waitOnPageOrTimer(page, getPlatformActionPaceDelayMs(platform));
}

export async function waitPlatformActionPaceWithoutPage(platform: SupportedPlatform): Promise<void> {
  const timeoutMs = getPlatformActionPaceDelayMs(platform);
  if (timeoutMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export async function waitPlatformCandidatePace(page: Page, platform: SupportedPlatform): Promise<void> {
  await waitOnPageOrTimer(page, getPlatformCandidatePaceDelayMs(platform));
}

export async function clickLocatorWithMouse(locator: Locator, page: Page, timeoutMs: number): Promise<boolean> {
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  const boundingBox = (locator as Partial<Pick<Locator, 'boundingBox'>>).boundingBox?.bind(locator);
  const scrollIntoViewIfNeeded = (locator as Partial<Pick<Locator, 'scrollIntoViewIfNeeded'>>).scrollIntoViewIfNeeded?.bind(locator);

  if (!mouse || !boundingBox) {
    return false;
  }

  await scrollIntoViewIfNeeded?.({ timeout: timeoutMs }).catch(() => undefined);
  const box = await boundingBox({ timeout: timeoutMs }).catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) {
    return false;
  }

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await mouse.move(targetX + randomIntBetween(-80, 80), targetY + randomIntBetween(-40, 40), { steps: randomIntBetween(3, 6) }).catch(() => undefined);
  await mouse.move(targetX, targetY, { steps: randomIntBetween(8, 16) });
  await mouse.click(targetX, targetY);
  return true;
}

export async function clickPlatformLocator(
  locator: Locator,
  page: Page,
  platform: SupportedPlatform,
  timeoutMs: number,
  options: { force?: boolean } = {},
): Promise<void> {
  await waitPlatformActionPace(page, platform);
  if (!options.force && await clickLocatorWithMouse(locator, page, timeoutMs)) {
    return;
  }

  await locator.click({ timeout: timeoutMs, force: options.force }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await locator.click();
  });
}

export async function fillPlatformLocator(
  locator: Locator,
  page: Page,
  platform: SupportedPlatform,
  value: string,
  timeoutMs: number,
): Promise<void> {
  await waitPlatformActionPace(page, platform);
  await locator.fill(value, { timeout: timeoutMs });
}
