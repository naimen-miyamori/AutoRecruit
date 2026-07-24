import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../browser/pacing.js';
import { config } from '../config.js';
import type {
  BossChatConversationSummary,
  BossChatMessage,
  BossChatOperation,
  BossChatOperationInput,
  BossChatOperationResult,
} from '../types/boss.js';
import {
  bossQualifiedCandidateChatMessage,
  closeBossChatResume,
  openAndParseBossChatResume,
  openBossChatPage,
  openBossUnreadConversation,
  requestBossPhoneExchange,
  sendBossCommonPhraseMessage,
  type BossOpenedConversation,
  type BossUnreadConversation,
} from './boss-chat.js';

const mutatingBossChatOperations = new Set<BossChatOperation>([
  'send-text',
  'remark',
  'mark-not-fit',
  'request-attachment-resume',
  'accept-attachment-resume',
  'exchange-phone',
  'exchange-wechat',
]);

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

async function runBossAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await waitPlatformActionPace(page, 'boss');
  return action();
}

export function isMutatingBossChatOperation(action: BossChatOperation): boolean {
  return mutatingBossChatOperations.has(action);
}

function mutationReceiptPath(intentId: string): string {
  const digest = createHash('sha256').update(intentId).digest('hex');
  return path.join(config.dataDir, 'boss', 'chat-operations', 'runs', `${digest}.json`);
}

