import type { Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { BossForwardMode, CandidatePostOpenActions, CandidateProfileDetailOptions } from '../../types.js';
import {
  parseBossResumePayload,
  type BossResumeApiPayload,
} from '../parsing/resume-parser.js';
import {
  clickBossControl,
  clickBossControlNatively,
  runBossAction,
  runBossActionWithinDeadline,
} from './context.js';

const bossResumePayloadCache = new WeakMap<Page, Map<string, BossResumeApiPayload>>();

/**
 * The external click was accepted but the page did not expose a verifiable
 * completion state. Callers must persist this as uncertain and never retry it
 * automatically, because a second click could send a duplicate resume.
 */
export class BossForwardUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossForwardUncertainError';
  }
}

/** The confirmation action was proven not to dispatch a click event. */
export class BossForwardPreConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossForwardPreConfirmationError';
  }
}

/** A retryable detail target mismatch; no resume/history write is safe. */
export class BossResumeIdentityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossResumeIdentityVerificationError';
  }
}

/**
 * Detail cleanup is a safety boundary for normal capture.  If Boss leaves a
 * resume modal visible, the next card action could target the wrong person;
 * callers must stop and leave the page available for inspection instead of
 * treating cleanup as best-effort.
 */
export class BossResumeDetailCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossResumeDetailCloseError';
  }
}

/**
 * A detail-card interaction exposed the Boss search-chat purchase surface
 * instead of the requested resume.  The page is no longer safe for the next
 * card, even when the purchase dialog can be closed successfully.
 */
export class BossUnexpectedContactDialogError extends Error {
  readonly purchaseDialogClosed: boolean;

  constructor(message: string, options: { purchaseDialogClosed?: boolean } = {}) {
    super(message);
    this.name = 'BossUnexpectedContactDialogError';
    this.purchaseDialogClosed = options.purchaseDialogClosed === true;
  }
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function remainingTimeWithReserve(deadline: number, cleanupReserveMs = 0): number {
  return Math.max(deadline - Date.now() - Math.max(cleanupReserveMs, 0), 1);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeEmailList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const email = value.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
}

export async function closeExistingBossResumeDialog(
  page: Page,
  deadline: number,
  options: { pace?: boolean; allowEscapeFallback?: boolean; cleanupReserveMs?: number } & Partial<CandidateProfileDetailOptions> = {},
): Promise<void> {
  const activeDialog = page.locator('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]), .dialog-wrap.active:has(.c-share-box)').first();
  if (await activeDialog.count().catch(() => 0) === 0) return;

  const closeButton = activeDialog.locator('.boss-popup__close, .close-btn, [ka="dialog_close"], .boss-dialog__close').first();
  const closeAction = options.deadline === undefined
    ? () => clickBossControl(closeButton, page, Math.min(remainingTime(deadline), 3000), { pace: options.pace })
    : () => clickBossControlNatively(page, closeButton, Math.min(remainingTime(options.deadline!), 3000), {
      pace: options.pace,
      deadline: options.deadline!,
      cleanupReserveMs: 0,
    });
  await closeAction().catch(async (error) => {
    if (options.allowEscapeFallback === false) {
      throw error;
    }
    const pressEscape = () => page.keyboard.press('Escape');
    if (options.pace === false) {
      await pressEscape().catch(() => undefined);
      return;
    }
    await runBossAction(page, pressEscape).catch(() => undefined);
  });
  await activeDialog.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) }).catch(() => undefined);
}

export async function waitForBossResumeDetailReady(page: Page, deadline: number, cleanupReserveMs = 0): Promise<void> {
  await page.locator('.dialog-wrap.active[data-type="boss-dialog"] iframe[src*="/web/frame/c-resume/"], .dialog-wrap.active iframe[src*="/web/frame/c-resume/"]').first().waitFor({
    state: 'visible',
    timeout: remainingTimeWithReserve(deadline, cleanupReserveMs),
  });
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active');
      const frame = document.querySelector<HTMLIFrameElement>('.dialog-wrap.active iframe[src*="/web/frame/c-resume/"]');
      return Boolean(dialog && frame);
    },
    undefined,
    { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 250 },
  );
  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) throw new Error('Boss resume detail frame did not become available.');
  await detailFrame.locator('canvas#resume, #resume canvas').first().waitFor({
    state: 'visible',
    timeout: remainingTimeWithReserve(deadline, cleanupReserveMs),
  });
}

