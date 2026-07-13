import type { Page } from 'playwright';
import { config } from '../config.js';
import type { CandidateListItem, CandidateResume, EducationExperience, WorkExperience } from '../types/job.js';
import {
  closeExistingBossResumeDialog,
  parseBossResumeData,
  parseBossResumeDetail,
  waitForBossResumeDetailReady,
} from './boss-adapter.js';

const bossChatUrl = 'https://www.zhipin.com/web/chat/index';
export const bossQualifiedCandidateChatMessage = '方便发一份你的简历过来吗？';
export const bossUnqualifiedCandidateChatMessage = '对不起，看了你的简历以后觉得不太合适，希望你早日找到满意的工作机会';

export interface BossUnreadConversation {
  conversationId: string;
  candidateName?: string;
  jobName: string;
  unreadCount: number;
}

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
  ageDesc?: string;
  education?: string;
  city?: string;
  currentCompany?: string;
  currentTitle?: string;
  workExperiences: BossChatWorkSnapshot[];
  educationExperiences: BossChatEducationSnapshot[];
}

export interface BossOpenedConversation {
  conversation: BossUnreadConversation;
  candidate: CandidateListItem;
  resume: CandidateResume;
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

function mergeBossChatResume(summary: CandidateResume, detail: CandidateResume): CandidateResume {
  const detailHasRichWork = detail.workExperiences.length > summary.workExperiences.length
    || detail.workExperiences.some((work) => work.details.length > 0);
  const detailHasRichEducation = detail.educationExperiences.length > summary.educationExperiences.length
    || detail.educationExperiences.some((education) => education.details.length > 0);
  return {
    ...summary,
    name: detail.name ?? summary.name,
    age: detail.age ?? summary.age,
    education: detail.education ?? summary.education,
    regions: detail.regions.length > 0 ? detail.regions : summary.regions,
    pr: detail.pr.length > 0 ? detail.pr : summary.pr,
    workExperiences: detailHasRichWork ? detail.workExperiences : summary.workExperiences,
    projectExperiences: detail.projectExperiences.length > 0 ? detail.projectExperiences : summary.projectExperiences,
    educationExperiences: detailHasRichEducation ? detail.educationExperiences : summary.educationExperiences,
    skill: detail.skill.length > 0 ? detail.skill : summary.skill,
    certificates: detail.certificates.length > 0 ? detail.certificates : summary.certificates,
  };
}

function isBossChatPage(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/chat\/index(?:[/?#].*)?$/i.test(url);
}

export async function openBossChatPage(page: Page): Promise<Page> {
  if (!isBossChatPage(page.url())) {
    await page.locator('a[ka="menu-im"], a[href^="/web/chat/index"]').first().click({
      timeout: config.playwright.searchPageTimeoutMs,
    });
    await page.waitForURL((url) => isBossChatPage(url.toString()), {
      timeout: config.playwright.searchPageTimeoutMs,
    });
  }

  const unreadTab = page.locator('.chat-message-filter-left span').filter({ hasText: '未读' }).first();
  await unreadTab.waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  const className = await unreadTab.getAttribute('class') ?? '';
  if (!className.split(/\s+/).includes('active')) {
    await unreadTab.click({ timeout: config.playwright.searchPageTimeoutMs });
  }

  await page.locator('.user-list').first().waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  return page;
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
    if (!badge && !retry) {
      return [];
    }

    const jobName = normalize(item.querySelector('.source-job')?.textContent) || retry?.jobName;
    if (!conversationId || !jobName) {
      return [];
    }

    const unreadCount = badge ? Number.parseInt(normalize(badge.textContent), 10) : retry!.unreadCount;
    return [{
      conversationId,
      candidateName: normalize(item.querySelector('.geek-name')?.textContent) || retry?.candidateName,
      jobName,
      unreadCount: Number.isFinite(unreadCount) ? unreadCount : 1,
    }];
    });
  }, retryConversations);
}

