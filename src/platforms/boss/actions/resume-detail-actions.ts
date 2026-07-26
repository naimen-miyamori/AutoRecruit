import type { Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { BossForwardMode, CandidatePostOpenActions } from '../../types.js';
import {
  parseBossResumePayload,
  type BossResumeApiPayload,
} from '../parsing/resume-parser.js';
import { clickBossControl, runBossAction } from './context.js';

const bossResumePayloadCache = new WeakMap<Page, Map<string, BossResumeApiPayload>>();

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
}

export async function closeExistingBossResumeDialog(
  page: Page,
  deadline: number,
  options: { pace?: boolean } = {},
): Promise<void> {
  const activeDialog = page.locator('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]), .dialog-wrap.active:has(.c-share-box)').first();
  if (await activeDialog.count().catch(() => 0) === 0) return;

  const closeButton = activeDialog.locator('.boss-popup__close, .close-btn, [ka="dialog_close"], .boss-dialog__close').first();
  await clickBossControl(closeButton, page, Math.min(remainingTime(deadline), 3000), { pace: options.pace }).catch(async () => {
    const pressEscape = () => page.keyboard.press('Escape');
    if (options.pace === false) {
      await pressEscape().catch(() => undefined);
      return;
    }
    await runBossAction(page, pressEscape).catch(() => undefined);
  });
  await activeDialog.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) }).catch(() => undefined);
}

export async function waitForBossResumeDetailReady(page: Page, deadline: number): Promise<void> {
  await page.locator('.dialog-wrap.active[data-type="boss-dialog"] iframe[src*="/web/frame/c-resume/"], .dialog-wrap.active iframe[src*="/web/frame/c-resume/"]').first().waitFor({
    state: 'visible',
    timeout: remainingTime(deadline),
  });
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('.dialog-wrap.active[data-type="boss-dialog"], .dialog-wrap.active');
      const frame = document.querySelector<HTMLIFrameElement>('.dialog-wrap.active iframe[src*="/web/frame/c-resume/"]');
      return Boolean(dialog && frame);
    },
    undefined,
    { timeout: remainingTime(deadline), polling: 250 },
  );
  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) throw new Error('Boss resume detail frame did not become available.');
  await detailFrame.locator('canvas#resume, #resume canvas').first().waitFor({
    state: 'visible',
    timeout: remainingTime(deadline),
  });
}

