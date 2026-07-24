import type { Locator, Page } from 'playwright';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';

export interface MousePointerPoint {
  x: number;
  y: number;
}

export interface MouseTrajectorySegment extends MousePointerPoint {
  steps: number;
}

const pointerPositionByScope = new WeakMap<object, MousePointerPoint>();
const continuousMouseBridgePages = new WeakSet<Page>();
export const continuousMouseBridgeName = '__autorecruitMoveMouseContinuously';

export function randomIntBetween(min: number, max: number): number {
  const lower = Math.max(0, Math.floor(Math.min(min, max)));
  const upper = Math.max(lower, Math.floor(Math.max(min, max)));
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function distanceBetween(start: MousePointerPoint, end: MousePointerPoint): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function trajectorySteps(start: MousePointerPoint, end: MousePointerPoint): number {
  return Math.max(3, Math.ceil(distanceBetween(start, end) / 28));
}

export function buildContinuousMouseTrajectory(
  start: MousePointerPoint,
  target: MousePointerPoint,
): MouseTrajectorySegment[] {
  const distance = distanceBetween(start, target);
  if (distance < 1) {
    return [{ ...target, steps: 1 }];
  }

  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const perpendicularX = -dy / distance;
  const perpendicularY = dx / distance;
  const bend = Math.min(96, Math.max(10, distance * (0.08 + Math.random() * 0.08)))
    * (Math.random() < 0.5 ? -1 : 1);
  const first = {
    x: start.x + dx * 0.35 + perpendicularX * bend,
    y: start.y + dy * 0.35 + perpendicularY * bend,
  };
  const second = {
    x: start.x + dx * 0.72 - perpendicularX * bend * 0.3,
    y: start.y + dy * 0.72 - perpendicularY * bend * 0.3,
  };

  return [
    { ...first, steps: trajectorySteps(start, first) },
    { ...second, steps: trajectorySteps(first, second) },
    { ...target, steps: trajectorySteps(second, target) },
  ];
}

export async function moveMouseContinuously(
  page: Page,
  target: MousePointerPoint,
): Promise<boolean> {
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  if (!mouse) {
    return false;
  }

  const context = (page as Partial<Pick<Page, 'context'>>).context?.();
  const pointerScope = context ?? page;
  const start = pointerPositionByScope.get(pointerScope) ?? { x: 0, y: 0 };
  let segmentStart = start;
  for (const segment of buildContinuousMouseTrajectory(start, target)) {
    for (let step = 1; step <= segment.steps; step += 1) {
      const progress = step / segment.steps;
      await mouse.move(
        segmentStart.x + (segment.x - segmentStart.x) * progress,
        segmentStart.y + (segment.y - segmentStart.y) * progress,
      );
      pointerPositionByScope.set(pointerScope, {
        x: segmentStart.x + (segment.x - segmentStart.x) * progress,
        y: segmentStart.y + (segment.y - segmentStart.y) * progress,
      });
    }
    segmentStart = segment;
  }
  pointerPositionByScope.set(pointerScope, target);
  return true;
}

export async function ensureContinuousMouseBridge(page: Page): Promise<void> {
  if (continuousMouseBridgePages.has(page)) {
    return;
  }

  const exposeFunction = (page as Partial<Pick<Page, 'exposeFunction'>>).exposeFunction?.bind(page);
  if (!exposeFunction) {
    return;
  }

  await exposeFunction(continuousMouseBridgeName, async (point: MousePointerPoint) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return false;
    }
    return moveMouseContinuously(page, point);
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|already registered|has been already/i.test(message)) {
      throw error;
    }
  });
  continuousMouseBridgePages.add(page);
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

export async function clickLocatorWithMouse(
  locator: Locator,
  page: Page,
  timeoutMs: number,
  options: { position?: MousePointerPoint } = {},
): Promise<boolean> {
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

  const horizontalInset = Math.min(Math.max(box.width * 0.2, 2), box.width / 2);
  const verticalInset = Math.min(Math.max(box.height * 0.2, 2), box.height / 2);
  const targetX = options.position
    ? Math.min(box.x + box.width, Math.max(box.x, box.x + options.position.x))
    : randomIntBetween(
      Math.round(box.x + horizontalInset),
      Math.round(box.x + box.width - horizontalInset),
    );
  const targetY = options.position
    ? Math.min(box.y + box.height, Math.max(box.y, box.y + options.position.y))
    : randomIntBetween(
      Math.round(box.y + verticalInset),
      Math.round(box.y + box.height - verticalInset),
    );
  await moveMouseContinuously(page, { x: targetX, y: targetY });
  await mouse.click(targetX, targetY);
  return true;
}

export async function moveMouseToLocatorCenter(
  locator: Locator,
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  return moveMouseToLocatorPosition(locator, page, timeoutMs);
}

export async function moveMouseToLocatorPosition(
  locator: Locator,
  page: Page,
  timeoutMs: number,
  position?: MousePointerPoint,
): Promise<boolean> {
  const boundingBox = (locator as Partial<Pick<Locator, 'boundingBox'>>).boundingBox?.bind(locator);
  const scrollIntoViewIfNeeded = (locator as Partial<Pick<Locator, 'scrollIntoViewIfNeeded'>>).scrollIntoViewIfNeeded?.bind(locator);
  if (!boundingBox) {
    return false;
  }

  await scrollIntoViewIfNeeded?.({ timeout: timeoutMs }).catch(() => undefined);
  const box = await boundingBox({ timeout: timeoutMs }).catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) {
    return false;
  }

  return moveMouseContinuously(page, {
    x: position
      ? Math.min(box.x + box.width, Math.max(box.x, box.x + position.x))
      : box.x + box.width / 2,
    y: position
      ? Math.min(box.y + box.height, Math.max(box.y, box.y + position.y))
      : box.y + box.height / 2,
  });
}

export async function clickPagePointWithMouse(
  page: Page,
  point: MousePointerPoint,
): Promise<boolean> {
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  if (!mouse || !await moveMouseContinuously(page, point)) {
    return false;
  }

  await mouse.click(point.x, point.y);
  return true;
}

export async function clickPlatformLocator(
  locator: Locator,
  page: Page,
  platform: SupportedPlatform,
  timeoutMs: number,
  options: { force?: boolean; position?: MousePointerPoint } = {},
): Promise<void> {
  await waitPlatformActionPace(page, platform);
  if (!options.force && await clickLocatorWithMouse(locator, page, timeoutMs, { position: options.position })) {
    return;
  }

  await moveMouseToLocatorPosition(locator, page, timeoutMs, options.position).catch(() => false);
  await locator.click({ timeout: timeoutMs, force: options.force, position: options.position }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unexpected argument|too many arguments/i.test(message)) {
      throw error;
    }

    await moveMouseToLocatorCenter(locator, page, timeoutMs).catch(() => false);
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
