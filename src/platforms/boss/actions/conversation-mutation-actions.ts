import type { Locator, Page } from 'playwright';
import { typeBossLocatorSequentially } from '../../../browser/pacing.js';
import { config } from '../../../config.js';
import { clickBossControl, clickBossControlWithDomEvent } from './context.js';

export const bossQualifiedCandidateChatMessage = '方便发一份你的简历过来吗？';
export const bossUnqualifiedCandidateChatMessage = '对不起，看了你的简历以后觉得不太合适，希望你早日找到满意的工作机会';
export const bossShanghaiOriginQuestionMessage = '是上海人吗？';

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export async function sendBossDirectText(page: Page, text: string): Promise<void> {
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]').first();
  const submit = page.locator('.conversation-editor .submit').first();
  const current = normalizeText(await editor.textContent()) ?? '';
  if (current) {
    throw new Error(`Boss chat editor contains an existing draft; refusing to overwrite it: ${current}`);
  }
  await typeBossLocatorSequentially(editor, page, text, config.playwright.resumeDetailTimeoutMs);
  await clickBossControl(submit, page, config.playwright.resumeDetailTimeoutMs);
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll<HTMLElement>('.chat-message-list .message-item .text-content'))
    .some((element) => (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim() === expected), text, {
    timeout: config.playwright.resumeDetailTimeoutMs,
  });
}

export async function clickUniqueBossTextControl(
  page: Page,
  pattern: RegExp,
  description: string,
): Promise<Locator> {
  const controls = page.locator('button, [role="button"], .operate-btn, .menu-item, li, a').filter({ hasText: pattern });
  const visible: number[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    if (await controls.nth(index).isVisible().catch(() => false)) visible.push(index);
  }
  if (visible.length !== 1) {
    throw new Error(`Expected one visible Boss ${description} control, found ${visible.length}.`);
  }
  const control = controls.nth(visible[0]!);
  await clickBossControl(control, page, config.playwright.resumeDetailTimeoutMs);
  return control;
}

export async function setBossConversationRemark(page: Page, remark: string): Promise<void> {
  await clickUniqueBossTextControl(page, /备注/, 'remark');
  const input = page.locator('textarea[placeholder*="备注"], input[placeholder*="备注"], .remark-dialog textarea, .remark-dialog input').first();
  await input.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
  await typeBossLocatorSequentially(input, page, remark, config.playwright.resumeDetailTimeoutMs, {
    replaceExisting: true,
  });
  await clickUniqueBossTextControl(page, /^(?:确定|保存)$/, 'remark confirmation');
}

export async function confirmBossConversationAction(
  page: Page,
  trigger: RegExp,
  description: string,
): Promise<void> {
  await clickUniqueBossTextControl(page, trigger, description);
  const confirmation = page.locator('.boss-dialog, .dialog-wrap, [role="dialog"]').last();
  if (await confirmation.isVisible().catch(() => false)) {
    const confirm = confirmation.locator('button, [role="button"], .boss-btn-primary').filter({ hasText: /^(?:确定|确认|同意)$/ }).first();
    if (!await confirm.isVisible().catch(() => false)) {
      throw new Error(`Boss ${description} confirmation dialog has no confirmation control.`);
    }
    await clickBossControl(confirm, page, config.playwright.resumeDetailTimeoutMs);
  }
}

export async function requestBossWechatExchange(page: Page): Promise<void> {
  await confirmBossConversationAction(page, /换微信|交换微信/, 'WeChat exchange');
}