async function readMutationReceipt(input: BossChatOperationInput): Promise<BossChatOperationResult | undefined> {
  if (!input.intentId) return undefined;
  try {
    const receipt = JSON.parse(await fs.readFile(mutationReceiptPath(input.intentId), 'utf8')) as {
      input: BossChatOperationInput;
      result: BossChatOperationResult;
    };
    if (receipt.input.action !== input.action || receipt.input.conversationId !== input.conversationId) {
      throw new Error(`Boss chat intentId ${input.intentId} was already used for a different operation.`);
    }
    return receipt.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function persistMutationReceipt(
  input: BossChatOperationInput,
  result: BossChatOperationResult,
): Promise<BossChatOperationResult> {
  const receiptPath = mutationReceiptPath(input.intentId!);
  const output = { ...result, receiptPath };
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  try {
    await fs.writeFile(receiptPath, `${JSON.stringify({ input, result: output }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readMutationReceipt(input);
    if (!existing) throw error;
    return existing;
  }
  return output;
}

export async function readBossConversationList(page: Page): Promise<BossChatConversationSummary[]> {
  return page.locator('.user-list .geek-item').evaluateAll((items) => items.flatMap((item) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const readPrimitive = (value: unknown) => (
      typeof value === 'string' || typeof value === 'number' ? normalize(String(value)) : ''
    );
    const conversationId = normalize(item.getAttribute('data-id')) || normalize(item.id).replace(/^_/, '');
    const jobName = normalize(item.querySelector('.source-job')?.textContent);
    if (!conversationId || !jobName) return [];
    const vue = (item as VueElement).__vue__ ?? {};
    const nestedValues = [vue.item, vue.data, vue.conversation]
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
    const records = [vue, ...nestedValues];
    const readFromRecords = (keys: readonly string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readPrimitive(record[key]);
          if (value) return value;
        }
      }
      return '';
    };
    const badge = item.querySelector<HTMLElement>('.figure .badge-count');
    const unreadCount = Number.parseInt(normalize(badge?.textContent), 10);
    return [{
      conversationId,
      candidateId: readFromRecords(['expectId', 'geekId', 'encryptExpectId']) || undefined,
      candidateName: normalize(item.querySelector('.geek-name')?.textContent) || undefined,
      jobName,
      bossJobId: normalize(item.getAttribute('data-job-id'))
        || readFromRecords(['jobId', 'positionId', 'toJobId', 'encryptJobId'])
        || undefined,
      unreadCount: Number.isFinite(unreadCount) ? unreadCount : 0,
      hasUnreadBadge: Boolean(badge),
    }];
  }));
}

async function selectBossConversationFilter(page: Page, unreadOnly: boolean): Promise<void> {
  if (unreadOnly) return;
  const allTab = page.locator('.chat-message-filter-left span').filter({ hasText: /全部|所有/ }).first();
  if (!await allTab.isVisible().catch(() => false)) {
    throw new Error('Boss chat does not expose the all-conversations filter.');
  }
  const className = await allTab.getAttribute('class') ?? '';
  if (!className.split(/\s+/).includes('active')) {
    await clickPlatformLocator(allTab, page, 'boss', config.playwright.searchPageTimeoutMs);
    await page.locator('.user-list').first().waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  }
}

async function prepareBossChatPage(page: Page, unreadOnly: boolean): Promise<Page> {
  const chatPage = await openBossChatPage(page);
  await selectBossConversationFilter(chatPage, unreadOnly);
  return chatPage;
}

function assertConversationInput(input: BossChatOperationInput): asserts input is BossChatOperationInput & {
  conversationId: string;
} {
  if (!input.conversationId?.trim()) {
    throw new Error(`Boss ${input.action} requires conversationId.`);
  }
}

async function openExactConversation(
  page: Page,
  input: BossChatOperationInput & { conversationId: string },
  conversations: readonly BossChatConversationSummary[],
): Promise<BossOpenedConversation> {
  const summary = conversations.find((item) => item.conversationId === input.conversationId);
  if (!summary) {
    throw new Error(`Boss conversation ${input.conversationId} is no longer visible.`);
  }
  if (input.expectedCandidateName && summary.candidateName !== input.expectedCandidateName) {
    throw new Error(`Boss conversation candidate mismatch: expected ${input.expectedCandidateName}, found ${summary.candidateName ?? '(unknown)'}.`);
  }
  if (input.expectedJobName && summary.jobName !== input.expectedJobName) {
    throw new Error(`Boss conversation job mismatch: expected ${input.expectedJobName}, found ${summary.jobName}.`);
  }
  const conversation: BossUnreadConversation = {
    conversationId: summary.conversationId,
    candidateName: summary.candidateName,
    jobName: summary.jobName,
    bossJobId: summary.bossJobId,
    unreadCount: Math.max(1, summary.unreadCount),
    hasUnreadBadge: summary.hasUnreadBadge,
  };
  const opened = await openBossUnreadConversation(page, conversation);
  if (opened.conversation.conversationId !== input.conversationId) {
    throw new Error(`Boss opened an unexpected conversation: ${opened.conversation.conversationId}.`);
  }
  if (input.expectedCandidateName && opened.candidate.name !== input.expectedCandidateName) {
    throw new Error(`Boss hydrated candidate mismatch: expected ${input.expectedCandidateName}, found ${opened.candidate.name ?? '(unknown)'}.`);
  }
  return opened;
}

export async function readBossVisibleMessages(page: Page): Promise<BossChatMessage[]> {
  return page.locator('.chat-message-list .message-item').evaluateAll((elements) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const readRecord = (element: VueElement) => {
      const root = element.__vue__ ?? {};
      const nested = ['message', 'message$', 'msg', 'msg$', 'item', 'data']
        .map((key) => root[key])
        .find((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
      return nested as Record<string, unknown> | undefined ?? root;
    };
    const readString = (record: Record<string, unknown>, keys: readonly string[]) => {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' || typeof value === 'number') {
          const text = normalize(String(value));
          if (text) return text;
        }
      }
      return undefined;
    };
    return elements.flatMap((node) => {
      const element = node as VueElement;
      const record = readRecord(element);
      const classes = element.className;
      const role = readString(record, ['senderRole', 'senderType', 'fromRole', 'role', 'side', 'direction'])?.toLowerCase();
      const self = record.isSelf === true || record.fromSelf === true || /myself|self|mine|right|outgoing|sent/i.test(classes)
        || Boolean(role && /self|boss|recruiter|right|outgoing/.test(role));
      const system = /system|notice|time|divider|tip/i.test(classes)
        || Boolean(role && /system|notice|time|divider|tip/.test(role));
      const sender = system ? 'system' : self ? 'recruiter' : role && /unknown/.test(role) ? 'unknown' : 'candidate';
      const content = normalize(element.querySelector<HTMLElement>('.text-content')?.innerText)
        || normalize(element.innerText);
      if (!content) return [];
      return [{
        messageId: readString(record, ['messageId', 'msgId', 'mid', 'uniqueId', 'id'])
          || normalize(element.dataset.messageId)
          || normalize(element.dataset.msgId)
          || undefined,
        sender,
        type: readString(record, ['type', 'contentType', 'bodyType', 'msgType']),
        content,
        sentAt: readString(record, ['sendTime', 'sentAt', 'createTime', 'timestamp', 'time'])
          || normalize(element.querySelector('time')?.getAttribute('datetime'))
          || undefined,
      }];
    });
  });
}

async function readBossHistory(page: Page): Promise<BossChatMessage[]> {
  const scroller = page.locator('.chat-message-list').first();
  let previousCount = -1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const count = await scroller.locator('.message-item').count();
    if (count === previousCount) break;
    previousCount = count;
    await runBossAction(page, () => scroller.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }));
    await page.waitForTimeout(300).catch(() => undefined);
  }
  return readBossVisibleMessages(page);
}

async function sendBossText(page: Page, text: string): Promise<void> {
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]').first();
  const submit = page.locator('.conversation-editor .submit').first();
  const current = normalizeText(await editor.textContent()) ?? '';
  if (current) {
    throw new Error(`Boss chat editor contains an existing draft; refusing to overwrite it: ${current}`);
  }
  await runBossAction(page, () => editor.fill(text, { timeout: config.playwright.resumeDetailTimeoutMs }));
  await clickPlatformLocator(submit, page, 'boss', config.playwright.resumeDetailTimeoutMs);
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll<HTMLElement>('.chat-message-list .message-item .text-content'))
    .some((element) => (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim() === expected), text, {
    timeout: config.playwright.resumeDetailTimeoutMs,
  });
}

async function clickUniqueTextControl(page: Page, pattern: RegExp, description: string): Promise<Locator> {
  const controls = page.locator('button, [role="button"], .operate-btn, .menu-item, li, a').filter({ hasText: pattern });
  const visible: number[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    if (await controls.nth(index).isVisible().catch(() => false)) visible.push(index);
  }
  if (visible.length !== 1) {
    throw new Error(`Expected one visible Boss ${description} control, found ${visible.length}.`);
  }
  const control = controls.nth(visible[0]!);
  await clickPlatformLocator(control, page, 'boss', config.playwright.resumeDetailTimeoutMs);
  return control;
}

async function setBossRemark(page: Page, remark: string): Promise<void> {
  await clickUniqueTextControl(page, /备注/, 'remark');
  const input = page.locator('textarea[placeholder*="备注"], input[placeholder*="备注"], .remark-dialog textarea, .remark-dialog input').first();
  await input.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
  await runBossAction(page, () => input.fill(remark, { timeout: config.playwright.resumeDetailTimeoutMs }));
  await clickUniqueTextControl(page, /^(?:确定|保存)$/, 'remark confirmation');
}

async function confirmBossAction(page: Page, trigger: RegExp, description: string): Promise<void> {
  await clickUniqueTextControl(page, trigger, description);
  const confirmation = page.locator('.boss-dialog, .dialog-wrap, [role="dialog"]').last();
  if (await confirmation.isVisible().catch(() => false)) {
    const confirm = confirmation.locator('button, [role="button"], .boss-btn-primary').filter({ hasText: /^(?:确定|确认|同意)$/ }).first();
    if (!await confirm.isVisible().catch(() => false)) {
      throw new Error(`Boss ${description} confirmation dialog has no confirmation control.`);
    }
    await clickPlatformLocator(confirm, page, 'boss', config.playwright.resumeDetailTimeoutMs);
  }
}

async function requestBossWechatExchange(page: Page): Promise<void> {
  await confirmBossAction(page, /换微信|交换微信/, 'WeChat exchange');
}

function baseResult(
  input: BossChatOperationInput,
  opened?: BossOpenedConversation,
): BossChatOperationResult {
  return {
    platform: 'boss',
    action: input.action,
    conversationId: opened?.conversation.conversationId ?? input.conversationId,
    candidateId: opened?.candidate.candidateId,
    candidateName: opened?.candidate.name ?? input.expectedCandidateName,
    jobName: opened?.conversation.jobName ?? input.expectedJobName,
    bossJobId: opened?.conversation.bossJobId,
    changed: false,
    intentId: input.intentId,
    completedAt: new Date().toISOString(),
  };
}

export async function executeBossChatOperation(
  page: Page,
  input: BossChatOperationInput,
): Promise<BossChatOperationResult> {
  const isMutation = isMutatingBossChatOperation(input.action);
  if (isMutation) {
    if (input.confirmed !== true) {
      throw new Error(`Boss ${input.action} requires confirmed=true.`);
    }
    if (!input.intentId?.trim()) {
      throw new Error(`Boss ${input.action} requires a non-empty intentId for retry idempotency.`);
    }
    const existing = await readMutationReceipt(input);
    if (existing) return existing;
  }

  const chatPage = await prepareBossChatPage(page, input.unreadOnly ?? false);
  const conversations = await readBossConversationList(chatPage);
  if (input.action === 'list-conversations') {
    return {
      ...baseResult(input),
      conversations: (input.unreadOnly ? conversations.filter((item) => item.hasUnreadBadge) : conversations),
    };
  }

  assertConversationInput(input);
  const opened = await openExactConversation(chatPage, input, conversations);
  let result: BossChatOperationResult;
  switch (input.action) {
    case 'open-conversation':
      result = baseResult(input, opened);
      break;
    case 'read-conversation':
      result = { ...baseResult(input, opened), messages: await readBossVisibleMessages(chatPage) };
      break;
    case 'read-history':
      result = { ...baseResult(input, opened), messages: await readBossHistory(chatPage) };
      break;
    case 'preview-resume': {
      try {
        result = { ...baseResult(input, opened), resume: await openAndParseBossChatResume(chatPage, opened) };
      } finally {
        await closeBossChatResume(chatPage).catch(() => undefined);
      }
      break;
    }
    case 'send-text':
      if (!input.text?.trim()) throw new Error('Boss send-text requires non-empty text.');
      await sendBossText(chatPage, input.text.trim());
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'remark':
      if (!input.remark?.trim()) throw new Error('Boss remark requires non-empty remark.');
      await setBossRemark(chatPage, input.remark.trim());
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'mark-not-fit':
      await confirmBossAction(chatPage, /不合适/, 'not-fit');
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'request-attachment-resume':
      await sendBossCommonPhraseMessage(chatPage, bossQualifiedCandidateChatMessage);
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'accept-attachment-resume':
      await confirmBossAction(chatPage, /同意(?:接收)?|接受简历/, 'attachment-resume acceptance');
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'exchange-phone':
      await requestBossPhoneExchange(chatPage);
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'exchange-wechat':
      await requestBossWechatExchange(chatPage);
      result = { ...baseResult(input, opened), changed: true };
      break;
  }

  return isMutation ? persistMutationReceipt(input, result) : result;
}
