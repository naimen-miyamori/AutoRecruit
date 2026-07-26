import type { Page } from 'playwright';
import type {
  BossCandidateReply,
  BossCandidateReplyType,
  BossPreviousChatAssessment,
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  WorkExperience,
} from '../types/job.js';
import { openBossChatPage } from './boss/actions/navigation-actions.js';
import {
  collectBossUnreadConversations,
  openBossConversationById,
  type BossUnreadConversation,
} from './boss/actions/conversation-read-actions.js';
import {
  bossQualifiedCandidateChatMessage,
  bossShanghaiOriginQuestionMessage,
  bossUnqualifiedCandidateChatMessage,
  requestBossPhoneExchange as requestBossPhoneExchangeAction,
  sendBossCommonPhraseMessage as sendBossCommonPhraseMessageAction,
  sendBossEditorMessage as sendBossEditorMessageAction,
} from './boss/actions/conversation-mutation-actions.js';
import {
  closeBossChatResume,
  openAndParseBossChatResume,
} from './boss/actions/resume-actions.js';

export { openBossChatPage } from './boss/actions/navigation-actions.js';
export {
  collectBossUnreadConversations,
  type BossUnreadConversation,
} from './boss/actions/conversation-read-actions.js';
export {
  closeBossChatResume,
  openAndParseBossChatResume,
} from './boss/actions/resume-actions.js';
export {
  bossQualifiedCandidateChatMessage,
  bossShanghaiOriginQuestionMessage,
  bossUnqualifiedCandidateChatMessage,
} from './boss/actions/conversation-mutation-actions.js';

const bossChatUrl = 'https://www.zhipin.com/web/chat/index';

interface BossChatWorkSnapshot {
  timeDesc?: string;
  company?: string;
  positionName?: string;
}

interface BossChatEducationSnapshot {
  timeDesc?: string;
  school?: string;
  major?: string;
  degree?: string;
}

export interface BossOpenedConversationSnapshot {
  conversationId: string;
  candidateId: string;
  candidateName?: string;
  jobName: string;
  bossJobId?: string;
  ageDesc?: string;
  nativePlace?: string;
  education?: string;
  city?: string;
  currentCompany?: string;
  currentTitle?: string;
  workExperiences: BossChatWorkSnapshot[];
  educationExperiences: BossChatEducationSnapshot[];
  previousChat?: BossPreviousChatAssessment;
  newCandidateReplies?: BossCandidateReply[];
  newCandidateRepliesError?: string;
}

export interface BossOpenedConversation {
  conversation: BossUnreadConversation;
  candidate: CandidateListItem;
  resume: CandidateResume;
  previousChat: BossPreviousChatAssessment;
  newCandidateReplies?: BossCandidateReply[];
  newCandidateRepliesError?: string;
}

export interface BossPreviousChatSignals {
  bothTalked: boolean;
  hasVisibleRecruiterMessage: boolean;
  visibleMessageCount: number;
  unreadCount: number;
}

interface BossChatMessageSnapshot extends BossCandidateReply {
  sender: 'candidate' | 'recruiter' | 'system' | 'unknown';
}

export interface BossQualifiedContactResult {
  messageSent: boolean;
  messageAlreadyPresent: boolean;
  phoneExchangeRequested: boolean;
  phoneExchangeAlreadyRequested: boolean;
}

