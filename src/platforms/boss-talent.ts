import type { Frame, Locator, Page } from 'playwright';
import { clickPlatformLocator, waitPlatformActionPace } from '../browser/pacing.js';
import { config } from '../config.js';
import type {
  BossDeepSearchForm,
  BossGreetInput,
  BossGreetResult,
  BossTalentCandidate,
  BossTalentSearchInput,
  BossTalentSearchResult,
  BossTalentSource,
} from '../types/boss.js';

const bossRecommendUrl = 'https://www.zhipin.com/web/chat/recommend';
const bossDeepSearchUrl = 'https://www.zhipin.com/web/chat/aiform';
const candidateCardSelector = '.geeks-box .geek-card-item, .geek-card-list .geek-card-item, .geek-card-item';

type BossTalentRoot = Page | Frame;

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function normalizeRequirements(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)))];
}

async function runBossAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await waitPlatformActionPace(page, 'boss');
  return action();
}

function talentUrl(source: BossTalentSearchInput['source']): string {
  return source === 'recommend' ? bossRecommendUrl : bossDeepSearchUrl;
}

function isTalentUrl(url: string, source: BossTalentSearchInput['source']): boolean {
  return new URL(talentUrl(source)).pathname === new URL(url, 'https://www.zhipin.com').pathname;
}

export async function openBossTalentPage(
  page: Page,
  source: BossTalentSearchInput['source'],
): Promise<Page> {
  if (!isTalentUrl(page.url(), source)) {
    await runBossAction(page, () => page.goto(talentUrl(source), {
      waitUntil: 'domcontentloaded',
      timeout: config.playwright.searchPageTimeoutMs,
    }));
  }

  const readySelector = source === 'deep-search'
    ? '.ai-form-left'
    : `${candidateCardSelector}, iframe[name="recommendFrame"], iframe[src*="recommend"]`;
  await page.locator(readySelector).first().waitFor({
    state: 'attached',
    timeout: config.playwright.searchPageTimeoutMs,
  });
  return page;
}

