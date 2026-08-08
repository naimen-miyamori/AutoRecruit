import type { Locator, Page } from 'playwright';
import { clickPagePointWithMouse, waitOnPageOrTimer } from '../../../browser/pacing.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { CandidatePostOpenActions } from '../../types.js';
import { assertLiepinAuthenticated } from './authentication.js';
import {
  clickLiepinLocator,
  createLiepinActionDeadline as createDeadline,
  liepinActionTimeoutMs,
  remainingLiepinActionMs as remainingTime,
  waitLiepinActionPace,
  waitLiepinActionPaceWithoutPage,
} from './context.js';

const liepinForwardDialogSelector = [
  '[role="dialog"]',
  '.ant-modal',
  '.semi-modal',
  '.modal',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="popover"]',
].join(', ');
const liepinForwardActionTargetAttribute = 'data-autorecruit-liepin-forward-target';
const liepinForwardContactTargetAttribute = 'data-autorecruit-liepin-forward-contact-target';
const liepinDetailPollIntervalMs = 250;

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function buildExactTextPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

async function waitForLiepinForwardingPageReady(page: Page, deadline: number): Promise<void> {
  let lastError: unknown;
  while (remainingTime(deadline) > 1) {
    try {
      await assertLiepinAuthenticated(page);
      return;
    } catch (error) {
      lastError = error;
    }
    await waitOnPageOrTimer(page, Math.min(remainingTime(deadline), liepinDetailPollIntervalMs));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function clickFirstVisibleLiepinLocator(locators: Locator[], timeoutMs: number): Promise<boolean> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    const candidates = count > 0
      ? Array.from({ length: count }, (_, index) => locator.nth(index))
      : [locator.first()];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
        continue;
      }

      const page = candidate.page?.();
      if (page) {
        await clickLiepinLocator(candidate, page, timeoutMs);
      } else {
        await waitLiepinActionPaceWithoutPage();
        await candidate.click({ timeout: timeoutMs });
      }
      return true;
    }
  }

  return false;
}

async function findLiepinForwardDialog(page: Page, timeoutMs: number): Promise<Locator | undefined> {
  const deadline = createDeadline(timeoutMs);

  while (remainingTime(deadline) > 1) {
    const dialogs = page.locator(liepinForwardDialogSelector, { hasText: /常联系的顾问|常用联系人|联系人|顾问|确认|确定|转发|发送/ });
    const count = await dialogs.count().catch(() => 0);

    for (let index = Math.max(count - 1, 0); index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      try {
        const waitTimeoutMs = Math.max(1, Math.min(remainingTime(deadline), 1000));
        await dialog.waitFor({ state: 'visible', timeout: waitTimeoutMs });
        const text = normalizeText(await dialog.innerText({ timeout: waitTimeoutMs }).catch(() => ''));
        if (text && text !== '转发简历') {
          return dialog;
        }
      } catch {
        continue;
      }
    }

    await waitOnPageOrTimer(page, Math.min(remainingTime(deadline), liepinDetailPollIntervalMs));
  }

  return undefined;
}

async function clickLiepinLocatorAndWaitForForwardDialog(locator: Locator, timeoutMs: number): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  const candidates = count > 0
    ? Array.from({ length: count }, (_, index) => locator.nth(index))
    : [locator.first()];

  for (const candidate of candidates) {
    if (!(await candidate.isVisible({ timeout: timeoutMs }).catch(() => false))) {
      continue;
    }

    const page = candidate.page();
    await clickLiepinLocator(candidate, page, timeoutMs);

    if (await findLiepinForwardDialog(page, timeoutMs)) {
      return true;
    }

    throw new Error('Clicked the visible Liepin resume forward action, but the forward dialog did not open. Stopping without trying alternate matches.');
  }

  return false;
}

type LiepinForwardActionClickPoint = {
  x: number;
  y: number;
  description: string;
};

function isLiepinForwardActionClickPoint(value: unknown): value is LiepinForwardActionClickPoint {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<LiepinForwardActionClickPoint>;
  return typeof candidate.x === 'number'
    && Number.isFinite(candidate.x)
    && typeof candidate.y === 'number'
    && Number.isFinite(candidate.y);
}