export interface BossChatMessageResult {
  messageSent: boolean;
  messageAlreadyPresent: boolean;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function parseAge(value: string | undefined): number | undefined {
  const match = value?.match(/(\d{1,3})/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

export function assessBossPreviousChat(signals: BossPreviousChatSignals): BossPreviousChatAssessment {
  const visibleMessageCount = Number.isFinite(signals.visibleMessageCount)
    ? Math.max(0, Math.trunc(signals.visibleMessageCount))
    : 0;
  const unreadCountAtOpen = Number.isFinite(signals.unreadCount)
    ? Math.max(1, Math.trunc(signals.unreadCount))
    : 1;

  if (signals.bothTalked) {
    return {
      previouslyChatted: true,
      basis: 'boss-both-talked',
      visibleMessageCount,
      unreadCountAtOpen,
    };
  }
  if (signals.hasVisibleRecruiterMessage) {
    return {
      previouslyChatted: true,
      basis: 'visible-recruiter-message',
      visibleMessageCount,
      unreadCountAtOpen,
    };
  }
  if (visibleMessageCount > unreadCountAtOpen) {
    return {
      previouslyChatted: true,
      basis: 'visible-message-history',
      visibleMessageCount,
      unreadCountAtOpen,
    };
  }

  return {
    previouslyChatted: false,
    basis: 'none',
    visibleMessageCount,
    unreadCountAtOpen,
  };
}

function selectBossNewCandidateReplies(
  messages: readonly BossChatMessageSnapshot[],
  unreadCount: number,
): { replies?: BossCandidateReply[]; error?: string } {
  const expectedCount = Number.isFinite(unreadCount) ? Math.max(1, Math.trunc(unreadCount)) : 1;
  const candidateMessages = messages.filter((message) => message.sender === 'candidate');
  if (candidateMessages.length < expectedCount) {
    const unknownMessages = messages.filter((message) => message.sender === 'unknown').length;
    return {
      error: `Unable to reliably extract ${expectedCount} unread Boss candidate message(s): found ${candidateMessages.length} candidate message(s) and ${unknownMessages} message(s) with unknown sender.`,
    };
  }

  return {
    replies: candidateMessages.slice(-expectedCount).map(({ sender: _sender, ...reply }) => reply),
  };
}

function parseTimeRange(value: string | undefined): { start?: string; end?: string } {
  const normalized = normalizeText(value);
  if (!normalized) {
    return {};
  }

  const [start, end] = normalized.split(/\s*[-至~]\s*/, 2);
  return {
    start: normalizeText(start),
    end: normalizeText(end),
  };
}

export function parseBossChatResumeSnapshot(snapshot: BossOpenedConversationSnapshot, resumeUrl: string): CandidateResume {
  const workExperiences: WorkExperience[] = snapshot.workExperiences.map((work) => ({
    company: normalizeText(work.company),
    title: normalizeText(work.positionName),
    ...parseTimeRange(work.timeDesc),
    details: [],
  })).filter((work) => Boolean(work.company || work.title));
  const educationExperiences: EducationExperience[] = snapshot.educationExperiences.map((education) => ({
    school: normalizeText(education.school),
    degree: normalizeText(education.degree),
    major: normalizeText(education.major),
    ...parseTimeRange(education.timeDesc),
    details: [],
  })).filter((education) => Boolean(education.school || education.degree || education.major));

  if (workExperiences.length === 0 && (snapshot.currentCompany || snapshot.currentTitle)) {
    workExperiences.push({
      company: normalizeText(snapshot.currentCompany),
      title: normalizeText(snapshot.currentTitle),
      details: [],
    });
  }

  return {
    candidateId: snapshot.candidateId,
    resumeUrl,
    name: normalizeText(snapshot.candidateName),
    age: parseAge(snapshot.ageDesc),
    nativePlace: normalizeText(snapshot.nativePlace),
    education: normalizeText(snapshot.education),
    regions: [normalizeText(snapshot.city)].filter((value): value is string => Boolean(value)),
    pr: [],
    workExperiences,
    projectExperiences: [],
    educationExperiences,
    skill: [],
    certificates: [],
  };
}

async function readOpenedBossConversation(page: Page, conversation: BossUnreadConversation): Promise<BossOpenedConversationSnapshot> {
  const snapshot = await page.evaluate(({ fallbackConversationId, fallbackName, fallbackJobName }) => {
    type VueViewModel = Record<string, unknown> & {
        $options?: { name?: string };
        currentData$?: Record<string, unknown>;
        conversation$?: Record<string, unknown>;
    };
    type VueElement = HTMLElement & {
      __vue__?: VueViewModel;
    };
    const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const readPlace = (value: unknown) => {
      if (typeof value === 'string') {
        return readString(value);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }

      const record = value as Record<string, unknown>;
      return readString(record.name) ?? readString(record.cityName) ?? readString(record.label);
    };
    const readNumberString = (value: unknown) => typeof value === 'number' || typeof value === 'string'
      ? String(value)
      : undefined;
    const currentData = (document.querySelector('.chat-conversation') as VueElement | null)?.__vue__?.currentData$ ?? {};
    const conversationData = (document.querySelector('.base-info-single-container') as VueElement | null)?.__vue__?.conversation$ ?? {};
    const exchangeConversation = Array.from(document.querySelectorAll<VueElement>('.operate-exchange-left .operate-icon-item'))
      .map((element) => element.__vue__)
      .find((viewModel) => viewModel?.$options?.name === 'ExchangePhone')
      ?.conversation$ ?? {};
    const isTrueFlag = (value: unknown) => value === true || value === 1 || value === '1';
    const bothTalked = [currentData, conversationData, exchangeConversation]
      .some((record) => isTrueFlag(record.bothTalked));
    const visibleMessages = Array.from(document.querySelectorAll<HTMLElement>('.chat-message-list .message-item'));
    const recruiterSelector = [
        '.item-myself',
        '.message-myself',
        '.is-self',
        '.self',
        '.mine',
        '[data-from="self"]',
        '[data-sender="self"]',
        '[data-side="right"]',
      ].join(',');
    const recruiterClassPattern = /(^|[-_])(myself|self|mine|outgoing|sent|right)([-_]|$)/i;
    const candidateClassPattern = /(^|[-_])(friend|other|incoming|received|left|candidate|geek)([-_]|$)/i;
    const systemClassPattern = /(^|[-_])(system|notice|time|divider|recall|tip)([-_]|$)/i;
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    );
    const collectVueRecords = (message: HTMLElement): Record<string, unknown>[] => {
      const viewModel = (message as VueElement).__vue__;
      if (!viewModel) {
        return [];
      }

      const records: Record<string, unknown>[] = [viewModel];
      const nestedKeys = [
        'message', 'message$', 'msg', 'msg$', 'item', 'item$', 'data', 'data$',
        'content', 'content$', '$props', 'messageData', 'messageData$',
      ];
      for (const key of nestedKeys) {
        const nested = viewModel[key];
        if (isRecord(nested)) {
          records.push(nested);
        }
      }
      return records;
    };
    const readRecordValue = (records: readonly Record<string, unknown>[], keys: readonly string[]): unknown => {
      for (const record of records) {
        for (const key of keys) {
          if (record[key] !== undefined && record[key] !== null) {
            return record[key];
          }
        }
      }
      return undefined;
    };
    const readRecordString = (records: readonly Record<string, unknown>[], keys: readonly string[]): string | undefined => {
      const value = readRecordValue(records, keys);
      return typeof value === 'string' || typeof value === 'number'
        ? readString(String(value))
        : undefined;
    };
    const readTrueFlag = (records: readonly Record<string, unknown>[], keys: readonly string[]): boolean => {
      const value = readRecordValue(records, keys);
      return value === true || value === 1 || value === '1' || value === 'true';
    };
    const normalizeVisible = (value: string | null | undefined) => readString(value?.replace(/\s+/g, ' '));
    const isBossNonConversationMessage = (
      message: HTMLElement,
      records: readonly Record<string, unknown>[],
    ): boolean => {
      const text = normalizeVisible(message.textContent) ?? '';
      const semanticType = readRecordString(records, ['type', 'contentType', 'bodyType', 'msgType'])?.toLowerCase();
      const templateId = readRecordString(records, ['templateId', 'templateID', 'tplId']);
      return Boolean(
        (semanticType === 'resume' && templateId === '3' && /沟通的职位\s*[-—]/.test(text))
        || (semanticType === 'listcard' && templateId === '6' && /快速回复/.test(text))
        || /该牛人近30天内未与您沟通过.*首次回聊该牛人消息需消耗回聊次数/.test(text),
      );
    };
    const classifySender = (
      message: HTMLElement,
      records: readonly Record<string, unknown>[],
    ): BossChatMessageSnapshot['sender'] => {
      const classNames = [...message.classList];
      const typeValue = readRecordString(records, ['type', 'contentType', 'bodyType', 'msgType', 'messageType'])?.toLowerCase();
      const domSenderValue = readString(
        message.getAttribute('data-sender')
          ?? message.getAttribute('data-from')
          ?? message.getAttribute('data-side'),
      )?.toLowerCase();
      if (isBossNonConversationMessage(message, records)
        || classNames.some((className) => systemClassPattern.test(className))
        || Boolean(typeValue && /(system|notice|time|divider|recall|tip)/i.test(typeValue))
        || Boolean(domSenderValue && /(system|notice|time|divider|recall|tip)/i.test(domSenderValue))) {
        return 'system';
      }

      const senderValue = readRecordString(records, [
        'senderType', 'senderRole', 'fromType', 'fromRole', 'userType', 'role', 'side', 'direction',
      ])?.toLowerCase();
      if (senderValue && /(geek|candidate|jobseeker|friend|other|incoming|received|left)/i.test(senderValue)) {
        return 'candidate';
      }
      if (senderValue && /(boss|recruiter|hr|self|myself|mine|outgoing|sent|right)/i.test(senderValue)) {
        return 'recruiter';
      }
      if (readTrueFlag(records, ['isFromGeek', 'fromGeek', 'isGeek', 'isCandidate', 'fromCandidate'])) {
        return 'candidate';
      }
      if (readTrueFlag(records, [
        'isSelf', 'isMine', 'fromSelf', 'senderIsSelf', 'sendBySelf', 'isFromBoss', 'fromBoss', 'isRecruiter',
      ])) {
        return 'recruiter';
      }

      const senderId = readRecordString(records, ['fromUid', 'senderUid', 'sendUserId', 'senderId', 'fromId']);
      const candidateSenderIds = [
        conversationData.expectId,
        conversationData.encryptExpectId,
        conversationData.geekUid,
        conversationData.uid,
        currentData.expectId,
        currentData.geekUid,
      ].map((value) => readNumberString(value)).filter((value): value is string => Boolean(value));
      if (senderId && candidateSenderIds.includes(senderId)) {
        return 'candidate';
      }
      const recruiterSenderIds = [
        conversationData.bossUid,
        conversationData.bossId,
        conversationData.recruiterId,
        currentData.bossUid,
        currentData.bossId,
      ].map((value) => readNumberString(value)).filter((value): value is string => Boolean(value));
      if (senderId && recruiterSenderIds.includes(senderId)) {
        return 'recruiter';
      }

      if (message.matches(recruiterSelector) || classNames.some((className) => recruiterClassPattern.test(className))) {
        return 'recruiter';
      }
      if (classNames.some((className) => candidateClassPattern.test(className))) {
        return 'candidate';
      }
      if (domSenderValue && /(geek|candidate|jobseeker|friend|other|incoming|received|left)/i.test(domSenderValue)) {
        return 'candidate';
      }
      if (domSenderValue && /(boss|recruiter|hr|self|myself|mine|outgoing|sent|right)/i.test(domSenderValue)) {
        return 'recruiter';
      }
      if (domSenderValue) {
        return 'unknown';
      }

      // Boss candidate messages use the base message-item class; recruiter messages add an explicit self marker.
      return 'candidate';
    };
    const classifyMessageType = (
      message: HTMLElement,
      records: readonly Record<string, unknown>[],
    ): BossCandidateReplyType => {
      const typeValue = readRecordString(records, ['type', 'contentType', 'bodyType', 'msgType', 'messageType'])?.toLowerCase() ?? '';
      const classValue = [...message.classList].join(' ').toLowerCase();
      const matches = (pattern: RegExp) => pattern.test(typeValue) || pattern.test(classValue);
      if (matches(/resume|简历/i) || Boolean(message.querySelector('[class*="resume"]'))) {
        return 'resume';
      }
      if (matches(/attachment|\bfile\b|附件|文件/i) || Boolean(message.querySelector('a[download], [class*="file"], [class*="attachment"]'))) {
        return 'attachment';
      }
      if (matches(/voice|audio|语音/i) || Boolean(message.querySelector('audio, [class*="voice"]'))) {
        return 'voice';
      }
      if (matches(/video|视频/i) || Boolean(message.querySelector('video, [class*="video"]'))) {
        return 'video';
      }
      if (matches(/image|photo|picture|\bpic\b|图片/i) || Boolean(message.querySelector(
        ':scope > img, .image-content img, [class*="message-image"] img, [class*="image-message"] img, .img-content img',
      ))) {
        return 'image';
      }
      const text = normalizeVisible(message.querySelector('.text-content')?.textContent)
        ?? readRecordString(records, ['text', 'contentText', 'messageText']);
      return text ? 'text' : 'other';
    };
    const placeholderByType: Record<BossCandidateReplyType, string> = {
      text: '[文本]',
      image: '[图片]',
      resume: '[简历]',
      attachment: '[附件]',
      voice: '[语音]',
      video: '[视频]',
      other: '[无法识别的消息]',
    };
    const messageSnapshots: BossChatMessageSnapshot[] = visibleMessages.map((message) => {
      const records = collectVueRecords(message);
      const sender = classifySender(message, records);
      const type = classifyMessageType(message, records);
      const textContent = normalizeVisible(message.querySelector('.text-content')?.textContent)
        ?? readRecordString(records, ['text', 'contentText', 'messageText']);
      const visibleDescription = normalizeVisible(
        message.querySelector<HTMLElement>('[class*="file-name"], [class*="resume"], [class*="voice"], [class*="video"]')?.textContent,
      ) ?? normalizeVisible(message.querySelector<HTMLImageElement>('img')?.alt)
        ?? readRecordString(records, ['fileName', 'filename', 'description', 'title']);
      const placeholder = placeholderByType[type];
      const content = type === 'text' && textContent
        ? textContent
        : visibleDescription && visibleDescription !== placeholder.slice(1, -1)
          ? `${placeholder} ${visibleDescription}`
          : placeholder;
      const messageId = readRecordString(records, ['messageId', 'msgId', 'mid', 'uniqueId', 'id'])
        ?? readString(message.dataset.messageId)
        ?? readString(message.dataset.msgId)
        ?? readString(message.dataset.id);
      const sentAt = readRecordString(records, ['sendTime', 'sentAt', 'createTime', 'timestamp', 'time'])
        ?? readString(message.dataset.time)
        ?? readString(message.querySelector('time')?.getAttribute('datetime'))
        ?? normalizeVisible(message.querySelector('.message-time, [class*="send-time"]')?.textContent);
      return {
        sender,
        type,
        content,
        ...(messageId ? { messageId } : {}),
        ...(sentAt ? { sentAt } : {}),
      };
    }).filter((message) => message.sender !== 'system');
    const hasVisibleRecruiterMessage = messageSnapshots.some((message) => message.sender === 'recruiter');
    const workExperiences = Array.isArray(conversationData.workExpList)
      ? conversationData.workExpList.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];
    const educationExperiences = Array.isArray(conversationData.eduExpList)
      ? conversationData.eduExpList.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];
    const candidateId = readNumberString(conversationData.expectId)
      ?? readNumberString(currentData.expectId)
      ?? readString(conversationData.encryptExpectId)
      ?? fallbackConversationId;
    const bossJobId = readNumberString(currentData.jobId)
      ?? readNumberString(currentData.positionId)
      ?? readNumberString(conversationData.jobId)
      ?? readNumberString(conversationData.positionId)
      ?? readString(currentData.encryptJobId)
      ?? readString(conversationData.encryptJobId);

    return {
      conversationId: readString(currentData.uniqueId) ?? fallbackConversationId,
      candidateId,
      candidateName: readString(conversationData.name) ?? readString(currentData.name) ?? fallbackName,
      jobName: readString(currentData.jobName) ?? readString(conversationData.toPosition) ?? fallbackJobName,
      bossJobId,
      ageDesc: readString(conversationData.ageDesc),
      nativePlace: readString(conversationData.hometownName)
        ?? readPlace(conversationData.hometown)
        ?? readString(conversationData.nativePlaceName)
        ?? readPlace(conversationData.nativePlace)
        ?? readPlace(conversationData.householdRegistration),
      education: readString(conversationData.edu),
      city: readString(conversationData.city),
      currentCompany: readString(conversationData.lastCompany2) ?? readString(conversationData.lastCompany),
      currentTitle: readString(conversationData.lastPosition2)
        ?? readString(conversationData.lastPosition)
        ?? readString(conversationData.positionName),
      workExperiences: workExperiences.map((item) => ({
        timeDesc: readString(item.timeDesc),
        company: readString(item.company),
        positionName: readString(item.positionName),
      })),
      educationExperiences: educationExperiences.map((item) => ({
        timeDesc: readString(item.timeDesc),
        school: readString(item.school),
        major: readString(item.major),
        degree: readString(item.degree),
      })),
      previousChatSignals: {
        bothTalked,
        hasVisibleRecruiterMessage,
        visibleMessageCount: messageSnapshots.length,
      },
      messageSnapshots,
    };
  }, {
    fallbackConversationId: conversation.conversationId,
    fallbackName: conversation.candidateName,
    fallbackJobName: conversation.jobName,
  });