async function resolveTalentRoot(page: Page, source: BossTalentSearchInput['source']): Promise<BossTalentRoot> {
  if (source !== 'recommend') {
    return page;
  }

  const frame = page.frames().find((candidate) => (
    candidate.name() === 'recommendFrame' || /\/recommend(?:[/?#]|$)/i.test(candidate.url())
  ));
  return frame ?? page;
}

function parseCandidateCards(root: BossTalentRoot, source: BossTalentSource): Promise<BossTalentCandidate[]> {
  return root.locator(candidateCardSelector).evaluateAll((cards, cardSource) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const readPrimitive = (value: unknown) => (
      typeof value === 'string' || typeof value === 'number' ? normalize(String(value)) : ''
    );
    const readVueId = (card: VueElement): string => {
      const roots = [card.__vue__];
      const keys = ['geekId', 'expectId', 'encryptGeekId', 'lid', 'jid', 'id'];
      for (const root of roots) {
        if (!root) continue;
        for (const key of keys) {
          const value = readPrimitive(root[key]);
          if (value) return value;
        }
        for (const nestedKey of ['geek', 'geekInfo', 'item', 'data', 'cardData']) {
          const nested = root[nestedKey];
          if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
          for (const key of keys) {
            const value = readPrimitive((nested as Record<string, unknown>)[key]);
            if (value) return value;
          }
        }
      }
      return '';
    };
    const readCandidateId = (card: HTMLElement): string => {
      const attributes = ['data-geek-id', 'data-expect', 'data-jid', 'data-lid', 'data-id', 'data-item-id'];
      for (const attribute of attributes) {
        const value = normalize(card.getAttribute(attribute));
        if (value) return value;
      }
      const href = card.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '';
      const match = href.match(/[?&](?:geekId|expectId|jid|lid|id)=([^&#]+)/i);
      return match?.[1] ? decodeURIComponent(match[1]) : readVueId(card as VueElement);
    };
    return cards.flatMap((element, index) => {
      const card = element as HTMLElement;
      const candidateId = readCandidateId(card);
      if (!candidateId) return [];
      const text = normalize(card.innerText || card.textContent);
      const chatText = normalize(card.querySelector<HTMLElement>('.geek-chat')?.innerText);
      const contactState = /继续沟通|继续聊/.test(chatText)
        ? 'continue-chat'
        : /打招呼|立即沟通|沟通/.test(chatText)
          ? 'greet'
          : 'unknown';
      return [{
        candidateId,
        name: normalize(card.querySelector<HTMLElement>('.geek-name, .name, [class*="name"]')?.innerText),
        summary: text || undefined,
        workSummary: normalize(card.querySelector<HTMLElement>('.work-info, .work-experience, [class*="work"]')?.innerText),
        educationSummary: normalize(card.querySelector<HTMLElement>('.edu-info, .education, [class*="edu"]')?.innerText),
        recommendationReason: normalize(card.querySelector<HTMLElement>('.recommend-reason, [class*="reason"]')?.innerText),
        contactState,
        source: cardSource,
        searchResultIndex: index,
      }];
    });
  }, source);
}

export async function readBossRecommendationCandidates(page: Page): Promise<BossTalentCandidate[]> {
  const root = await resolveTalentRoot(page, 'recommend');
  return parseCandidateCards(root, 'recommend');
}

export async function readBossDeepSearchCandidates(page: Page): Promise<BossTalentCandidate[]> {
  return (await parseCandidateCards(page, 'deep-search')).slice(-20);
}

export async function readBossDeepSearchForm(page: Page): Promise<BossDeepSearchForm> {
  return page.evaluate(() => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const groups = Array.from(document.querySelectorAll<HTMLElement>('.form-content'));
    const readRequirementGroup = (label: RegExp) => {
      const group = groups.find((element) => label.test(normalize(
        element.querySelector<HTMLElement>('.form-content-title-h3')?.innerText ?? element.innerText,
      )));
      if (!group) return [];
      return Array.from(group.querySelectorAll<HTMLElement>('.form-content-list-item'))
        .map((row) => normalize(
          row.querySelector<HTMLInputElement | HTMLTextAreaElement>('.auto-resize-textarea-wrapper textarea, .auto-resize-textarea-wrapper input')?.value
          ?? row.querySelector<HTMLElement>('.form-content-word')?.innerText
          ?? row.innerText,
        ))
        .filter(Boolean);
    };
    const footer = document.querySelector<HTMLElement>('.ai-form-match-footer');
    const quotaText = normalize(footer?.querySelector<HTMLElement>('.ai-form-match-footer-text-count')?.innerText);
    const quotaMatch = quotaText.match(/(\d+)/);
    const button = footer?.querySelector<HTMLButtonElement>('.btn-ai-match-v2');
    const jobElement = document.querySelector<HTMLElement>('[data-job-id], [data-position-id], .job-select, .position-select');
    const vue = (jobElement as VueElement | null)?.__vue__;
    const bossJobId = normalize(
      jobElement?.getAttribute('data-job-id')
      ?? jobElement?.getAttribute('data-position-id')
      ?? (typeof vue?.jobId === 'string' || typeof vue?.jobId === 'number' ? String(vue.jobId) : ''),
    );
    const jobName = normalize(
      document.querySelector<HTMLElement>('.job-select .selected, .position-select .selected, .job-name, [data-current-job-name]')?.innerText
      ?? document.querySelector<HTMLElement>('[data-current-job-name]')?.getAttribute('data-current-job-name'),
    );
    return {
      bossJobId: bossJobId || undefined,
      jobName,
      coreRequirements: readRequirementGroup(/核心要求/),
      bonusRequirements: readRequirementGroup(/加分项/),
      remainingMatchCount: quotaMatch ? Number.parseInt(quotaMatch[1]!, 10) : undefined,
      matchButtonEnabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'),
    };
  });
}

async function locateRequirementGroup(page: Page, title: '核心要求' | '加分项'): Promise<Locator> {
  const groups = page.locator('.form-content');
  const count = await groups.count();
  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    const heading = normalizeText(await group.locator('.form-content-title-h3').first().textContent().catch(() => ''));
    if (heading?.includes(title)) {
      return group;
    }
  }
  throw new Error(`Boss deep-search form does not contain the ${title} group.`);
}

async function resizeRequirementRows(page: Page, group: Locator, desiredCount: number, title: string): Promise<void> {
  let rows = group.locator('.form-content-list-item');
  let count = await rows.count();
  while (count < desiredCount) {
    const add = group.locator('.form-content-add, .btn-add, [class*="add"]').filter({ hasText: /添加|新增|\+/ }).first();
    if (!await add.isVisible().catch(() => false)) {
      throw new Error(`Boss deep-search ${title} has ${count} row(s), but ${desiredCount} are required and no add control is available.`);
    }
    await clickPlatformLocator(add, page, 'boss', config.playwright.resumeDetailTimeoutMs);
    rows = group.locator('.form-content-list-item');
    const nextCount = await rows.count();
    if (nextCount <= count) {
      throw new Error(`Boss deep-search ${title} add control did not create a requirement row.`);
    }
    count = nextCount;
  }
  while (count > desiredCount) {
    const row = rows.nth(count - 1);
    const remove = row.locator('.delete, .remove, [class*="delete"], [class*="remove"]').first();
    if (!await remove.isVisible().catch(() => false)) {
      throw new Error(`Boss deep-search ${title} has ${count} row(s), but ${desiredCount} are required and no remove control is available.`);
    }
    await clickPlatformLocator(remove, page, 'boss', config.playwright.resumeDetailTimeoutMs);
    rows = group.locator('.form-content-list-item');
    const nextCount = await rows.count();
    if (nextCount >= count) {
      throw new Error(`Boss deep-search ${title} remove control did not delete a requirement row.`);
    }
    count = nextCount;
  }
}

async function synchronizeRequirementGroup(
  page: Page,
  title: '核心要求' | '加分项',
  desiredValues: readonly string[],
): Promise<void> {
  const group = await locateRequirementGroup(page, title);
  await resizeRequirementRows(page, group, desiredValues.length, title);
  const rows = group.locator('.form-content-list-item');
  for (let index = 0; index < desiredValues.length; index += 1) {
    const row = rows.nth(index);
    const desired = desiredValues[index]!;
    const current = normalizeText(await row.locator('.form-content-word').first().textContent().catch(() => ''));
    if (current === desired) continue;
    const editor = row.locator('.auto-resize-textarea-wrapper textarea, .auto-resize-textarea-wrapper input').first();
    if (!await editor.isVisible().catch(() => false)) {
      await clickPlatformLocator(
        row.locator('.form-content-word').first(),
        page,
        'boss',
        config.playwright.resumeDetailTimeoutMs,
      );
    }
    await editor.waitFor({ state: 'visible', timeout: config.playwright.resumeDetailTimeoutMs });
    await runBossAction(page, () => editor.fill(desired, { timeout: config.playwright.resumeDetailTimeoutMs }));
    await runBossAction(page, () => editor.press('Tab', { timeout: config.playwright.resumeDetailTimeoutMs })).catch(() => undefined);
  }
}

export async function synchronizeBossDeepSearchRequirements(
  page: Page,
  input: { coreRequirements: readonly string[]; bonusRequirements?: readonly string[] },
): Promise<BossDeepSearchForm> {
  const coreRequirements = normalizeRequirements(input.coreRequirements);
  const bonusRequirements = normalizeRequirements(input.bonusRequirements ?? []);
  if (coreRequirements.length === 0) {
    throw new Error('Boss deep-search requires at least one non-empty core requirement.');
  }

  await synchronizeRequirementGroup(page, '核心要求', coreRequirements);
  await synchronizeRequirementGroup(page, '加分项', bonusRequirements);
  const form = await readBossDeepSearchForm(page);
  if (JSON.stringify(form.coreRequirements) !== JSON.stringify(coreRequirements)
    || JSON.stringify(form.bonusRequirements) !== JSON.stringify(bonusRequirements)) {
    throw new Error('Boss deep-search requirements did not persist exactly as requested.');
  }
  return form;
}

export async function triggerBossDeepSearchMatch(page: Page): Promise<BossTalentCandidate[]> {
  const form = await readBossDeepSearchForm(page);
  if (form.coreRequirements.length === 0) {
    throw new Error('Boss deep-search match requires at least one core requirement.');
  }
  if (form.remainingMatchCount !== undefined && form.remainingMatchCount <= 0) {
    throw new Error('Boss deep-search has no remaining immediate-match quota.');
  }
  if (!form.matchButtonEnabled) {
    throw new Error('Boss deep-search immediate-match button is disabled.');
  }

  const button = page.locator('.ai-form-match-footer .btn-ai-match-v2').first();
  await clickPlatformLocator(button, page, 'boss', config.playwright.searchPageTimeoutMs);
  await page.locator(candidateCardSelector).first().waitFor({
    state: 'visible',
    timeout: config.playwright.searchPageTimeoutMs,
  });
  return readBossDeepSearchCandidates(page);
}

function resolveCardIndex(root: BossTalentRoot, candidateId: string): Promise<number> {
  return root.locator(candidateCardSelector).evaluateAll((cards, expectedId) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    return cards.findIndex((element) => {
      const card = element as VueElement;
      const direct = ['data-geek-id', 'data-expect', 'data-jid', 'data-lid', 'data-id', 'data-item-id']
        .map((attribute) => normalize(card.getAttribute(attribute)));
      const vue = card.__vue__ ?? {};
      const vueIds = ['geekId', 'expectId', 'encryptGeekId', 'lid', 'jid', 'id']
        .map((key) => vue[key])
        .filter((value) => typeof value === 'string' || typeof value === 'number')
        .map(String);
      const href = card.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '';
      return direct.includes(expectedId) || vueIds.includes(expectedId) || href.includes(encodeURIComponent(expectedId));
    });
  }, candidateId);
}

export async function greetBossTalentCandidate(page: Page, input: BossGreetInput): Promise<BossGreetResult> {
  if (!input.confirmed) {
    throw new Error('Boss candidate greet requires confirmed=true.');
  }
  if (!input.candidateId.trim() || !input.expectedCandidateName.trim() || !input.expectedJobName.trim()) {
    throw new Error('Boss candidate greet requires candidateId, expectedCandidateName, and expectedJobName.');
  }
  if (input.source === 'normal-search') {
    throw new Error('Single-candidate greet currently supports Boss recommendation and deep-search results only.');
  }
  const source = input.source;
  await openBossTalentPage(page, source);
  const root = await resolveTalentRoot(page, source);
  const index = await resolveCardIndex(root, input.candidateId);
  if (index < 0) {
    throw new Error(`Boss candidate ${input.candidateId} is no longer present on the ${source} page.`);
  }
  const card = root.locator(candidateCardSelector).nth(index);
  const cardText = normalizeText(await card.innerText()) ?? '';
  if (!cardText.includes(input.expectedCandidateName)) {
    throw new Error(`Boss candidate identity changed before greet: expected ${input.expectedCandidateName}.`);
  }
  if (source === 'deep-search') {
    const form = await readBossDeepSearchForm(page);
    if (input.bossJobId && form.bossJobId && input.bossJobId !== form.bossJobId) {
      throw new Error(`Boss job changed before greet: expected ID ${input.bossJobId}, found ${form.bossJobId}.`);
    }
    if (form.jobName && form.jobName !== input.expectedJobName) {
      throw new Error(`Boss job changed before greet: expected ${input.expectedJobName}, found ${form.jobName}.`);
    }
  }
  const chat = card.locator('.geek-chat').first();
  const chatText = normalizeText(await chat.innerText().catch(() => '')) ?? '';
  if (/继续沟通|继续聊/.test(chatText)) {
    return {
      platform: 'boss',
      candidateId: input.candidateId,
      candidateName: input.expectedCandidateName,
      jobName: input.expectedJobName,
      source,
      greeted: false,
      alreadyContacted: true,
      intentId: input.intentId,
      completedAt: new Date().toISOString(),
    };
  }
  if (!/打招呼|立即沟通|沟通/.test(chatText)) {
    throw new Error(`Boss candidate ${input.candidateId} does not expose a greet control.`);
  }
  await clickPlatformLocator(chat, page, 'boss', config.playwright.resumeDetailTimeoutMs);
  await root.waitForFunction(({ selector, expectedId }) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const cards = Array.from(document.querySelectorAll<VueElement>(selector));
    const card = cards.find((element) => {
      const directMatch = ['data-geek-id', 'data-expect', 'data-jid', 'data-lid', 'data-id', 'data-item-id']
        .some((attribute) => element.getAttribute(attribute) === expectedId);
      const vue = element.__vue__ ?? {};
      const vueMatch = ['geekId', 'expectId', 'encryptGeekId', 'lid', 'jid', 'id']
        .some((key) => String(vue[key] ?? '') === expectedId);
      const href = element.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '';
      return directMatch || vueMatch || href.includes(encodeURIComponent(expectedId));
    });
    const text = (card?.querySelector<HTMLElement>('.geek-chat')?.innerText ?? '').replace(/\s+/g, ' ').trim();
    return /继续沟通|继续聊/.test(text);
  }, { selector: candidateCardSelector, expectedId: input.candidateId }, {
    timeout: config.playwright.resumeDetailTimeoutMs,
  });
  return {
    platform: 'boss',
    candidateId: input.candidateId,
    candidateName: input.expectedCandidateName,
    jobName: input.expectedJobName,
    source,
    greeted: true,
    alreadyContacted: false,
    intentId: input.intentId,
    completedAt: new Date().toISOString(),
  };
}