async function clickLiepinDomForwardActionAndWait(page: Page, timeoutMs: number): Promise<boolean> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  if (!evaluate || !mouse) {
    return false;
  }

  const clickPoint = await evaluate((targetAttribute) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const isHTMLElement = (element: Element | null): element is HTMLElement => element instanceof HTMLElement;
    const isVisibleRect = (rect: DOMRect | ClientRect) => rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth;
    const isVisible = (element: Element | null) => {
      if (!isHTMLElement(element)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return isVisibleRect(rect)
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const directText = (element: Element) => Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    const isClickLike = (element: HTMLElement) => {
      const tagName = element.tagName.toLowerCase();
      const role = element.getAttribute('role') ?? '';
      const className = typeof element.className === 'string' ? element.className : '';
      const style = window.getComputedStyle(element);
      return tagName === 'button'
        || tagName === 'a'
        || role === 'button'
        || style.cursor === 'pointer'
        || Boolean(element.getAttribute('onclick'))
        || /button|btn|action|operate|forward|share|item|tool|icon/i.test(className);
    };
    const chooseClickElement = (element: HTMLElement) => {
      let best = element;
      let current: HTMLElement | null = element;
      let depth = 0;

      while (current && current !== document.body && depth < 6) {
        if (!isVisible(current)) {
          current = current.parentElement;
          depth += 1;
          continue;
        }

        const rect = current.getBoundingClientRect();
        const text = normalize(current.textContent);
        const compact = rect.width <= 260 && rect.height <= 120 && text.length <= 24;
        if (compact) {
          best = current;
        }
        if (compact && isClickLike(current)) {
          return current;
        }

        current = current.parentElement;
        depth += 1;
      }

      return best;
    };
    const scoreCandidate = (element: HTMLElement, pointRect: DOMRect | ClientRect, source: string) => {
      const clickElement = chooseClickElement(element);
      const rect = clickElement.getBoundingClientRect();
      const text = normalize(clickElement.textContent);
      const className = typeof clickElement.className === 'string' ? clickElement.className : '';
      const tagName = clickElement.tagName.toLowerCase();
      const style = window.getComputedStyle(clickElement);
      let score = 0;

      if (source === 'text-node') {
        score += 70;
      } else if (source === 'own-text') {
        score += 60;
      } else if (source === 'accessible-label') {
        score += 45;
      } else {
        score += 25;
      }
      if (text === '转发') {
        score += 30;
      } else if (/转发/.test(text) && text.length <= 12) {
        score += 12;
      } else if (text.length > 30) {
        score -= 70;
      }
      if (tagName === 'button' || tagName === 'a') {
        score += 20;
      }
      if (clickElement.getAttribute('role') === 'button') {
        score += 16;
      }
      if (style.cursor === 'pointer') {
        score += 16;
      }
      if (/button|btn|action|operate|forward|share|item|tool|icon/i.test(className)) {
        score += 12;
      }
      if (rect.width <= 180 && rect.height <= 80) {
        score += 12;
      }
      if (rect.width > 360 || rect.height > 180) {
        score -= 45;
      }
      if (clickElement === document.body || clickElement === document.documentElement) {
        score -= 1000;
      }

      return {
        clickElement,
        pointRect,
        score,
        source,
      };
    };
    const candidates: Array<ReturnType<typeof scoreCandidate>> = [];
    const pushCandidate = (element: Element | null, rect: DOMRect | ClientRect, source: string) => {
      if (!isHTMLElement(element) || !isVisible(element) || !isVisibleRect(rect)) {
        return;
      }

      candidates.push(scoreCandidate(element, rect, source));
    };

    document.querySelectorAll(`[${targetAttribute}]`).forEach((element) => {
      element.removeAttribute(targetAttribute);
    });

    const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], span, div, p, i, svg'));
    for (const element of allElements) {
      if (!isHTMLElement(element) || !isVisible(element)) {
        continue;
      }

      const ownText = normalize(directText(element));
      const accessibleLabel = normalize(`${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`);
      const className = typeof element.className === 'string' ? element.className : '';
      if (ownText === '转发') {
        pushCandidate(element, element.getBoundingClientRect(), 'own-text');
      } else if (accessibleLabel === '转发' || accessibleLabel === '转给同事' || accessibleLabel === '分享') {
        pushCandidate(element, element.getBoundingClientRect(), 'accessible-label');
      } else if (/forward|share/i.test(className) && /转发|转给同事|分享/.test(normalize(element.textContent))) {
        pushCandidate(element, element.getBoundingClientRect(), 'semantic-class');
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      if (normalize(currentNode.textContent) === '转发') {
        const parent = currentNode.parentElement;
        const range = document.createRange();
        range.selectNodeContents(currentNode);
        const rects = Array.from(range.getClientRects()).filter(isVisibleRect);
        const fallbackRect = parent?.getBoundingClientRect();

        for (const rect of rects) {
          pushCandidate(parent, rect, 'text-node');
        }
        if (rects.length === 0 && fallbackRect) {
          pushCandidate(parent, fallbackRect, 'text-node');
        }
        range.detach();
      }

      currentNode = walker.nextNode();
    }

    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0];
    if (!selected) {
      return null;
    }

    selected.clickElement.setAttribute(targetAttribute, 'true');
    return {
      x: Math.round((selected.pointRect.left + selected.pointRect.width / 2) * 100) / 100,
      y: Math.round((selected.pointRect.top + selected.pointRect.height / 2) * 100) / 100,
      description: `${selected.source}:${selected.clickElement.tagName.toLowerCase()}.${typeof selected.clickElement.className === 'string' ? selected.clickElement.className : ''}`.slice(0, 160),
    };
  }, liepinForwardActionTargetAttribute).catch(() => undefined);

  if (!isLiepinForwardActionClickPoint(clickPoint)) {
    return false;
  }

  try {
    await waitLiepinActionPace(page);
    await clickPagePointWithMouse(page, clickPoint);
  } catch (error) {
    throw new Error(`Failed to click the selected Liepin resume forward action. Stopping without trying alternate matches. Cause: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (await findLiepinForwardDialog(page, timeoutMs)) {
    return true;
  }

  throw new Error('Clicked the selected Liepin resume forward action, but the forward dialog did not open. Stopping without trying alternate matches.');
}

async function clickLiepinForwardAction(page: Page, timeoutMs: number): Promise<void> {
  if (await clickLiepinDomForwardActionAndWait(page, timeoutMs)) {
    return;
  }

  const roleLookup = (page as Partial<Pick<Page, 'getByRole'>>).getByRole?.bind(page);
  const locators: Locator[] = [];

  if (roleLookup) {
    locators.push(roleLookup('button', { name: /^转发$/ }));
    locators.push(roleLookup('button', { name: /转发|转给同事|分享/ }));
  }

  locators.push(page.locator('button, a, [role="button"], [class*="button"], [class*="btn"], [class*="action"], [class*="operate"], [class*="forward"], [class*="share"]', { hasText: /^\s*转发\s*$/ }));
  locators.push(page.locator('button, a, [role="button"]', { hasText: /转发|转给同事|分享/ }));
  locators.push(page.locator('span, div, p', { hasText: /^\s*转发\s*$/ }));
  locators.push(page.getByText(/^\s*转发\s*$/, { exact: false }));

  for (const locator of locators) {
    if (await clickLiepinLocatorAndWaitForForwardDialog(locator, timeoutMs)) {
      return;
    }
  }

  throw new Error('Could not find or click the visible Liepin resume forward action, or the forward dialog did not open after clicking.');
}

async function getLiepinForwardDialog(page: Page, timeoutMs: number): Promise<Locator> {
  const dialog = await findLiepinForwardDialog(page, timeoutMs);
  if (dialog) {
    return dialog;
  }

  const body = page.locator('body');
  await body.waitFor({ state: 'visible', timeout: timeoutMs });
  return body;
}

type LiepinForwardContactClickPoint = {
  x: number;
  y: number;
  description: string;
};

type LiepinForwardContactClickResult = {
  points: LiepinForwardContactClickPoint[];
  diagnostic: string;
};

function isLiepinForwardContactClickPoint(value: unknown): value is LiepinForwardContactClickPoint {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<LiepinForwardContactClickPoint>;
  return typeof candidate.x === 'number'
    && Number.isFinite(candidate.x)
    && typeof candidate.y === 'number'
    && Number.isFinite(candidate.y);
}

function isLiepinForwardContactClickResult(value: unknown): value is LiepinForwardContactClickResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<LiepinForwardContactClickResult>;
  return Array.isArray(candidate.points)
    && candidate.points.every(isLiepinForwardContactClickPoint)
    && typeof candidate.diagnostic === 'string';
}

async function clickLiepinDomFrequentContact(page: Page, contactName: string, timeoutMs: number): Promise<boolean> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  if (!evaluate) {
    return false;
  }

  const result = await evaluate(({ name, targetAttribute, dialogSelector }) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const isHTMLElement = (element: Element | null): element is HTMLElement => element instanceof HTMLElement;
    const isVisibleRect = (rect: DOMRect | ClientRect) => rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth;
    const isVisible = (element: Element | null) => {
      if (!isHTMLElement(element)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return isVisibleRect(rect)
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const directText = (element: Element) => Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    const visibleDialogs = Array.from(document.querySelectorAll(dialogSelector))
      .filter(isVisible);
    const roots = visibleDialogs.length > 0 ? visibleDialogs : [document.body].filter(isVisible);

    document.querySelectorAll(`[${targetAttribute}]`).forEach((element) => {
      element.removeAttribute(targetAttribute);
    });

    const isClickLike = (element: HTMLElement) => {
      const tagName = element.tagName.toLowerCase();
      const role = element.getAttribute('role') ?? '';
      const className = typeof element.className === 'string' ? element.className : '';
      const style = window.getComputedStyle(element);
      return tagName === 'button'
        || tagName === 'a'
        || tagName === 'label'
        || role === 'button'
        || role === 'checkbox'
        || role === 'option'
        || style.cursor === 'pointer'
        || Boolean(element.getAttribute('onclick'))
        || /checkbox|contact|user|item|option|select|row|list/i.test(className);
    };
    const nearestContactCard = (element: HTMLElement) => {
      let best: HTMLElement = element;
      let current: HTMLElement | null = element;
      let depth = 0;

      while (current && current !== document.body && depth < 8) {
        if (!isVisible(current)) {
          current = current.parentElement;
          depth += 1;
          continue;
        }

        const rect = current.getBoundingClientRect();
        const text = normalize(current.textContent);
        const compact = rect.width <= 520 && rect.height <= 220 && text.includes(name) && text.length <= 140;
        const hasAboveNameMedia = Array.from(current.querySelectorAll('img, picture, canvas, svg, [class*="avatar"], [class*="Avatar"], [class*="photo"], [class*="Photo"], [class*="head"], [class*="Head"], [class*="portrait"], [class*="Portrait"], [style*="background-image"]'))
          .filter((candidate): candidate is HTMLElement => isHTMLElement(candidate) && isVisible(candidate))
          .some((candidate) => {
            const mediaRect = candidate.getBoundingClientRect();
            return isVisibleRect(mediaRect)
              && mediaRect.width <= 140
              && mediaRect.height <= 140
              && mediaRect.top >= rect.top - 4
              && mediaRect.bottom <= rect.bottom + 4
              && mediaRect.top < element.getBoundingClientRect().top;
          });
        if (compact) {
          best = current;
        }
        if (compact && hasAboveNameMedia) {
          return current;
        }
        if (compact && isClickLike(current) && current !== element) {
          return current;
        }

        current = current.parentElement;
        depth += 1;
      }

      return best;
    };
    const pushPoint = (
      points: LiepinForwardContactClickPoint[],
      seen: Set<string>,
      x: number,
      y: number,
      description: string,
    ) => {
      const roundedX = Math.round(x * 100) / 100;
      const roundedY = Math.round(y * 100) / 100;
      const key = `${Math.round(roundedX)}:${Math.round(roundedY)}`;
      if (
        seen.has(key)
        || roundedX < 0
        || roundedY < 0
        || roundedX > window.innerWidth
        || roundedY > window.innerHeight
      ) {
        return;
      }

      const elementAtPoint = document.elementFromPoint(roundedX, roundedY);
      if (!elementAtPoint || !isVisible(elementAtPoint)) {
        return;
      }

      seen.add(key);
      points.push({
        x: roundedX,
        y: roundedY,
        description: description.slice(0, 160),
      });
    };
    const buildClickPoints = (card: HTMLElement, textRect: DOMRect | ClientRect, source: string) => {
      const points: LiepinForwardContactClickPoint[] = [];
      const seen = new Set<string>();
      const cardRect = card.getBoundingClientRect();
      let hasNameAboveImagePoint = false;
      const aboveNameMedia = Array.from(card.querySelectorAll('img, picture, canvas, svg, [class*="avatar"], [class*="Avatar"], [class*="photo"], [class*="Photo"], [class*="head"], [class*="Head"], [class*="portrait"], [class*="Portrait"], [style*="background-image"]'))
        .filter((element): element is HTMLElement => isHTMLElement(element) && isVisible(element))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => {
          if (!isVisibleRect(rect) || rect.width > 140 || rect.height > 140) {
            return false;
          }

          const mediaCenterX = rect.left + rect.width / 2;
          const textCenterX = textRect.left + textRect.width / 2;
          const horizontalDistance = Math.abs(mediaCenterX - textCenterX);
          const isAboveName = rect.top < textRect.top && rect.bottom <= textRect.top + 18;
          const isInsideCard = rect.left >= cardRect.left - 4
            && rect.right <= cardRect.right + 4
            && rect.top >= cardRect.top - 4
            && rect.bottom <= cardRect.bottom + 4;
          return isAboveName && isInsideCard && horizontalDistance <= Math.max(80, cardRect.width * 0.45);
        })
        .sort((left, right) => {
          const leftCenterX = left.rect.left + left.rect.width / 2;
          const rightCenterX = right.rect.left + right.rect.width / 2;
          const textCenterX = textRect.left + textRect.width / 2;
          const leftDistance = Math.abs(leftCenterX - textCenterX) + Math.abs(left.rect.bottom - textRect.top);
          const rightDistance = Math.abs(rightCenterX - textCenterX) + Math.abs(right.rect.bottom - textRect.top);
          return leftDistance - rightDistance;
        })[0];

      if (aboveNameMedia) {
        hasNameAboveImagePoint = true;
        pushPoint(
          points,
          seen,
          aboveNameMedia.rect.left + aboveNameMedia.rect.width / 2,
          aboveNameMedia.rect.top + aboveNameMedia.rect.height / 2,
          `${source}:name-above-image:${aboveNameMedia.element.tagName.toLowerCase()}`,
        );
      } else if (isVisibleRect(cardRect) && textRect.top - cardRect.top > 24) {
        hasNameAboveImagePoint = true;
        pushPoint(
          points,
          seen,
          textRect.left + textRect.width / 2,
          cardRect.top + Math.max(16, (textRect.top - cardRect.top) / 2),
          `${source}:name-above-image-fallback:${card.tagName.toLowerCase()}`,
        );
      }

      if (hasNameAboveImagePoint) {
        return points;
      }

      const controls = Array.from(card.querySelectorAll('input[type="checkbox"], [role="checkbox"], label, button, a, .ant-checkbox, .semi-checkbox, [class*="checkbox"], [class*="radio"], [class*="select"], [class*="avatar"], [class*="photo"], [class*="head"], [class*="item"]'))
        .filter((element): element is HTMLElement => isHTMLElement(element) && isVisible(element));
      const control = controls
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => isVisibleRect(rect) && rect.width <= 120 && rect.height <= 120)
        .sort((left, right) => {
          const leftDistance = Math.abs(left.rect.left - cardRect.left) + Math.abs(left.rect.top - cardRect.top);
          const rightDistance = Math.abs(right.rect.left - cardRect.left) + Math.abs(right.rect.top - cardRect.top);
          return leftDistance - rightDistance;
        })[0];

      if (control) {
        pushPoint(points, seen, control.rect.left + control.rect.width / 2, control.rect.top + control.rect.height / 2, `${source}:control:${control.element.tagName.toLowerCase()}`);
      }

      if (isVisibleRect(cardRect) && cardRect.width <= 520 && cardRect.height <= 220) {
        pushPoint(points, seen, cardRect.left + cardRect.width / 2, cardRect.top + cardRect.height / 2, `${source}:card-center:${card.tagName.toLowerCase()}`);
        pushPoint(points, seen, cardRect.left + Math.min(44, Math.max(12, cardRect.width * 0.25)), cardRect.top + cardRect.height / 2, `${source}:card-left:${card.tagName.toLowerCase()}`);
        pushPoint(points, seen, cardRect.left + cardRect.width / 2, cardRect.top + Math.min(44, Math.max(12, cardRect.height * 0.35)), `${source}:card-upper:${card.tagName.toLowerCase()}`);
      }

      pushPoint(points, seen, textRect.left + textRect.width / 2, textRect.top + textRect.height / 2, `${source}:text:${card.tagName.toLowerCase()}`);
      return points;
    };
    const scoreCandidate = (element: HTMLElement, rect: DOMRect | ClientRect, source: string) => {
      const card = nearestContactCard(element);
      const clickPoints = buildClickPoints(card, rect, source);
      const cardRect = card.getBoundingClientRect();
      const text = normalize(card.textContent);
      const className = typeof card.className === 'string' ? card.className : '';
      let score = 0;

      if (normalize(directText(element)) === name) {
        score += 50;
      }
      if (normalize(element.textContent) === name) {
        score += 35;
      }
      if (source === 'text-node') {
        score += 40;
      }
      if (isClickLike(card)) {
        score += 20;
      }
      if (/checkbox|contact|user|item|option|select|row|list/i.test(className)) {
        score += 15;
      }
      if (clickPoints.some((point) => point.description.includes(':control:'))) {
        score += 35;
      }
      if (text === name || text.length <= 40) {
        score += 10;
      }
      if (cardRect.width > 640 || cardRect.height > 260 || text.length > 180) {
        score -= 45;
      }
      if (card === document.body || card === document.documentElement) {
        score -= 1000;
      }

      return {
        card,
        clickPoints,
        score,
        source,
      };
    };
    const candidates: Array<ReturnType<typeof scoreCandidate>> = [];
    const pushCandidate = (element: Element | null, rect: DOMRect | ClientRect, source: string) => {
      if (!isHTMLElement(element) || !isVisible(element) || !isVisibleRect(rect)) {
        return;
      }

      candidates.push(scoreCandidate(element, rect, source));
    };

    document.querySelectorAll(`[${targetAttribute}]`).forEach((element) => {
      element.removeAttribute(targetAttribute);
    });

    for (const root of roots) {
      root.querySelectorAll('li, [role="option"], [role="checkbox"], label, span, div, p').forEach((element) => {
        if (!isHTMLElement(element) || !isVisible(element)) {
          return;
        }

        const ownText = normalize(directText(element));
        const text = normalize(element.textContent);
        if (ownText === name || text === name) {
          pushCandidate(element, element.getBoundingClientRect(), 'element');
        }
      });

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let currentNode = walker.nextNode();
      while (currentNode) {
        if (normalize(currentNode.textContent) === name) {
          const parent = currentNode.parentElement;
          const range = document.createRange();
          range.selectNodeContents(currentNode);
          const rects = Array.from(range.getClientRects()).filter(isVisibleRect);
          const fallbackRect = parent?.getBoundingClientRect();

          for (const rect of rects) {
            pushCandidate(parent, rect, 'text-node');
          }
          if (rects.length === 0 && fallbackRect) {
            pushCandidate(parent, fallbackRect, 'text-node');
          }
          range.detach();
        }

        currentNode = walker.nextNode();
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0];
    if (!selected || selected.clickPoints.length === 0) {
      return {
        points: [],
        diagnostic: candidates.length === 0
          ? `No visible contact candidate for ${name}`
          : `No visible click point for ${name}`,
      };
    }

    selected.card.setAttribute(targetAttribute, 'true');
    return {
      points: selected.clickPoints,
      diagnostic: `score=${selected.score};source=${selected.source};card=${selected.card.tagName.toLowerCase()}.${typeof selected.card.className === 'string' ? selected.card.className : ''};text=${normalize(selected.card.textContent).slice(0, 120)}`,
    };
  }, {
    name: contactName,
    targetAttribute: liepinForwardContactTargetAttribute,
    dialogSelector: liepinForwardDialogSelector,
  }).catch(() => undefined);

  if (!mouse || !isLiepinForwardContactClickResult(result) || result.points.length === 0) {
    return false;
  }

  try {
    for (const point of result.points.slice(0, 1)) {
      console.log(`Clicking Liepin frequent forward contact "${contactName}" at ${point.x},${point.y} (${point.description}; ${result.diagnostic})`);
      await waitLiepinActionPace(page);
      await clickPagePointWithMouse(page, point);
      await waitLiepinActionPace(page);
    }

    return true;
  } catch (error) {
    throw new Error(`Failed to click the selected Liepin frequent forward contact "${contactName}". Stopping without trying alternate matches. Cause: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function clickLiepinDomConfirmForward(page: Page): Promise<boolean> {
  const evaluate = (page as Partial<Pick<Page, 'evaluate'>>).evaluate?.bind(page);
  const mouse = (page as Partial<Pick<Page, 'mouse'>>).mouse;
  if (!evaluate || !mouse) {
    return false;
  }

  const clickPoint = await evaluate((dialogSelector) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const isHTMLElement = (element: Element | null): element is HTMLElement => element instanceof HTMLElement;
    const isVisible = (element: Element | null) => {
      if (!isHTMLElement(element)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };

    const dialogs = Array.from(document.querySelectorAll(dialogSelector)).filter(isVisible);
    const roots = dialogs.length > 0 ? dialogs : [document.body].filter(isVisible);
    for (const root of roots) {
      const candidates = Array.from(root.querySelectorAll('button, [role="button"], a, [class*="button"], [class*="btn"], span, div'))
        .filter(isHTMLElement)
        .filter(isVisible)
        .filter((element) => /^(确认转发|确定转发|转发|确认|确定|发送)$/.test(normalize(element.textContent)))
        .sort((left, right) => {
          const leftButton = left.tagName.toLowerCase() === 'button' || left.getAttribute('role') === 'button' ? 0 : 1;
          const rightButton = right.tagName.toLowerCase() === 'button' || right.getAttribute('role') === 'button' ? 0 : 1;
          return leftButton - rightButton;
      });
      const selected = candidates[0];
      if (selected) {
        const rect = selected.getBoundingClientRect();
        return {
          x: Math.round((rect.left + rect.width / 2) * 100) / 100,
          y: Math.round((rect.top + rect.height / 2) * 100) / 100,
          description: `confirm:${selected.tagName.toLowerCase()}.${typeof selected.className === 'string' ? selected.className : ''}`.slice(0, 160),
        };
      }
    }

    return null;
  }, liepinForwardDialogSelector).catch(() => undefined);

  if (!isLiepinForwardContactClickPoint(clickPoint)) {
    return false;
  }

  await waitLiepinActionPace(page);
  await clickPagePointWithMouse(page, clickPoint);
  return true;
}

async function selectLiepinFrequentForwardContact(page: Page, contactName: string, timeoutMs: number): Promise<void> {
  const dialog = await getLiepinForwardDialog(page, timeoutMs);
  const exactContact = buildExactTextPattern(contactName);
  if (await clickLiepinDomFrequentContact(page, contactName, timeoutMs)) {
    return;
  }

  const preciseLocators: Locator[] = [
    dialog.getByText(exactContact, { exact: false }).first(),
    page.getByText(exactContact, { exact: false }).first(),
  ];

  if (await clickFirstVisibleLiepinLocator(preciseLocators, Math.min(timeoutMs, 2000))) {
    await waitLiepinActionPace(page);
    return;
  }

  const containers = ['li', '[role="option"]', '[role="checkbox"]', 'label', '.ant-checkbox-wrapper', '.semi-checkbox', '[class*="contact"]', '[class*="user"]', '[class*="item"]', 'div', 'span'];
  const locators: Locator[] = [
    dialog.getByText(exactContact, { exact: false }).first(),
    dialog.locator(containers.join(', '), { hasText: exactContact }).first(),
    page.locator(containers.join(', '), { hasText: exactContact }).first(),
    page.getByText(exactContact, { exact: false }).first(),
  ];

  const selected = await clickFirstVisibleLiepinLocator(locators, timeoutMs);
  if (!selected) {
    const dialogText = await dialog.innerText({ timeout: timeoutMs }).catch(() => '');
    throw new Error(`Could not select Liepin frequent forward contact "${contactName}". Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  }
}

async function confirmLiepinForward(page: Page, contactName: string, timeoutMs: number): Promise<void> {
  if (await clickLiepinDomConfirmForward(page)) {
    await waitLiepinActionPace(page);
    return;
  }

  const dialog = await getLiepinForwardDialog(page, timeoutMs);
  const roleLookup = (page as Partial<Pick<Page, 'getByRole'>>).getByRole?.bind(page);
  const locators: Locator[] = [];
  const clickableSelector = 'button, [role="button"], a, [class*="button"], [class*="btn"]';
  const exactConfirmPattern = /^\s*(确认转发|确定转发|转\s*发|确\s*认|确\s*定|发\s*送)\s*$/;
  const looseConfirmPattern = /确认转发|确定转发|确\s*认|确\s*定|发\s*送/;

  locators.push(dialog.locator(clickableSelector, { hasText: exactConfirmPattern }).first());
  if (roleLookup) {
    locators.push(roleLookup('button', { name: exactConfirmPattern }).first());
  }
  locators.push(page.locator(clickableSelector, { hasText: exactConfirmPattern }).first());
  locators.push(dialog.locator(clickableSelector, { hasText: looseConfirmPattern }).first());
  locators.push(dialog.getByText(looseConfirmPattern, { exact: false }).first());

  const confirmed = await clickFirstVisibleLiepinLocator(locators, timeoutMs);
  if (!confirmed) {
    const dialogText = await dialog.innerText({ timeout: timeoutMs }).catch(() => '');
    throw new Error(`Could not confirm Liepin resume forward to "${contactName}". Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  }

  await waitLiepinActionPace(page);
}

export async function forwardLiepinResumeToFrequentContact(
  page: Page,
  contactName: string,
  mode: NonNullable<CandidatePostOpenActions['liepinForwardContactMode']> = 'confirm',
): Promise<void> {
  const normalizedContactName = normalizeText(contactName);
  if (!normalizedContactName) {
    return;
  }

  const deadline = createDeadline();
  await waitForLiepinForwardingPageReady(page, deadline);
  await clickLiepinForwardAction(page, liepinActionTimeoutMs());
  await selectLiepinFrequentForwardContact(page, normalizedContactName, liepinActionTimeoutMs());
  if (mode === 'select-only') {
    return;
  }
  await confirmLiepinForward(page, normalizedContactName, liepinActionTimeoutMs());
}

export async function runLiepinPostOpenActions(page: Page, candidate: CandidateListItem, actions: CandidatePostOpenActions): Promise<void> {
  if (actions.liepinForwardContact) {
    await forwardLiepinResumeToFrequentContact(page, actions.liepinForwardContact, actions.liepinForwardContactMode);
  }
}