async function readBossResumeApiPayload(page: Page, deadline: number): Promise<BossResumeApiPayload> {
  await waitForBossResumeDetailReady(page, deadline);
  const detailFrame = page.frames().find((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
  if (!detailFrame) {
    throw new Error('Boss resume detail frame did not become available for parsing.');
  }
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

export async function parseBossResumeDetail(page: Page, candidate: CandidateListItem): Promise<CandidateResume> {
  const payload = takeCachedBossResumePayload(page, candidate.candidateId)
    ?? await readBossResumeApiPayload(page, createResumeDetailDeadline());
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(`Boss resume detail API failed: ${payload.message ?? `code ${payload.code}`}`);
  }
  return parseBossResumePayload(payload, page.url(), candidate);
}

async function waitForBossForwardDialog(page: Page, deadline: number): Promise<Locator> {
  const dialog = page.locator('.dialog-wrap.active .c-share-box').first();
  await dialog.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return dialog;
}

async function openBossForwardDialog(page: Page, deadline: number): Promise<Locator> {
  await waitForBossResumeDetailReady(page, deadline);
  const action = page.locator('.dialog-wrap.active:has(iframe[src*="/web/frame/c-resume/"]) .btn-coop-forward');
  const actionCount = await action.count();
  if (actionCount !== 1) {
    throw new Error(`Expected one visible Boss resume forward action, found ${actionCount}.`);
  }
  await clickBossControl(action, page, remainingTime(deadline));
  return waitForBossForwardDialog(page, deadline);
}

async function selectBossForwardMode(
  dialog: Locator,
  mode: BossForwardMode,
  deadline: number,
): Promise<Locator> {
  const label = mode === 'colleague' ? '站内同事' : '邮件转发';
  const tab = dialog.locator('.nav-list .item').filter({ hasText: label });
  const tabCount = await tab.count();
  if (tabCount !== 1) {
    throw new Error(`Expected one Boss forward mode tab "${label}", found ${tabCount}.`);
  }
  if (!normalizeText(await tab.getAttribute('class') ?? '').split(' ').includes('cur')) {
    await clickBossControl(tab, dialog.page(), remainingTime(deadline));
  }
  const placeholder = mode === 'colleague' ? '姓名、职位、邮箱' : '请输入收件人邮箱';
  const input = dialog.locator(`input[placeholder="${placeholder}"]`);
  await input.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  return input;
}

async function selectBossForwardColleague(
  dialog: Locator,
  input: Locator,
  recipient: string,
  deadline: number,
): Promise<void> {
  await runBossAction(dialog.page(), () => input.fill(recipient, { timeout: remainingTime(deadline) }));
  const options = dialog.locator('.check-list li, .selector [class*="option"], .selector [class*="result-item"]');
  await options.first().waitFor({ state: 'visible', timeout: remainingTime(deadline) });
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
  await clickBossControl(options.nth(matches[0]!.index), dialog.page(), remainingTime(deadline));
}

async function fillBossForwardForm(
  dialog: Locator,
  mode: BossForwardMode,
  recipient: string,
  candidateId: string,
  deadline: number,
): Promise<void> {
  const input = await selectBossForwardMode(dialog, mode, deadline);
  if (mode === 'colleague') {
    await selectBossForwardColleague(dialog, input, recipient, deadline);
  } else {
    await runBossAction(dialog.page(), () => input.fill(recipient, { timeout: remainingTime(deadline) }));
  }
  const message = dialog.locator('textarea[placeholder="请输入留言"]');
  await runBossAction(dialog.page(), () => message.fill(candidateId, { timeout: remainingTime(deadline) }));
  if (await message.inputValue() !== candidateId) {
    throw new Error(`Boss forward message did not retain candidate ID ${candidateId}.`);
  }
}

async function confirmBossForward(dialog: Locator, candidateId: string, deadline: number): Promise<void> {
  const forwardButton = dialog.locator('a[ka="geek_coop_forward"]');
  const buttonCount = await forwardButton.count();
  if (buttonCount !== 1) {
    throw new Error(`Expected one Boss forward confirmation button for candidate ${candidateId}, found ${buttonCount}.`);
  }
  await clickBossControl(forwardButton, dialog.page(), remainingTime(deadline));
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) }).catch(async () => {
    const dialogText = await dialog.innerText().catch(() => '');
    throw new Error(`Boss resume forward did not complete for candidate ${candidateId}. Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  });
}

export async function forwardBossResumeAction(
  page: Page,
  input: {
    candidateId: string;
    mode: BossForwardMode;
    recipient: string;
    actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']>;
    deadline: number;
  },
): Promise<void> {
  const recipient = normalizeText(input.recipient);
  if (!recipient) throw new Error('Boss forward recipient must be a non-empty string.');
  const dialog = await openBossForwardDialog(page, input.deadline);
  await fillBossForwardForm(dialog, input.mode, recipient, input.candidateId, input.deadline);
  if (input.actionMode !== 'prepare-only') {
    await confirmBossForward(dialog, input.candidateId, input.deadline);
  }
}

export async function forwardBossResume(
  page: Page,
  candidate: CandidateListItem,
  mode: BossForwardMode,
  recipient: string,
  actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']> = 'confirm',
): Promise<void> {
  const normalizedRecipient = normalizeText(recipient);
  if (!normalizedRecipient) {
    throw new Error('Boss forward recipient must be a non-empty string.');
  }
  const deadline = createResumeDetailDeadline();
  const payload = await readBossResumeApiPayload(page, deadline);
  cacheBossResumePayload(page, candidate.candidateId, payload);
  await forwardBossResumeAction(page, {
    candidateId: candidate.candidateId,
    mode,
    recipient: normalizedRecipient,
    actionMode,
    deadline,
  });
}