export async function runBossTalentSearch(page: Page, input: BossTalentSearchInput): Promise<BossTalentSearchResult> {
  if (input.triggerMatch === true && input.confirmed !== true) {
    throw new Error('Boss deep-search immediate match requires confirmed=true.');
  }
  await openBossTalentPage(page, input.source);
  if (input.source === 'recommend') {
    return {
      platform: 'boss',
      source: 'recommend',
      matched: false,
      candidates: await readBossRecommendationCandidates(page),
    };
  }

  let form = await readBossDeepSearchForm(page);
  if (input.expectedJobName && form.jobName && input.expectedJobName !== form.jobName) {
    throw new Error(`Boss deep-search selected job mismatch: expected ${input.expectedJobName}, found ${form.jobName}.`);
  }
  if (input.bossJobId && form.bossJobId && input.bossJobId !== form.bossJobId) {
    throw new Error(`Boss deep-search selected job ID mismatch: expected ${input.bossJobId}, found ${form.bossJobId}.`);
  }
  if (input.coreRequirements) {
    form = await synchronizeBossDeepSearchRequirements(page, {
      coreRequirements: input.coreRequirements,
      bonusRequirements: input.bonusRequirements,
    });
  }
  const candidates = input.triggerMatch === true
    ? await triggerBossDeepSearchMatch(page)
    : await readBossDeepSearchCandidates(page);
  return {
    platform: 'boss',
    source: 'deep-search',
    form,
    matched: input.triggerMatch === true,
    candidates,
  };
}