async function raiseUnexpectedContactDialog(
  page: Page,
  deadline: number,
  context: string,
): Promise<never> {
  try {
    const closed = await closeBossPurchaseChatDialogIfPresent(page, deadline);
    throw new BossUnexpectedContactDialogError(
      `${context}; no forwarding confirmation was attempted; no contact action was attempted.`,
      { purchaseDialogClosed: closed },
    );
  } catch (error) {
    if (error instanceof BossUnexpectedContactDialogError) {
      throw error;
    }
    throw new BossUnexpectedContactDialogError(
      `${context}; purchase dialog cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      { purchaseDialogClosed: false },
    );
  }
}

/**
 * Fails closed when a purchase/contact dialog is visible before a detail
 * lifecycle begins.  Closing the dialog is cleanup only; it never authorizes
 * continuing with another candidate on the same page.
 */
export async function assertNoBossPurchaseChatDialog(page: Page, deadline: number): Promise<void> {
  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) === 0) return;
  await raiseUnexpectedContactDialog(page, deadline, 'Boss search-chat-card purchase dialog was visible before opening the requested resume');
}

/**
 * Waits for the first observable result of a detail click.  A purchase dialog
 * wins over detail readiness and is always converted to a fatal page-safety
 * error; callers must not continue to the next card.
 */
export async function waitForBossResumeDetailOrPurchase(
  page: Page,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = (element: Element): boolean => element instanceof HTMLElement
          && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
          && window.getComputedStyle(element).visibility !== 'hidden';
        const detailVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
          isVisible(dialog) && Boolean(dialog.querySelector('iframe[src*="/web/frame/c-resume/"]')));
        const purchaseVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
          isVisible(dialog)
          && !dialog.querySelector('iframe[src*="/web/frame/c-resume/"]')
          && /搜索畅聊卡|立即购买/.test(dialog.textContent ?? ''));
        return detailVisible || purchaseVisible;
      },
      undefined,
      { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 },
    );
  } catch (error) {
    if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
      await raiseUnexpectedContactDialog(page, deadline, 'Boss detail click exposed a search-chat-card purchase dialog');
    }
    throw error;
  }

  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(page, deadline, 'Boss detail click exposed a search-chat-card purchase dialog');
  }
  await waitForBossResumeDetailReady(page, deadline, cleanupReserveMs);
}

async function readBossResumeApiPayload(
  page: Page,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<BossResumeApiPayload> {
  await waitForBossResumeDetailReady(page, deadline, cleanupReserveMs);
  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) {
    throw new Error('Boss resume detail frame did not become available for parsing.');
  }
  await detailFrame.waitForFunction(
    () => performance.getEntriesByType('resource')
      .some((entry) => /\/wapi\/(?:zpitem\/web\/boss\/search\/geek\/info|zpjob\/view\/geek\/info\/v2)\?/.test(entry.name)),
    undefined,
    { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 },
  );
  return detailFrame.evaluate(async () => {
    const apiUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .reverse()
      .find((url) => /\/wapi\/(?:zpitem\/web\/boss\/search\/geek\/info|zpjob\/view\/geek\/info\/v2)\?/.test(url));
    if (!apiUrl) {
      throw new Error('Boss resume detail API resource was not found in the detail frame.');
    }
    const response = await fetch(apiUrl, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Boss resume detail API returned HTTP ${response.status}.`);
    }
    return response.json();
  }) as Promise<BossResumeApiPayload>;
}

function cacheBossResumePayload(page: Page, candidateId: string, payload: BossResumeApiPayload): void {
  const pageCache = bossResumePayloadCache.get(page) ?? new Map<string, BossResumeApiPayload>();
  pageCache.set(candidateId, payload);
  bossResumePayloadCache.set(page, pageCache);
}