  const { previousChatSignals, messageSnapshots, ...resumeSnapshot } = snapshot;
  const newReplies = selectBossNewCandidateReplies(messageSnapshots, conversation.unreadCount);
  return {
    ...resumeSnapshot,
    previousChat: assessBossPreviousChat({
      ...previousChatSignals,
      unreadCount: conversation.unreadCount,
    }),
    ...(newReplies.replies ? { newCandidateReplies: newReplies.replies } : {}),
    ...(newReplies.error ? { newCandidateRepliesError: newReplies.error } : {}),
  };
}

export async function openBossUnreadConversation(
  page: Page,
  conversation: BossUnreadConversation,
): Promise<BossOpenedConversation> {
  await openBossConversationById(page, conversation);
  const snapshot = await readOpenedBossConversation(page, conversation);
  const candidate: CandidateListItem = {
    candidateId: snapshot.candidateId,
    name: snapshot.candidateName,
    currentCompany: snapshot.currentCompany,
    currentTitle: snapshot.currentTitle,
    cardText: [snapshot.candidateName, snapshot.jobName, snapshot.currentCompany, snapshot.currentTitle].filter(Boolean).join(' '),
    sourceText: `boss-chat-conversation=${conversation.conversationId}`,
  };

  return {
    conversation,
    candidate,
    resume: parseBossChatResumeSnapshot(snapshot, bossChatUrl),
    previousChat: snapshot.previousChat ?? assessBossPreviousChat({
      bothTalked: false,
      hasVisibleRecruiterMessage: false,
      visibleMessageCount: 0,
      unreadCount: conversation.unreadCount,
    }),
    ...(snapshot.newCandidateReplies ? { newCandidateReplies: snapshot.newCandidateReplies } : {}),
    ...(snapshot.newCandidateRepliesError ? { newCandidateRepliesError: snapshot.newCandidateRepliesError } : {}),
  };
}