async function readOpenedBossConversation(page: Page, conversation: BossUnreadConversation): Promise<BossOpenedConversationSnapshot> {
  return page.evaluate(({ fallbackConversationId, fallbackName, fallbackJobName }) => {
    type VueElement = HTMLElement & {
      __vue__?: {
        currentData$?: Record<string, unknown>;
        conversation$?: Record<string, unknown>;
      };
    };
    const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const readNumberString = (value: unknown) => typeof value === 'number' || typeof value === 'string'
      ? String(value)
      : undefined;
    const currentData = (document.querySelector('.chat-conversation') as VueElement | null)?.__vue__?.currentData$ ?? {};
    const conversationData = (document.querySelector('.base-info-single-container') as VueElement | null)?.__vue__?.conversation$ ?? {};
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

    return {
      conversationId: readString(currentData.uniqueId) ?? fallbackConversationId,
      candidateId,
      candidateName: readString(conversationData.name) ?? readString(currentData.name) ?? fallbackName,
      jobName: readString(currentData.jobName) ?? readString(conversationData.toPosition) ?? fallbackJobName,
      ageDesc: readString(conversationData.ageDesc),
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
    };
  }, {
    fallbackConversationId: conversation.conversationId,
    fallbackName: conversation.candidateName,
    fallbackJobName: conversation.jobName,
  });
}

export async function openBossUnreadConversation(
  page: Page,
  conversation: BossUnreadConversation,
): Promise<BossOpenedConversation> {
  const items = page.locator('.user-list .geek-item');
  const itemIndex = await items.evaluateAll((elements, conversationId) => elements.findIndex((element) => (
    element.getAttribute('data-id') === conversationId || element.id === `_${conversationId}`
  )), conversation.conversationId);
  if (itemIndex < 0) {
    throw new Error(`Boss unread conversation ${conversation.conversationId} is no longer visible.`);
  }

  await items.nth(itemIndex).click({ timeout: config.playwright.resumeDetailTimeoutMs });
  await page.waitForFunction(({ expectedConversationId, expectedName }) => {
    type VueElement = HTMLElement & {
      __vue__?: {
        currentData$?: Record<string, unknown>;
        conversation$?: Record<string, unknown>;
      };
    };
    const currentData = (document.querySelector('.chat-conversation') as VueElement | null)?.__vue__?.currentData$;
    const conversationData = (document.querySelector('.base-info-single-container') as VueElement | null)?.__vue__?.conversation$;
    if (!currentData || !conversationData) {
      return false;
    }

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
    return currentMatches && detailMatches && detailHydrated;
  }, {
    expectedConversationId: conversation.conversationId,
    expectedName: conversation.candidateName,
  }, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 200 });

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
  };
}