function takeCachedBossResumePayload(page: Page, candidateId: string): BossResumeApiPayload | undefined {
  const pageCache = bossResumePayloadCache.get(page);
  const payload = pageCache?.get(candidateId);
  pageCache?.delete(candidateId);
  return payload;
}

/**
 * Reads the current detail API identity without populating the resume parse
 * cache. History-view synchronisation deliberately uses this action so an
 * already-seen card is opened/verified/closed without becoming a capture or
 * causing any resume payload to be reused by a later parse.
 */
export async function verifyBossResumeDetailIdentity(
  page: Page,
  candidate: CandidateListItem,
  deadline: number = createResumeDetailDeadline(),
  cleanupReserveMs = 0,
): Promise<{ candidateId: string }> {
  bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  const verified = await readVerifiedBossResumePayload(page, candidate, deadline, cleanupReserveMs);
  bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  return { candidateId: verified.detailCandidateId };
}

export function assertBossResumeTarget(payload: BossResumeApiPayload, candidate: CandidateListItem): string {
  const detailCandidateId = payload.zpData?.expectId === undefined || payload.zpData.expectId === null
    ? ''
    : String(payload.zpData.expectId).trim();
  if (!detailCandidateId) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail identity verification failed for candidate ${candidate.candidateId}: detail API omitted expectId.`);
  }

  const sourceMatches = candidate.sourceText
    ? [...candidate.sourceText.matchAll(/data-(?:expect|jid|lid)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
    : [];
  const sourceIdentifiers = [
    candidate.candidateId,
    ...sourceMatches.map((match) => match[1] ?? match[2] ?? match[3]),
  ].filter((value): value is string => Boolean(value)).map((value) => value.trim());
  if (!sourceIdentifiers.includes(detailCandidateId)) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail identity ${detailCandidateId} does not match requested candidate ${candidate.candidateId}.`);
  }
  return detailCandidateId;
}

