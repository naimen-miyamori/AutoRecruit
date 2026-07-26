import type { Page } from 'playwright';
import { config } from '../../../config.js';
import type { BossChatConversationSummary, BossChatMessage } from '../../../types/boss.js';
import { runBossAction } from './context.js';
import { openBossChatPage } from './navigation-actions.js';
import { clickBossControl } from './context.js';

export interface BossUnreadConversation {
  conversationId: string;
  candidateName?: string;
  jobName: string;
  bossJobId?: string;
  unreadCount: number;
  hasUnreadBadge?: boolean;
}

export async function collectBossUnreadConversations(
  page: Page,
  retryConversations: readonly BossUnreadConversation[] = [],
): Promise<BossUnreadConversation[]> {
  return page.locator('.user-list .geek-item').evaluateAll((items, retries) => {
    const retryById = new Map(retries.map((retry) => [retry.conversationId, retry]));
    return items.flatMap((item) => {
      const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const conversationId = normalize(item.getAttribute('data-id')) || normalize(item.id).replace(/^_/, '');
      const badge = item.querySelector<HTMLElement>('.figure .badge-count');
      const retry = retryById.get(conversationId);
      if (!badge && !retry) return [];

      const jobName = normalize(item.querySelector('.source-job')?.textContent) || retry?.jobName;
      if (!conversationId || !jobName) return [];

      type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
      const vue = (item as VueElement).__vue__ ?? {};
      const nested = [vue.item, vue.data, vue.conversation].find((value) => (
        Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      )) as Record<string, unknown> | undefined;
      const readJobId = (record: Record<string, unknown> | undefined) => {
        if (!record) return '';
        for (const key of ['jobId', 'positionId', 'toJobId', 'encryptJobId']) {
          const value = record[key];
          if (typeof value === 'string' || typeof value === 'number') return normalize(String(value));
        }
        return '';
      };
      const bossJobId = normalize(item.getAttribute('data-job-id'))
        || readJobId(vue)
        || readJobId(nested)
        || retry?.bossJobId;
      const unreadCount = badge ? Number.parseInt(normalize(badge.textContent), 10) : retry!.unreadCount;
      return [{
        conversationId,
        candidateName: normalize(item.querySelector('.geek-name')?.textContent) || retry?.candidateName,
        jobName,
        ...(bossJobId ? { bossJobId } : {}),
        unreadCount: Number.isFinite(unreadCount) ? unreadCount : 1,
        hasUnreadBadge: Boolean(badge),
      }];
    });
  }, retryConversations);
}

export async function openBossConversationById(
  page: Page,
  conversation: Pick<BossUnreadConversation, 'conversationId' | 'candidateName'>,
): Promise<void> {
  const deadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
  const items = page.locator('.user-list .geek-item');
  const itemIndex = await items.evaluateAll((elements, conversationId) => elements.findIndex((element) => (
    element.getAttribute('data-id') === conversationId || element.id === `_${conversationId}`
  )), conversation.conversationId);
  if (itemIndex < 0) {
    throw new Error(`Boss unread conversation ${conversation.conversationId} is no longer visible.`);
  }

  const beforeClick = await page.evaluate(({ expectedConversationId, expectedName }) => {
    type VueElement = HTMLElement & { __vue__?: { currentData$?: Record<string, unknown> } };
    const currentData = (document.querySelector('.chat-conversation') as VueElement | null)?.__vue__?.currentData$;
    const wasAlreadyCurrent = Boolean(currentData && (
      String(currentData.uniqueId ?? '') === expectedConversationId
      || (expectedName && currentData.name === expectedName)
    ));
    const messageSignature = Array.from(document.querySelectorAll<HTMLElement>('.chat-message-list .message-item'))
      .map((message) => [
        message.dataset.messageId ?? message.dataset.msgId ?? message.dataset.id ?? '',
        message.className,
        (message.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      ].join('|'))
      .join('\n');
    return { wasAlreadyCurrent, messageSignature };
  }, {
    expectedConversationId: conversation.conversationId,
    expectedName: conversation.candidateName,
  });

  await clickBossControl(items.nth(itemIndex), page, Math.max(1, deadline - Date.now()));
  await page.waitForFunction(({ expectedConversationId, expectedName, wasAlreadyCurrent, previousMessageSignature }) => {
    type VueElement = HTMLElement & {
      __vue__?: {
        currentData$?: Record<string, unknown>;
        conversation$?: Record<string, unknown>;
      };
    };
    const currentData = (document.querySelector('.chat-conversation') as VueElement | null)?.__vue__?.currentData$;
    const conversationData = (document.querySelector('.base-info-single-container') as VueElement | null)?.__vue__?.conversation$;
    if (!currentData || !conversationData) return false;

    const currentMatches = String(currentData.uniqueId ?? '') === expectedConversationId
      || Boolean(expectedName && currentData.name === expectedName);
    const detailMatches = String(conversationData.uniqueId ?? '') === expectedConversationId
      || Boolean(
        expectedName
        && conversationData.name === expectedName
        && String(conversationData.expectId ?? '') === String(currentData.expectId ?? ''),
      );
    const detailHydrated = typeof conversationData.ageDesc === 'string'
      && conversationData.ageDesc.trim().length > 0;
    const visibleMessages = Array.from(document.querySelectorAll<HTMLElement>('.chat-message-list .message-item'));
    const messageSignature = visibleMessages.map((message) => [
      message.dataset.messageId ?? message.dataset.msgId ?? message.dataset.id ?? '',
      message.className,
      (message.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    ].join('|')).join('\n');
    const messagesHydrated = visibleMessages.length > 0
      && (wasAlreadyCurrent || messageSignature !== previousMessageSignature);
    return currentMatches && detailMatches && detailHydrated && messagesHydrated;
  }, {
    expectedConversationId: conversation.conversationId,
    expectedName: conversation.candidateName,
    wasAlreadyCurrent: beforeClick.wasAlreadyCurrent,
    previousMessageSignature: beforeClick.messageSignature,
  }, { timeout: Math.max(1, deadline - Date.now()), polling: 200 });
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

export async function selectBossConversationFilter(page: Page, unreadOnly: boolean): Promise<void> {
  if (unreadOnly) return;
  const allTab = page.locator('.chat-message-filter-left span').filter({ hasText: /全部|所有/ }).first();
  if (!await allTab.isVisible().catch(() => false)) {
    throw new Error('Boss chat does not expose the all-conversations filter.');
  }
  const className = await allTab.getAttribute('class') ?? '';
  if (!className.split(/\s+/).includes('active')) {
    await clickBossControl(allTab, page, config.playwright.searchPageTimeoutMs);
    await page.locator('.user-list').first().waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  }
}

export async function prepareBossChatPage(page: Page, unreadOnly: boolean): Promise<Page> {
  const chatPage = await openBossChatPage(page);
  await selectBossConversationFilter(chatPage, unreadOnly);
  return chatPage;
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

export async function readBossConversationHistory(page: Page): Promise<BossChatMessage[]> {
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