export async function openAndParseBossChatResume(page: Page, opened: BossOpenedConversation): Promise<CandidateResume> {
  const deadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
  await closeExistingBossResumeDialog(page, deadline);
  const abstractMessageCount = await page.evaluate(() => {
    type BossResumeCaptureWindow = Window & typeof globalThis & {
      __autorecruitBossResumeAbstracts?: unknown[];
      __autorecruitBossResumeListenerInstalled?: boolean;
    };
    const target = window as BossResumeCaptureWindow;
    target.__autorecruitBossResumeAbstracts ??= [];
    if (!target.__autorecruitBossResumeListenerInstalled) {
      target.__autorecruitBossResumeListenerInstalled = true;
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'IFRAME_DONE' && event.data?.data?.abstractData) {
          target.__autorecruitBossResumeAbstracts!.push(event.data.data.abstractData);
        }
      });
    }

    return target.__autorecruitBossResumeAbstracts.length;
  });
  const primaryResumeButton = page.locator('.chat-conversation .resume-btn-online');
  const primaryCount = await primaryResumeButton.count();
  const onlineResume = primaryCount === 1
    ? primaryResumeButton
    : page.getByText('简历简介', { exact: true }).or(page.getByText('在线简历', { exact: true }));
  const onlineResumeCount = await onlineResume.count();
  if (onlineResumeCount !== 1) {
    throw new Error(`Expected one Boss chat resume introduction control, found ${onlineResumeCount}.`);
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await onlineResume.click({ timeout: config.playwright.resumeDetailTimeoutMs });
  if (!isBossChatPage(page.url())) {
    throw new Error(`Boss resume introduction click left the chat page unexpectedly: ${page.url()}`);
  }
  await waitForBossResumeDetailReady(page, deadline);

  const abstractData = await page.waitForFunction((previousCount) => {
    const values = (window as Window & typeof globalThis & {
      __autorecruitBossResumeAbstracts?: unknown[];
    }).__autorecruitBossResumeAbstracts ?? [];
    return values.length > previousCount ? values.at(-1) : undefined;
  }, abstractMessageCount, { timeout: Math.max(deadline - Date.now(), 1), polling: 100 })
    .then((handle) => handle.jsonValue() as Promise<Record<string, unknown>>)
    .catch(() => undefined);
  const abstractResume = abstractData
    ? parseBossResumeData(abstractData, page, opened.candidate)
    : undefined;
  const apiResume = await parseBossResumeDetail(page, opened.candidate).catch(() => undefined);
  const withAbstract = abstractResume ? mergeBossChatResume(opened.resume, abstractResume) : opened.resume;
  return apiResume ? mergeBossChatResume(withAbstract, apiResume) : withAbstract;
}

async function hasBossChatMessage(page: Page, message: string): Promise<boolean> {
  return page.locator('.chat-message-list .message-item .text-content').evaluateAll((elements, expectedMessage) => (
    elements.some((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage)
  ), message);
}

async function chooseBossCommonPhrase(page: Page, message: string): Promise<void> {
  const editor = page.locator('#boss-chat-editor-input[contenteditable="true"]');
  const currentEditorText = normalizeText(await editor.textContent() ?? '');
  if (currentEditorText === message) {
    return;
  }
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
    await trigger.click({ timeout: config.playwright.resumeDetailTimeoutMs });
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

  await phraseItems.nth(matches[0]!.index).click({
    position: { x: 8, y: 8 },
    timeout: config.playwright.resumeDetailTimeoutMs,
  });
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
  await submit.click({ timeout: config.playwright.resumeDetailTimeoutMs });
  await page.waitForFunction((expectedMessage) => {
    const messageExists = Array.from(document.querySelectorAll('.chat-message-list .message-item .text-content'))
      .some((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedMessage);
    const editor = document.querySelector<HTMLElement>('#boss-chat-editor-input[contenteditable="true"]');
    return messageExists && !(editor?.innerText ?? editor?.textContent ?? '').trim();
  }, message, { timeout: config.playwright.resumeDetailTimeoutMs, polling: 200 });

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

async function readBossPhoneExchangeState(page: Page): Promise<{
  requested: boolean;
  bothTalked: boolean;
}> {
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
  if (initialState.requested) {
    return { requested: true, alreadyRequested: true };
  }

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
  await phoneButton.evaluate((element) => (element as HTMLElement).click());
  const confirmation = phoneItem.locator('.exchange-tooltip');
  await confirmation.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
  const confirmButton = confirmation.locator('.boss-btn-primary').filter({ hasText: '确定' });
  const confirmButtonCount = await confirmButton.count();
  if (confirmButtonCount !== 1) {
    throw new Error(`Expected one Boss phone-exchange confirmation control, found ${confirmButtonCount}.`);
  }

  await confirmButton.evaluate((element) => (element as HTMLElement).click());
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

export async function closeBossChatResume(page: Page): Promise<void> {
  const deadline = Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
  await closeExistingBossResumeDialog(page, deadline);
}