async function readVerifiedBossResumePayload(
  page: Page,
  candidate: CandidateListItem,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<{ payload: BossResumeApiPayload; detailCandidateId: string }> {
  const payload = await readBossResumeApiPayload(page, deadline, cleanupReserveMs);
  if (payload.code !== 0) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail API failed: ${payload.message ?? `code ${payload.code ?? 'omitted'}`}`);
  }
  return {
    payload,
    detailCandidateId: assertBossResumeTarget(payload, candidate),
  };
}

export async function parseBossResumeDetail(
  page: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<CandidateResume> {
  const cachedPayload = takeCachedBossResumePayload(page, candidate.candidateId);
  const verified = cachedPayload
    ? { payload: cachedPayload, detailCandidateId: assertBossResumeTarget(cachedPayload, candidate) }
    : await readVerifiedBossResumePayload(
      page,
      candidate,
      options?.deadline ?? createResumeDetailDeadline(),
      options?.cleanupReserveMs ?? 0,
    );
  const resume = parseBossResumePayload(verified.payload, page.url(), candidate);
  if (resume.candidateId !== candidate.candidateId || resume.candidateId !== verified.detailCandidateId) {
    throw new BossResumeIdentityVerificationError(
      `Boss parsed resume identity ${resume.candidateId} does not match candidate ${candidate.candidateId} or detail ${verified.detailCandidateId}.`,
    );
  }
  return resume;
}

async function waitForBossForwardDialog(page: Page, deadline: number, cleanupReserveMs = 0): Promise<Locator> {
  const dialogs = page.locator('.dialog-wrap.active .c-share-box:visible');
  const dialog = dialogs.first();
  await dialog.waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
  const dialogCount = await dialogs.count();
  if (dialogCount !== 1) {
    throw new Error(`Expected one visible Boss forwarding dialog, found ${dialogCount}.`);
  }
  return dialog;
}

function bossPurchaseChatDialogs(page: Page): Locator {
  return page
    .locator('.dialog-wrap.active:visible:not(:has(iframe[src*="/web/frame/c-resume/"]))')
    .filter({ hasText: /搜索畅聊卡|立即购买/ });
}

async function closeBossPurchaseChatDialogIfPresent(page: Page, deadline: number): Promise<boolean> {
  const dialogs = bossPurchaseChatDialogs(page);
  const dialogCount = await dialogs.count();
  if (dialogCount === 0) return false;
  if (dialogCount !== 1) {
    throw new Error(`Expected at most one visible Boss search-chat-card purchase dialog, found ${dialogCount}.`);
  }
  const dialog = dialogs.first();
  const closeButtons = dialog.locator('.boss-popup__close:visible, [ka="dialog_close"]:visible');
  const closeCount = await closeButtons.count();
  if (closeCount !== 1) {
    throw new Error(`Expected one close control on the Boss search-chat-card purchase dialog, found ${closeCount}.`);
  }
  const closeButton = closeButtons.first();
  await clickBossControlNatively(page, closeButton, remainingTime(deadline), { deadline, pace: true });
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
  return true;
}

/**
 * Safety-only semantic action used by non-forwarding detail visits. It keeps
 * the purchase-dialog selector inside the Boss action boundary while allowing
 * callers to fail closed if an accidental contact click opened a purchase UI.
 */
export async function closeBossPurchaseChatDialogForSafety(page: Page, deadline: number): Promise<boolean> {
  return closeBossPurchaseChatDialogIfPresent(page, deadline);
}

/**
 * Closes one visible resume detail dialog and verifies that it is gone. The
 * ordinary adapter close remains tolerant for legacy cleanup; this strict
 * variant is reserved for the history-view action where leaving a modal open
 * would make the next candidate unsafe to operate.
 */
export async function closeBossResumeDetailStrict(
  page: Page,
  deadline: number,
  options: { pace?: boolean; cleanupReserveMs?: number } = {},
): Promise<void> {
  const visibleResumeDialogs = page.locator('.dialog-wrap.active:visible:has(iframe[src*="/web/frame/c-resume/"])');
  const dialogCount = await visibleResumeDialogs.count();
  if (dialogCount !== 1) {
    throw new Error(`Expected one visible Boss resume detail dialog before close, found ${dialogCount}.`);
  }
  if (await bossPurchaseChatDialogs(page).count() > 0) {
    await closeBossPurchaseChatDialogIfPresent(page, deadline);
    throw new Error('Boss resume detail close was blocked by a visible search-chat-card purchase dialog.');
  }
  await closeExistingBossResumeDialog(page, deadline, {
    ...options,
    deadline,
    allowEscapeFallback: false,
    cleanupReserveMs: 0,
  });
  const remaining = await visibleResumeDialogs.count().catch(() => 0);
  if (remaining !== 0) {
    throw new Error('Boss resume detail dialog remained visible after the close action.');
  }
}

async function openBossForwardDialog(page: Page, deadline: number, cleanupReserveMs = 0): Promise<Locator> {
  await waitForBossResumeDetailReady(page, deadline, cleanupReserveMs);
  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(
      page,
      deadline,
      'Boss resume forwarding started while a search-chat-card purchase dialog was already visible',
    );
  }
  const action = page.locator('.dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]) .btn-coop-forward:visible');
  const actionCount = await action.count();
  if (actionCount !== 1) {
    throw new Error(`Expected one visible Boss resume forward action, found ${actionCount}.`);
  }
  // The generic coordinate click intentionally follows a continuous pointer
  // path, but the detail footer can reflow while that path is in motion. Use
  // a native locator click after pointer movement so Playwright resolves the
  // forward element again at mutation time instead of clicking a stale point
  // that may now belong to “联系Ta”.
  await clickBossControlNatively(page, action, remainingTime(deadline), {
    deadline,
    cleanupReserveMs,
  });
  await page.waitForFunction(() => {
    const isVisible = (element: Element) => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const forwardingVisible = [...document.querySelectorAll('.dialog-wrap.active .c-share-box')].some(isVisible);
    const purchaseVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
      isVisible(dialog)
      && !dialog.querySelector('iframe[src*="/web/frame/c-resume/"]')
      && /搜索畅聊卡|立即购买/.test(dialog.textContent ?? ''));
    return forwardingVisible || purchaseVisible;
  }, undefined, { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 });
  if (await bossPurchaseChatDialogs(page).count() > 0) {
    await raiseUnexpectedContactDialog(
      page,
      deadline,
      'Boss resume forward action opened the search-chat-card purchase dialog instead of the forwarding dialog',
    );
  }
  return waitForBossForwardDialog(page, deadline, cleanupReserveMs);
}

async function selectBossForwardMode(
  dialog: Locator,
  mode: BossForwardMode,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<Locator> {
  const label = mode === 'colleague' ? '站内同事' : '邮件转发';
  const tab = dialog.locator('.nav-list .item').filter({ hasText: label });
  const tabCount = await tab.count();
  if (tabCount !== 1) {
    throw new Error(`Expected one Boss forward mode tab "${label}", found ${tabCount}.`);
  }
  if (!normalizeText(await tab.getAttribute('class') ?? '').split(' ').includes('cur')) {
    await clickBossControlNatively(dialog.page(), tab, remainingTime(deadline), {
      deadline,
      cleanupReserveMs,
    });
  }
  const placeholder = mode === 'colleague' ? '姓名、职位、邮箱' : '请输入收件人邮箱';
  const input = dialog.locator(`input[placeholder="${placeholder}"]`);
  await input.waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
  return input;
}

async function selectBossForwardColleague(
  dialog: Locator,
  input: Locator,
  recipient: string,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  await runBossActionWithinDeadline(
    dialog.page(),
    deadline,
    () => input.fill(recipient, { timeout: remainingTime(deadline) }),
    cleanupReserveMs,
  );
  const options = dialog.locator('.check-list li, .selector [class*="option"], .selector [class*="result-item"]');
  await options.first().waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
  const matches = await options.evaluateAll((elements, target) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const normalizedTarget = normalize(target);
    return elements
      .map((element, index) => ({
        index,
        text: normalize(element.textContent),
        visible: element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      }))
      .filter((item) => item.visible && (item.text === normalizedTarget || item.text.startsWith(normalizedTarget)));
  }, recipient);
  if (matches.length !== 1) {
    const optionTexts = await options.evaluateAll((elements) => elements
      .filter((element) => element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean));
    throw new Error(`Boss colleague forward recipient "${recipient}" matched ${matches.length} options. Visible options: ${optionTexts.slice(0, 10).join(' | ') || '(none)'}`);
  }
  await clickBossControlNatively(dialog.page(), options.nth(matches[0]!.index), remainingTime(deadline), {
    deadline,
    cleanupReserveMs,
  });
}

async function fillBossForwardForm(
  dialog: Locator,
  mode: BossForwardMode,
  recipient: string,
  candidateId: string,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  const input = await selectBossForwardMode(dialog, mode, deadline, cleanupReserveMs);
  if (mode === 'colleague') {
    await selectBossForwardColleague(dialog, input, recipient, deadline, cleanupReserveMs);
  } else {
    await runBossActionWithinDeadline(
      dialog.page(),
      deadline,
      () => input.fill(recipient, { timeout: remainingTime(deadline) }),
      cleanupReserveMs,
    );
    if (await input.inputValue() !== recipient) {
      throw new Error('Boss email forward recipient input did not retain the configured address.');
    }
  }
  const message = dialog.locator('textarea[placeholder="请输入留言"]');
  await runBossActionWithinDeadline(
    dialog.page(),
    deadline,
    () => message.fill(candidateId, { timeout: remainingTime(deadline) }),
    cleanupReserveMs,
  );
  if (await message.inputValue() !== candidateId) {
    throw new Error(`Boss forward message did not retain candidate ID ${candidateId}.`);
  }
}

function bossForwardSuccessIndicators(page: Page): Locator {
  return page.locator('[data-boss-forward-success="true"], .boss-toast, .toast-success, [role="alert"]');
}

async function readBossForwardSuccessSignature(page: Page): Promise<string> {
  return bossForwardSuccessIndicators(page).evaluateAll((elements) => elements.flatMap((element, index) => {
    if (!(element instanceof HTMLElement)) return [];
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible = style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return visible && /转发成功|发送成功|已转发|forwarded successfully/i.test(text)
      ? [`${index}:${text}:${element.getAttribute('data-boss-forward-success') ?? ''}`]
      : [];
  }).join('|'));
}

async function waitForBossForwardSuccessEvidence(
  page: Page,
  deadline: number,
  beforeSignature: string,
  cleanupReserveMs = 0,
): Promise<void> {
  await page.waitForFunction((before) => {
    const isVisible = (element: Element): boolean => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      && window.getComputedStyle(element).visibility !== 'hidden';
    const signature = [...document.querySelectorAll('[data-boss-forward-success="true"], .boss-toast, .toast-success, [role="alert"]')]
      .flatMap((element, index) => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return isVisible(element) && /转发成功|发送成功|已转发|forwarded successfully/i.test(text)
          ? [`${index}:${text}:${element.getAttribute('data-boss-forward-success') ?? ''}`]
          : [];
      }).join('|');
    return Boolean(signature) && signature !== before;
  }, beforeSignature, { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 });
}

async function armBossForwardClickObserver(button: Locator, token: string): Promise<void> {
  await button.evaluate((element, expectedToken) => {
    type ObserverState = {
      token: string;
      dispatched: boolean;
      handler: (event: Event) => void;
    };
    const host = window as Window & { __autorecruitBossForwardClick?: ObserverState };
    const previous = host.__autorecruitBossForwardClick;
    if (previous) {
      document.removeEventListener('click', previous.handler, true);
    }
    const state = {} as ObserverState;
    state.token = expectedToken;
    state.dispatched = false;
    state.handler = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && (target === element || element.contains(target))) {
        state.dispatched = true;
      }
    };
    document.addEventListener('click', state.handler, true);
    host.__autorecruitBossForwardClick = state;
  }, token);
}

async function readBossForwardClickDispatched(page: Page, token: string): Promise<boolean> {
  return page.evaluate((expectedToken) => {
    const state = (window as Window & { __autorecruitBossForwardClick?: { token: string; dispatched: boolean } }).__autorecruitBossForwardClick;
    return Boolean(state && state.token === expectedToken && state.dispatched);
  }, token).catch(() => false);
}

async function clearBossForwardClickObserver(page: Page, token: string): Promise<void> {
  await page.evaluate((expectedToken) => {
    const host = window as Window & { __autorecruitBossForwardClick?: { token: string; handler: (event: Event) => void } };
    const state = host.__autorecruitBossForwardClick;
    if (!state || state.token !== expectedToken) return;
    document.removeEventListener('click', state.handler, true);
    delete host.__autorecruitBossForwardClick;
  }, token).catch(() => undefined);
}

async function confirmBossForward(
  dialog: Locator,
  candidateId: string,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  const forwardButton = dialog.locator('a[ka="geek_coop_forward"]');
  const buttonCount = await forwardButton.count();
  if (buttonCount !== 1) {
    throw new Error(`Expected one Boss forward confirmation button for candidate ${candidateId}, found ${buttonCount}.`);
  }
  const beforeSuccessSignature = await readBossForwardSuccessSignature(dialog.page());
  const observerToken = `boss-forward-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await armBossForwardClickObserver(forwardButton, observerToken);
  try {
    await clickBossControlNatively(dialog.page(), forwardButton, remainingTime(deadline), {
      deadline,
      cleanupReserveMs,
      beforeClick: async () => {
        const currentButtons = dialog.locator('a[ka="geek_coop_forward"]');
        if (await currentButtons.count() !== 1 || !(await currentButtons.first().isVisible().catch(() => false))) {
          throw new Error(`Boss forward confirmation control changed before candidate ${candidateId} click.`);
        }
        const message = dialog.locator('textarea[placeholder="请输入留言"]');
        if (await message.count() !== 1 || await message.inputValue().catch(() => '') !== candidateId) {
          throw new Error(`Boss forward candidate ID message changed before candidate ${candidateId} click.`);
        }
      },
    });
  } catch (error) {
    const dispatched = await readBossForwardClickDispatched(dialog.page(), observerToken);
    await clearBossForwardClickObserver(dialog.page(), observerToken);
    if (!dispatched) {
      throw new BossForwardPreConfirmationError(`Boss resume forward confirmation did not dispatch for candidate ${candidateId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new BossForwardUncertainError(`Boss resume forward click is uncertain for candidate ${candidateId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dispatched = await readBossForwardClickDispatched(dialog.page(), observerToken);
  await clearBossForwardClickObserver(dialog.page(), observerToken);
  if (!dispatched) {
    throw new BossForwardPreConfirmationError(`Boss resume forward confirmation did not dispatch for candidate ${candidateId}.`);
  }
  await dialog.waitFor({ state: 'hidden', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) }).catch(async () => {
    const dialogText = await dialog.innerText().catch(() => '');
    throw new BossForwardUncertainError(`Boss resume forward completion is uncertain for candidate ${candidateId}. Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  });
  if (await bossPurchaseChatDialogs(dialog.page()).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(
      dialog.page(),
      deadline,
      'Boss resume forward confirmation exposed the search-chat-card purchase dialog',
    );
  }
  try {
    await waitForBossForwardSuccessEvidence(
      dialog.page(),
      deadline,
      beforeSuccessSignature,
      cleanupReserveMs,
    );
  } catch {
    throw new BossForwardUncertainError(`Boss resume forward success evidence was not observed for candidate ${candidateId}.`);
  }
}

export async function forwardBossResumeAction(
  page: Page,
  input: {
    candidateId: string;
    mode: BossForwardMode;
    recipient: string;
    actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']>;
    ccEmails?: readonly string[];
    deadline: number;
    cleanupReserveMs?: number;
  },
): Promise<void> {
  const recipient = normalizeText(input.recipient);
  if (!recipient) throw new Error('Boss forward recipient must be a non-empty string.');
  const ccEmails = normalizeEmailList(input.ccEmails) ?? [];
  if (input.mode !== 'email' && ccEmails.length) {
    throw new Error('Boss forward CC is only supported for email forwarding.');
  }
  const recipients = input.mode === 'email'
    ? normalizeEmailList([recipient, ...ccEmails])!
    : [recipient];
  if (input.actionMode === 'prepare-only' && recipients.length > 1) {
    throw new Error('Boss copy forwarding requires confirmed sequential actions and cannot be prepared in one dialog.');
  }
  for (const targetRecipient of recipients) {
    const dialog = await openBossForwardDialog(page, input.deadline, input.cleanupReserveMs ?? 0);
    await fillBossForwardForm(
      dialog,
      input.mode,
      targetRecipient,
      input.candidateId,
      input.deadline,
      input.cleanupReserveMs ?? 0,
    );
    if (input.actionMode !== 'prepare-only') {
      await confirmBossForward(dialog, input.candidateId, input.deadline, input.cleanupReserveMs ?? 0);
    }
  }
}

export async function forwardBossResume(
  page: Page,
  candidate: CandidateListItem,
  mode: BossForwardMode,
  recipient: string,
  actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']> = 'confirm',
  ccEmails?: readonly string[],
  cachePayloadForParse = true,
  options?: CandidateProfileDetailOptions,
): Promise<void> {
  const normalizedRecipient = normalizeText(recipient);
  if (!normalizedRecipient) {
    throw new Error('Boss forward recipient must be a non-empty string.');
  }
  if (mode !== 'email' && normalizeEmailList(ccEmails)?.length) {
    throw new Error('Boss forward CC is only supported for email forwarding.');
  }
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  const { payload } = await readVerifiedBossResumePayload(
    page,
    candidate,
    deadline,
    options?.cleanupReserveMs ?? 0,
  );
  if (cachePayloadForParse) {
    cacheBossResumePayload(page, candidate.candidateId, payload);
  } else {
    bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  }
  await forwardBossResumeAction(page, {
    candidateId: candidate.candidateId,
    mode,
    recipient: normalizedRecipient,
    actionMode,
    ccEmails,
    deadline,
    cleanupReserveMs: options?.cleanupReserveMs,
  });
}