async function hasBossChatMessage(page: Page, message: string): Promise<boolean> {
  return page.locator('.chat-message-list .message-item .text-content').evaluateAll((elements, expectedMessage) => (
    elements.some((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage)
  ), message);
}

export async function chooseBossCommonPhrase(page: Page, message: string): Promise<void> {
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]');
  const currentEditorText = normalizeText(await editor.textContent() ?? '');
  if (currentEditorText === message) return;
  if (currentEditorText) {
    throw new Error(`Boss chat editor contains unexpected text before choosing a common phrase: ${currentEditorText}`);
  }

  const trigger = page.locator('.toolbar-box-left .operate-icon-item').filter({
    has: page.locator('.toolbar-icon.changyongyu'),
  });
  const triggerCount = await trigger.count();
  if (triggerCount !== 1) {
    throw new Error(`Expected one Boss common-phrase control, found ${triggerCount}.`);
  }

  const phraseContent = trigger.locator('.phrase-content');
  if (!await phraseContent.isVisible().catch(() => false)) {
    await clickBossControl(trigger, page, config.playwright.resumeDetailTimeoutMs);
  }
  await phraseContent.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
  const phraseItems = phraseContent.locator('li');
  const phraseEntries = await phraseItems.evaluateAll((elements) => elements.map((element, index) => ({
    index,
    title: (element.getAttribute('title') ?? '').replace(/\s+/g, ' ').trim(),
  })));
  const matches = phraseEntries.filter((entry) => entry.title === message);
  if (matches.length !== 1) {
    throw new Error(`Boss common phrase "${message}" matched ${matches.length} items. Available phrases: ${phraseEntries.map((entry) => entry.title).filter(Boolean).join(' | ') || '(none)'}`);
  }

  await clickBossControl(
    phraseItems.nth(matches[0]!.index),
    page,
    config.playwright.resumeDetailTimeoutMs,
    { position: { x: 8, y: 8 } },
  );
  await page.waitForFunction((expectedMessage) => {
    const editorElement = document.querySelector<HTMLElement>('#boss-chat-editor-input[contenteditable="true"]');
    return (editorElement?.innerText ?? editorElement?.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage;
  }, message, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 100 });
}

export async function sendBossCommonPhraseMessage(
  page: Page,
  message: string,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  if (await hasBossChatMessage(page, message)) {
    return { sent: true, alreadyPresent: true };
  }
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]');
  const submit = page.locator('.conversation-editor .submit');
  const editorCount = await editor.count();
  const submitCount = await submit.count();
  if (editorCount !== 1 || submitCount !== 1) {
    throw new Error(`Expected one Boss chat editor and submit control, found editor=${editorCount}, submit=${submitCount}.`);
  }
  await chooseBossCommonPhrase(page, message);
  await clickBossControl(submit, page, config.playwright.resumeDetailTimeoutMs);
  await waitForBossSentMessage(page, message);
  return { sent: true, alreadyPresent: false };
}

async function waitForBossSentMessage(page: Page, message: string): Promise<void> {
  await page.waitForFunction((expectedMessage) => {
    const messageExists = Array.from(document.querySelectorAll('.chat-message-list .message-item .text-content'))
      .some((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage);
    const editor = document.querySelector<HTMLElement>('#boss-chat-editor-input[contenteditable="true"]');
    return messageExists && !(editor?.innerText ?? editor?.textContent ?? '').trim();
  }, message, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 200 });
}

export async function sendBossEditorMessage(
  page: Page,
  message: string,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  if (await hasBossChatMessage(page, message)) {
    return { sent: true, alreadyPresent: true };
  }
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]');
  const submit = page.locator('.conversation-editor .submit');
  const editorCount = await editor.count();
  const submitCount = await submit.count();
  if (editorCount !== 1 || submitCount !== 1) {
    throw new Error(`Expected one Boss chat editor and submit control, found editor=${editorCount}, submit=${submitCount}.`);
  }
  const currentEditorText = normalizeText(await editor.textContent() ?? '');
  if (currentEditorText && currentEditorText !== message) {
    throw new Error(`Boss chat editor contains unexpected text before typing a message: ${currentEditorText}`);
  }
  if (currentEditorText !== message) {
    await typeBossLocatorSequentially(editor, page, message, config.playwright.resumeDetailTimeoutMs);
  }
  await page.waitForFunction((expectedMessage) => {
    const editorElement = document.querySelector<HTMLElement>('#boss-chat-editor-input[contenteditable="true"]');
    return (editorElement?.innerText ?? editorElement?.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage;
  }, message, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 100 });
  await clickBossControl(submit, page, config.playwright.resumeDetailTimeoutMs);
  await waitForBossSentMessage(page, message);
  return { sent: true, alreadyPresent: false };
}

