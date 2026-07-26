import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import type {
  BossChatConversationSummary,
  BossChatMessage,
  BossChatOperation,
  BossChatOperationInput,
  BossChatOperationResult,
} from '../types/boss.js';
import {
  closeBossChatResume,
  openAndParseBossChatResume,
  openBossUnreadConversation,
  type BossOpenedConversation,
  type BossUnreadConversation,
} from './boss-chat.js';
import {
  prepareBossChatPage,
  readBossConversationHistory,
  readBossConversationList,
  readBossVisibleMessages,
} from './boss/actions/conversation-read-actions.js';
import {
  confirmBossConversationAction,
  bossQualifiedCandidateChatMessage,
  requestBossPhoneExchange,
  requestBossWechatExchange,
  sendBossCommonPhraseMessage,
  sendBossDirectText,
  setBossConversationRemark,
} from './boss/actions/conversation-mutation-actions.js';

export { readBossConversationList, readBossVisibleMessages } from './boss/actions/conversation-read-actions.js';

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
      result = { ...baseResult(input, opened), messages: await readBossConversationHistory(chatPage) };
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
      await sendBossDirectText(chatPage, input.text.trim());
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'remark':
      if (!input.remark?.trim()) throw new Error('Boss remark requires non-empty remark.');
      await setBossConversationRemark(chatPage, input.remark.trim());
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'mark-not-fit':
      await confirmBossConversationAction(chatPage, /不合适/, 'not-fit');
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'request-attachment-resume':
      await sendBossCommonPhraseMessage(chatPage, bossQualifiedCandidateChatMessage);
      result = { ...baseResult(input, opened), changed: true };
      break;
    case 'accept-attachment-resume':
      await confirmBossConversationAction(chatPage, /同意(?:接收)?|接受简历/, 'attachment-resume acceptance');
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