export async function sendBossCommonPhraseMessage(
  page: Page,
  message: string,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  return sendBossCommonPhraseMessageAction(page, message);
}

async function sendBossEditorMessage(
  page: Page,
  message: string,
): Promise<{ sent: boolean; alreadyPresent: boolean }> {
  return sendBossEditorMessageAction(page, message);
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

export async function requestBossPhoneExchange(page: Page): Promise<{ requested: boolean; alreadyRequested: boolean }> {
  return requestBossPhoneExchangeAction(page);
}

export async function contactBossQualifiedCandidate(page: Page): Promise<BossQualifiedContactResult> {
  const message = await sendBossQualifiedCandidateMessage(page);
  const phone = await requestBossPhoneExchange(page);
  return {
    messageSent: message.sent,
    messageAlreadyPresent: message.alreadyPresent,
    phoneExchangeRequested: phone.requested,
    phoneExchangeAlreadyRequested: phone.alreadyRequested,
  };
}

export async function contactBossUnqualifiedCandidate(page: Page): Promise<BossChatMessageResult> {
  const message = await sendBossUnqualifiedCandidateMessage(page);
  return {
    messageSent: message.sent,
    messageAlreadyPresent: message.alreadyPresent,
  };
}

export async function contactBossShanghaiOriginCandidate(page: Page): Promise<BossChatMessageResult> {
  const message = await sendBossShanghaiOriginQuestionMessage(page);
  return {
    messageSent: message.sent,
    messageAlreadyPresent: message.alreadyPresent,
  };
}