export async function sendBossQualifiedCandidateMessage(
  page: Page,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  return sendBossCommonPhraseMessage(page, bossQualifiedCandidateChatMessage);
}

export async function sendBossUnqualifiedCandidateMessage(
  page: Page,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  return sendBossCommonPhraseMessage(page, bossUnqualifiedCandidateChatMessage);
}

export async function sendBossShanghaiOriginQuestionMessage(
  page: Page,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  return sendBossEditorMessage(page, bossShanghaiOriginQuestionMessage);
}

async function readBossPhoneExchangeState(page: Page): Promise<{ requested: boolean; bothTalked: boolean }> {
  return page.evaluate(() => {
    type ExchangePhoneViewModel = {
      $options?: { name?: string };
      conversation$?: Record<string, unknown>;
      isExchangePhoneBlueMsg?: boolean;
    };
    type VueElement = HTMLElement & { __vue__?: ExchangePhoneViewModel };
    const viewModel = Array.from(document.querySelectorAll<VueElement>('.operate-exchange-left .operate-icon-item'))
      .map((element) => element.__vue__)
      .find((candidate) => candidate?.$options?.name === 'ExchangePhone');
    const conversation = viewModel?.conversation$ ?? {};
    return {
      requested: Boolean(conversation.requestPhone || conversation.phone || viewModel?.isExchangePhoneBlueMsg),
      bothTalked: conversation.bothTalked === true,
    };
  });
}

export async function requestBossPhoneExchange(page: Page): Promise<{ requested: boolean; alreadyRequested: boolean }> {
  const initialState = await readBossPhoneExchangeState(page);
  if (initialState.requested) return { requested: true, alreadyRequested: true };

  await page.waitForFunction(() => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('.operate-exchange-left .operate-icon-item'))
      .find((element) => (element.querySelector('.operate-btn')?.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith('换电话'));
    const button = item?.querySelector<HTMLElement>('.operate-btn');
    return Boolean(button && !button.classList.contains('disabled'));
  }, undefined, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 200 });

  const phoneItem = page.locator('.operate-exchange-left .operate-icon-item').filter({ hasText: '换电话' });
  const phoneItemCount = await phoneItem.count();
  if (phoneItemCount !== 1) {
    throw new Error(`Expected one Boss phone-exchange control, found ${phoneItemCount}.`);
  }
  const phoneButton = phoneItem.locator('.operate-btn');
  await clickBossControlWithDomEvent(page, phoneButton, config.playwright.resumeDetailTimeoutMs);
  const confirmation = phoneItem.locator('.exchange-tooltip');
  await confirmation.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
  const confirmButton = confirmation.locator('.boss-btn-primary').filter({ hasText: '确定' });
  const confirmButtonCount = await confirmButton.count();
  if (confirmButtonCount !== 1) {
    throw new Error(`Expected one Boss phone-exchange confirmation control, found ${confirmButtonCount}.`);
  }
  await clickBossControlWithDomEvent(page, confirmButton, config.playwright.resumeDetailTimeoutMs);
  await page.waitForFunction(() => {
    type ExchangePhoneViewModel = {
      $options?: { name?: string };
      conversation$?: Record<string, unknown>;
      isExchangePhoneBlueMsg?: boolean;
    };
    type VueElement = HTMLElement & { __vue__?: ExchangePhoneViewModel };
    const viewModel = Array.from(document.querySelectorAll<VueElement>('.operate-exchange-left .operate-icon-item'))
      .map((element) => element.__vue__)
      .find((candidate) => candidate?.$options?.name === 'ExchangePhone');
    const conversation = viewModel?.conversation$ ?? {};
    return Boolean(conversation.requestPhone || conversation.phone || viewModel?.isExchangePhoneBlueMsg);
  }, undefined, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 200 });
  return { requested: true, alreadyRequested: false };
}
