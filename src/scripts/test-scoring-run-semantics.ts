import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright';

import { config, resolveStorageStatePath } from '../config.js';
import { buildJobKey } from '../parsers/jd-parser.js';
import { getResumeDomSnapshot, collectResumePageEvidence, openResumeDetail } from '../browser/resume-detail.js';
import { collectCandidateList, waitForCandidateResultsReady } from '../browser/candidate-list.js';
import { clickSearchTriggerRef, findSubscriptionCardRef, openAuthenticatedSubscribePageRef, openSubscribeSearch, waitForAuthenticatedSubscribeReadyRef, waitForSearchTriggerReadyRef } from '../browser/subscribe-search.js';
import { BrowserSession, closeBrowserSessionRef, createFreshBrowserSessionRef, createPersistentBrowserSessionRef, isLiepinReusableBrowserEnabled, isReusableBrowserEnabled, openLoginSessionRef, persistBrowserSessionRef, openAuthenticatedSubscribePageRef as openAuthenticatedSubscribePageSessionRef, resolveBrowserHeadless, verifyPersistedBrowserSessionRef } from '../browser/session.js';
import { validateCandidateListExtraction } from '../extraction/extractor.js';
import { resolveOpenAISettings } from '../llm/openai-client.js';
import { CodexSessionProviderError } from '../llm/codex-session-provider.js';
import { liepinAdapter } from '../platforms/liepin-adapter.js';
import {
  BossForwardPreConfirmationError,
  BossForwardUncertainError,
  BossUnexpectedContactDialogError,
  bossAdapter,
} from '../platforms/boss-adapter.js';
import { buildBossSyncedJobKey } from '../platforms/boss-jobs.js';
import { fingerprintSavedSearchConditionIdentity } from '../platforms/boss/saved-search-identity.js';
import { zhilianAdapter } from '../platforms/zhilian-adapter.js';
import { SearchConditionSetService } from '../search/search-condition-sets.js';
import { hashBossScreeningPolicy } from '../scoring/boss-screening.js';
import { extractCandidateScoreFromTextResponse } from '../scoring/score-resume.js';
import { openResumeByUrl } from './capture-resume-dom-snapshot.js';
import { runManualLoginSessionSave } from './login-and-save-session.js';
import { sendJobReportEmailRef } from './send-job-report-email.js';
import type { AllPlatformsRunSummary, BatchJobRunSummary, MainResult } from '../index.js';
import type { BossCandidateRoutingArtifact, BossRejectionEmailOutboxEntry, SavedSearchReference } from '../types/job.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function makeIsolatedTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-scoring-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function setIsolatedDataDir(tempDir: string) {
  process.env.DATA_DIR = tempDir;
  (config as { dataDir: string }).dataDir = tempDir;
}

async function makeIsolatedStore(): Promise<typeof import('../storage/job-store.js').JobStore> {
  const tempDir = await makeIsolatedTempDir();
  setIsolatedDataDir(tempDir);
  const module = await import(`../storage/job-store.js?test=${Date.now()}-${Math.random()}`);
  return module.JobStore;
}

async function loadIndexModule(tempDir: string): Promise<typeof import('../index.js')> {
  setIsolatedDataDir(tempDir);
  process.argv = ['node', 'test-index'];
  const scriptPath = fileURLToPath(new URL('../index.ts', import.meta.url));
  const moduleUrl = `${pathToFileURL(scriptPath).href}?test=${Date.now()}-${Math.random()}`;
  const module = await import(moduleUrl);
  // Browser-facing history visits have dedicated action tests. Orchestration
  // tests use this seam so their lightweight page doubles do not need DOM
  // selectors, while still asserting which IDs were scheduled for viewing.
  module.visitBossSeenCandidateDetailRef.fn = async (
    _page: never,
    candidate: { candidateId: string },
  ) => ({
    candidateId: candidate.candidateId,
    detailOpened: true,
    detailIdentityVerified: true,
    detailClosed: true,
  });
  module.readBossColleagueCommunicationFlagRef.fn = async () => ({
    hasColleagueCommunication: false,
  });
  return module;
}

function buildNormalizedJob() {
  return {
    title: '东南亚销售经理',
    majors: [],
    languageRequirements: [],
    responsibilities: [],
    hardRequirements: [],
    preferredRequirements: [],
    regionPreferences: [],
    industryTags: [],
  };
}

function buildResume(candidateId: string) {
  return {
    candidateId,
    regions: [],
    pr: [],
    workExperiences: [],
    projectExperiences: [],
    educationExperiences: [],
    skill: [],
    certificates: [],
  };
}

function buildScore() {
  return {
    totalScore: 88,
    dimensionScores: {
      education: { score: 88, reason: 'ok' },
      language: { score: 88, reason: 'ok' },
      experience: { score: 88, reason: 'ok' },
      industryMatch: { score: 88, reason: 'ok' },
      regionMatch: { score: 88, reason: 'ok' },
      responsibilityMatch: { score: 88, reason: 'ok' },
    },
    risks: [],
    summary: 'good fit',
  };
}

function buildModelScreeningSettings() {
  return {
    enabled: true as const,
    policyVersion: 2 as const,
    decisionMode: 'reject-on-any-missing' as const,
    requirements: [{
      id: 'must-have-model-requirement',
      enabled: true,
      kind: 'modelRequirement' as const,
      requirement: '候选人明确满足测试岗位要求。',
      criteria: ['简历存在明确证据。'],
      insufficientEvidence: ['缺少明确证据。'],
    }],
    secondaryDelivery: {
      recipientEmail: 'secondary-report@outlook.com',
    },
  };
}

function buildModelRequirementEvaluation(
  outcome: 'satisfied' | 'missing' | 'unknown',
  candidateId = 'candidate',
) {
  return {
    requirementId: 'must-have-model-requirement',
    outcome,
    evidence: outcome === 'unknown' ? [] : [candidateId],
    missingCriteria: outcome === 'missing' ? ['简历存在明确证据。'] : [],
    reason: `screening:${outcome}`,
  };
}

async function writeBossApplicationFilterOptions(tempDir: string): Promise<void> {
  const optionsPath = path.join(tempDir, 'boss', 'filter-catalog', 'application-filter-options.latest.json');
  await fs.mkdir(path.dirname(optionsPath), { recursive: true });
  await fs.writeFile(optionsPath, JSON.stringify({
    platform: 'boss',
    capturedAt: '2026-07-30T00:00:00.000Z',
    keyword: '全铝箱包设计',
    fieldCount: 1,
    fieldIds: ['education'],
    fieldIdByLabel: { 学历: 'education' },
    groups: {
      singleSelect: ['education'],
      textInput: [],
      salaryRange: [],
      numberRange: [],
    },
    fieldsById: {
      education: {
        fieldId: 'education',
        filterKey: 'education',
        label: '学历',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string'],
        allowedValues: ['大专及以上'],
        options: [{ label: '大专及以上', value: '大专及以上', disabled: false, selected: false }],
      },
    },
  }, null, 2), 'utf8');
}

function assertAllPlatformsSummary(result: MainResult): AllPlatformsRunSummary[] {
  assert.equal(Array.isArray(result), true);
  return result as AllPlatformsRunSummary[];
}

function assertBatchSummary(result: MainResult): BatchJobRunSummary[] {
  assert.equal(Array.isArray(result), true);
  return result as BatchJobRunSummary[];
}

function buildArgs(options: { includeEmail?: boolean; ccArg?: string | null; jdText?: string; jdFilePath?: string; platform?: string } = {}) {
  const { includeEmail = false, ccArg, jdText = '职位名称：东南亚销售经理', jdFilePath, platform = '51job' } = options;

  return [
    'node',
    'index.ts',
    '--platform',
    platform,
    '--keyword',
    '东南亚 销售',
    ...(jdFilePath ? ['--jd-file', jdFilePath] : ['--jd', jdText]),
    ...(includeEmail ? ['--email', 'ops@example.com'] : []),
    ...(ccArg !== undefined && ccArg !== null ? ['--cc', ccArg] : []),
  ];
}

function createSearchPage() {
  return {
    id: 'search-page',
    close: async () => undefined,
    bringToFront: async () => undefined,
  } as never;
}

function createDetailPage() {
  return {
    locator: () => ({ innerText: async () => 'raw resume text' }),
    close: async () => undefined,
  } as never;
}

function createCandidateListPage(options: {
  bodyText?: string;
  resultListVisible?: boolean;
  candidateCardsVisible?: boolean;
  candidateCardCountSequence?: number[];
  cardPayloads?: Array<{ id: string; text: string; html?: string; resumeUrl?: string; name?: string }>;
  url?: string;
  loadingVisible?: boolean;
  rootVisible?: boolean;
  onWaitForTimeout?: (timeout: number) => void;
}) {
  const {
    bodyText = '结果页已加载',
    resultListVisible = true,
    candidateCardsVisible = false,
    candidateCardCountSequence,
    cardPayloads = [],
    url = 'https://example.com/search',
    loadingVisible = false,
    rootVisible = false,
    onWaitForTimeout,
  } = options;
  const countSequence = [...(candidateCardCountSequence ?? [])];

  const candidateCardsLocator = {
    first: () => ({
      waitFor: async (_options?: { state?: string; timeout?: number }) => {
        if (!candidateCardsVisible) {
          throw new Promise<void>(() => undefined);
        }
      },
    }),
    count: async () => countSequence.shift() ?? cardPayloads.length,
    evaluateAll: async () => cardPayloads.map((card) => ({
      elementId: card.id,
      html: card.html ?? `<div id="${card.id}">${card.text}</div>`,
      text: card.text,
      resumeUrl: card.resumeUrl,
      name: card.name,
    })),
  };

  const resultListLocator = {
    first: () => ({
      waitFor: async (_options?: { state?: string; timeout?: number }) => {
        if (!resultListVisible) {
          throw new Error('result list not visible');
        }
      },
      locator: (selector?: string) => {
        if (selector === 'div[id^="no_interested_"]') {
          return {
            evaluateAll: async () => candidateCardsLocator.evaluateAll(),
          };
        }

        throw new Error(`unexpected nested selector: ${selector ?? ''}`);
      },
    }),
  };

  return {
    waitForLoadState: async (_state: string) => undefined,
    waitForTimeout: async (timeout: number) => {
      onWaitForTimeout?.(timeout);
    },
    url: () => url,
    locator: (selector?: string) => {
      if (selector === 'div[id^="no_interested_"]') {
        return candidateCardsLocator;
      }
      if (selector === '.virtual_list') {
        return {
          ...resultListLocator,
          count: async () => (resultListVisible ? 1 : 0),
        };
      }
      if (selector === 'body') {
        return {
          innerText: async () => bodyText,
        };
      }
      if (selector === '#app, #root, [data-testid="app-root"]') {
        return {
          count: async () => (rootVisible ? 1 : 0),
        };
      }
      if (selector === '.base-page-loading') {
        return {
          count: async () => (loadingVisible ? 1 : 0),
          first: () => ({
            waitFor: async () => {
              if (!loadingVisible) {
                throw new Error('loading not visible');
              }
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector ?? ''}`);
    },
  } as never;
}

function createSubscribeSearchOpenStub() {
  const viewedFilterSelector = 'label.el-checkbox:has-text("我已看"), label:has-text("我已看")';
  const popupWaitForLoadStateCalls: string[] = [];
  const popupWaitForTimeoutCalls: number[] = [];
  const targetWaitForLoadStateCalls: string[] = [];
  const targetWaitForTimeoutCalls: number[] = [];
  const pageWaitForTimeoutCalls: number[] = [];
  const pageWaitForLoadStateCalls: string[] = [];
  const closedPageLabels: string[] = [];
  const cardWaitForCalls: Array<{ state?: string; timeout?: number }> = [];
  const cardSelectorWaits = new Map<string, number>();
  const pageSelectorWaits = new Map<string, number>();
  const panelSelectorWaits = new Map<string, number>();
  const mouseMoves: Array<{ x: number; y: number }> = [];
  const mouseClicks: Array<{ x: number; y: number }> = [];
  const cardBox = { x: 100, y: 100, width: 120, height: 40 };
  const panelBox = { x: 80, y: 140, width: 400, height: 240 };
  const panelTriggerBox = { x: 400, y: 300, width: 60, height: 30 };
  const cardTriggerBox = { x: 130, y: 110, width: 70, height: 24 };
  let popupPage: Record<string, unknown> | null = null;
  let currentUrl = 'https://example.com/subscribe';
  let searchTriggerHref: string | null = null;
  let cardCountSequence: number[] = [];
  let availableCardSelectors = new Set<string>();
  let conditionPanelVisible = false;
  let conditionPanelTitle = '泰国 英语';
  let panelSearchTriggerReady = false;
  let cardTextTriggerReady = false;
  let pageTextTriggerReady = false;
  let viewedFilterChecked = true;
  let viewedFilterClicks = 0;
  const extraPages: Array<{
    label: string;
    url: () => string;
    isClosed: () => boolean;
    close: () => Promise<void>;
  }> = [];

  const viewedFilterLocator = {
    first: () => ({
      waitFor: async () => undefined,
      evaluate: async () => viewedFilterChecked,
      click: async () => {
        viewedFilterClicks += 1;
        viewedFilterChecked = !viewedFilterChecked;
      },
    }),
  };

  const targetPage = {
    waitForLoadState: async (state: string) => {
      targetWaitForLoadStateCalls.push(state);
    },
    waitForTimeout: async (timeout: number) => {
      targetWaitForTimeoutCalls.push(timeout);
    },
  };

  const cardLocator = {
    first: () => ({
      waitFor: async (options?: { state?: string; timeout?: number }) => {
        cardWaitForCalls.push(options ?? {});
        if (options?.state === 'visible') {
          throw new Error('not visible yet');
        }
      },
    }),
    count: async () => cardCountSequence.shift() ?? 0,
    nth: () => ({
      locator: () => ({
        first: () => ({
          innerText: async () => '',
        }),
      }),
    }),
  };

  const readyLocator = {
    first: () => ({
      waitFor: async () => undefined,
    }),
  };

  const makeWaitable = (kind: 'card' | 'page' | 'panel', key: string, isReady: () => boolean) => ({
    first: () => ({
      waitFor: async () => {
        const waits = kind === 'card' ? cardSelectorWaits : kind === 'panel' ? panelSelectorWaits : pageSelectorWaits;
        waits.set(key, (waits.get(key) ?? 0) + 1);
        if (!isReady()) {
          throw new Error(`missing trigger: ${key}`);
        }
      },
      click: async () => undefined,
      boundingBox: async () => (kind === 'panel'
        ? panelTriggerBox
        : kind === 'card'
          ? cardTriggerBox
          : null),
      scrollIntoViewIfNeeded: async () => undefined,
      getAttribute: async (name: string) => (name === 'href' ? searchTriggerHref : null),
    }),
    filter: () => ({
      first: () => ({
        waitFor: async () => {
          const waits = kind === 'card' ? cardSelectorWaits : kind === 'panel' ? panelSelectorWaits : pageSelectorWaits;
          waits.set(key, (waits.get(key) ?? 0) + 1);
          if (!isReady()) {
            throw new Error(`missing trigger: ${key}`);
          }
        },
        click: async () => undefined,
        getAttribute: async (name: string) => (name === 'href' ? searchTriggerHref : null),
      }),
    }),
  });

  const conditionPanel = {
    isVisible: async () => conditionPanelVisible,
    boundingBox: async () => panelBox,
    locator: (selector?: string) => {
      if (selector === '.subscribe-title') {
        return {
          first: () => ({
            innerText: async () => conditionPanelTitle,
          }),
        };
      }

      return makeWaitable('panel', selector ?? '', () => panelSearchTriggerReady);
    },
  };

  let bodyText = '已选条件 关键词：泰国 英语 100228050 在线简历 工作经历 教育经历';
  let bodyInnerText = bodyText;
  let bodyTextContent = bodyText;

  const card = {
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => cardBox,
    evaluate: async () => false,
    click: async () => undefined,
    hover: async () => undefined,
    locator: (selector?: string) => makeWaitable('card', selector ?? '', () => availableCardSelectors.has(selector ?? '')),
    getByText: (text?: string) => makeWaitable('card', `text:${text ?? ''}`, () => cardTextTriggerReady),
    getByRole: (role?: string, options?: { name?: RegExp }) => makeWaitable('card', `role:${role ?? ''}:${options?.name?.toString() ?? ''}`, () => cardTextTriggerReady),
  };

  const context = {
    waitForEvent: async () => popupPage,
    pages: () => [
      page,
      ...extraPages,
      ...(popupPage ? [popupPage] : []),
    ],
  };

  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
    },
    isClosed: () => false,
    close: async () => {
      closedPageLabels.push('main');
    },
    waitForLoadState: async (state: string) => {
      pageWaitForLoadStateCalls.push(state);
    },
    waitForTimeout: async (timeout: number) => {
      pageWaitForTimeoutCalls.push(timeout);
    },
    locator: (selector?: string) => {
      if (selector === viewedFilterSelector) {
        return viewedFilterLocator;
      }
      if (selector === '.talent-subscribe-card-main-wrapper') {
        return cardLocator;
      }
      if (selector === '.talent-subscribe-card-main-wrapper, .el-empty') {
        return readyLocator;
      }
      if (selector === '.talent-subscribe-condition-popover') {
        return {
          count: async () => 1,
          nth: () => conditionPanel,
        };
      }
      if (selector === 'body') {
        return {
          first: () => ({
            innerText: async () => bodyInnerText,
            textContent: async () => bodyTextContent,
          }),
          innerText: async () => bodyInnerText,
          textContent: async () => bodyTextContent,
        };
      }
      if (selector === '#app') {
        return {
          first: () => ({
            innerText: async () => bodyInnerText,
            textContent: async () => bodyTextContent,
          }),
          innerText: async () => bodyInnerText,
          textContent: async () => bodyTextContent,
        };
      }
      return makeWaitable('page', selector ?? '', () => false);
    },
    getByText: (text?: string) => makeWaitable('page', `text:${text ?? ''}`, () => pageTextTriggerReady),
    getByRole: (role?: string, options?: { name?: RegExp }) => makeWaitable('page', `role:${role ?? ''}:${options?.name?.toString() ?? ''}`, () => pageTextTriggerReady),
    context: () => context,
    mouse: {
      move: async (x: number, y: number) => {
        mouseMoves.push({ x, y });
      },
      click: async (x: number, y: number) => {
        mouseClicks.push({ x, y });
      },
    },
    waitForURL: async () => {
      if (popupPage) {
        throw new Error('no current-page navigation when popup opens');
      }
      currentUrl = 'https://example.com/search';
      return targetPage;
    },
  };

  return {
    page: page as never,
    card: card as never,
    setCardCountSequence(sequence: number[]) {
      cardCountSequence = [...sequence];
    },
    setAvailableCardSelectors(selectors: string[]) {
      availableCardSelectors = new Set(selectors);
    },
    showCardTextTrigger() {
      cardTextTriggerReady = true;
    },
    showPageTextTrigger() {
      pageTextTriggerReady = true;
    },
    showConditionPanelSearchTrigger(title = '泰国 英语') {
      conditionPanelVisible = true;
      conditionPanelTitle = title;
      panelSearchTriggerReady = true;
    },
    showConditionPanelWithoutSearchTrigger(title = '泰国 英语') {
      conditionPanelVisible = true;
      conditionPanelTitle = title;
      panelSearchTriggerReady = false;
    },
    showPopup() {
      popupPage = {
        url: () => 'https://ehire.51job.com/Revision/talent/search?rt=popup',
        isClosed: () => false,
        close: async () => {
          closedPageLabels.push('popup');
        },
        waitForLoadState: async (state: string) => {
          popupWaitForLoadStateCalls.push(state);
        },
        waitForTimeout: async (timeout: number) => {
          popupWaitForTimeoutCalls.push(timeout);
        },
        locator: page.locator,
        context: () => context,
      };
    },
    addExtraPage(label: string, url: string) {
      let closed = false;
      extraPages.push({
        label,
        url: () => url,
        isClosed: () => closed,
        close: async () => {
          closed = true;
          closedPageLabels.push(label);
        },
      });
    },
    setCurrentUrl(url: string) {
      currentUrl = url;
    },
    setSearchTriggerHref(href: string | null) {
      searchTriggerHref = href;
    },
    setBodyText(text: string) {
      bodyText = text;
      bodyInnerText = text;
      bodyTextContent = text;
    },
    setBodyInnerText(text: string) {
      bodyInnerText = text;
    },
    setBodyTextContent(text: string) {
      bodyTextContent = text;
    },
    setViewedFilterChecked(checked: boolean) {
      viewedFilterChecked = checked;
    },
    getCardWaitForCalls: () => cardWaitForCalls,
    getPageWaitForLoadStateCalls: () => pageWaitForLoadStateCalls,
    getPageWaitForTimeoutCalls: () => pageWaitForTimeoutCalls,
    getPopupWaitForLoadStateCalls: () => popupWaitForLoadStateCalls,
    getPopupWaitForTimeoutCalls: () => popupWaitForTimeoutCalls,
    getTargetWaitForLoadStateCalls: () => targetWaitForLoadStateCalls,
    getTargetWaitForTimeoutCalls: () => targetWaitForTimeoutCalls,
    getCardSelectorWaits: () => new Map(cardSelectorWaits),
    getPageSelectorWaits: () => new Map(pageSelectorWaits),
    getPanelSelectorWaits: () => new Map(panelSelectorWaits),
    getViewedFilterClicks: () => viewedFilterClicks,
    isViewedFilterChecked: () => viewedFilterChecked,
    getCurrentUrl: () => currentUrl,
    getClosedPageLabels: () => closedPageLabels,
    getMouseMoves: () => mouseMoves,
    getMouseClicks: () => mouseClicks,
  };
}

function createResumeDetailPageStub() {
  const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
  const waitForLoadStateCalls: string[] = [];
  const waitForTimeoutCalls: number[] = [];
  const clickCalls: string[] = [];
  const countCalls: string[] = [];
  let bodyText = '100228050 在线简历 工作经历 教育经历';
  let bodyTextSequence: string[] = [];
  let currentUrl = 'https://example.com/list';
  let triggerVisible = false;
  let clickNavigates = false;

  function readBodyText() {
    if (bodyTextSequence.length > 0) {
      bodyText = bodyTextSequence.shift() ?? bodyText;
    }

    return bodyText;
  }

  function createClickableLocator(label: string) {
    return {
      count: async () => {
        countCalls.push(label);
        return 1;
      },
      click: async () => {
        clickCalls.push(label);
        if (clickNavigates) {
          currentUrl = 'https://example.com/resume/100228050';
        }
      },
      first: () => createClickableLocator(label),
      locator: (nestedSelector?: string) => createClickableLocator(nestedSelector ? `${label}:${nestedSelector}` : label),
    };
  }

  return {
    page: {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        gotoCalls.push({ url, waitUntil: options?.waitUntil });
        currentUrl = url;
      },
      title: async () => '',
      waitForLoadState: async (state: string) => {
        waitForLoadStateCalls.push(state);
      },
      waitForTimeout: async (timeout: number) => {
        waitForTimeoutCalls.push(timeout);
      },
      locator: (selector?: string) => {
        if (selector === `#no_interested_100228050`) {
          return {
            first: () => ({
              waitFor: async () => {
                if (!triggerVisible) {
                  throw new Error('missing trigger');
                }
              },
              locator: (nestedSelector?: string) => {
                if (nestedSelector === 'xpath=ancestor::*[contains(@class, "card") or self::li][1]') {
                  return createClickableLocator('card');
                }

                return createClickableLocator(`trigger:${nestedSelector ?? ''}`);
              },
            }),
            innerText: async () => readBodyText(),
          };
        }

        return {
          first: () => ({
            waitFor: async () => {
              throw new Error('missing trigger');
            },
            locator: (nestedSelector?: string) => createClickableLocator(`fallback:${nestedSelector ?? ''}`),
          }),
          innerText: async () => readBodyText(),
          locator: (nestedSelector?: string) => createClickableLocator(`fallback:${nestedSelector ?? ''}`),
        };
      },
      url: () => currentUrl,
      mouse: { move: async () => undefined },
      close: async () => undefined,
    } as never,
    context: {
      waitForEvent: async () => {
        throw new Error('no popup');
      },
    } as never,
    getGotoCalls: () => gotoCalls,
    getWaitForLoadStateCalls: () => waitForLoadStateCalls,
    getWaitForTimeoutCalls: () => waitForTimeoutCalls,
    getClickCalls: () => clickCalls,
    getCountCalls: () => countCalls,
    setBodyTextSequence: (values: string[]) => {
      bodyTextSequence = [...values];
    },
    showTrigger: () => {
      triggerVisible = true;
    },
    enableClickNavigation: () => {
      clickNavigates = true;
    },
  };
}

function createManualLoginSessionStub() {
  const pageWaitForTimeoutCalls: number[] = [];
  const openAuthenticatedCalls: string[] = [];
  const persistCalls: string[] = [];
  const closeCalls: number[] = [];
  const verifyCalls: string[] = [];
  const openLoginCalls: string[] = [];
  const createFreshCalls: string[] = [];
  const createPersistentCalls: string[] = [];
  let authFailuresRemaining = 0;
  let persistShouldThrow: unknown;
  let verifyShouldThrow: unknown;

  const page = {
    waitForTimeout: async (timeout: number) => {
      pageWaitForTimeoutCalls.push(timeout);
    },
    bringToFront: async () => undefined,
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
    title: async () => '',
    url: () => 'about:blank',
    locator: () => ({
      innerText: async () => '',
    }),
  };

  const session = {
    page,
    context: {
      storageState: async () => undefined,
      close: async () => undefined,
    },
    browser: {
      close: async () => undefined,
    },
  } as unknown as BrowserSession;

  return {
    session,
    page,
    failAuthenticationAttempts(count: number) {
      authFailuresRemaining = count;
    },
    setPersistError(error: unknown) {
      persistShouldThrow = error;
    },
    setVerifyError(error: unknown) {
      verifyShouldThrow = error;
    },
    createFreshBrowserSession: async () => {
      createFreshCalls.push('fresh');
      return session;
    },
    createPersistentBrowserSession: async (platform: string) => {
      createPersistentCalls.push(platform);
      return session;
    },
    openLoginSession: async (platform: string) => {
      openLoginCalls.push(platform);
      return session;
    },
    openAuthenticatedSubscribePage: async (platform: string) => {
      openAuthenticatedCalls.push(platform);
      if (authFailuresRemaining > 0) {
        authFailuresRemaining -= 1;
        throw new Error('login not ready');
      }
    },
    persistBrowserSession: async (platform: string) => {
      persistCalls.push(platform);
      if (persistShouldThrow) {
        throw persistShouldThrow;
      }
    },
    verifyPersistedBrowserSession: async (platform: string) => {
      verifyCalls.push(platform);
      if (verifyShouldThrow) {
        throw verifyShouldThrow;
      }
    },
    closeBrowserSession: async () => {
      closeCalls.push(Date.now());
    },
    getPageWaitForTimeoutCalls: () => pageWaitForTimeoutCalls,
    getOpenAuthenticatedCalls: () => openAuthenticatedCalls,
    getPersistCalls: () => persistCalls,
    getVerifyCalls: () => verifyCalls,
    getOpenLoginCalls: () => openLoginCalls,
    getCreateFreshCalls: () => createFreshCalls,
    getCreatePersistentCalls: () => createPersistentCalls,
    getCloseCalls: () => closeCalls,
  };
}

function createClosableBrowserSessionStub(options: { temporaryUserDataDir?: string; closeBrowser?: boolean; keepOpenOnExit?: boolean } = {}) {
  const closeOrder: string[] = [];
  const session = {
    context: {
      close: async () => {
        closeOrder.push('context');
      },
    },
    browser: {
      close: async () => {
        closeOrder.push('browser');
      },
    },
    page: {} as never,
    temporaryUserDataDir: options.temporaryUserDataDir,
    closeBrowser: options.closeBrowser,
    keepOpenOnExit: options.keepOpenOnExit,
  } as unknown as BrowserSession;

  return {
    session,
    getCloseOrder: () => [...closeOrder],
  };
}

async function captureDateNow(fn: () => Promise<void>) {
  const originalNow = Date.now;

  try {
    await fn();
  } finally {
    Date.now = originalNow;
  }
}

function createDomSnapshotPageStub() {
  const waitForLoadStateCalls: string[] = [];
  const waitForTimeoutCalls: number[] = [];
  let bodyHtml = '';
  let bodyText = '';
  let pageHtml = '<html><body></body></html>';
  let pageTitle = '';
  let frameRecords: Array<{
    url: string;
    name: string;
    title: string;
    bodyText: string;
    bodyHtml: string;
    html: string;
  }> = [];

  const emptyLocator = {
    count: async () => 0,
    allTextContents: async () => [],
    innerText: async () => bodyText,
    innerHTML: async () => bodyHtml,
    textContent: async () => bodyText,
    getAttribute: async () => null,
    evaluate: async () => [],
    evaluateAll: async () => [],
    first: () => emptyLocator,
    nth: () => emptyLocator,
    locator: () => emptyLocator,
  };

  function createFrame(record: typeof frameRecords[number]) {
    return {
      url: () => record.url,
      name: () => record.name,
      title: async () => record.title,
      content: async () => record.html,
      locator: () => ({
        innerText: async () => record.bodyText,
        innerHTML: async () => record.bodyHtml,
        evaluate: async () => [],
        evaluateAll: async () => [],
      }),
    };
  }

  const mainFrame = createFrame({
    url: 'https://example.com/resume/100228050',
    name: '',
    title: pageTitle,
    bodyText,
    bodyHtml,
    html: pageHtml,
  });

  return {
    page: {
      waitForLoadState: async (state: string) => {
        waitForLoadStateCalls.push(state);
      },
      waitForTimeout: async (timeout: number) => {
        waitForTimeoutCalls.push(timeout);
      },
      evaluate: async () => [],
      title: async () => pageTitle,
      content: async () => pageHtml,
      url: () => 'https://example.com/resume/100228050',
      locator: () => emptyLocator,
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, ...frameRecords.map((record) => createFrame(record))],
    } as never,
    setMainDocument(values: { bodyText?: string; bodyHtml?: string; html?: string; title?: string }) {
      bodyText = values.bodyText ?? bodyText;
      bodyHtml = values.bodyHtml ?? bodyHtml;
      pageHtml = values.html ?? pageHtml;
      pageTitle = values.title ?? pageTitle;
    },
    setFrames(values: typeof frameRecords) {
      frameRecords = values;
    },
    getWaitForLoadStateCalls: () => waitForLoadStateCalls,
    getWaitForTimeoutCalls: () => waitForTimeoutCalls,
  };
}

function stubSuccessfulRun(indexModule: Awaited<ReturnType<typeof loadIndexModule>>) {
  indexModule.parseJobDescriptionRef.fn = async () => buildNormalizedJob();
  indexModule.extractionBoundary.extractCandidateListFromPage = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  indexModule.extractCandidateListWithAdapterRef.fn = async (adapter) => ({
    candidates: [{ candidateId: adapter.platform === 'boss' ? 'boss-cand-1' : 'cand-1' }],
  });
  indexModule.openSubscribeSearchRef.fn = (async () => createSearchPage()) as typeof indexModule.openSubscribeSearchRef.fn;
  indexModule.openDirectSearchRef.fn = (async () => createSearchPage()) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;
  indexModule.openResumeDetailRef.fn = (async () => createDetailPage()) as typeof indexModule.openResumeDetailRef.fn;
  indexModule.extractCandidateListRef.fn = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  indexModule.extractionBoundary.extractResumeFromPage = async () => ({
    resume: buildResume('cand-1'),
    domSnapshot: { workLines: [] },
  });
  liepinAdapter.openSubscribeSearch = (async () => createSearchPage()) as typeof liepinAdapter.openSubscribeSearch;
  liepinAdapter.openDirectSearch = (async () => createSearchPage()) as NonNullable<typeof liepinAdapter.openDirectSearch>;
  liepinAdapter.openResumeDetail = (async () => createDetailPage()) as typeof liepinAdapter.openResumeDetail;
  liepinAdapter.extractCandidateList = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  liepinAdapter.parseResumeDetail = async () => buildResume('cand-1');
  zhilianAdapter.openSubscribeSearch = (async () => createSearchPage()) as typeof zhilianAdapter.openSubscribeSearch;
  zhilianAdapter.openDirectSearch = (async () => createSearchPage()) as NonNullable<typeof zhilianAdapter.openDirectSearch>;
  zhilianAdapter.openResumeDetail = (async () => createDetailPage()) as typeof zhilianAdapter.openResumeDetail;
  zhilianAdapter.extractCandidateList = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  zhilianAdapter.parseResumeDetail = async () => buildResume('cand-1');
  bossAdapter.openSubscribeSearch = (async () => createSearchPage()) as typeof bossAdapter.openSubscribeSearch;
  bossAdapter.openDirectSearch = (async () => createSearchPage()) as NonNullable<typeof bossAdapter.openDirectSearch>;
  bossAdapter.openResumeDetail = (async () => createDetailPage()) as typeof bossAdapter.openResumeDetail;
  bossAdapter.extractCandidateList = async () => ({
    candidates: [{ candidateId: 'boss-cand-1' }],
  });
  bossAdapter.parseResumeDetail = async () => buildResume('boss-cand-1');
  indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();
  indexModule.exportJobResultsRef.fn = async (_platform: string, jobKey: string) => ({
    jobKey,
    exportPath: '/tmp/export.md',
    summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
    markdown: '# export',
  });
  indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => ({
    jobKey,
    recipient: deliveryOverrides.recipientEmail ?? 'ops@example.com',
    subject: 'subject',
    summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
  });
  indexModule.ensureAuthenticatedBrowserSessionRef.fn = async (_platform) => ({
    page: { id: 'root-page', close: async () => undefined },
    context: { close: async () => undefined },
    browser: { close: async () => undefined },
  } as never);
}

async function captureConsole(fn: () => Promise<void>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  return { stdout, stderr };
}

function buildManualLoginReadyLog(
  platform: '51job' | 'liepin' | 'zhilian',
  url: string,
  title: string,
): string {
  return `Authenticated page ready: url=${url} title=${JSON.stringify(title)} storageStatePath=${resolveStorageStatePath(platform)}`;
}

function buildLiepinManualLoginWaitDiagnosticLog(options: {
  pageRole: 'context';
  finalUrl: string;
  title: string;
  bodyPreview: string;
  lastError: string;
}): string {
  return `Liepin manual login is still waiting for recruiter-search readiness after authenticated cookies were detected: pageRole=${options.pageRole} finalUrl=${options.finalUrl} title=${JSON.stringify(options.title)} bodyPreview=${JSON.stringify(options.bodyPreview)} storageStatePath=${resolveStorageStatePath('liepin')} lastError=${JSON.stringify(options.lastError)}`;
}

after(async () => {
  delete process.env.DATA_DIR;
  (config as { dataDir: string }).dataDir = originalDataDir;
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('candidate list readiness', () => {
  it('treats a stable empty visible result list as ready', async () => {
    let now = 0;
    const page = createCandidateListPage({
      bodyText: '已筛选为零条结果',
      resultListVisible: true,
      candidateCardsVisible: false,
      cardPayloads: [],
      onWaitForTimeout: (timeout) => {
        now += timeout;
      },
    });

    await captureDateNow(async () => {
      Date.now = () => now;
      await assert.doesNotReject(() => waitForCandidateResultsReady(page, { deadline: config.playwright.emptyResultsStableMs + 500 }));
      const candidates = await collectCandidateList(page, { deadline: now + config.playwright.emptyResultsStableMs + 500 });

      assert.deepStrictEqual(candidates, []);
    });
  });

  it('returns candidates when the result list appears before delayed candidate cards', async () => {
    let now = 0;
    const page = createCandidateListPage({
      bodyText: '结果页已加载',
      resultListVisible: true,
      candidateCardsVisible: true,
      candidateCardCountSequence: [0, 0, 1],
      cardPayloads: [
        {
          id: 'no_interested_100228050',
          text: '张三\n上海测试科技有限公司\n销售经理',
          resumeUrl: 'https://example.com/resume/100228050',
          name: '张三',
        },
      ],
      onWaitForTimeout: (timeout) => {
        now += timeout;
      },
    });

    await captureDateNow(async () => {
      Date.now = () => now;
      const candidates = await collectCandidateList(page, { deadline: config.playwright.emptyResultsStableMs + 500 });

      assert.deepStrictEqual(candidates.map((candidate) => candidate.candidateId), ['100228050']);
    });
  });

  it('treats explicit empty-result text as ready without waiting for the stable empty-list window', async () => {
    const waitCalls: number[] = [];
    const page = createCandidateListPage({
      bodyText: '暂无符合条件的人才',
      resultListVisible: true,
      candidateCardsVisible: false,
      cardPayloads: [],
      onWaitForTimeout: (timeout) => {
        waitCalls.push(timeout);
      },
    });

    await waitForCandidateResultsReady(page, { deadline: Date.now() + 1000 });

    assert.deepStrictEqual(waitCalls, []);
  });

  it('treats 51job filtered empty-result text as ready without waiting for the stable empty-list window', async () => {
    const waitCalls: number[] = [];
    const page = createCandidateListPage({
      bodyText: '过滤：\n我已看\n\n没有搜索到相关的人才\n\n更换搜索条件再试试',
      resultListVisible: true,
      candidateCardsVisible: false,
      cardPayloads: [],
      onWaitForTimeout: (timeout) => {
        waitCalls.push(timeout);
      },
    });

    await waitForCandidateResultsReady(page, { deadline: Date.now() + 1000 });

    assert.deepStrictEqual(waitCalls, []);
  });

  it('allows extraction validation to accept an empty candidate list', () => {
    assert.deepStrictEqual(validateCandidateListExtraction({ candidates: [] }), { candidates: [] });
  });

  it('still rejects candidates without candidateId', () => {
    assert.throws(
      () => validateCandidateListExtraction({
        candidates: [{ candidateId: '', cardText: 'bad candidate' }],
      }),
      /candidate without candidateId/,
    );
  });

  it('includes loading diagnostics when the page never renders result content', async () => {
    const page = createCandidateListPage({
      bodyText: '',
      resultListVisible: false,
      candidateCardsVisible: false,
      cardPayloads: [],
      url: 'https://ehire.51job.com/Revision/talent/search?rt=1',
      loadingVisible: true,
      rootVisible: true,
    });

    await assert.rejects(
      () => waitForCandidateResultsReady(page, { deadline: Date.now() - 1 }),
      /emptyTextMatched=false.*loadingVisible=true.*resultListVisible=false.*candidateCardCount=0.*stableEmptyListObservedMs=0.*deadlineRemainingMs=0/,
    );
  });

  it('rejects when an empty visible result list has not met the stable window before the deadline', async () => {
    let now = 0;
    const page = createCandidateListPage({
      bodyText: '结果页已加载',
      resultListVisible: true,
      candidateCardsVisible: false,
      cardPayloads: [],
      onWaitForTimeout: (timeout) => {
        now += timeout;
      },
    });

    await captureDateNow(async () => {
      Date.now = () => now;
      await assert.rejects(
        () => waitForCandidateResultsReady(page, { deadline: config.playwright.emptyResultsStableMs - 100 }),
        /resultListVisible=true.*candidateCardCount=0.*stableEmptyListObservedMs=/,
      );
    });
  });

  it('passes the same search deadline from orchestration to open and extract', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-search-deadline-contract';
    const fetchedAt = '2026-05-25T00:00:00.000Z';
    const observed: Array<{ phase: string; deadline?: number }> = [];
    let now = 1000;

    const adapter = {
      ...indexModule.resolvePlatformAdapter('liepin'),
      openSubscribeSearch: async (_page, _keyword, options) => {
        observed.push({ phase: 'open', deadline: options?.deadline });
        now += 25;
        return { id: 'search-page' } as never;
      },
      extractCandidateList: async (_page, options) => {
        observed.push({ phase: 'extract', deadline: options?.deadline });
        return { candidates: [] };
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const session = {
      page: { id: 'root-page' },
      context: { id: 'browser-context' },
    } as never;

    await captureDateNow(async () => {
      Date.now = () => now;
      await indexModule.runResumeCaptureFlow(
        'liepin',
        jobKey,
        {
          title: 'Test Job',
          majors: [],
          languageRequirements: [],
          responsibilities: [],
          hardRequirements: [],
          preferredRequirements: [],
          regionPreferences: [],
          industryTags: [],
        },
        'search keyword',
        store,
        session,
        fetchedAt,
        adapter,
      );
    });

    assert.deepStrictEqual(observed, [
      { phase: 'open', deadline: 1000 + config.playwright.searchPageTimeoutMs },
      { phase: 'extract', deadline: 1000 + config.playwright.searchPageTimeoutMs },
    ]);
  });

  it('uses a platform-owned direct-search estimate without resetting the shared deadline', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const observed: Array<{ phase: string; deadline?: number }> = [];
    let now = 10_000;
    const conditions: import('../types/job.js').SearchCondition[] = [{
      kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect', value: '本科及以上',
    }];
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      estimateSearchTimeoutMs: (input) => {
        assert.deepStrictEqual(input, { source: 'direct', conditions, includeViewedCandidates: false });
        return 90_000;
      },
      openDirectSearch: async (_page, _keyword, _conditions, options) => {
        observed.push({ phase: 'open', deadline: options?.deadline });
        now += 50;
        return { id: 'search-page' } as never;
      },
      extractCandidateList: async (_page, options) => {
        observed.push({ phase: 'extract', deadline: options?.deadline });
        return { candidates: [] };
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    await captureDateNow(async () => {
      Date.now = () => now;
      await indexModule.runResumeCaptureFlow(
        'boss',
        'job-platform-estimated-search-deadline',
        {
          title: 'Test Job', majors: [], languageRequirements: [], responsibilities: [], hardRequirements: [],
          preferredRequirements: [], regionPreferences: [], industryTags: [],
        },
        '铝',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-05-25T00:00:00.000Z',
        adapter,
        { searchSource: 'direct', searchConditions: conditions, includeViewedCandidates: false },
      );
    });

    assert.deepStrictEqual(observed, [
      { phase: 'open', deadline: 100_000 },
      { phase: 'extract', deadline: 100_000 },
    ]);
  });

  it('fails before browser search when Boss saved capture has no complete native reference', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    let legacyFallbackCalls = 0;
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openSubscribeSearch: async () => {
        legacyFallbackCalls += 1;
        return { id: 'legacy-search-page' } as never;
      },
      extractCandidateList: async () => ({ candidates: [] }),
    } satisfies import('../platforms/types.js').PlatformAdapter;

    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'boss',
        'boss-legacy-saved-reference-required',
        {
          title: '全铝箱包设计',
          majors: [],
          languageRequirements: [],
          responsibilities: [],
          hardRequirements: [],
          preferredRequirements: [],
          regionPreferences: [],
          industryTags: [],
        },
        '铝镁合金 拉杆箱',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-04T00:00:00.000Z',
        adapter,
        { searchSource: 'saved' },
      ),
      /saved-reference-required/i,
    );
    assert.equal(legacyFallbackCalls, 0);
  });

  it('fails closed instead of using the legacy saved-search entry when the native Boss hook is unavailable', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    let legacyFallbackCalls = 0;
    const { openSavedSearch: _openSavedSearch, ...registeredBossAdapter } = indexModule.resolvePlatformAdapter('boss');
    const adapter = {
      ...registeredBossAdapter,
      openSubscribeSearch: async (page: Page) => {
        legacyFallbackCalls += 1;
        return page;
      },
      extractCandidateList: async () => ({ candidates: [] }),
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const conditionIdentity = {
      jobScope: '全铝箱包设计',
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'subscription-native-required',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };

    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'boss',
        'boss-native-saved-action-required',
        {
          title: '全铝箱包设计',
          majors: [],
          languageRequirements: [],
          responsibilities: [],
          hardRequirements: [],
          preferredRequirements: [],
          regionPreferences: [],
          industryTags: [],
        },
        savedSearch.expectedKeyword,
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-04T00:00:00.000Z',
        adapter,
        { searchSource: 'saved', savedSearch },
      ),
      /native saved-search action is not registered/i,
    );
    assert.equal(legacyFallbackCalls, 0);
  });
});

describe('scoring run semantics', () => {
  it('keeps failed scoring candidates out of seen-ids while preserving successful ones', async () => {
    const JobStore = await makeIsolatedStore();
    const store = new JobStore();
    const jobKey = 'job-retry-semantics';

    await store.saveSeenIds('51job', jobKey, ['existing-candidate', 'cand-success']);
    const existingSeenIds = await store.readSeenIds('51job', jobKey);
    const scoredCandidateIds = ['cand-success', 'cand-success-2'];

    await store.saveSeenIds('51job', jobKey, [
      ...existingSeenIds,
      ...scoredCandidateIds,
    ]);

    const seenIds = await store.readSeenIds('51job', jobKey);

    assert.deepStrictEqual(seenIds, [
      'existing-candidate',
      'cand-success',
      'cand-success-2',
    ]);
    assert.ok(!seenIds.includes('cand-failed'));
  });

  it('keeps seen ids isolated by platform for the same job key', async () => {
    const JobStore = await makeIsolatedStore();
    const store = new JobStore();
    const jobKey = 'shared-keyword';

    await store.saveSeenIds('51job', jobKey, ['51job-candidate']);
    await store.saveSeenIds('liepin', jobKey, ['liepin-candidate']);

    assert.deepStrictEqual(await store.readSeenIds('51job', jobKey), ['51job-candidate']);
    assert.deepStrictEqual(await store.readSeenIds('liepin', jobKey), ['liepin-candidate']);
  });

  it('deduplicates job email settings and does not rewrite an unchanged job record', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobRecord: import('../types/job.js').JobRecord = {
      jobKey: 'deduplicated-job-config',
      platform: '51job',
      searchKeyword: 'deduplicated job config',
      recipientEmail: ' ops@example.com ',
      ccEmails: ['audit@example.com', ' audit@example.com ', ''],
      searchSettings: {
        source: 'saved',
        conditions: [],
      },
      rawText: '测试 JD',
      normalizedJob: buildNormalizedJob(),
      createdAt: '2026-07-13T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', jobRecord);
    const jdPath = path.join(tempDir, '51job', 'jobs', jobRecord.jobKey, 'jd.json');
    const firstStat = await fs.stat(jdPath);
    const saved = await store.readJobRecord('51job', jobRecord.jobKey);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.saveJobRecord('51job', saved);
    const secondStat = await fs.stat(jdPath);

    assert.equal(saved.recipientEmail, 'ops@example.com');
    assert.deepStrictEqual(saved.ccEmails, ['audit@example.com']);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  });

  it('persists a complete Boss saved-search reference through the revision-checked job patch', async () => {
    const JobStore = await makeIsolatedStore();
    const store = new JobStore();
    const jobKey = 'boss-saved-reference-cas';
    const conditionIdentity = {
      jobScope: '全铝箱包设计',
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'subscription-1',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: '岗位 JD',
      normalizedJob: {
        title: '全铝箱包设计',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-08-04T00:00:00.000Z',
      searchSettings: { source: 'saved', conditions: [] },
    });
    const before = await store.readJobRecord('boss', jobKey);
    const updated = await store.applyJobConfigPatch('boss', jobKey, before.revision ?? 1, {
      searchSource: 'saved',
      savedSearch,
    });
    assert.deepEqual(updated.searchSettings?.savedSearch, savedSearch);
    assert.deepEqual((await store.readJobRecord('boss', jobKey)).searchSettings?.savedSearch, savedSearch);
  });

  it('binds a verified Boss saved reference without entering candidate capture', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('全铝箱包设计', '');
    const conditionIdentity = {
      jobScope: '全铝箱包设计',
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'subscription-binding-1',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '全铝箱包设计',
      rawText: '职位名称：全铝箱包设计',
      normalizedJob: { ...buildNormalizedJob(), title: '全铝箱包设计' },
      createdAt: '2026-08-04T00:00:00.000Z',
      searchSettings: { source: 'saved', conditions: [] },
    });

    const originalOpenSavedSearch = bossAdapter.openSavedSearch;
    const originalEnsureSession = indexModule.ensureAuthenticatedBrowserSessionRef.fn;
    const originalCloseSession = indexModule.closeBrowserSessionRef.fn;
    const opened: Array<{ target: unknown; options?: unknown }> = [];
    const session = {
      page: { id: 'boss-binding-page' },
      context: { id: 'boss-binding-context' },
      browser: { id: 'boss-binding-browser' },
    } as unknown as BrowserSession;
    bossAdapter.openSavedSearch = async (page, target, options) => {
      opened.push({ target, options });
      assert.equal(page, session.page);
      return page;
    };
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => session;
    indexModule.closeBrowserSessionRef.fn = async (closed) => {
      assert.equal(closed, session);
    };

    try {
      const result = await indexModule.main([
        '--platform', 'boss',
        '--keyword', '全铝箱包设计',
        '--boss-bind-saved-search', 'true',
        '--boss-confirmed', 'true',
        '--boss-saved-search-reference-json', JSON.stringify(savedSearch),
      ]) as { mode: string; candidateSideEffects: boolean; revision: number };
      assert.equal(result.mode, 'boss-saved-search-binding');
      assert.equal(result.candidateSideEffects, false);
      assert.equal(result.revision, 2);
    } finally {
      bossAdapter.openSavedSearch = originalOpenSavedSearch;
      indexModule.ensureAuthenticatedBrowserSessionRef.fn = originalEnsureSession;
      indexModule.closeBrowserSessionRef.fn = originalCloseSession;
    }

    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0]?.target, savedSearch);
    assert.deepEqual(opened[0]?.options, {
      deadline: (opened[0]?.options as { deadline: number }).deadline,
      includeViewedCandidates: false,
      sortPolicy: 'match-priority',
    });
    const persisted = await store.readJobRecord('boss', jobKey);
    assert.equal(persisted.searchSettings?.source, 'saved');
    assert.deepEqual(persisted.searchSettings?.savedSearch, savedSearch);
    assert.equal(persisted.searchSettings?.pageKeyword, savedSearch.expectedKeyword);
    assert.deepEqual(persisted.searchSettings?.conditions, []);
  });

  it('persists run results with separate success and failure buckets', async () => {
    const JobStore = await makeIsolatedStore();
    const store = new JobStore();
    const jobKey = 'job-run-result';
    const fetchedAt = '2026-04-20T12:34:56.000Z';

    const resultPath = await store.saveRunResult('51job', jobKey, {
      jobKey,
      platform: '51job',
      fetchedAt,
      totalCandidates: 3,
      newCandidateIds: [
        'cand-success',
        'cand-failed',
      ],
      scoredCandidates: ['cand-success'],
      failedCandidates: [
        { candidateId: 'cand-failed', error: 'Scoring timed out' },
      ],
    });

    const saved = JSON.parse(await fs.readFile(resultPath, 'utf8')) as {
      newCandidateIds: string[];
      newCandidates?: unknown;
      scoredCandidates: string[];
      failedCandidates: Array<{ candidateId: string; error: string }>;
    };

    assert.deepStrictEqual(saved.newCandidateIds, ['cand-success', 'cand-failed']);
    assert.equal('newCandidates' in saved, false);
    assert.deepStrictEqual(saved.scoredCandidates, ['cand-success']);
    assert.deepStrictEqual(saved.failedCandidates, [
      { candidateId: 'cand-failed', error: 'Scoring timed out' },
    ]);
  });

  it('persists v2 captured history without the legacy new-candidate alias', async () => {
    const JobStore = await makeIsolatedStore();
    const store = new JobStore();
    const jobKey = 'job-run-result-v2';
    const resultPath = await store.saveRunResult('boss', jobKey, {
      jobKey,
      platform: 'boss',
      fetchedAt: '2026-04-20T12:34:57.000Z',
      totalCandidates: 2,
      runResultVersion: 2,
      capturedCandidateIds: ['cand-captured'],
      newCandidateIds: ['legacy-attempt-id'],
      scoredCandidates: ['cand-captured'],
      failedCandidates: [],
    });

    const saved = JSON.parse(await fs.readFile(resultPath, 'utf8')) as {
      runResultVersion: number;
      capturedCandidateIds: string[];
      newCandidateIds?: string[];
    };
    assert.equal(saved.runResultVersion, 2);
    assert.deepStrictEqual(saved.capturedCandidateIds, ['cand-captured']);
    assert.equal('newCandidateIds' in saved, false);
  });

  it('opens subscription search without extra fixed waits once the target page is ready', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showConditionPanelSearchTrigger('泰国 英语');
    searchOpen.setViewedFilterChecked(true);
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      const result = await openSubscribeSearch(searchOpen.page, '泰国 英语');

      assert.equal(result !== null, true);
      assert.deepStrictEqual(searchOpen.getPopupWaitForLoadStateCalls(), ['domcontentloaded']);
      assert.deepStrictEqual(searchOpen.getPopupWaitForTimeoutCalls(), []);
      assert.deepStrictEqual(searchOpen.getTargetWaitForTimeoutCalls(), []);
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }
  });

  it('moves down into the matching 51job subscription panel before crossing to its search button', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showConditionPanelSearchTrigger('泰国 英语');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    const mouseMoves = searchOpen.getMouseMoves();
    const cardBridgeIndex = mouseMoves.findIndex(({ x, y }) => x === 160 && y === 120);
    const panelEntryIndex = mouseMoves.findIndex(({ x, y }) => x === 160 && y === 183.2);
    const panelCrossIndex = mouseMoves.findIndex(({ x, y }) => x === 430 && y === 183.2);
    const triggerIndex = mouseMoves.findIndex(({ x, y }) => x === 430 && y === 315);

    assert.ok(cardBridgeIndex >= 0);
    assert.ok(panelEntryIndex > cardBridgeIndex);
    assert.ok(panelCrossIndex > panelEntryIndex);
    assert.ok(triggerIndex > panelCrossIndex);
    assert.equal(
      mouseMoves.slice(panelEntryIndex, panelCrossIndex + 1).every(({ y }) => y === 183.2),
      true,
    );
  });

  it('keeps the 51job viewed filter by default after opening subscription search results', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setViewedFilterChecked(true);
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getViewedFilterClicks(), 0);
    assert.equal(searchOpen.isViewedFilterChecked(), true);
  });

  it('checks the 51job viewed filter by default when a reusable page left it unchecked', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setViewedFilterChecked(false);
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getViewedFilterClicks(), 1);
    assert.equal(searchOpen.isViewedFilterChecked(), true);
  });

  it('closes 51job subscribe tabs after a popup search page opens', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setCurrentUrl('https://ehire.51job.com/Revision/talent/subscribe?rt=current');
    searchOpen.addExtraPage('stale-subscribe', 'https://ehire.51job.com/Revision/talent/subscribe?rt=stale');
    searchOpen.addExtraPage('unrelated-search', 'https://ehire.51job.com/Revision/talent/search?rt=old');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.deepStrictEqual(searchOpen.getClosedPageLabels(), ['main', 'stale-subscribe']);
  });

  it('clears the 51job viewed filter when viewed candidates are explicitly included', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setViewedFilterChecked(true);
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语', { includeViewedCandidates: true });
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getViewedFilterClicks(), 1);
    assert.equal(searchOpen.isViewedFilterChecked(), false);
  });

  it('does not perform duplicate readiness waits before clicking the subscription search trigger', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.setAvailableCardSelectors(['a.to-talent-search-button, a[href*="/Revision/talent/search"]']);
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
    }

    assert.equal(searchOpen.getCardSelectorWaits().get('a.to-talent-search-button, a[href*="/Revision/talent/search"]'), 3);
  });

  it('falls back to text-based card triggers when selector-based descendants are absent', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getCardSelectorWaits().get('text:人才搜索'), 1);
    assert.equal(searchOpen.getPageSelectorWaits().size, 0);
  });

  it('falls back to search-trigger href when click produces no popup or navigation', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showCardTextTrigger();
    searchOpen.setSearchTriggerHref('https://example.com/search?keyword=%E6%B3%B0%E5%9B%BD%20%E8%8B%B1%E8%AF%AD');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      const result = await openSubscribeSearch(searchOpen.page, '泰国 英语');

      assert.equal(result, searchOpen.page);
      assert.deepStrictEqual(searchOpen.getPageWaitForLoadStateCalls(), []);
      assert.equal(searchOpen.getCurrentUrl(), 'https://example.com/search?keyword=%E6%B3%B0%E5%9B%BD%20%E8%8B%B1%E8%AF%AD');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }
  });

  it('confirms the 51job search condition from textContent after opening subscription search results', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setBodyInnerText('');
    searchOpen.setBodyTextContent('已选条件\n关键词：泰国 英语\n从事职能：门店经理');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      const result = await openSubscribeSearch(searchOpen.page, '泰国 英语');

      assert.equal(result !== null, true);
      assert.deepStrictEqual(searchOpen.getPopupWaitForLoadStateCalls(), ['domcontentloaded']);
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }
  });

  it('rejects the 51job search page when the applied keyword belongs to another subscription', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showCardTextTrigger();
    searchOpen.setBodyText('已选条件\n关键词：优衣库\n从事职能：门店经理');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await assert.rejects(
        () => openSubscribeSearch(searchOpen.page, '泰国 英语', { deadline: Date.now() + 300 }),
        /51job talent search page did not confirm saved search keyword "泰国 英语"\./,
      );
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }
  });

  it('falls back to the active subscription detail panel trigger when the matched card exposes no descendant trigger', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showConditionPanelSearchTrigger('泰国 英语');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await openSubscribeSearch(searchOpen.page, '泰国 英语');
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getCardSelectorWaits().size, 0);
    assert.equal(searchOpen.getPageSelectorWaits().size, 0);
    assert.equal(searchOpen.getPanelSelectorWaits().get('button.to-talent-search-button'), 1);
  });

  it('rejects the 51job subscription detail panel when it belongs to a different saved search', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.showConditionPanelSearchTrigger('优衣库');
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => searchOpen.card) as typeof findSubscriptionCardRef.fn;
    waitForSearchTriggerReadyRef.fn = async () => undefined;
    clickSearchTriggerRef.fn = async () => undefined;

    try {
      await assert.rejects(
        () => openSubscribeSearch(searchOpen.page, '泰国 英语', { deadline: Date.now() + 300 }),
        /51job saved search "泰国 英语" did not become the active subscription detail panel\./,
      );
    } finally {
      openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      findSubscriptionCardRef.fn = originalFindSubscriptionCard;
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      clickSearchTriggerRef.fn = originalClickSearchTrigger;
    }

    assert.equal(searchOpen.getCardSelectorWaits().size, 0);
    assert.equal(searchOpen.getPageSelectorWaits().size, 0);
    assert.equal(searchOpen.getPanelSelectorWaits().size, 0);
  });

  it('waits for the subscribe page without fixed polling backoff once readiness appears', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.setCardCountSequence([0, 1]);

    await waitForAuthenticatedSubscribeReadyRef.fn(searchOpen.page);

    assert.equal(searchOpen.getPageWaitForTimeoutCalls().length, 0);
    assert.deepStrictEqual(
      searchOpen.getCardWaitForCalls().map((call) => ({ ...call, timeout: undefined })),
      [
        { state: 'visible', timeout: undefined },
        { state: 'attached', timeout: undefined },
      ],
    );
    for (const call of searchOpen.getCardWaitForCalls()) {
      assert.ok(call.timeout !== undefined && call.timeout > 0 && call.timeout <= config.playwright.searchPageTimeoutMs);
    }
  });

  it('rejects the subscribe page immediately when the authenticated subscribe page has fallen back to the login screen', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.setBodyText('请登录\n账号\n密码');

    await assert.rejects(
      () => waitForAuthenticatedSubscribeReadyRef.fn(searchOpen.page),
      /51job authenticated subscribe page is not available because the session has fallen back to the login screen\./,
    );

    assert.deepStrictEqual(searchOpen.getCardWaitForCalls(), []);
  });

  it('retries the subscription search trigger with one platform pace per click attempt', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalNow = Date.now;
    let attempts = 0;
    let now = 0;
    const searchTrigger = {
      click: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('not clickable yet');
        }
      },
    } as never;

    waitForSearchTriggerReadyRef.fn = async () => undefined;
    Date.now = () => {
      now += 100;
      return now;
    };

    try {
      await clickSearchTriggerRef.fn(searchOpen.page, searchTrigger);
    } finally {
      waitForSearchTriggerReadyRef.fn = originalWaitForSearchTriggerReady;
      Date.now = originalNow;
    }

    assert.equal(attempts, 2);
    const paceWaits = searchOpen.getPageWaitForTimeoutCalls();
    assert.equal(paceWaits.length, 2);
    assert.equal(paceWaits.every((delay) => delay >= 2000 && delay <= 4000), true);
  });

  it('collects HTML and frame evidence when the main body is empty', async () => {
    const detailPage = createDomSnapshotPageStub();
    detailPage.setMainDocument({
      bodyText: '',
      bodyHtml: '',
      html: '<html><body><iframe src="https://example.com/frame"></iframe></body></html>',
      title: '人才详情',
    });
    detailPage.setFrames([
      {
        url: 'https://example.com/frame',
        name: 'resume-frame',
        title: '人才详情',
        bodyText: '100228050 在线简历 工作经历 教育经历',
        bodyHtml: '<section>工作经历<div>示例经历</div>教育经历</section>',
        html: '<html><body><section>工作经历<div>示例经历</div>教育经历</section></body></html>',
      },
    ]);

    const evidence = await collectResumePageEvidence(detailPage.page);

    assert.equal(evidence.title, '人才详情');
    assert.equal(evidence.bodyLength, 0);
    assert.equal(evidence.htmlLength > 0, true);
    assert.deepStrictEqual(evidence.markers, []);
    assert.deepStrictEqual(evidence.frames, [
      {
        url: 'https://example.com/frame',
        name: 'resume-frame',
        title: '人才详情',
        bodyLength: '100228050 在线简历 工作经历 教育经历'.length,
        bodyPreview: '100228050 在线简历 工作经历 教育经历',
        htmlLength: '<html><body><section>工作经历<div>示例经历</div>教育经历</section></body></html>'.length,
        markers: ['在线简历', '工作经历', '教育经历'],
      },
    ]);
  });

  it('extracts DOM snapshot from a child frame when the main body is empty', async () => {
    const detailPage = createDomSnapshotPageStub();
    detailPage.setMainDocument({
      bodyText: '',
      bodyHtml: '',
      html: '<html><body><iframe src="https://example.com/frame"></iframe></body></html>',
    });
    detailPage.setFrames([
      {
        url: 'https://example.com/frame',
        name: 'resume-frame',
        title: '人才详情',
        bodyText: '100228050 在线简历 工作经历 教育经历',
        bodyHtml: '<section>工作经历<div>示例公司</div><div>销售经理</div>教育经历</section>',
        html: '<html><body><section>工作经历<div>示例公司</div><div>销售经理</div>教育经历</section></body></html>',
      },
    ]);

    const snapshot = await getResumeDomSnapshot(detailPage.page);

    assert.deepStrictEqual(snapshot, {
      workLines: ['示例公司', '销售经理'],
      workBlocks: undefined,
      workNodes: undefined,
    });
  });
  it('opens resume by URL without extra fixed waits once the page is ready', async () => {
    const detailPage = createResumeDetailPageStub();
    const session = {
      page: detailPage.page,
    } as never;
    const originalWaitForAuthenticatedSubscribeReady = waitForAuthenticatedSubscribeReadyRef.fn;
    waitForAuthenticatedSubscribeReadyRef.fn = async () => undefined;

    try {
      await openResumeByUrl(session, 'https://example.com/resume/100228050', '100228050');
    } finally {
      waitForAuthenticatedSubscribeReadyRef.fn = originalWaitForAuthenticatedSubscribeReady;
    }

    assert.deepStrictEqual(detailPage.getGotoCalls(), [
      { url: 'https://example.com/resume/100228050', waitUntil: 'domcontentloaded' },
    ]);
    assert.deepStrictEqual(detailPage.getWaitForTimeoutCalls(), []);
  });

  it('opens resume detail by URL after waiting for rendered resume content', async () => {
    const detailPage = createResumeDetailPageStub();
    const candidate = {
      candidateId: '100228050',
      resumeUrl: 'https://example.com/resume/100228050',
    };

    detailPage.setBodyTextSequence([
      '',
      '100228050 在线简历 工作经历 教育经历',
    ]);

    const result = await openResumeDetail(detailPage.context, detailPage.page, candidate);

    assert.equal(result, detailPage.page);
    assert.deepStrictEqual(detailPage.getGotoCalls(), [
      { url: 'https://example.com/resume/100228050', waitUntil: 'domcontentloaded' },
    ]);
    const waits = detailPage.getWaitForTimeoutCalls();
    assert.equal(waits.length, 2);
    assert.equal(waits[0]! >= 2000 && waits[0]! <= 4000, true);
    assert.equal(waits[1], 500);
  });

  it('falls back to resume URL when click does not open a real resume detail page', async () => {
    const detailPage = createResumeDetailPageStub();
    const candidate = {
      candidateId: '100228050',
      resumeUrl: 'https://example.com/resume/100228050',
    };

    detailPage.showTrigger();
    detailPage.setBodyTextSequence(['100228050 工作经历 教育经历']);

    const result = await openResumeDetail(detailPage.context, detailPage.page, candidate);

    assert.equal(result, detailPage.page);
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card:.name']);
    assert.deepStrictEqual(detailPage.getGotoCalls(), []);
    assert.equal(candidate.resumeUrl, 'https://example.com/resume/100228050');
    const waits = detailPage.getWaitForTimeoutCalls();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]! >= 2000 && waits[0]! <= 4000, true);
  });

  it('accepts same-page resume detail content when online resume marker is present', async () => {
    const detailPage = createResumeDetailPageStub();
    const candidate = {
      candidateId: '100228050',
    };

    detailPage.showTrigger();

    const result = await openResumeDetail(detailPage.context, detailPage.page, candidate);

    assert.equal(result, detailPage.page);
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card:.name']);
    assert.deepStrictEqual(detailPage.getGotoCalls(), []);
    const waits = detailPage.getWaitForTimeoutCalls();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]! >= 2000 && waits[0]! <= 4000, true);
  });

  it('opens resume detail by click navigation without extra fixed waits once the page is ready', async () => {
    const detailPage = createResumeDetailPageStub();
    const candidate = {
      candidateId: '100228050',
    };

    detailPage.showTrigger();
    detailPage.enableClickNavigation();

    const result = await openResumeDetail(detailPage.context, detailPage.page, candidate);

    assert.equal(result, detailPage.page);
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card:.name']);
    const waits = detailPage.getWaitForTimeoutCalls();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]! >= 2000 && waits[0]! <= 4000, true);
  });

  it('opens manual login in an isolated persistent browser profile', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreateFreshBrowserSession = createFreshBrowserSessionRef.fn;
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    const gotoCalls: string[] = [];
    let currentUrl = 'about:blank';
    let currentBodyText = '';

    createFreshBrowserSessionRef.fn = (async () => loginSession.createFreshBrowserSession()) as typeof createFreshBrowserSessionRef.fn;
    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      gotoCalls.push(url);
      currentUrl = url;
      currentBodyText = url === 'https://h.liepin.com/account/login'
        ? '登录/注册 我要找工作 获取验证码'
        : '';
    }) as typeof loginSession.page.goto;
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => currentBodyText,
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as typeof loginSession.page.locator;

    try {
      const session = await openLoginSessionRef.fn('liepin');

      assert.equal(session, loginSession.session);
      assert.deepStrictEqual(loginSession.getCreateFreshCalls(), []);
      assert.deepStrictEqual(loginSession.getCreatePersistentCalls(), ['liepin']);
      assert.deepStrictEqual(gotoCalls, ['https://h.liepin.com/account/login']);
    } finally {
      createFreshBrowserSessionRef.fn = originalCreateFreshBrowserSession;
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }
  });

  it('accepts a staged Liepin manual login landing when the login page body is blank', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    let currentUrl = 'about:blank';

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      currentUrl = url;
    }) as typeof loginSession.page.goto;
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => '',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as typeof loginSession.page.locator;

    try {
      const output = await captureConsole(async () => {
        const session = await openLoginSessionRef.fn('liepin');
        assert.equal(session, loginSession.session);
      });

      assert.deepStrictEqual(output.stdout, ['Browser opened for Liepin manual login. Complete the login flow, then return to the terminal when you are done.']);
      assert.deepStrictEqual(loginSession.getCreatePersistentCalls(), ['liepin']);
      assert.equal(currentUrl, 'https://h.liepin.com/account/login');
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }
  });

  it('accepts a staged Liepin manual login landing that stays on the login page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    let currentUrl = 'about:blank';

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      currentUrl = url;
    }) as typeof loginSession.page.goto;
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => '登录/注册 我已有账号，直接登录 获取验证码',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as typeof loginSession.page.locator;

    try {
      const output = await captureConsole(async () => {
        const session = await openLoginSessionRef.fn('liepin');
        assert.equal(session, loginSession.session);
      });

      assert.deepStrictEqual(output.stdout, [
        'Browser opened for Liepin manual login. Complete the login flow, then return to the terminal when you are done.',
      ]);
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }
  });

  it('keeps non-Liepin manual login on the existing adapter-driven path', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;

    const gotoCalls: string[] = [];

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      gotoCalls.push(url);
    }) as typeof loginSession.page.goto;

    try {
      await openLoginSessionRef.fn('51job');
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
    }

    assert.deepStrictEqual(loginSession.getCreatePersistentCalls(), ['51job']);
    assert.deepStrictEqual(gotoCalls, ['https://ehire.51job.com/Revision/talent/subscribe']);
  });

  it('opens Zhilian manual login on the passport login page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;

    const gotoCalls: string[] = [];

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      gotoCalls.push(url);
    }) as typeof loginSession.page.goto;

    try {
      await openLoginSessionRef.fn('zhilian');
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
    }

    assert.deepStrictEqual(loginSession.getCreatePersistentCalls(), ['zhilian']);
    assert.deepStrictEqual(gotoCalls, ['https://passport.zhaopin.com/org/login']);
  });

  it('opens Boss manual login on the provided Boss login page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;

    const gotoCalls: string[] = [];

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      gotoCalls.push(url);
    }) as typeof loginSession.page.goto;

    try {
      await openLoginSessionRef.fn('boss');
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
    }

    assert.deepStrictEqual(loginSession.getCreatePersistentCalls(), ['boss']);
    assert.deepStrictEqual(gotoCalls, ['https://www.zhipin.com/web/user/?ka=header-login']);
  });

  it('fails Liepin manual login entry when staged navigation lands on an unexpected page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      void url;
    }) as typeof loginSession.page.goto;
    loginSession.page.url = (() => 'https://h.liepin.com/account/verify') as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => '请先完成身份验证',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as typeof loginSession.page.locator;

    try {
      await assert.rejects(
        () => openLoginSessionRef.fn('liepin'),
        /unexpected page.*https:\/\/h\.liepin\.com\/account\/verify/,
      );
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }
  });

  it('fails Liepin manual login entry when staged navigation lands on a wow redirect page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalCreatePersistentBrowserSession = createPersistentBrowserSessionRef.fn;
    const originalGoto = loginSession.page.goto;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    const gotoCalls: string[] = [];
    let currentUrl = 'about:blank';

    createPersistentBrowserSessionRef.fn = (async (platform) => loginSession.createPersistentBrowserSession(platform)) as typeof createPersistentBrowserSessionRef.fn;
    loginSession.page.goto = (async (url: string) => {
      gotoCalls.push(url);
      currentUrl = 'https://wow.liepin.com/t1012695/4410f519.html';
    }) as typeof loginSession.page.goto;
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => '登录/注册 我要找工作 获取验证码',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as typeof loginSession.page.locator;

    try {
      await assert.rejects(
        () => openLoginSessionRef.fn('liepin'),
        /redirect\/interstitial page.*wow\.liepin\.com\/t1012695\/4410f519\.html/,
      );
    } finally {
      createPersistentBrowserSessionRef.fn = originalCreatePersistentBrowserSession;
      loginSession.page.goto = originalGoto;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }

    assert.deepStrictEqual(gotoCalls, ['https://h.liepin.com/account/login']);
  });

  it('removes temporary persistent profile directories after closing the browser session', async () => {
    const temporaryUserDataDir = await makeIsolatedTempDir();
    const closableSession = createClosableBrowserSessionStub({ temporaryUserDataDir });

    await closeBrowserSessionRef.fn(closableSession.session);

    await assert.rejects(fs.access(temporaryUserDataDir));
    assert.deepStrictEqual(closableSession.getCloseOrder(), ['context', 'browser']);
  });

  it('keeps a Liepin headed browser session open until manual close is requested', async () => {
    const closableSession = createClosableBrowserSessionStub({ keepOpenOnExit: true });

    await closeBrowserSessionRef.fn(closableSession.session);

    assert.deepStrictEqual(closableSession.getCloseOrder(), []);
  });

  it('forces Liepin browser sessions to headed mode even when headless is requested', () => {
    assert.equal(resolveBrowserHeadless('liepin', true), false);
    assert.equal(resolveBrowserHeadless('liepin', false), false);
    assert.equal(resolveBrowserHeadless('51job', true), true);
    assert.equal(resolveBrowserHeadless('zhilian', true), true);
  });

  it('enables reusable Liepin browser sessions only for headed Liepin runs unless explicitly disabled', () => {
    const originalReuseBrowser = config.playwright.reuseBrowserByPlatform.liepin;

    try {
      (config.playwright.reuseBrowserByPlatform as { liepin: boolean }).liepin = true;
      assert.equal(isLiepinReusableBrowserEnabled(true), true);
      assert.equal(isLiepinReusableBrowserEnabled(false), true);

      (config.playwright.reuseBrowserByPlatform as { liepin: boolean }).liepin = false;
      assert.equal(isLiepinReusableBrowserEnabled(false), false);
    } finally {
      (config.playwright.reuseBrowserByPlatform as { liepin: boolean }).liepin = originalReuseBrowser;
    }
  });

  it('supports reusable browser sessions per platform with production platforms enabled by default', () => {
    const originalReuseBrowser = { ...config.playwright.reuseBrowserByPlatform };
    const originalHeadless = config.playwright.headless;

    try {
      (config.playwright as { headless: boolean }).headless = false;
      assert.equal(isReusableBrowserEnabled('liepin'), true);
      assert.equal(isReusableBrowserEnabled('51job'), true);
      assert.equal(isReusableBrowserEnabled('zhilian'), true);

      (config.playwright.reuseBrowserByPlatform as { '51job': boolean; zhilian: boolean })['51job'] = false;
      assert.equal(isReusableBrowserEnabled('51job', false), false);
      (config.playwright.reuseBrowserByPlatform as { '51job': boolean; zhilian: boolean }).zhilian = false;
      assert.equal(isReusableBrowserEnabled('zhilian', false), false);

      (config.playwright.reuseBrowserByPlatform as { '51job': boolean; zhilian: boolean })['51job'] = true;
      (config.playwright.reuseBrowserByPlatform as { '51job': boolean; zhilian: boolean }).zhilian = true;
      assert.equal(isReusableBrowserEnabled('51job', false), true);
      assert.equal(isReusableBrowserEnabled('zhilian', false), true);
      assert.equal(isReusableBrowserEnabled('51job', true), false);
      assert.equal(isReusableBrowserEnabled('zhilian', true), false);
    } finally {
      (config.playwright as { headless: boolean }).headless = originalHeadless;
      Object.assign(config.playwright.reuseBrowserByPlatform, originalReuseBrowser);
    }
  });

  it('diagnoses manual login session module identity', async () => {
    const token = `${Date.now()}-${Math.random()}`;
    const sessionModule = await import(`../browser/session.js?test=${token}`);
    const loginModule = await import(`./login-and-save-session.js?test=${token}`);

    assert.ok(loginModule.runManualLoginSessionSave);
    assert.notStrictEqual(sessionModule.persistBrowserSessionRef.fn, undefined);
  });

  it('saves and verifies a Liepin session from the current authenticated recruiter search page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;
    const originalTitle = loginSession.page.title;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/search/getConditionItem') as typeof loginSession.page.url;
    loginSession.page.title = (async () => '猎聘人才搜索') as typeof loginSession.page.title;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 招聘管理 候选人',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as unknown as typeof loginSession.page.locator;

    let caughtError: unknown;
    let loginSucceeded = false;
    let output: Awaited<ReturnType<typeof captureConsole>>;
    const originalSessionStorageState = loginSession.session.context.storageState;
    let storageStateCalls = 0;
    loginSession.session.context.storageState = async () => {
      storageStateCalls += 1;
      return { cookies: [], origins: [] };
    };

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
            loginSucceeded = true;
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.session.context.storageState = originalSessionStorageState;
      loginSession.page.url = originalUrl;
      loginSession.page.title = originalTitle;
      loginSession.page.locator = originalLocator;
    }

    assert.equal(loginSucceeded, true);
    assert.deepStrictEqual(output.stdout, [
      'Waiting for login to complete.',
      buildManualLoginReadyLog('liepin', 'https://h.liepin.com/search/getConditionItem', '猎聘人才搜索'),
      'Authenticated page confirmed and storage state saved.',
    ]);
    assert.equal(caughtError, undefined);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(storageStateCalls, 0);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('checks Liepin manual login completion without fixed polling waits once recruiter search is ready', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;
    const originalTitle = loginSession.page.title;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/search/getConditionItem') as typeof loginSession.page.url;
    loginSession.page.title = (async () => '猎聘人才搜索') as typeof loginSession.page.title;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 招聘管理 候选人',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as unknown as typeof loginSession.page.locator;

    let caughtError: unknown;
    let loginSucceeded = false;
    let output: Awaited<ReturnType<typeof captureConsole>>;
    const originalSessionStorageState = loginSession.session.context.storageState;
    let storageStateCalls = 0;
    loginSession.session.context.storageState = async () => {
      storageStateCalls += 1;
      return { cookies: [], origins: [] };
    };

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
            loginSucceeded = true;
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.session.context.storageState = originalSessionStorageState;
      loginSession.page.url = originalUrl;
      loginSession.page.title = originalTitle;
      loginSession.page.locator = originalLocator;
    }

    assert.equal(loginSucceeded, true);
    assert.deepStrictEqual(output.stdout, [
      'Waiting for login to complete.',
      buildManualLoginReadyLog('liepin', 'https://h.liepin.com/search/getConditionItem', '猎聘人才搜索'),
      'Authenticated page confirmed and storage state saved.',
    ]);
    assert.equal(caughtError, undefined);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(storageStateCalls, 0);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not probe the active Liepin login page while manual login is still in progress', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [config.playwright.loginPollIntervalMs]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not probe other Liepin login pages in the same context before authenticated cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const visibleLoginPage = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'https://h.liepin.com/account/login',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      close: async () => undefined,
      isClosed: () => false,
    } as never;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage, visibleLoginPage],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [config.playwright.loginPollIntervalMs]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not probe non-login Liepin pages in the same context before authenticated cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const blankPage = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'about:blank',
      locator: () => ({
        innerText: async () => '',
      }),
      close: async () => undefined,
      isClosed: () => false,
    } as never;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage, blankPage],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [config.playwright.loginPollIntervalMs]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not probe the active Zhilian login page while manual login is still in progress', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'zhilian'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'zhilian') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://passport.zhaopin.com/org/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['zhilian']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [config.playwright.loginPollIntervalMs]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('saves and verifies a Zhilian session without opening a probe tab when auth cookies exist on passport', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'zhilian'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'zhilian') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      void page;
      throw new Error('login page should not be probed once auth cookies exist');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://passport.zhaopin.com/org/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage],
      cookies: async () => [
        { name: 'at' },
        { name: 'rt' },
      ],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe tab should not be opened once auth cookies exist');
      },
    });

    let caughtError: unknown;
    let loginSucceeded = false;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
            loginSucceeded = true;
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.equal(loginSucceeded, true);
    assert.deepStrictEqual(output.stdout, [
      'Waiting for login to complete.',
      'Authenticated page confirmed, storage state saved, and fresh-session reuse verified.',
    ]);
    assert.equal(caughtError, undefined);
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['zhilian']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['zhilian']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), ['zhilian']);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not treat shallow Zhilian device cookies on passport as a completed login', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'zhilian'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'zhilian') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://passport.zhaopin.com/org/login') as typeof loginSession.page.url;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage],
      cookies: async () => [
        { name: 'x-zp-client-id' },
        { name: 'login-type' },
        { name: 'x-zp-device-id' },
      ],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before real authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['zhilian']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [config.playwright.loginPollIntervalMs]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });
  it('does not reopen a Liepin login page when the active manual-login page has been closed before auth cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;
    const replacementGotoCalls: Array<{ url: string; waitUntil?: string }> = [];
    const currentPages: Page[] = [];
    const replacementLoginPage = {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        replacementGotoCalls.push({ url, waitUntil: options?.waitUntil });
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'https://h.liepin.com/account/login',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      close: async () => undefined,
      isClosed: () => false,
    } as never;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.page as object, {
      isClosed: () => true,
    });
    Object.assign(loginSession.session.context as object, {
      pages: () => currentPages,
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        currentPages.splice(0, currentPages.length, replacementLoginPage);
        return replacementLoginPage;
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(replacementGotoCalls, []);
    assert.deepStrictEqual(checkedPages, []);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not reopen a Liepin login page when the active manual-login page disappears from the context before auth cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;
    const replacementGotoCalls: Array<{ url: string; waitUntil?: string }> = [];
    const replacementLoginPage = {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        replacementGotoCalls.push({ url, waitUntil: options?.waitUntil });
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'https://h.liepin.com/account/login',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      close: async () => undefined,
      isClosed: () => false,
    } as never;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.page as object, {
      isClosed: () => false,
    });
    Object.assign(loginSession.session.context as object, {
      pages: () => [],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        return replacementLoginPage;
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(replacementGotoCalls, []);
    assert.deepStrictEqual(checkedPages, []);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not reopen Liepin login pages when the manual-login page stays missing before auth cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    let now = 0;
    let newPageCalls = 0;
    const replacementGotoCalls: Array<{ url: string; waitUntil?: string }> = [];
    const replacementLoginPage = {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        replacementGotoCalls.push({ url, waitUntil: options?.waitUntil });
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'https://h.liepin.com/account/login',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      close: async () => undefined,
      isClosed: () => false,
    } as never;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/account/login') as typeof loginSession.page.url;
    Object.assign(loginSession.page as object, {
      isClosed: () => true,
    });
    Object.assign(loginSession.session.context as object, {
      pages: () => [],
      cookies: async () => [],
      newPage: async () => {
        newPageCalls += 1;
        return replacementLoginPage;
      },
    });

    try {
      await assert.rejects(
        captureDateNow(async () => {
          Date.now = () => now;
          await runManualLoginSessionSave();
        }),
        /Login confirmation timed out/,
      );
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
    }

    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(replacementGotoCalls, []);
    assert.ok(loginSession.getPageWaitForTimeoutCalls().length > 1);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('saves and verifies a Liepin session when another page in the same context is recruiter-search ready', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;
    const authenticatedPage = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      url: () => 'https://h.liepin.com/search/getConditionItem',
      title: async () => '猎聘人才搜索',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '搜简历 招聘管理 候选人',
        };
      },
      close: async () => undefined,
    } as never;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      if (page === authenticatedPage) {
        return authenticatedPage;
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginSession.page, authenticatedPage],
      newPage: async () => {
        newPageCalls += 1;
        return authenticatedPage;
      },
    });

    let caughtError: unknown;
    let loginSucceeded = false;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
            loginSucceeded = true;
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.equal(loginSucceeded, true);
    assert.deepStrictEqual(output.stdout, [
      'Waiting for login to complete.',
      buildManualLoginReadyLog('liepin', 'https://h.liepin.com/search/getConditionItem', '猎聘人才搜索'),
      'Authenticated page confirmed and storage state saved.',
    ]);
    assert.equal(caughtError, undefined);
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not open a Liepin probe page when authenticated cookies exist but the current page is not ready', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;
    const currentUrl = 'about:blank';
    const currentBodyText = '';

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      if (page === loginPage) {
        throw new Error('login not ready');
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => currentBodyText,
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as unknown as typeof loginSession.page.locator;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginSession.page],
      cookies: async () => [
        { name: 'UniqueKey' },
        { name: 'liepin_login_valid' },
      ],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened after authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.deepStrictEqual(checkedPages, []);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.ok(loginSession.getPageWaitForTimeoutCalls().length > 0);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('polls the same Liepin page across login checks instead of opening a probe tab', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    let readyAttempts = 0;
    const checkedPages: unknown[] = [];
    let newPageCalls = 0;
    let currentUrl = 'https://h.liepin.com/account/login';
    let currentBodyText = '立即登录/注册 密码登录';

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      checkedPages.push(page);
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('manual login polling must not call openAuthenticatedHome');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      readyAttempts += 1;
      if (readyAttempts >= 2) {
        currentUrl = 'https://h.liepin.com/search/getConditionItem';
        currentBodyText = '搜简历 招聘管理 候选人';
      }
      now += timeout;
    };
    loginSession.page.url = (() => currentUrl) as typeof loginSession.page.url;
    loginSession.page.title = (async () => '猎聘人才搜索') as typeof loginSession.page.title;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          innerText: async () => currentBodyText,
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as unknown as typeof loginSession.page.locator;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginSession.page],
      cookies: async () => [
        { name: 'UniqueKey' },
        { name: 'liepin_login_valid' },
      ],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened after authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let loginSucceeded = false;

    try {
      await captureDateNow(async () => {
        Date.now = () => now;
        try {
          await runManualLoginSessionSave();
          loginSucceeded = true;
        } catch (error) {
          caughtError = error;
        }
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.equal(loginSucceeded, true);
    assert.equal(caughtError, undefined);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(checkedPages, []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [
      config.playwright.loginPollIntervalMs,
      config.playwright.loginPollIntervalMs,
    ]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not keep opening Liepin probe tabs before authenticated cookies exist', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    let newPageCalls = 0;
    let contextCookiesCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      throw new Error('login not ready');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginSession.page],
      cookies: async () => {
        contextCookiesCalls += 1;
        return [
          { name: 'acw_tc' },
          { name: 'XSRF-TOKEN' },
        ];
      },
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened before auth cookies exist');
      },
    });
    try {
      await assert.rejects(
        captureDateNow(async () => {
          Date.now = () => now;
          await runManualLoginSessionSave();
        }),
        /Login confirmation timed out/,
      );
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.equal(newPageCalls, 0);
    assert.ok(contextCookiesCalls > 0);
    assert.ok(loginSession.getPageWaitForTimeoutCalls().length > 0);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('logs Liepin page diagnostics when authenticated cookies exist but recruiter search never becomes ready', async () => {
    const loginSession = createManualLoginSessionStub();
    const loginPage = loginSession.page as unknown as Page;
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    const originalUrl = loginSession.page.url;
    const originalTitle = loginSession.page.title;
    const originalLocator = loginSession.page.locator;
    let now = 0;
    let newPageCalls = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (page, platform) => {
      if (platform !== 'liepin') {
        throw new Error(`Unexpected platform: ${platform}`);
      }
      if (page === loginPage) {
        throw new Error('search shell still loading');
      }
      throw new Error('unexpected page');
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += config.playwright.loginTimeoutMs;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/search/getConditionItem') as typeof loginSession.page.url;
    loginSession.page.title = (async () => '猎聘人才搜索') as typeof loginSession.page.title;
    loginSession.page.locator = ((selector: string) => {
      assert.equal(selector, 'body');
      return {
        innerText: async () => '搜索条件正在加载',
      };
    }) as unknown as typeof loginSession.page.locator;
    Object.assign(loginSession.session.context as object, {
      pages: () => [loginPage],
      cookies: async () => [
        { name: 'UniqueKey' },
        { name: 'liepin_login_valid' },
      ],
      newPage: async () => {
        newPageCalls += 1;
        throw new Error('probe page should not be opened after authenticated cookies exist');
      },
    });

    let caughtError: unknown;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
      loginSession.page.title = originalTitle;
      loginSession.page.locator = originalLocator;
    }

    assert.match(
      caughtError instanceof Error ? caughtError.message : String(caughtError),
      /Login confirmation timed out before the authenticated page became ready\./,
    );
    assert.deepStrictEqual(output.stdout, ['Waiting for login to complete.']);
    assert.deepStrictEqual(output.stderr, [
      buildLiepinManualLoginWaitDiagnosticLog({
        pageRole: 'context',
        finalUrl: 'https://h.liepin.com/search/getConditionItem',
        title: '猎聘人才搜索',
        bodyPreview: '搜索条件正在加载',
        lastError: 'recruiter-search page exists but is not ready',
      }),
    ]);
    assert.equal(newPageCalls, 0);
    assert.deepStrictEqual(loginSession.getPersistCalls(), []);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('saves and verifies a 51job session after the authenticated page becomes ready', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const originalUrl = loginSession.page.url;
    const originalTitle = loginSession.page.title;

    loginSession.failAuthenticationAttempts(2);
    process.argv = ['node', 'test-login-save-session', '--platform', '51job'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://ehire.51job.com/Revision/talent/subscribe') as typeof loginSession.page.url;
    loginSession.page.title = (async () => '简历订阅') as typeof loginSession.page.title;

    let caughtError: unknown;
    let loginSucceeded = false;
    let output: Awaited<ReturnType<typeof captureConsole>>;

    try {
      output = await captureConsole(async () => {
        await captureDateNow(async () => {
          Date.now = () => now;
          try {
            await runManualLoginSessionSave();
            loginSucceeded = true;
          } catch (error) {
            caughtError = error;
          }
        });
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
      loginSession.page.title = originalTitle;
    }

    assert.equal(loginSucceeded, true);
    assert.deepStrictEqual(output.stdout, [
      'Waiting for login to complete.',
      buildManualLoginReadyLog('51job', 'https://ehire.51job.com/Revision/talent/subscribe', '简历订阅'),
      'Authenticated page confirmed, storage state saved, and fresh-session reuse verified.',
    ]);
    assert.equal(caughtError, undefined);
    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), ['51job', '51job', '51job']);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), [
      config.playwright.loginPollIntervalMs,
      config.playwright.loginPollIntervalMs,
    ]);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), ['51job']);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('surfaces storage save failures instead of retrying until login timeout', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const persistError = new Error('storage save failed');

    loginSession.setPersistError(persistError);
    process.argv = ['node', 'test-login-save-session'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };

    try {
      await assert.rejects(
        captureDateNow(async () => {
          Date.now = () => now;
          await runManualLoginSessionSave();
        }),
        persistError,
      );
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('does not run fresh-session verification after saving a Liepin session from the current page', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const originalUrl = loginSession.page.url;
    const originalLocator = loginSession.page.locator;

    loginSession.setVerifyError(new Error('saved state could not be reused'));
    process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };
    loginSession.page.url = (() => 'https://h.liepin.com/search/getConditionItem') as typeof loginSession.page.url;
    loginSession.page.locator = ((selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 招聘管理 候选人',
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }) as unknown as typeof loginSession.page.locator;

    try {
      await captureDateNow(async () => {
        Date.now = () => now;
        await runManualLoginSessionSave();
      });
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
      loginSession.page.url = originalUrl;
      loginSession.page.locator = originalLocator;
    }

    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), []);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('verifies saved manual-login state in a fresh session for non-Liepin only', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;

    process.argv = ['node', 'test-login-save-session', '--platform', 'zhilian'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;

    const verifyCalls: Array<{ platform: string; options?: { headless?: boolean } }> = [];
    verifyPersistedBrowserSessionRef.fn = (async (platform, options) => {
      verifyCalls.push({ platform, options });
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;

    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };

    try {
      await captureDateNow(async () => {
        Date.now = () => now;
        await runManualLoginSessionSave();
      });

      assert.deepStrictEqual(verifyCalls, [
        { platform: 'zhilian', options: { headless: true } },
      ]);
      assert.deepStrictEqual(loginSession.getPersistCalls(), ['zhilian']);
      assert.deepStrictEqual(loginSession.getVerifyCalls(), ['zhilian']);

      verifyCalls.length = 0;
      loginSession.getPersistCalls().length = 0;
      loginSession.getVerifyCalls().length = 0;
      loginSession.getOpenLoginCalls().length = 0;
      loginSession.getOpenAuthenticatedCalls().length = 0;
      loginSession.getCloseCalls().length = 0;
      process.argv = ['node', 'test-login-save-session', '--platform', 'liepin'];
      now = 0;
      loginSession.page.url = (() => 'https://h.liepin.com/search/getConditionItem') as typeof loginSession.page.url;
      loginSession.page.locator = ((selector: string) => {
        if (selector === 'body') {
          return {
            innerText: async () => '搜简历 招聘管理 候选人',
          };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      }) as unknown as typeof loginSession.page.locator;

      await captureDateNow(async () => {
        Date.now = () => now;
        await runManualLoginSessionSave();
      });

      assert.deepStrictEqual(verifyCalls, []);
      assert.deepStrictEqual(loginSession.getPersistCalls(), ['liepin']);
      assert.deepStrictEqual(loginSession.getVerifyCalls(), []);
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }
  });

  it('brings authenticated headed Zhilian and Boss sessions to the front', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const originalHeadless = config.playwright.headless;
    const bringToFrontCalls: string[] = [];

    (config.playwright as { headless: boolean }).headless = false;
    sessionModule.createBrowserSessionRef.fn = (async (platform: string) => ({
      page: {
        bringToFront: async () => {
          bringToFrontCalls.push(platform);
        },
      },
      context: {},
      browser: {},
    } as unknown as BrowserSession)) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async (page: Page) => page) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;

    try {
      await sessionModule.ensureAuthenticatedBrowserSession('zhilian');
      await sessionModule.ensureAuthenticatedBrowserSession('boss');
      await sessionModule.ensureAuthenticatedBrowserSession('51job');
      await sessionModule.ensureAuthenticatedBrowserSession('liepin');
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      (config.playwright as { headless: boolean }).headless = originalHeadless;
    }

    assert.deepStrictEqual(bringToFrontCalls, ['zhilian', 'boss']);
  });

  it('skips foregrounding in headless mode and for platforms without foreground behavior', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    let bringToFrontCalls = 0;
    const session = {
      page: {
        bringToFront: async () => {
          bringToFrontCalls += 1;
        },
      },
      context: {},
      browser: {},
    } as unknown as BrowserSession;

    await sessionModule.bringAuthenticatedSessionPageToFront(session, 'zhilian', true);
    await sessionModule.bringAuthenticatedSessionPageToFront(session, 'boss', true);
    await sessionModule.bringAuthenticatedSessionPageToFront(session, '51job', false);
    await sessionModule.bringAuthenticatedSessionPageToFront(session, 'liepin', false);

    assert.equal(bringToFrontCalls, 0);
  });

  it('continues an authenticated Zhilian run when page foregrounding fails', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    const session = {
      page: {
        bringToFront: async () => {
          throw new Error('window manager denied focus');
        },
      },
      context: {},
      browser: {},
    } as unknown as BrowserSession;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      await assert.doesNotReject(() => sessionModule.bringAuthenticatedSessionPageToFront(session, 'zhilian', false));
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Could not bring Zhilian browser page to front.*window manager denied focus/);
  });

  it('brings the newly authenticated Zhilian session to the front after login refresh', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const originalRefreshExpiredLoginSession = sessionModule.refreshExpiredLoginSessionRef.fn;
    const originalHeadless = config.playwright.headless;
    const staleSession = {
      page: {
        title: async () => '登录',
        locator: () => ({ innerText: async () => '企业登录' }),
        url: () => 'https://passport.zhaopin.com/org/login',
      },
      context: {},
      browser: {},
    } as unknown as BrowserSession;
    let bringToFrontCalls = 0;
    const refreshedSession = {
      page: {
        bringToFront: async () => {
          bringToFrontCalls += 1;
        },
      },
      context: {},
      browser: {},
    } as unknown as BrowserSession;
    const createCalls: string[] = [];
    const closeCalls: BrowserSession[] = [];
    const refreshCalls: string[] = [];

    (config.playwright as { headless: boolean }).headless = false;
    sessionModule.createBrowserSessionRef.fn = (async (platform: string) => {
      createCalls.push(platform);
      return createCalls.length === 1 ? staleSession : refreshedSession;
    }) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async (session: BrowserSession) => {
      closeCalls.push(session);
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async (page: Page) => {
      if (page === staleSession.page) {
        throw new Error('Zhilian login state is invalid');
      }
      return page;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;
    sessionModule.refreshExpiredLoginSessionRef.fn = async (platform: string) => {
      refreshCalls.push(platform);
    };

    try {
      const session = await sessionModule.ensureAuthenticatedBrowserSession('zhilian');
      assert.equal(session, refreshedSession);
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      sessionModule.refreshExpiredLoginSessionRef.fn = originalRefreshExpiredLoginSession;
      (config.playwright as { headless: boolean }).headless = originalHeadless;
    }

    assert.deepStrictEqual(createCalls, ['zhilian', 'zhilian']);
    assert.deepStrictEqual(closeCalls, [staleSession]);
    assert.deepStrictEqual(refreshCalls, ['zhilian']);
    assert.equal(bringToFrontCalls, 1);
  });

  it('verifies a persisted Liepin session from fresh auth state by requiring recruiter search readiness', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
    const freshPage = {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        gotoCalls.push({ url, waitUntil: options?.waitUntil });
      },
      waitForLoadState: async () => undefined,
      locator: () => ({
        waitFor: async () => undefined,
        innerText: async () => '',
      }),
      url: () => 'https://h.liepin.com/search/getConditionItem',
      context: () => ({
        cookies: async () => [
          { name: 'UniqueKey' },
          { name: 'liepin_login_valid' },
          { name: 'lt_auth' },
        ],
      }),
    } as never;
    const freshSession = {
      page: freshPage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    const openAuthenticatedCalls: string[] = [];
    let closeCalls = 0;

    sessionModule.createBrowserSessionRef.fn = (async () => freshSession) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async () => {
      closeCalls += 1;
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async (page: never, platform: string) => {
      openAuthenticatedCalls.push(platform);
      assert.equal(page, freshPage);
      return freshPage;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;

    try {
      await assert.doesNotReject(() => sessionModule.verifyPersistedBrowserSession('liepin'));
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
    }

    assert.deepStrictEqual(openAuthenticatedCalls, ['liepin']);
    assert.deepStrictEqual(gotoCalls, []);
    assert.equal(closeCalls, 1);
  });

  it('surfaces Liepin fresh-session verification diagnostics when persisted state reuse fails', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const authError = new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
    const freshPage = {
      title: async () => '猎头-猎头招聘服务',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      url: () => 'https://h.liepin.com/account/login',
    } as never;
    const freshSession = {
      page: freshPage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    let closeCalls = 0;

    sessionModule.createBrowserSessionRef.fn = (async () => freshSession) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async () => {
      closeCalls += 1;
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async () => {
      throw authError;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;

    try {
      await assert.rejects(
        () => sessionModule.verifyPersistedBrowserSession('liepin'),
        /Saved Liepin storage state could not be reused in a fresh browser session\. Original error: Liepin authenticated page is not available because the session has fallen back to the login screen\..*finalUrl.*https:\/\/h\.liepin\.com\/account\/login.*title.*猎头-猎头招聘服务.*bodyPreview.*立即登录\/注册 密码登录/s,
      );
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
    }

    assert.equal(closeCalls, 1);
  });

  it('reuses a persisted Liepin session for authenticated browser setup only after recruiter search is ready', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
    const freshPage = {
      goto: async (url: string, options?: { waitUntil?: string }) => {
        gotoCalls.push({ url, waitUntil: options?.waitUntil });
      },
      waitForLoadState: async () => undefined,
      locator: () => ({
        waitFor: async () => undefined,
        innerText: async () => '',
      }),
      url: () => 'https://h.liepin.com/search/getConditionItem',
      context: () => ({
        cookies: async () => [
          { name: 'UniqueKey' },
          { name: 'liepin_login_valid' },
          { name: 'lt_auth' },
        ],
      }),
    } as never;
    const freshSession = {
      page: freshPage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    const openAuthenticatedCalls: string[] = [];
    let closeCalls = 0;

    sessionModule.createBrowserSessionRef.fn = (async () => freshSession) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async () => {
      closeCalls += 1;
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async (page: never, platform: string) => {
      openAuthenticatedCalls.push(platform);
      assert.equal(page, freshPage);
      return freshPage;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;

    try {
      const session = await sessionModule.ensureAuthenticatedBrowserSession('liepin');
      assert.equal(session, freshSession);
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
    }

    assert.deepStrictEqual(openAuthenticatedCalls, ['liepin']);
    assert.deepStrictEqual(gotoCalls, []);
    assert.equal(closeCalls, 0);
  });

  it('uses headed Liepin browser setup even when global headless mode is enabled', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const originalHeadless = config.playwright.headless;
    const authError = new Error('Liepin authenticated page is not available because the session has fallen back to the login screen.');
    const refreshRef = (sessionModule as unknown as {
      refreshExpiredLoginSessionRef: { fn: (platform: string) => Promise<void> };
    }).refreshExpiredLoginSessionRef;
    const originalRefreshExpiredLoginSession = refreshRef.fn;
    const freshPage = {
      title: async () => '猎头-猎头招聘服务',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '立即登录/注册 密码登录',
        };
      },
      url: () => 'https://h.liepin.com/account/login',
    } as never;
    const freshSession = {
      page: freshPage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    let closeCalls = 0;
    const refreshCalls: string[] = [];
    let authenticated = false;

    (config.playwright as { headless: boolean }).headless = true;
    sessionModule.createBrowserSessionRef.fn = (async () => freshSession) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async () => {
      closeCalls += 1;
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async () => {
      if (!authenticated) {
        throw authError;
      }

      return freshPage;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;
    refreshRef.fn = async (platform: string) => {
      refreshCalls.push(platform);
      authenticated = true;
    };

    try {
      const session = await sessionModule.ensureAuthenticatedBrowserSession('liepin');
      assert.equal(session, freshSession);
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      refreshRef.fn = originalRefreshExpiredLoginSession;
      (config.playwright as { headless: boolean }).headless = originalHeadless;
    }

    assert.equal(closeCalls, 1);
    assert.deepStrictEqual(refreshCalls, ['liepin']);
  });

  it('refreshes expired login state in headed mode and returns a newly authenticated session', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const originalHeadless = config.playwright.headless;
    const refreshRef = (sessionModule as unknown as {
      refreshExpiredLoginSessionRef: { fn: (platform: string) => Promise<void> };
    }).refreshExpiredLoginSessionRef;
    const originalRefreshExpiredLoginSession = refreshRef.fn;
    const authError = new Error('51job authenticated subscribe page is not available because the session has fallen back to the login screen.');
    const stalePage = {
      title: async () => '登录',
      locator: (selector?: string) => {
        assert.equal(selector, 'body');
        return {
          innerText: async () => '账号登录',
        };
      },
      url: () => 'https://ehire.51job.com/login',
    } as never;
    const refreshedPage = {
      title: async () => '人才订阅',
      locator: () => ({
        innerText: async () => '人才订阅 搜索',
      }),
      url: () => 'https://ehire.51job.com/Revision/talent/subscribe',
    } as never;
    const staleSession = {
      page: stalePage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    const refreshedSession = {
      page: refreshedPage,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    const createCalls: string[] = [];
    const closeCalls: BrowserSession[] = [];
    const openAuthenticatedCalls: Array<{ page: never; platform: string }> = [];
    const refreshCalls: string[] = [];

    (config.playwright as { headless: boolean }).headless = false;
    sessionModule.createBrowserSessionRef.fn = (async (platform: string) => {
      createCalls.push(platform);
      return createCalls.length === 1 ? staleSession : refreshedSession;
    }) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async (session: BrowserSession) => {
      closeCalls.push(session);
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async (page: never, platform: string) => {
      openAuthenticatedCalls.push({ page, platform });
      if (page === stalePage) {
        throw authError;
      }
      return refreshedPage;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;
    refreshRef.fn = async (platform: string) => {
      refreshCalls.push(platform);
    };

    try {
      const session = await sessionModule.ensureAuthenticatedBrowserSession('51job');

      assert.equal(session, refreshedSession);
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      refreshRef.fn = originalRefreshExpiredLoginSession;
      (config.playwright as { headless: boolean }).headless = originalHeadless;
    }

    assert.deepStrictEqual(createCalls, ['51job', '51job']);
    assert.deepStrictEqual(refreshCalls, ['51job']);
    assert.deepStrictEqual(closeCalls, [staleSession]);
    assert.deepStrictEqual(openAuthenticatedCalls, [
      { page: stalePage, platform: '51job' },
      { page: refreshedPage, platform: '51job' },
    ]);
  });

  it('keeps headless expired-login behavior as an actionable failure', async () => {
    const sessionModule = await import(`../browser/session.js?test=${Date.now()}-${Math.random()}`);
    const originalCreateBrowserSession = sessionModule.createBrowserSessionRef.fn;
    const originalCloseBrowserSession = sessionModule.closeBrowserSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = sessionModule.openAuthenticatedSubscribePageRef.fn;
    const originalHeadless = config.playwright.headless;
    const refreshRef = (sessionModule as unknown as {
      refreshExpiredLoginSessionRef: { fn: (platform: string) => Promise<void> };
    }).refreshExpiredLoginSessionRef;
    const originalRefreshExpiredLoginSession = refreshRef.fn;
    const authError = new Error('51job authenticated subscribe page is not available because the session has fallen back to the login screen.');
    const page = {
      title: async () => '登录',
      locator: () => ({
        innerText: async () => '账号登录',
      }),
      url: () => 'https://ehire.51job.com/login',
    } as never;
    const session = {
      page,
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as unknown as BrowserSession;
    const refreshCalls: string[] = [];
    let closeCalls = 0;

    (config.playwright as { headless: boolean }).headless = true;
    sessionModule.createBrowserSessionRef.fn = (async () => session) as typeof sessionModule.createBrowserSessionRef.fn;
    sessionModule.closeBrowserSessionRef.fn = (async () => {
      closeCalls += 1;
    }) as typeof sessionModule.closeBrowserSessionRef.fn;
    sessionModule.openAuthenticatedSubscribePageRef.fn = (async () => {
      throw authError;
    }) as typeof sessionModule.openAuthenticatedSubscribePageRef.fn;
    refreshRef.fn = async (platform: string) => {
      refreshCalls.push(platform);
    };

    try {
      await assert.rejects(
        () => sessionModule.ensureAuthenticatedBrowserSession('51job'),
        /51job login state is invalid and cannot be refreshed in headless mode\. Re-run with PLAYWRIGHT_HEADLESS=false\./,
      );
    } finally {
      sessionModule.createBrowserSessionRef.fn = originalCreateBrowserSession;
      sessionModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
      sessionModule.openAuthenticatedSubscribePageRef.fn = originalOpenAuthenticatedSubscribePage;
      refreshRef.fn = originalRefreshExpiredLoginSession;
      (config.playwright as { headless: boolean }).headless = originalHeadless;
    }

    assert.deepStrictEqual(refreshCalls, []);
    assert.equal(closeCalls, 1);
  });

  it('surfaces persisted-state verification failures after saving the session', async () => {
    const loginSession = createManualLoginSessionStub();
    const originalArgv = process.argv;
    const originalOpenLoginSession = openLoginSessionRef.fn;
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageSessionRef.fn;
    const originalPersistBrowserSession = persistBrowserSessionRef.fn;
    const originalVerifyPersistedBrowserSession = verifyPersistedBrowserSessionRef.fn;
    const originalCloseBrowserSession = closeBrowserSessionRef.fn;
    let now = 0;
    const verifyError = new Error('saved state could not be reused');

    loginSession.setVerifyError(verifyError);
    process.argv = ['node', 'test-login-save-session'];
    openLoginSessionRef.fn = async (platform) => loginSession.openLoginSession(platform);
    openAuthenticatedSubscribePageSessionRef.fn = (async (_page, platform) => {
      await loginSession.openAuthenticatedSubscribePage(platform);
      return loginSession.page as never;
    }) as typeof openAuthenticatedSubscribePageSessionRef.fn;
    persistBrowserSessionRef.fn = (async (_session, platform) => {
      await loginSession.persistBrowserSession(platform);
    }) as typeof persistBrowserSessionRef.fn;
    verifyPersistedBrowserSessionRef.fn = (async (platform) => {
      await loginSession.verifyPersistedBrowserSession(platform);
    }) as typeof verifyPersistedBrowserSessionRef.fn;
    closeBrowserSessionRef.fn = (async () => {
      await loginSession.closeBrowserSession();
    }) as typeof closeBrowserSessionRef.fn;
    loginSession.page.waitForTimeout = async (timeout: number) => {
      loginSession.getPageWaitForTimeoutCalls().push(timeout);
      now += timeout;
    };

    try {
      await assert.rejects(
        captureDateNow(async () => {
          Date.now = () => now;
          await runManualLoginSessionSave();
        }),
        verifyError,
      );
    } finally {
      process.argv = originalArgv;
      openLoginSessionRef.fn = originalOpenLoginSession;
      openAuthenticatedSubscribePageSessionRef.fn = originalOpenAuthenticatedSubscribePage;
      persistBrowserSessionRef.fn = originalPersistBrowserSession;
      verifyPersistedBrowserSessionRef.fn = originalVerifyPersistedBrowserSession;
      closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }

    assert.deepStrictEqual(loginSession.getOpenLoginCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getOpenAuthenticatedCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getPageWaitForTimeoutCalls(), []);
    assert.deepStrictEqual(loginSession.getPersistCalls(), ['51job']);
    assert.deepStrictEqual(loginSession.getVerifyCalls(), ['51job']);
    assert.equal(loginSession.getCloseCalls().length, 1);
  });

  it('persists failed scoring artifacts, marks captured candidates as seen, and records scoring failures in run-level failedCandidates', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-scoring-failure';
    const fetchedAt = '2026-04-20T12:34:56.000Z';

    indexModule.extractCandidateListRef.fn = async () => ({
      candidates: [
        { candidateId: 'cand-score-fails' },
      ],
    });
    indexModule.extractionBoundary.extractCandidateListFromPage = async () => ({
      candidates: [
        { candidateId: 'cand-score-fails' },
      ],
    });
    indexModule.openSubscribeSearchRef.fn = (async () => ({ id: 'search-page' } as never)) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openResumeDetailRef.fn = (async () => ({
      waitForLoadState: async () => undefined,
      title: async () => 'Resume Detail',
      content: async () => '<html><body>raw resume text</body></html>',
      locator: () => ({
        innerText: async () => 'raw resume text',
        innerHTML: async () => '<div>raw resume text</div>',
      }),
      mainFrame: () => ({ childFrames: () => [] }),
      close: async () => undefined,
    } as never)) as typeof indexModule.openResumeDetailRef.fn;
    indexModule.extractResumeFromPageRef.fn = async () => ({
      resume: {
        candidateId: 'cand-score-fails',
        regions: [],
        pr: [],
        workExperiences: [],
        projectExperiences: [],
        educationExperiences: [],
        skill: [],
        certificates: [],
      },
      domSnapshot: { workLines: [] },
    });
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      throw new Error('Scoring timed out');
    };


    const session = {
      page: { id: 'root-page' },
      context: { id: 'browser-context' },
    } as never;

    const originalWaitForAuthenticatedSubscribeReady = waitForAuthenticatedSubscribeReadyRef.fn;
    const originalCloseBrowserSession = indexModule.closeBrowserSessionRef.fn;
    waitForAuthenticatedSubscribeReadyRef.fn = async () => undefined;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;

    try {
      const result = await indexModule.runResumeCaptureFlow(
        '51job',
        jobKey,
        {
          title: 'Test Job',
          majors: [],
          languageRequirements: [],
          responsibilities: [],
          hardRequirements: [],
          preferredRequirements: [],
          regionPreferences: [],
          industryTags: [],
        },
        'search keyword',
        store,
        session,
        fetchedAt,
        indexModule.resolvePlatformAdapter('51job'),
      );

      const storedResumes = await store.listStoredResumes('51job', jobKey);
      const storedArtifacts = await store.listStoredScoreArtifacts('51job', jobKey);

      assert.deepStrictEqual(storedResumes.map((resume) => resume.candidateId), ['cand-score-fails']);
      assert.deepStrictEqual(storedArtifacts.map((artifact) => ({ candidateId: artifact.candidateId, status: artifact.status })), [
        { candidateId: 'cand-score-fails', status: 'failed' },
      ]);
      assert.deepStrictEqual(await store.readSeenIds('51job', jobKey), ['cand-score-fails']);
      assert.deepStrictEqual(result.runResult.scoredCandidates, []);
      assert.deepStrictEqual(result.runResult.failedCandidates, [
        { candidateId: 'cand-score-fails', error: 'Scoring timed out' },
      ]);
    } finally {
      waitForAuthenticatedSubscribeReadyRef.fn = originalWaitForAuthenticatedSubscribeReady;
      indexModule.closeBrowserSessionRef.fn = originalCloseBrowserSession;
    }
  });

  it('captures all new resumes before starting model scoring', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-capture-before-score';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const callOrder: string[] = [];

    indexModule.extractCandidateListRef.fn = async () => ({
      candidates: [
        { candidateId: 'cand-1' },
        { candidateId: 'cand-2' },
      ],
    });
    indexModule.extractionBoundary.extractCandidateListFromPage = async () => ({
      candidates: [
        { candidateId: 'cand-1' },
        { candidateId: 'cand-2' },
      ],
    });
    indexModule.openSubscribeSearchRef.fn = (async () => ({ id: 'search-page' } as never)) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openResumeDetailRef.fn = (async (_context, _searchPage, candidate) => ({
      waitForLoadState: async () => undefined,
      title: async () => 'Resume Detail',
      content: async () => `<html><body>${candidate.candidateId} raw resume text</body></html>`,
      locator: () => ({
        innerText: async () => `${candidate.candidateId} raw resume text`,
        innerHTML: async () => `<div>${candidate.candidateId} raw resume text</div>`,
      }),
      mainFrame: () => ({ childFrames: () => [] }),
      close: async () => undefined,
    } as never)) as typeof indexModule.openResumeDetailRef.fn;
    indexModule.extractResumeFromPageRef.fn = async (_page, candidate) => ({
      resume: {
        candidateId: candidate.candidateId,
        regions: [],
        pr: [],
        workExperiences: [],
        projectExperiences: [],
        educationExperiences: [],
        skill: [],
        certificates: [],
      },
      domSnapshot: { workLines: [] },
    });

    const originalSaveCandidateResume = store.saveCandidateResume.bind(store);
    store.saveCandidateResume = async (platform, key, resume, rawText, domSnapshot) => {
      callOrder.push(`save:${resume.candidateId}`);
      return originalSaveCandidateResume(platform, key, resume, rawText, domSnapshot);
    };
    indexModule.scoreResumeAgainstJobRef.fn = async (_job, resume) => {
      callOrder.push(`score:${resume.candidateId}`);
      return buildScore();
    };

    const session = {
      page: { id: 'root-page' },
      context: { id: 'browser-context' },
    } as never;

    const result = await indexModule.runResumeCaptureFlow(
      '51job',
      jobKey,
      {
        title: 'Test Job',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      'search keyword',
      store,
      session,
      fetchedAt,
      indexModule.resolvePlatformAdapter('51job'),
    );

    assert.deepStrictEqual(callOrder, [
      'save:cand-1',
      'save:cand-2',
      'score:cand-1',
      'score:cand-2',
    ]);
    assert.deepStrictEqual(result.runResult.scoredCandidates, ['cand-1', 'cand-2']);
    assert.deepStrictEqual(result.runResult.failedCandidates, []);
  });

  it('carries Zhilian delivery metadata into score artifacts', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-zhilian-share-link';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const candidateShareUrl = 'https://m.zhaopin.com/b/resume-package?zhaopinToken=artifact-token';
    const searchPage = createSearchPage();
    const detailPage = createDetailPage();
    const adapter = {
      ...indexModule.resolvePlatformAdapter('zhilian'),
      openSubscribeSearch: async () => searchPage,
      extractCandidateList: async () => ({
        candidates: [{ candidateId: 'cand-share-link' }],
      }),
      openResumeDetail: async () => detailPage,
      afterResumeDetailOpened: async () => ({ candidateShareUrl }),
      parseResumeDetail: async () => ({
        candidateId: 'cand-share-link',
        regions: [],
        pr: [],
        workExperiences: [],
        projectExperiences: [],
        educationExperiences: [],
        skill: [],
        certificates: [],
      }),
    } satisfies import('../platforms/types.js').PlatformAdapter;

    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    await indexModule.runResumeCaptureFlow(
      'zhilian',
      jobKey,
      {
        title: 'Test Job',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      'search keyword',
      store,
      {
        page: { id: 'root-page' },
        context: { id: 'browser-context' },
      } as never,
      fetchedAt,
      adapter,
    );

    const artifacts = await store.listStoredScoreArtifacts('zhilian', jobKey);

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.candidateId, 'cand-share-link');
    assert.equal(artifacts[0]?.candidateShareUrl, candidateShareUrl);
  });

  it('runs Liepin frequent-contact forwarding only for new candidates before parsing resumes', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-liepin-forward';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const callOrder: string[] = [];
    const detailPage = createDetailPage();

    await store.saveSeenIds('liepin', jobKey, ['cand-seen']);

    const adapter = {
      ...indexModule.resolvePlatformAdapter('liepin'),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({
        candidates: [
          { candidateId: 'cand-seen' },
          { candidateId: 'cand-new' },
        ],
      }),
      openResumeDetail: async (_context, _searchPage, candidate) => {
        callOrder.push(`open:${candidate.candidateId}`);
        return detailPage;
      },
      afterResumeDetailOpened: async (_page, candidate, actions) => {
        callOrder.push(`forward:${candidate.candidateId}:${actions.liepinForwardContact ?? ''}`);
      },
      parseResumeDetail: async (_page, candidate) => {
        callOrder.push(`parse:${candidate.candidateId}`);
        return buildResume(candidate.candidateId);
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    const result = await indexModule.runResumeCaptureFlow(
      'liepin',
      jobKey,
      {
        title: 'Test Job',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      'search keyword',
      store,
      {
        page: { id: 'root-page' },
        context: { id: 'browser-context' },
      } as never,
      fetchedAt,
      adapter,
      { liepinForwardContact: '王经理' },
    );

    assert.deepStrictEqual(callOrder, [
      'open:cand-new',
      'forward:cand-new:王经理',
      'parse:cand-new',
    ]);
    assert.deepStrictEqual(result.newCandidates.map((candidate) => candidate.candidateId), ['cand-new']);
    assert.deepStrictEqual(await store.readSeenIds('liepin', jobKey), ['cand-seen', 'cand-new']);
  });

  it('runs Boss forwarding for new candidates before parsing resumes', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-forward';
    const fetchedAt = '2026-07-11T12:34:56.000Z';
    const callOrder: string[] = [];
    const detailPage = createDetailPage();

    await store.saveCandidateResume('boss', jobKey, buildResume('boss-seen'));
    await store.saveSeenIds('boss', jobKey, ['boss-seen']);

    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({
        candidates: [
          { candidateId: 'boss-seen' },
          { candidateId: 'boss-new' },
        ],
      }),
      openResumeDetail: async (_context, _searchPage, candidate) => {
        callOrder.push(`open:${candidate.candidateId}`);
        return detailPage;
      },
      afterResumeDetailOpened: async (_page, candidate, actions) => {
        callOrder.push(`forward:${candidate.candidateId}:${actions.bossForwardMode ?? ''}:${actions.bossForwardRecipient ?? ''}:${actions.bossForwardCcEmails?.join(',') ?? ''}`);
      },
      parseResumeDetail: async (_page, candidate) => {
        callOrder.push(`parse:${candidate.candidateId}`);
        return buildResume(candidate.candidateId);
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      {
        page: { id: 'root-page' },
        context: { id: 'browser-context' },
      } as never,
      fetchedAt,
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossForwardCc: ['primary-audit@example.com'],
      },
    );

    assert.deepStrictEqual(callOrder, [
      'open:boss-new',
      'forward:boss-new:email:primary@example.com:primary-audit@example.com',
      'parse:boss-new',
    ]);
    assert.deepStrictEqual(result.newCandidates.map((candidate) => candidate.candidateId), ['boss-new']);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), ['boss-seen', 'boss-new']);
  });

  it('limits ordinary Boss capture to the first twenty extracted resumes before seen filtering or actions', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-first-twenty-limit';
    const candidates = Array.from({ length: 22 }, (_, index) => ({
      candidateId: `boss-cap-${String(index + 1).padStart(2, '0')}`,
    }));
    const openedCandidateIds: string[] = [];
    const forwardedCandidateIds: string[] = [];
    const parsedCandidateIds: string[] = [];
    const scoredCandidateIds: string[] = [];
    const historyViewedCandidateIds: string[] = [];

    await store.saveCandidateResume('boss', jobKey, buildResume(candidates[0]!.candidateId));
    await store.saveSeenIds('boss', jobKey, [candidates[0]!.candidateId]);
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates }),
      openResumeDetail: async (_context, _searchPage, candidate) => {
        openedCandidateIds.push(candidate.candidateId);
        return createDetailPage();
      },
      afterResumeDetailOpened: async (_page, candidate) => {
        forwardedCandidateIds.push(candidate.candidateId);
      },
      parseResumeDetail: async (_page, candidate) => {
        parsedCandidateIds.push(candidate.candidateId);
        return buildResume(candidate.candidateId);
      },
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.visitBossSeenCandidateDetailRef.fn = async (_page, candidate) => {
      historyViewedCandidateIds.push(candidate.candidateId);
      return {
        candidateId: candidate.candidateId,
        detailOpened: true,
        detailIdentityVerified: true,
        detailClosed: true,
      };
    };
    indexModule.scoreResumeAgainstJobRef.fn = async (_job, resume) => {
      scoredCandidateIds.push(resume.candidateId);
      return buildScore();
    };

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      {
        page: { id: 'root-page' },
        context: { id: 'browser-context' },
      } as never,
      '2026-08-01T12:34:56.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
      },
    );

    const firstTwentyIds = candidates.slice(0, 20).map((candidate) => candidate.candidateId);
    const newIdsWithinLimit = firstTwentyIds.slice(1);
    assert.deepStrictEqual(result.candidates.map((candidate) => candidate.candidateId), firstTwentyIds);
    assert.deepStrictEqual(result.newCandidates.map((candidate) => candidate.candidateId), newIdsWithinLimit);
    assert.equal(result.runResult.totalCandidates, 20);
    assert.deepStrictEqual(result.runResult.capturedCandidateIds, newIdsWithinLimit);
    assert.equal('newCandidateIds' in result.runResult, false);
    assert.deepStrictEqual(openedCandidateIds, newIdsWithinLimit);
    assert.deepStrictEqual(historyViewedCandidateIds, [firstTwentyIds[0]]);
    assert.deepStrictEqual(forwardedCandidateIds, newIdsWithinLimit);
    assert.deepStrictEqual(parsedCandidateIds, newIdsWithinLimit);
    assert.deepStrictEqual(scoredCandidateIds, newIdsWithinLimit);
    assert.deepStrictEqual(result.runResult.bossSeenViewSync, {
      eligibleCandidateIds: [firstTwentyIds[0]],
      attemptedCandidateIds: [firstTwentyIds[0]],
      completedCandidateIds: [firstTwentyIds[0]],
      coveredByProcessingCandidateIds: [],
      failures: [],
    });
    assert.deepStrictEqual(
      (await store.listStoredResumes('boss', jobKey)).map((resume) => resume.candidateId).sort(),
      [...firstTwentyIds].sort(),
    );
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), firstTwentyIds);
  });

  it('views every historical card inside the first twenty without parsing, scoring, forwarding, or rewriting history', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-all-seen-view-sync';
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      candidateId: `boss-seen-only-${String(index + 1).padStart(2, '0')}`,
    }));
    const viewedIds: string[] = [];
    let adapterOpenCalls = 0;
    let parseCalls = 0;
    let scoreCalls = 0;
    await Promise.all(candidates.map(async (candidate) => {
      await store.saveCandidateResume('boss', jobKey, buildResume(candidate.candidateId));
    }));
    await store.saveSeenIds('boss', jobKey, candidates.map((candidate) => candidate.candidateId));
    const beforeSeen = await store.readSeenIds('boss', jobKey);
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates }),
      openResumeDetail: async () => {
        adapterOpenCalls += 1;
        throw new Error('ordinary adapter detail must not run for view-only history cards');
      },
      parseResumeDetail: async () => {
        parseCalls += 1;
        throw new Error('view-only history must not parse');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.visitBossSeenCandidateDetailRef.fn = async (_page, candidate) => {
      viewedIds.push(candidate.candidateId);
      return {
        candidateId: candidate.candidateId,
        detailOpened: true,
        detailIdentityVerified: true,
        detailClosed: true,
      };
    };
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      scoreCalls += 1;
      return buildScore();
    };

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T12:34:56.000Z',
      adapter,
      { searchSource: 'direct' },
    );

    assert.deepStrictEqual(viewedIds, candidates.map((candidate) => candidate.candidateId));
    assert.equal(adapterOpenCalls, 0);
    assert.equal(parseCalls, 0);
    assert.equal(scoreCalls, 0);
    assert.deepStrictEqual(result.newCandidates, []);
    assert.deepStrictEqual(result.capturedCandidateIds, []);
    assert.equal(result.runResult.captureAttemptCount, 0);
    assert.equal(result.runResult.detailAttemptCount, 20);
    assert.deepStrictEqual(result.runResult.bossSeenViewSync, {
      eligibleCandidateIds: candidates.map((candidate) => candidate.candidateId),
      attemptedCandidateIds: candidates.map((candidate) => candidate.candidateId),
      completedCandidateIds: candidates.map((candidate) => candidate.candidateId),
      coveredByProcessingCandidateIds: [],
      failures: [],
    });
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), beforeSeen);
  });

  it('fails closed when the bounded Boss card snapshot repeats a stable candidate ID', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-duplicate-bounded-id';
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [{ candidateId: 'duplicate-id' }, { candidateId: 'duplicate-id' }] }),
      openResumeDetail: async () => {
        throw new Error('duplicate snapshot must fail before detail operations');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        '物业电工',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T12:34:56.000Z',
        adapter,
        { searchSource: 'direct' },
      ),
      /duplicate stable IDs inside the first twenty: duplicate-id/,
    );
  });

  it('does not recover or mutate Boss outbox entries beyond the first twenty cards', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-cap-outbox';
    const candidates = Array.from({ length: 22 }, (_, index) => ({
      candidateId: `boss-cap-outbox-${String(index + 1).padStart(2, '0')}`,
    }));
    const firstTwentyIds = candidates.slice(0, 20).map((candidate) => candidate.candidateId);
    const screening = buildModelScreeningSettings();
    const policyHash = hashBossScreeningPolicy(screening);

    await Promise.all(firstTwentyIds.map(async (candidateId) => {
      await store.saveCandidateResume('boss', jobKey, buildResume(candidateId));
    }));
    await store.saveSeenIds('boss', jobKey, firstTwentyIds);
    await store.saveBossForwardingOutboxEntry('boss', jobKey, {
      candidateId: candidates[21]!.candidateId,
      policyHash,
      classification: 'qualified',
      audience: 'primary',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:01.000Z',
      forwarding: {
        status: 'sending',
        mode: 'email',
        recipient: 'primary@example.com',
      },
    });

    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates }),
      openResumeDetail: async () => {
        throw new Error('No detail should open for seen candidates in this cap test');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T12:00:02.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossScreening: screening,
      },
    );

    const outbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidates[21]!.candidateId);
    assert.equal(result.runResult.totalCandidates, 20);
    assert.equal(result.runResult.detailAttemptCount, 20);
    assert.deepStrictEqual(result.runResult.bossSeenViewSync?.attemptedCandidateIds, firstTwentyIds);
    assert.deepStrictEqual(result.runResult.bossSeenViewSync?.completedCandidateIds, firstTwentyIds);
    assert.equal(outbox?.forwarding.status, 'sending');
    assert.equal(outbox?.updatedAt, '2026-08-01T12:00:01.000Z');
  });

  it('does not persist history when a parsed detail returns another candidate identity', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-detail-identity-mismatch';
    const candidate = { candidateId: 'boss-card-candidate' };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => createDetailPage(),
      parseResumeDetail: async () => buildResume('different-candidate'),
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      throw new Error('identity mismatch must not reach scoring');
    };

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T12:34:56.000Z',
      adapter,
      { searchSource: 'direct' },
    );

    assert.deepEqual(result.capturedCandidateIds, []);
    assert.deepEqual(await store.readSeenIds('boss', jobKey), []);
    assert.deepEqual(await store.listStoredResumes('boss', jobKey), []);
    assert.deepEqual(result.runResult.captureFailures, [{
      candidateId: candidate.candidateId,
      stage: 'identity-verify',
      detailVerified: false,
      error: 'Parsed resume identity different-candidate does not match candidate boss-card-candidate.',
    }]);
    assert.deepEqual(result.runResult.scoredCandidates, []);
  });

  it('scores, checks communication, and forwards in one Boss detail while keeping rejected and failed scores isolated', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-post-score-routing';
    const fetchedAt = '2026-07-31T12:34:56.000Z';
    const callOrder: string[] = [];
    const detailPage = createDetailPage();
    let activeDetailOptions: { deadline: number } | undefined;
    const originalMarkCapturedCandidatesSeen = store.markCapturedCandidatesSeen.bind(store);

    store.markCapturedCandidatesSeen = async (platform, key, candidateIds) => {
      callOrder.push(`seen:${candidateIds.at(-1)}`);
      return originalMarkCapturedCandidatesSeen(platform, key, candidateIds);
    };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({
        candidates: [
          { candidateId: 'boss-qualified' },
          { candidateId: 'boss-review' },
          { candidateId: 'boss-rejected' },
          { candidateId: 'boss-score-failed' },
        ],
      }),
      openResumeDetail: async (_context, _searchPage, candidate, detailOptions) => {
        callOrder.push(`open:${candidate.candidateId}`);
        assert.ok(detailOptions);
        activeDetailOptions = detailOptions;
        return detailPage;
      },
      afterResumeDetailOpened: async () => {
        callOrder.push('legacy-forward');
      },
      parseResumeDetail: async (_page, candidate) => {
        callOrder.push(`parse:${candidate.candidateId}`);
        return {
          ...buildResume(candidate.candidateId),
          pr: [candidate.candidateId],
        };
      },
      closeResumeDetail: async (_searchPage, _detailPage, candidate, detailOptions) => {
        assert.ok(detailOptions && detailOptions.deadline > Date.now(), 'strict close must use the fresh post-model continuation');
        callOrder.push(`close:${candidate.candidateId}`);
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const interruptedDiagnostic = {
      provider: 'codex-session' as const,
      kind: 'turn-interrupted' as const,
      phase: 'turn-running' as const,
      retryable: true,
      firstOutputObserved: true,
      elapsedMs: 125_000,
      occurredAt: '2026-07-31T12:36:00.000Z',
      lastProtocolActivityAt: '2026-07-31T12:35:59.000Z',
    };
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async ({ resume }) => {
      callOrder.push(`score:${resume.candidateId}`);
      assert.ok(activeDetailOptions);
      activeDetailOptions.deadline = Date.now() - 1;
      if (resume.candidateId === 'boss-score-failed') {
        throw new CodexSessionProviderError(
          'boss-screening',
          'Codex App Server exited while the turn was running',
          interruptedDiagnostic,
        );
      }
      const outcome = resume.candidateId === 'boss-rejected'
        ? 'missing'
        : resume.candidateId === 'boss-review'
          ? 'unknown'
          : 'satisfied';
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation(outcome, resume.candidateId)],
      };
    };
    indexModule.readBossColleagueCommunicationFlagRef.fn = async (_page, candidate, detailOptions) => {
      assert.ok(detailOptions.deadline > Date.now(), 'communication read must use the fresh post-model continuation');
      callOrder.push(`communication:${candidate.candidateId}`);
      return { hasColleagueCommunication: candidate.candidateId === 'boss-qualified' };
    };
    indexModule.forwardBossResumeRef.fn = async (
      _page,
      candidate,
      mode,
      recipient,
      _actionMode,
      _ccEmails,
      _cacheShareUrl,
      detailOptions,
      hasColleagueCommunication,
    ) => {
      assert.ok(detailOptions && detailOptions.deadline > Date.now(), 'forwarding must use the fresh post-model continuation');
      callOrder.push(`forward:${candidate.candidateId}:${mode}:${recipient}:${hasColleagueCommunication ? 'communication' : 'none'}`);
    };
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    const rejectionEmails: Array<{ recipient: string; subject: string; markdown: string; messageId?: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, markdown, messageId }) => {
      const persisted = (await store.listBossRejectionEmailOutboxEntries('boss', jobKey))
        .find((entry) => entry.candidateId === 'boss-rejected');
      assert.ok(persisted?.detailClosedAt, 'verified detail-close proof must be persisted before SMTP');
      assert.equal(persisted.status, 'sending');
      rejectionEmails.push({ recipient, subject, markdown, messageId });
      return { recipient, subject };
    };

    let result: Awaited<ReturnType<typeof indexModule.runResumeCaptureFlow>>;
    try {
      result = await indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        '物业电工',
        store,
        {
          page: { id: 'root-page' },
          context: { id: 'browser-context' },
        } as never,
        fetchedAt,
        adapter,
        {
          searchSource: 'direct',
          bossForwardMode: 'email',
          bossForwardRecipient: 'primary-forward@example.com',
          bossForwardCc: ['primary-forward-audit@example.com'],
          bossScreening: {
            ...buildModelScreeningSettings(),
          },
        },
      );
      const rerun = await indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        '物业电工',
        store,
        {
          page: { id: 'root-page' },
          context: { id: 'browser-context' },
        } as never,
        fetchedAt,
        adapter,
        {
          searchSource: 'direct',
          bossForwardMode: 'email',
          bossForwardRecipient: 'primary-forward@example.com',
          bossForwardCc: ['primary-forward-audit@example.com'],
          bossScreening: buildModelScreeningSettings(),
        },
      );
      assert.equal(rejectionEmails.length, 1);
      assert.deepEqual(rerun.runResult.bossRouting?.rejectionEmailStatusCounts, {});
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }

    assert.deepStrictEqual(callOrder, [
      'open:boss-qualified',
      'parse:boss-qualified',
      'seen:boss-qualified',
      'score:boss-qualified',
      'communication:boss-qualified',
      'forward:boss-qualified:email:primary-forward@example.com:communication',
      'forward:boss-qualified:email:primary-forward-audit@example.com:communication',
      'close:boss-qualified',
      'open:boss-review',
      'parse:boss-review',
      'seen:boss-review',
      'score:boss-review',
      'communication:boss-review',
      'forward:boss-review:email:primary-forward@example.com:none',
      'forward:boss-review:email:primary-forward-audit@example.com:none',
      'close:boss-review',
      'open:boss-rejected',
      'parse:boss-rejected',
      'seen:boss-rejected',
      'score:boss-rejected',
      'close:boss-rejected',
      'open:boss-score-failed',
      'parse:boss-score-failed',
      'seen:boss-score-failed',
      'score:boss-score-failed',
      'close:boss-score-failed',
      'open:boss-score-failed',
      'parse:boss-score-failed',
      'seen:boss-score-failed',
      'score:boss-score-failed',
      'close:boss-score-failed',
    ]);
    assert.equal(callOrder.includes('legacy-forward'), false);
    assert.deepStrictEqual(result.runResult.bossRouting, {
      enabled: true,
      policyHash: result.runResult.bossRouting?.policyHash,
      qualifiedCandidateIds: ['boss-qualified'],
      reviewCandidateIds: ['boss-review'],
      rejectedCandidateIds: ['boss-rejected'],
      pendingScoreCandidateIds: ['boss-score-failed'],
      scoreFailureStatusCounts: { 'turn-interrupted@turn-running': 1 },
      forwardingStatusCounts: { sent: 2 },
      rejectionEmailStatusCounts: { sent: 1 },
      rejectionEmailSmtpAttemptCount: 1,
      rejectionEmailRetryExhaustedCount: 0,
    });
    assert.equal(result.runResult.detailAttemptCount, 4);
    assert.equal(rejectionEmails.length, 1);
    assert.equal(rejectionEmails[0]?.recipient, 'secondary-report@outlook.com');
    assert.match(rejectionEmails[0]?.subject ?? '', /明确否定/);
    assert.match(rejectionEmails[0]?.markdown ?? '', /模型明确判断/);
    assert.match(rejectionEmails[0]?.markdown ?? '', /boss-rejected/);
    assert.match(rejectionEmails[0]?.messageId ?? '', /autorecruit-boss-rejection/);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), [
      'boss-qualified',
      'boss-review',
      'boss-rejected',
      'boss-score-failed',
    ]);
    const artifacts = await store.listBossCandidateRoutingArtifacts('boss', jobKey);
    assert.deepStrictEqual(artifacts.map((artifact) => [artifact.candidateId, artifact.classification, artifact.audience]), [
      ['boss-qualified', 'qualified', 'primary'],
      ['boss-review', 'review', 'primary'],
      ['boss-rejected', 'rejected', 'secondary'],
    ]);
    assert.equal(await store.readBossForwardingOutboxEntry('boss', jobKey, 'boss-score-failed'), undefined);
    assert.equal((await store.listBossRejectionEmailOutboxEntries('boss', jobKey))
      .some((entry) => entry.candidateId === 'boss-score-failed'), false);
    const pendingItems = await store.listBossScreeningWorkItems('boss', jobKey);
    assert.deepStrictEqual(pendingItems.map((item) => ({
      candidateId: item.candidateId,
      scoreAttemptCount: item.scoreAttemptCount,
      lastError: item.lastScoreFailure?.error,
      diagnostic: item.lastScoreFailure?.diagnostic,
    })), [{
      candidateId: 'boss-score-failed',
      scoreAttemptCount: 2,
      lastError: 'boss-screening Codex-session request failed: Codex App Server exited while the turn was running',
      diagnostic: interruptedDiagnostic,
    }]);
    assert.deepStrictEqual(result.runResult.failedCandidates, [{
      candidateId: 'boss-score-failed',
      error: 'boss-screening Codex-session request failed: Codex App Server exited while the turn was running',
      diagnostic: interruptedDiagnostic,
    }]);
  });

  it('fails rejection-email preflight before SMTP and never retries an uncertain send', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-rejection-email-recovery';
    const routingArtifact: BossCandidateRoutingArtifact = {
      routingDecisionId: 'rejection-recovery-decision',
      candidateId: 'rejection-recovery-candidate',
      fetchedAt: '2026-08-01T01:00:00.000Z',
      decidedAt: '2026-08-01T01:01:00.000Z',
      policyHash: 'rejection-recovery-policy',
      scoreStatus: 'success',
      classification: 'rejected',
      audience: 'secondary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '明确否定。',
      deliveryKind: 'rejection-email',
    };
    const baseEntry: BossRejectionEmailOutboxEntry = {
      version: 1,
      deliveryId: 'rejection-recovery-delivery',
      candidateId: routingArtifact.candidateId,
      routingDecisionId: routingArtifact.routingDecisionId!,
      routingArtifact,
      policyHash: routingArtifact.policyHash,
      recipientEmail: 'secondary@outlook.com',
      ccEmails: [],
      messageId: '<rejection-recovery-delivery@autorecruit.local>',
      subject: '明确否定',
      markdown: '完整简历',
      contentHash: 'content-hash',
      status: 'pending',
      createdAt: routingArtifact.decidedAt,
      updatedAt: routingArtifact.decidedAt,
    };
    let sendCalls = 0;
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    sendJobReportEmailRef.fn = async () => {
      sendCalls += 1;
      return { recipient: baseEntry.recipientEmail, subject: baseEntry.subject };
    };
    try {
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, baseEntry);
      const invalid = await indexModule.executeBossRejectionEmailDeliveryRef.fn(
        store,
        jobKey,
        { ...baseEntry, deliveryId: 'rejection-preflight-delivery', recipientEmail: 'invalid-address' },
      );
      assert.equal(invalid.status, 'superseded');
      assert.equal(sendCalls, 0);
      assert.match(invalid.error ?? '', /no SMTP call was attempted/);
      assert.doesNotMatch(invalid.error ?? '', /invalid-address/);

      const smtpConfig = { ...config.smtp };
      try {
        Object.assign(config.smtp, { host: '', user: '', pass: '', from: '' });
        sendJobReportEmailRef.fn = originalSendJobReportEmail;
        const smtpFailure = await indexModule.executeBossRejectionEmailDeliveryRef.fn(
          store,
          jobKey,
          {
            ...baseEntry,
            deliveryId: 'rejection-smtp-config-delivery',
            contentHash: createHash('sha256').update(baseEntry.markdown).digest('hex'),
          },
        );
        assert.equal(smtpFailure.status, 'retryable-failed');
        assert.match(smtpFailure.error ?? '', /SMTP configuration is incomplete/);
      } finally {
        Object.assign(config.smtp, smtpConfig);
      }
      sendJobReportEmailRef.fn = async () => {
        sendCalls += 1;
        return { recipient: baseEntry.recipientEmail, subject: baseEntry.subject };
      };

      const sending = { ...baseEntry, status: 'sending' as const, deliveryId: 'rejection-uncertain-delivery' };
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, sending);
      const recovered = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, sending);
      assert.equal(recovered.status, 'uncertain');
      const retried = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, recovered);
      assert.equal(retried.status, 'uncertain');
      assert.equal(sendCalls, 0);
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }
  });

  it('retries one transient pre-submit SMTP failure and never makes a third call', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-rejection-email-bounded-retry';
    const decidedAt = '2026-08-01T01:30:00.000Z';
    const markdown = '完整简历';
    const makeEntry = (deliveryId: string): BossRejectionEmailOutboxEntry => {
      const routingArtifact: BossCandidateRoutingArtifact = {
        routingDecisionId: `${deliveryId}-decision`,
        candidateId: `${deliveryId}-candidate`,
        fetchedAt: decidedAt,
        decidedAt,
        policyHash: 'bounded-retry-policy',
        scoreStatus: 'success',
        classification: 'rejected',
        audience: 'secondary',
        requirementEvaluations: [],
        matchedRequirementIds: [],
        unknownRequirementIds: [],
        reason: '明确否定。',
        deliveryKind: 'rejection-email',
      };
      return {
        version: 1,
        deliveryId,
        candidateId: routingArtifact.candidateId,
        routingDecisionId: routingArtifact.routingDecisionId!,
        routingArtifact,
        policyHash: routingArtifact.policyHash,
        recipientEmail: 'secondary@outlook.com',
        ccEmails: [],
        messageId: `<${deliveryId}@autorecruit.local>`,
        subject: '明确否定',
        markdown,
        contentHash: createHash('sha256').update(markdown).digest('hex'),
        status: 'pending',
        createdAt: decidedAt,
        updatedAt: decidedAt,
        detailClosedAt: decidedAt,
        attemptCount: 0,
      };
    };
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    const originalWait = indexModule.waitBossRejectionEmailRetryRef.fn;
    let sendCalls = 0;
    let waitCalls = 0;
    const attemptPayloads: Array<{ recipient: string; subject: string; messageId?: string }> = [];
    sendJobReportEmailRef.fn = async ({ recipient, subject, messageId }) => {
      sendCalls += 1;
      attemptPayloads.push({ recipient, subject, messageId });
      if (sendCalls === 1) {
        throw Object.assign(new Error('DNS resolution failed'), {
          code: 'EDNS',
          command: 'CONN',
        });
      }
      return { recipient, subject };
    };
    indexModule.waitBossRejectionEmailRetryRef.fn = async () => {
      waitCalls += 1;
    };
    try {
      const entry = makeEntry('bounded-retry-success');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, entry);
      const delivered = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, entry);
      assert.equal(sendCalls, 2);
      assert.equal(waitCalls, 1);
      assert.equal(delivered.status, 'sent');
      assert.equal(delivered.attemptCount, 2);
      assert.equal(delivered.retryExhausted, undefined);
      assert.equal(delivered.lastSmtpFailure, undefined);
      assert.equal(delivered.retryAuthorization?.failedAttempt, 1);
      assert.equal(delivered.retryAuthorization?.phase, 'connect');
      assert.deepEqual(attemptPayloads, [
        { recipient: entry.recipientEmail, subject: entry.subject, messageId: entry.messageId },
        { recipient: entry.recipientEmail, subject: entry.subject, messageId: entry.messageId },
      ]);

      sendCalls = 0;
      waitCalls = 0;
      sendJobReportEmailRef.fn = async () => {
        sendCalls += 1;
        throw Object.assign(new Error('DNS resolution failed'), {
          code: 'EDNS',
          command: 'CONN',
        });
      };
      const exhaustedEntry = makeEntry('bounded-retry-exhausted');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, exhaustedEntry);
      const exhausted = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, exhaustedEntry);
      assert.equal(sendCalls, 2);
      assert.equal(waitCalls, 1);
      assert.equal(exhausted.status, 'retryable-failed');
      assert.equal(exhausted.attemptCount, 2);
      assert.equal(exhausted.retryExhausted, true);
      const afterExhaustion = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, exhausted);
      assert.equal(afterExhaustion.status, 'retryable-failed');
      assert.equal(sendCalls, 2, 'an exhausted delivery must not make a third SMTP call');
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
      indexModule.waitBossRejectionEmailRetryRef.fn = originalWait;
    }
  });

  it('allows only one concurrent executor to call SMTP for the same rejection delivery', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const competingStore = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-rejection-email-concurrent-lock';
    const decidedAt = '2026-08-01T01:40:00.000Z';
    const routingArtifact: BossCandidateRoutingArtifact = {
      routingDecisionId: 'concurrent-delivery-decision',
      candidateId: 'concurrent-delivery-candidate',
      fetchedAt: decidedAt,
      decidedAt,
      policyHash: 'concurrent-delivery-policy',
      scoreStatus: 'success',
      classification: 'rejected',
      audience: 'secondary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '明确否定。',
      deliveryKind: 'rejection-email',
    };
    const entry: BossRejectionEmailOutboxEntry = {
      version: 1,
      deliveryId: 'concurrent-delivery',
      candidateId: routingArtifact.candidateId,
      routingDecisionId: routingArtifact.routingDecisionId!,
      routingArtifact,
      policyHash: routingArtifact.policyHash,
      recipientEmail: 'secondary@outlook.com',
      ccEmails: [],
      messageId: '<concurrent-delivery@autorecruit.local>',
      subject: '明确否定',
      markdown: '完整简历',
      contentHash: createHash('sha256').update('完整简历').digest('hex'),
      status: 'pending',
      createdAt: decidedAt,
      updatedAt: decidedAt,
      detailClosedAt: decidedAt,
      attemptCount: 0,
    };
    await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, entry);
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    let sendCalls = 0;
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sendCalls += 1;
      markSendStarted();
      await sendGate;
      return { recipient, subject };
    };
    try {
      const firstExecution = indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, entry);
      await sendStarted;
      await assert.rejects(
        indexModule.executeBossRejectionEmailDeliveryRef.fn(competingStore, jobKey, entry),
        /already being delivered by another live process/,
      );
      assert.equal(sendCalls, 1);
      releaseSend();
      const delivered = await firstExecution;
      assert.equal(delivered.status, 'sent');
      assert.equal(sendCalls, 1);
      const idempotent = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, delivered);
      assert.equal(idempotent.status, 'sent');
      assert.equal(sendCalls, 1);
    } finally {
      releaseSend();
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }
  });

  it('defers AUTH failures, while ambiguous CONN, unknown, and DATA failures remain uncertain', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-rejection-email-failure-phases';
    const decidedAt = '2026-08-01T01:45:00.000Z';
    const makeEntry = (deliveryId: string): BossRejectionEmailOutboxEntry => {
      const routingArtifact: BossCandidateRoutingArtifact = {
        routingDecisionId: `${deliveryId}-decision`,
        candidateId: `${deliveryId}-candidate`,
        fetchedAt: decidedAt,
        decidedAt,
        policyHash: 'failure-phase-policy',
        scoreStatus: 'success',
        classification: 'rejected',
        audience: 'secondary',
        requirementEvaluations: [],
        matchedRequirementIds: [],
        unknownRequirementIds: [],
        reason: '明确否定。',
        deliveryKind: 'rejection-email',
      };
      return {
        version: 1,
        deliveryId,
        candidateId: routingArtifact.candidateId,
        routingDecisionId: routingArtifact.routingDecisionId!,
        routingArtifact,
        policyHash: routingArtifact.policyHash,
        recipientEmail: 'secondary@outlook.com',
        ccEmails: [],
        messageId: `<${deliveryId}@autorecruit.local>`,
        subject: '明确否定',
        markdown: '完整简历',
        contentHash: createHash('sha256').update('完整简历').digest('hex'),
        status: 'pending',
        createdAt: decidedAt,
        updatedAt: decidedAt,
        detailClosedAt: decidedAt,
        attemptCount: 0,
      };
    };
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    const originalWait = indexModule.waitBossRejectionEmailRetryRef.fn;
    let sendCalls = 0;
    let waitCalls = 0;
    try {
      sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw Object.assign(new Error('authentication failed'), { code: 'EAUTH', command: 'AUTH' });
        }
        return { recipient, subject };
      };
      indexModule.waitBossRejectionEmailRetryRef.fn = async () => {
        waitCalls += 1;
      };
      const deferredEntry = makeEntry('deferred-auth');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, deferredEntry);
      const deferred = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, deferredEntry);
      assert.equal(sendCalls, 1);
      assert.equal(waitCalls, 0);
      assert.equal(deferred.status, 'retryable-failed');
      assert.equal(deferred.attemptCount, 1);
      assert.equal(deferred.retryAuthorization?.retryDisposition, 'deferred-once');
      const authRecovered = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, deferred);
      assert.equal(authRecovered.status, 'sent');
      assert.equal(sendCalls, 2);
      assert.equal(authRecovered.attemptCount, 2);

      sendCalls = 0;
      sendJobReportEmailRef.fn = async () => {
        sendCalls += 1;
        throw Object.assign(new Error('connection closed during DATA'), {
          code: 'ECONNRESET',
          command: 'DATA',
        });
      };
      const dataEntry = makeEntry('data-uncertain');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, dataEntry);
      const uncertain = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, dataEntry);
      assert.equal(uncertain.status, 'uncertain');
      assert.equal(uncertain.attemptCount, 1);
      assert.equal(sendCalls, 1);
      const uncertainAgain = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, uncertain);
      assert.equal(uncertainAgain.status, 'uncertain');
      assert.equal(sendCalls, 1);

      sendCalls = 0;
      sendJobReportEmailRef.fn = async () => {
        sendCalls += 1;
        throw Object.assign(new Error('Greeting never received'), {
          code: 'ETIMEDOUT',
          command: 'CONN',
        });
      };
      const timeoutEntry = makeEntry('conn-timeout-uncertain');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, timeoutEntry);
      const timeout = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, timeoutEntry);
      assert.equal(timeout.status, 'uncertain');
      assert.equal(timeout.lastSmtpFailure?.phase, 'unknown');
      assert.equal(sendCalls, 1);

      sendCalls = 0;
      sendJobReportEmailRef.fn = async () => {
        sendCalls += 1;
        throw new Error('Greeting never received');
      };
      const unknownEntry = makeEntry('unknown-uncertain');
      await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, unknownEntry);
      const unknown = await indexModule.executeBossRejectionEmailDeliveryRef.fn(store, jobKey, unknownEntry);
      assert.equal(unknown.status, 'uncertain');
      assert.equal(unknown.lastSmtpFailure?.phase, 'unknown');
      assert.equal(sendCalls, 1);
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
      indexModule.waitBossRejectionEmailRetryRef.fn = originalWait;
    }
  });

  it('requires formal policy migration for an old in-flight rejection email before browser work', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-old-policy-email';
    const candidateId = 'boss-old-policy-email';
    const decidedAt = '2026-08-01T02:30:00.000Z';
    const routingArtifact: BossCandidateRoutingArtifact = {
      routingDecisionId: 'old-policy-email-decision',
      candidateId,
      fetchedAt: decidedAt,
      decidedAt,
      policyHash: 'old-policy-hash',
      scoreStatus: 'success',
      classification: 'rejected',
      audience: 'secondary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '明确否定。',
      deliveryKind: 'rejection-email',
    };
    await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, {
      version: 1,
      deliveryId: 'old-policy-email-delivery',
      candidateId,
      routingDecisionId: routingArtifact.routingDecisionId!,
      routingArtifact,
      policyHash: routingArtifact.policyHash,
      recipientEmail: 'secondary-report@outlook.com',
      ccEmails: [],
      messageId: '<old-policy-email-delivery@autorecruit.local>',
      subject: '明确否定',
      markdown: '完整简历',
      contentHash: createHash('sha256').update('完整简历').digest('hex'),
      status: 'sending',
      createdAt: decidedAt,
      updatedAt: decidedAt,
      attemptedAt: decidedAt,
      detailClosedAt: decidedAt,
    });
    let searchCalls = 0;
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => {
        searchCalls += 1;
        return createSearchPage();
      },
      openSubscribeSearch: async () => createSearchPage(),
    } satisfies import('../platforms/types.js').PlatformAdapter;

    await assert.rejects(
      indexModule.runResumeCaptureFlow(
        'boss', jobKey, buildNormalizedJob(), '物业电工', store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        decidedAt, adapter, {
          searchSource: 'direct',
          bossForwardMode: 'email',
          bossForwardRecipient: 'primary-forward@example.com',
          bossScreening: buildModelScreeningSettings(),
        },
      ),
      /migrate:boss-model-screening before opening the browser/,
    );
    assert.equal(searchCalls, 0);
    assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, 'old-policy-email-delivery'))?.status, 'sending');
  });

  it('does not send a rejection email when persisting the closed-detail delivery outbox fails', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-close-proof-failure';
    const candidateId = 'boss-close-proof-failure';
    const originalSave = store.saveBossRejectionEmailOutboxEntry.bind(store);
    store.saveBossRejectionEmailOutboxEntry = async (platform, key, entry) => {
      if (entry.detailClosedAt) throw new Error('simulated detail-close proof persistence failure');
      return originalSave(platform, key, entry);
    };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [{ candidateId }] }),
      openResumeDetail: async () => createDetailPage(),
      parseResumeDetail: async () => buildResume(candidateId),
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => ({
      score: buildScore(),
      evaluations: [buildModelRequirementEvaluation('missing', candidateId)],
    });
    let sendCalls = 0;
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sendCalls += 1;
      return { recipient, subject };
    };

    try {
      const result = await indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        '物业电工',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T03:00:00.000Z',
        adapter,
        {
          searchSource: 'direct',
          bossForwardMode: 'email',
          bossForwardRecipient: 'primary-forward@example.com',
          bossScreening: buildModelScreeningSettings(),
        },
      );
      assert.equal(sendCalls, 0);
      const entries = await store.listBossRejectionEmailOutboxEntries('boss', jobKey);
      assert.equal(entries.length, 0);
      assert.deepStrictEqual(result.runResult.processingFailures, [{
        candidateId,
        stage: 'routing',
        error: 'simulated detail-close proof persistence failure',
      }]);
      assert.equal((await store.listBossScreeningWorkItems('boss', jobKey)).length, 1);
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }
  });

  it('recovers a rejected email after its embedded routing artifact write was interrupted', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-rejection-artifact-recovery';
    const candidate = { candidateId: 'boss-rejection-artifact-recovery' };
    let visibleCandidates = [candidate];
    let scoreCalls = 0;
    let sendCalls = 0;
    let failArtifactWrite = true;
    const originalSaveArtifact = store.saveBossCandidateRoutingArtifact.bind(store);
    store.saveBossCandidateRoutingArtifact = async (...args) => {
      if (failArtifactWrite) throw new Error('simulated rejection routing artifact interruption');
      return originalSaveArtifact(...args);
    };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: visibleCandidates }),
      openResumeDetail: async () => createDetailPage(),
      parseResumeDetail: async () => buildResume(candidate.candidateId),
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      scoreCalls += 1;
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('missing', candidate.candidateId)],
      };
    };
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => {
      sendCalls += 1;
      return { recipient, subject };
    };
    const options = {
      searchSource: 'direct' as const,
      bossForwardMode: 'email' as const,
      bossForwardRecipient: 'primary-forward@example.com',
      bossScreening: buildModelScreeningSettings(),
    };

    try {
      const first = await indexModule.runResumeCaptureFlow(
        'boss', jobKey, buildNormalizedJob(), '物业电工', store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T03:10:00.000Z', adapter, options,
      );
      assert.equal(scoreCalls, 1);
      assert.equal(sendCalls, 0);
      assert.match(first.runResult.failedCandidates.at(-1)?.error ?? '', /routing artifact interruption/);
      assert.deepStrictEqual(first.runResult.processingFailures, [{
        candidateId: candidate.candidateId,
        stage: 'routing',
        error: 'simulated rejection routing artifact interruption',
      }]);
      const pending = (await store.listBossRejectionEmailOutboxEntries('boss', jobKey))[0];
      assert.equal(pending?.status, 'pending');
      assert.ok(pending?.detailClosedAt, 'the close proof must survive a later routing-artifact failure');
      assert.equal((await store.listBossCandidateRoutingArtifacts('boss', jobKey)).length, 0);

      failArtifactWrite = false;
      visibleCandidates = [];
      const recovered = await indexModule.runResumeCaptureFlow(
        'boss', jobKey, buildNormalizedJob(), '物业电工', store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T03:11:00.000Z', adapter, options,
      );
      assert.equal(scoreCalls, 1);
      assert.equal(sendCalls, 1);
      assert.deepStrictEqual(recovered.runResult.bossRouting?.rejectedCandidateIds, [candidate.candidateId]);
      assert.deepStrictEqual(recovered.runResult.bossRouting?.rejectionEmailStatusCounts, { sent: 1 });
      assert.equal((await store.listBossCandidateRoutingArtifacts('boss', jobKey)).length, 1);
      assert.equal((await store.listBossRejectionEmailOutboxEntries('boss', jobKey))[0]?.status, 'sent');
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }
  });

  it('reports recovered rejection email outcomes even when the candidate is absent and already indexed', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-recovered-email-audit';
    const candidateId = 'boss-recovered-email-off-page';
    const screening = buildModelScreeningSettings();
    const policyHash = hashBossScreeningPolicy(screening);
    const decidedAt = '2026-08-01T04:00:00.000Z';
    const routingDecisionId = 'recovered-email-routing-decision';
    const routingArtifact: BossCandidateRoutingArtifact = {
      routingDecisionId,
      candidateId,
      fetchedAt: decidedAt,
      decidedAt,
      policyHash,
      scoreStatus: 'success',
      classification: 'rejected',
      audience: 'secondary',
      requirementEvaluations: [],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '明确否定。',
      deliveryKind: 'rejection-email',
    };
    const markdown = '完整结构化简历';
    const outbox: BossRejectionEmailOutboxEntry = {
      version: 1,
      deliveryId: 'recovered-email-delivery',
      candidateId,
      routingDecisionId,
      routingArtifact,
      policyHash,
      recipientEmail: 'secondary-report@outlook.com',
      ccEmails: [],
      messageId: '<recovered-email-delivery@autorecruit.local>',
      subject: '明确否定',
      markdown,
      contentHash: createHash('sha256').update(markdown).digest('hex'),
      status: 'retryable-failed',
      createdAt: decidedAt,
      updatedAt: decidedAt,
      detailClosedAt: decidedAt,
      error: 'previous pre-SMTP failure',
    };
    await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, outbox);
    await store.saveRunResult('boss', jobKey, {
      platform: 'boss',
      jobKey,
      fetchedAt: '2026-08-01T04:01:00.000Z',
      totalCandidates: 1,
      runResultVersion: 2,
      capturedCandidateIds: [candidateId],
      captureAttemptCount: 1,
      detailAttemptCount: 1,
      captureFailures: [],
      processingFailures: [],
      scoredCandidates: [candidateId],
      failedCandidates: [],
      bossRouting: {
        enabled: true,
        policyHash,
        qualifiedCandidateIds: [],
        reviewCandidateIds: [],
        rejectedCandidateIds: [candidateId],
        forwardingStatusCounts: {},
        rejectionEmailStatusCounts: { 'retryable-failed': 1 },
      },
    });
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [] }),
    } satisfies import('../platforms/types.js').PlatformAdapter;
    let sendCalls = 0;
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    sendJobReportEmailRef.fn = async () => {
      sendCalls += 1;
      throw new Error('SMTP result unknown for private@example.com');
    };

    try {
      const result = await indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        '物业电工',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T04:02:00.000Z',
        adapter,
        {
          searchSource: 'direct',
          bossForwardMode: 'email',
          bossForwardRecipient: 'primary-forward@example.com',
          bossScreening: screening,
        },
      );
      assert.equal(sendCalls, 1);
      assert.deepStrictEqual(result.candidates, []);
      assert.deepStrictEqual(result.runResult.bossRouting?.rejectedCandidateIds, [candidateId]);
      assert.deepStrictEqual(result.runResult.bossRouting?.rejectionEmailStatusCounts, { uncertain: 1 });
      assert.ok(result.runResult.processingFailures?.some((failure) =>
        failure.candidateId === candidateId && failure.stage === 'rejection-email'));
      assert.ok(result.runResult.failedCandidates.some((failure) => failure.candidateId === candidateId));
      const persisted = await store.readBossRejectionEmailOutboxEntry('boss', jobKey, outbox.deliveryId);
      assert.equal(persisted?.status, 'uncertain');
      assert.doesNotMatch(persisted?.error ?? '', /private@example.com/);

      const emailSummary = indexModule.buildBossRoutedMainRunEmailSummary({
        primary: {
          jobKey,
          audience: 'primary',
          attempted: true,
          delivered: true,
          recipient: 'primary@example.com',
          subject: 'primary report',
          summary: { candidateCount: 0, successCount: 0, failureCount: 0 },
        },
        secondary: {
          jobKey,
          audience: 'secondary',
          attempted: false,
          delivered: false,
          skipReason: 'rejected-candidates-delivered-individually',
          summary: { candidateCount: 0, successCount: 0, failureCount: 0 },
        },
      }, result.runResult.bossRouting);
      assert.equal(emailSummary.emailDelivered, false);
      assert.match(emailSummary.emailError ?? '', /not confirmed sent/);
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }
  });

  it('routes a non-Boss candidate after detail persistence and keeps native forwarding out of the flow', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-liepin-post-score-routing';
    const candidateId = 'liepin-rejected';
    const callOrder: string[] = [];
    indexModule.openSubscribeSearchRef.fn = (async () => createSearchPage()) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.extractCandidateListRef.fn = async () => ({ candidates: [{ candidateId }] });
    indexModule.openResumeDetailRef.fn = (async () => {
      callOrder.push('open');
      return createDetailPage();
    }) as typeof indexModule.openResumeDetailRef.fn;
    indexModule.extractResumeFromPageRef.fn = async () => {
      callOrder.push('parse');
      return { resume: { ...buildResume(candidateId), pr: [candidateId] }, domSnapshot: { workLines: [] } };
    };
    indexModule.scoreAndEvaluatePostScoreRoutingRef.fn = async ({ resume }) => {
      callOrder.push('score');
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('missing', resume.candidateId)],
      };
    };
    const result = await indexModule.runResumeCaptureFlow(
      '51job',
      jobKey,
      buildNormalizedJob(),
      'search keyword',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-02T12:34:56.000Z',
      indexModule.resolvePlatformAdapter('51job'),
      {
        postScoreRouting: {
          enabled: true,
          policyVersion: 2,
          decisionMode: 'reject-on-any-missing',
          requirements: [{
            id: 'must-have-model-requirement',
            enabled: true,
            kind: 'modelRequirement',
            requirement: '候选人明确满足测试岗位要求。',
            criteria: ['简历存在明确证据。'],
            insufficientEvidence: ['缺少明确证据。'],
          }],
          secondaryDelivery: { recipientEmail: 'secondary-report@example.com' },
        },
        reportDelivery: { recipientEmail: 'primary-report@example.com' },
      },
    );

    assert.deepStrictEqual(callOrder, ['open', 'parse', 'score']);
    assert.deepStrictEqual(await store.readSeenIds('51job', jobKey), [candidateId]);
    const artifacts = await store.listCandidateRoutingArtifacts('51job', jobKey);
    assert.deepStrictEqual(artifacts.map((artifact) => [artifact.candidateId, artifact.classification, artifact.audience]), [[candidateId, 'rejected', 'secondary']]);
    assert.deepStrictEqual(result.runResult.postScoreRouting?.rejectedCandidateIds, [candidateId]);
    assert.deepStrictEqual(await store.listPostScoreRoutingWorkItems('51job', jobKey), []);
  });

  it('keeps a non-Boss score failure pending without a routing decision and recovers from the stored resume', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-generic-pending-score';
    const candidateId = 'generic-pending-score';
    let visible = true;
    let failScore = true;
    indexModule.openSubscribeSearchRef.fn = (async () => createSearchPage()) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.extractCandidateListRef.fn = async () => ({ candidates: visible ? [{ candidateId }] : [] });
    indexModule.openResumeDetailRef.fn = (async () => createDetailPage()) as typeof indexModule.openResumeDetailRef.fn;
    indexModule.extractResumeFromPageRef.fn = async () => ({
      resume: buildResume(candidateId),
      domSnapshot: { workLines: [] },
    });
    indexModule.scoreAndEvaluatePostScoreRoutingRef.fn = async () => {
      if (failScore) throw new Error('temporary scoring transport failure');
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('satisfied', candidateId)],
      };
    };
    const routing = {
      enabled: true as const,
      policyVersion: 2 as const,
      decisionMode: 'reject-on-any-missing' as const,
      requirements: [{
        id: 'must-have-model-requirement',
        enabled: true,
        kind: 'modelRequirement' as const,
        requirement: '候选人明确满足测试岗位要求。',
        criteria: ['简历存在明确证据。'],
        insufficientEvidence: ['缺少明确证据。'],
      }],
      secondaryDelivery: { recipientEmail: 'secondary-report@example.com' },
    };
    const first = await indexModule.runResumeCaptureFlow(
      '51job', jobKey, buildNormalizedJob(), 'search keyword', store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-02T12:40:00.000Z', indexModule.resolvePlatformAdapter('51job'),
      { postScoreRouting: routing, reportDelivery: { recipientEmail: 'primary-report@example.com' } },
    );
    assert.deepStrictEqual(first.runResult.postScoreRouting?.qualifiedCandidateIds, []);
    assert.deepStrictEqual(first.runResult.postScoreRouting?.reviewCandidateIds, []);
    assert.deepStrictEqual(first.runResult.postScoreRouting?.rejectedCandidateIds, []);
    assert.deepStrictEqual(first.runResult.postScoreRouting?.pendingScoreCandidateIds, [candidateId]);
    assert.deepStrictEqual(first.runResult.postScoreRouting?.scoreFailureStatusCounts, {
      'score-error@evaluation': 1,
    });
    assert.deepStrictEqual(await store.listCandidateRoutingArtifacts('51job', jobKey), []);
    assert.deepStrictEqual((await store.listPostScoreRoutingWorkItems('51job', jobKey)).map((item) => ({
      candidateId: item.candidateId,
      scoreAttemptCount: item.scoreAttemptCount,
      error: item.lastScoreFailure?.error,
    })), [{ candidateId, scoreAttemptCount: 1, error: 'temporary scoring transport failure' }]);

    visible = false;
    failScore = false;
    const second = await indexModule.runResumeCaptureFlow(
      '51job', jobKey, buildNormalizedJob(), 'search keyword', store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-02T12:41:00.000Z', indexModule.resolvePlatformAdapter('51job'),
      { postScoreRouting: routing, reportDelivery: { recipientEmail: 'primary-report@example.com' } },
    );
    assert.deepStrictEqual(second.runResult.postScoreRouting?.qualifiedCandidateIds, [candidateId]);
    assert.equal(second.runResult.postScoreRouting?.pendingScoreCandidateIds, undefined);
    assert.equal((await store.listCandidateRoutingArtifacts('51job', jobKey)).length, 1);
    assert.deepStrictEqual(await store.listPostScoreRoutingWorkItems('51job', jobKey), []);
  });

  it('recovers an orphaned non-Boss routing artifact without requiring the candidate to reappear', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-routing-recovery';
    const candidateId = '51job-orphaned-route';
    const policy = {
      enabled: true as const,
      policyVersion: 2 as const,
      decisionMode: 'reject-on-any-missing' as const,
      requirements: [{
        id: 'must-have-model-requirement', enabled: true, kind: 'modelRequirement' as const,
        requirement: '候选人明确满足测试岗位要求。', criteria: ['简历存在明确证据。'], insufficientEvidence: ['缺少明确证据。'],
      }],
      secondaryDelivery: { recipientEmail: 'secondary-report@example.com' },
    };
    const fetchedAt = '2026-08-02T13:34:56.000Z';
    const scoreArtifact = {
      candidateId,
      model: 'test-model',
      scoredAt: '2026-08-02T13:35:00.000Z',
      status: 'success' as const,
      score: buildScore(),
    };
    await store.saveCandidateResume('51job', jobKey, buildResume(candidateId), 'orphaned resume');
    await store.markCapturedCandidatesSeen('51job', jobKey, [candidateId]);
    await store.saveCandidateScoreArtifact('51job', jobKey, scoreArtifact);
    const policyHash = hashBossScreeningPolicy(policy);
    await store.saveCandidateRoutingArtifact('51job', jobKey, {
      routingDecisionId: 'orphaned-routing-decision', candidateId, fetchedAt, scoredAt: scoreArtifact.scoredAt,
      decidedAt: '2026-08-02T13:35:01.000Z', policyHash, scoreStatus: 'success', classification: 'rejected', audience: 'secondary',
      requirementEvaluations: [buildModelRequirementEvaluation('missing', candidateId)], matchedRequirementIds: ['must-have-model-requirement'],
      unknownRequirementIds: [], reason: '明确否定',
    });
    await store.savePostScoreRoutingWorkItem('51job', jobKey, {
      candidateId, policyHash, createdAt: fetchedAt, updatedAt: fetchedAt,
    });
    indexModule.openSubscribeSearchRef.fn = (async () => createSearchPage()) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.extractCandidateListRef.fn = async () => ({ candidates: [] });
    indexModule.scoreAndEvaluatePostScoreRoutingRef.fn = async () => {
      throw new Error('orphaned candidate must not be rescored');
    };
    const result = await indexModule.runResumeCaptureFlow(
      '51job', jobKey, buildNormalizedJob(), 'search keyword', store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      fetchedAt, indexModule.resolvePlatformAdapter('51job'), { postScoreRouting: policy },
    );
    assert.deepStrictEqual(result.runResult.postScoreRouting?.rejectedCandidateIds, [candidateId]);
    assert.deepStrictEqual(await store.listPostScoreRoutingWorkItems('51job', jobKey), []);
  });

  it('persists disabled-screening Boss deliveries per address and resumes only the failed copy before capture', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-pre-capture-per-delivery';
    const candidate = { candidateId: 'boss-pre-capture-per-delivery' };
    const detailPage = createDetailPage();
    const forwardRecipients: string[] = [];
    let failCopy = true;
    let parseCalls = 0;
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => {
        parseCalls += 1;
        return buildResume(candidate.candidateId);
      },
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();
    indexModule.forwardBossResumeRef.fn = async (_page, _candidate, _mode, recipient) => {
      forwardRecipients.push(recipient);
      if (recipient === 'copy@example.com' && failCopy) {
        throw new Error('copy delivery unavailable before confirmation');
      }
    };

    const first = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      'disabled screening',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T13:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossForwardCc: ['copy@example.com'],
      },
    );
    assert.deepStrictEqual(forwardRecipients, ['primary@example.com', 'copy@example.com']);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), []);
    assert.equal(first.capturedCandidateIds.length, 0);
    const firstOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.equal(firstOutbox?.workflow, 'pre-capture');
    assert.deepStrictEqual(firstOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['copy@example.com', 'retryable-failed'],
    ]);

    failCopy = false;
    const second = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      'disabled screening',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T14:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'changed-primary@example.com',
        bossForwardCc: ['changed-copy@example.com'],
      },
    );
    assert.deepStrictEqual(forwardRecipients, [
      'primary@example.com',
      'copy@example.com',
      'copy@example.com',
    ]);
    assert.equal(parseCalls, 1);
    assert.deepStrictEqual(second.capturedCandidateIds, [candidate.candidateId]);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), [candidate.candidateId]);
    const secondOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(secondOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['copy@example.com', 'sent'],
    ]);
  });

  it('stops Boss capture immediately when detail close cannot be verified', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-close-fatal';
    const opened: string[] = [];
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [
        { candidateId: 'boss-close-first' },
        { candidateId: 'boss-close-second' },
      ] }),
      openResumeDetail: async (_context, _page, candidate) => {
        opened.push(candidate.candidateId);
        return createDetailPage();
      },
      parseResumeDetail: async (_page, candidate) => buildResume(candidate.candidateId),
      closeResumeDetail: async () => {
        throw new Error('detail modal remained visible');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        'close safety',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T15:00:00.000Z',
        adapter,
        { searchSource: 'direct' },
      ),
      /detail modal remained visible/,
    );
    assert.deepStrictEqual(opened, ['boss-close-first']);
  });

  it('stops Boss capture after an unexpected contact purchase dialog without recording the candidate', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-contact-dialog-fatal';
    const opened: string[] = [];
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [
        { candidateId: 'boss-contact-first' },
        { candidateId: 'boss-contact-second' },
      ] }),
      openResumeDetail: async (_context, _page, candidate) => {
        opened.push(candidate.candidateId);
        throw new BossUnexpectedContactDialogError(
          'Boss opened a search-chat-card purchase dialog after the detail click; no forwarding confirmation was attempted and no contact action was attempted.',
        );
      },
      parseResumeDetail: async () => {
        throw new Error('unexpected contact dialog must stop before parsing');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      throw new Error('unexpected contact dialog must stop before scoring');
    };

    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'boss',
        jobKey,
        buildNormalizedJob(),
        'contact safety',
        store,
        { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
        '2026-08-01T15:30:00.000Z',
        adapter,
        { searchSource: 'direct' },
      ),
      /purchase dialog.*no forwarding confirmation was attempted/i,
    );
    assert.deepStrictEqual(opened, ['boss-contact-first']);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), []);
    assert.deepStrictEqual(await store.listStoredResumes('boss', jobKey), []);
    assert.deepStrictEqual(await store.listBossCandidateRoutingArtifacts('boss', jobKey), []);
    assert.equal(await store.readBossForwardingOutboxEntry('boss', jobKey, 'boss-contact-first'), undefined);
  });

  it('rebuilds a missing Boss routing artifact from the outbox without rescoring', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-outbox-first-recovery';
    const candidate = { candidateId: 'boss-outbox-first-recovery' };
    const detailPage = createDetailPage();
    const forwardRecipients: string[] = [];
    let scoreCalls = 0;
    let failArtifactWrite = true;
    const originalSaveArtifact = store.saveBossCandidateRoutingArtifact.bind(store);
    store.saveBossCandidateRoutingArtifact = async (...args) => {
      if (failArtifactWrite) throw new Error('simulated routing artifact interruption');
      return originalSaveArtifact(...args);
    };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => buildResume(candidate.candidateId),
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const screeningSettings = buildModelScreeningSettings();
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      scoreCalls += 1;
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('satisfied', '明确证据')],
      };
    };
    indexModule.forwardBossResumeRef.fn = async (_page, _candidate, _mode, recipient) => {
      forwardRecipients.push(recipient);
    };

    const first = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      'outbox-first',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T16:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossScreening: screeningSettings,
      },
    );
    assert.equal(scoreCalls, 1);
    assert.deepStrictEqual(forwardRecipients, []);
    assert.match(first.runResult.failedCandidates.at(-1)?.error ?? '', /routing artifact interruption/);
    const pending = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.equal(pending?.routingDecisionId !== undefined, true);
    assert.equal(pending?.routingFacts?.candidateId, candidate.candidateId);
    assert.equal((await store.listBossCandidateRoutingArtifacts('boss', jobKey)).length, 0);

    failArtifactWrite = false;
    const second = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      'outbox-first',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T16:01:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'changed-primary@example.com',
        bossScreening: screeningSettings,
      },
    );
    assert.equal(scoreCalls, 1);
    assert.deepStrictEqual(forwardRecipients, ['primary@example.com']);
    assert.deepStrictEqual(second.runResult.bossRouting?.qualifiedCandidateIds, [candidate.candidateId]);
    assert.equal((await store.listBossCandidateRoutingArtifacts('boss', jobKey)).length, 1);
  });

  it('retries a known pre-confirmation Boss forwarding failure from outbox without rescoring a seen candidate', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-forward-retry';
    const candidate = { candidateId: 'boss-forward-retry' };
    const detailPage = createDetailPage();
    let scoreCalls = 0;
    const forwardRecipients: string[] = [];
    const forwardCommunicationFlags: Array<boolean | undefined> = [];
    let communicationReads = 0;
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => buildResume(candidate.candidateId),
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const screeningSettings = buildModelScreeningSettings();
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      scoreCalls += 1;
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('satisfied', '明确证据')],
      };
    };
    indexModule.readBossColleagueCommunicationFlagRef.fn = async () => {
      communicationReads += 1;
      return { hasColleagueCommunication: true };
    };
    indexModule.forwardBossResumeRef.fn = async (
      _page,
      _candidate,
      _mode,
      recipient,
      _actionMode,
      _ccEmails,
      _cacheShareUrl,
      _detailOptions,
      hasColleagueCommunication,
    ) => {
      forwardRecipients.push(recipient);
      forwardCommunicationFlags.push(hasColleagueCommunication);
      if (recipient === 'primary-copy@example.com'
        && forwardRecipients.filter((value) => value === recipient).length === 1) {
        throw new BossForwardPreConfirmationError('copy forward dialog was unavailable before confirmation');
      }
    };

    const first = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T01:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossForwardCc: ['primary-copy@example.com'],
        bossScreening: screeningSettings,
      },
    );
    assert.equal(communicationReads, 1);
    assert.deepStrictEqual(forwardCommunicationFlags, [true, true]);
    assert.equal(first.runResult.bossRouting?.forwardingStatusCounts['retryable-failed'], 1);
    assert.match(first.runResult.failedCandidates.at(-1)?.error ?? '', /Boss forwarding retryable-failed/);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), [candidate.candidateId]);
    const partiallyCompletedOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(partiallyCompletedOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['primary-copy@example.com', 'retryable-failed'],
    ]);

    const second = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T02:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'changed-primary@example.com',
        bossForwardCc: ['changed-copy@example.com'],
        bossScreening: screeningSettings,
      },
    );

    assert.equal(scoreCalls, 1);
    assert.equal(communicationReads, 2);
    assert.deepStrictEqual(forwardRecipients, [
      'primary@example.com',
      'primary-copy@example.com',
      'primary-copy@example.com',
    ]);
    assert.deepStrictEqual(forwardCommunicationFlags, [true, true, true]);
    assert.deepStrictEqual(second.newCandidates, []);
    assert.deepStrictEqual(second.runResult.bossRouting?.qualifiedCandidateIds, []);
    assert.equal(second.runResult.bossRouting?.forwardingStatusCounts.sent, 1);
    assert.deepStrictEqual(second.runResult.bossSeenViewSync?.coveredByProcessingCandidateIds, [candidate.candidateId]);
    assert.deepStrictEqual(second.runResult.bossSeenViewSync?.attemptedCandidateIds, []);
    assert.deepStrictEqual(second.runResult.failedCandidates, []);
    const completedOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.equal(completedOutbox?.forwarding.status, 'sent');
    assert.equal(completedOutbox?.forwarding.recipient, 'primary@example.com');
    assert.deepStrictEqual(completedOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['primary-copy@example.com', 'sent'],
    ]);
    assert.equal(completedOutbox?.policyHash, first.runResult.bossRouting?.policyHash);

    await store.saveSeenIds('boss', jobKey, []);
    const third = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T03:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'another-target@example.com',
        bossForwardCc: ['another-copy@example.com'],
        bossScreening: screeningSettings,
      },
    );
    assert.deepStrictEqual(third.newCandidates, []);
    assert.equal(scoreCalls, 1);
    assert.equal(communicationReads, 2);
    assert.equal(forwardRecipients.length, 3);
  });

  it('continues pending copy deliveries without repeating sent or uncertain Boss targets', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-forward-uncertain-copy';
    const candidate = { candidateId: 'boss-forward-uncertain-copy' };
    const detailPage = createDetailPage();
    const forwardRecipients: string[] = [];
    let scoreCalls = 0;
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => buildResume(candidate.candidateId),
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const screeningSettings = buildModelScreeningSettings();
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      scoreCalls += 1;
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('satisfied', '明确证据')],
      };
    };
    indexModule.forwardBossResumeRef.fn = async (_page, _candidate, _mode, recipient) => {
      forwardRecipients.push(recipient);
      if (recipient === 'uncertain-copy@example.com') {
        throw new BossForwardUncertainError('confirmation result was not observable');
      }
    };

    const first = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T04:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossForwardCc: ['uncertain-copy@example.com', 'pending-copy@example.com'],
        bossScreening: screeningSettings,
      },
    );
    assert.equal(first.runResult.bossRouting?.forwardingStatusCounts.uncertain, 1);
    assert.deepStrictEqual(forwardRecipients, ['primary@example.com', 'uncertain-copy@example.com']);
    const firstOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(firstOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['uncertain-copy@example.com', 'uncertain'],
      ['pending-copy@example.com', 'pending'],
    ]);

    const second = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T05:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'changed@example.com',
        bossForwardCc: ['changed-copy@example.com'],
        bossScreening: screeningSettings,
      },
    );
    assert.equal(scoreCalls, 1);
    assert.deepStrictEqual(forwardRecipients, [
      'primary@example.com',
      'uncertain-copy@example.com',
      'pending-copy@example.com',
    ]);
    assert.equal(second.runResult.bossRouting?.forwardingStatusCounts.uncertain, 1);
    assert.equal(second.runResult.failedCandidates.filter((failure) => failure.candidateId === candidate.candidateId).length, 1);
    const completedOutbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(completedOutbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['primary@example.com', 'sent'],
      ['uncertain-copy@example.com', 'uncertain'],
      ['pending-copy@example.com', 'sent'],
    ]);
  });

  it('migrates a legacy pre-confirmation Boss outbox and delivers each stored target once', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-forward-legacy-retry';
    const candidate = { candidateId: 'boss-forward-legacy-retry' };
    const timestamp = '2026-08-01T06:00:00.000Z';
    const screeningSettings = buildModelScreeningSettings();
    const policyHash = hashBossScreeningPolicy(screeningSettings);
    const scoreArtifact = {
      candidateId: candidate.candidateId,
      model: 'test-model',
      scoredAt: timestamp,
      status: 'success' as const,
      score: buildScore(),
    };
    await store.saveCandidateScoreArtifact('boss', jobKey, scoreArtifact);
    await store.saveBossCandidateRoutingArtifact('boss', jobKey, {
      candidateId: candidate.candidateId,
      fetchedAt: '2026-08-01T05:59:00.000Z',
      scoredAt: timestamp,
      decidedAt: timestamp,
      policyHash,
      scoreStatus: 'success',
      classification: 'qualified',
      audience: 'primary',
      requirementEvaluations: [buildModelRequirementEvaluation('satisfied', '明确证据')],
      matchedRequirementIds: [],
      unknownRequirementIds: [],
      reason: '所有模型要求均满足',
      forwarding: {
        status: 'retryable-failed',
        mode: 'email',
        recipient: 'stored-primary@example.com',
        ccEmails: ['stored-copy@example.com'],
        error: 'legacy dialog had no native CC field before confirmation',
      },
    });
    await store.saveBossForwardingOutboxEntry('boss', jobKey, {
      candidateId: candidate.candidateId,
      policyHash,
      classification: 'qualified',
      audience: 'primary',
      createdAt: timestamp,
      updatedAt: timestamp,
      forwarding: {
        status: 'retryable-failed',
        mode: 'email',
        recipient: 'stored-primary@example.com',
        ccEmails: ['stored-copy@example.com'],
        attemptedAt: timestamp,
        error: 'legacy dialog had no native CC field before confirmation',
      },
    });
    await store.saveCandidateResume('boss', jobKey, buildResume(candidate.candidateId));
    await store.saveSeenIds('boss', jobKey, [candidate.candidateId]);
    const forwardRecipients: string[] = [];
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => createDetailPage(),
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.forwardBossResumeRef.fn = async (_page, _candidate, _mode, recipient) => {
      forwardRecipients.push(recipient);
    };
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      throw new Error('legacy forwarding recovery must not rescore');
    };

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T07:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'current-primary@example.com',
        bossScreening: screeningSettings,
      },
    );
    assert.deepStrictEqual(forwardRecipients, ['stored-primary@example.com', 'stored-copy@example.com']);
    assert.equal(result.runResult.bossRouting?.forwardingStatusCounts.sent, 1);
    assert.deepStrictEqual(result.runResult.bossRouting?.qualifiedCandidateIds, [candidate.candidateId]);
    assert.deepStrictEqual(result.runResult.scoredCandidates, [candidate.candidateId]);
    const outbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(outbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['stored-primary@example.com', 'sent'],
      ['stored-copy@example.com', 'sent'],
    ]);
  });

  it('migrates a legacy in-flight Boss outbox to uncertain without repeating any target', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-forward-legacy-sending';
    const candidate = { candidateId: 'boss-forward-legacy-sending' };
    const timestamp = '2026-08-01T08:00:00.000Z';
    await store.saveBossForwardingOutboxEntry('boss', jobKey, {
      candidateId: candidate.candidateId,
      policyHash: 'legacy-policy-hash',
      classification: 'qualified',
      audience: 'primary',
      createdAt: timestamp,
      updatedAt: timestamp,
      forwarding: {
        status: 'sending',
        mode: 'email',
        recipient: 'stored-primary@example.com',
        ccEmails: ['stored-copy@example.com'],
        attemptedAt: timestamp,
      },
    });
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => {
        throw new Error('uncertain legacy forwarding must not reopen the resume');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    let forwardCalls = 0;
    indexModule.forwardBossResumeRef.fn = async () => {
      forwardCalls += 1;
    };

    const result = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T09:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'current-primary@example.com',
        bossScreening: buildModelScreeningSettings(),
      },
    );
    assert.equal(forwardCalls, 0);
    assert.equal(result.runResult.bossRouting?.forwardingStatusCounts.uncertain, 1);
    assert.equal(result.runResult.failedCandidates.filter((failure) => failure.candidateId === candidate.candidateId).length, 1);
    const outbox = await store.readBossForwardingOutboxEntry('boss', jobKey, candidate.candidateId);
    assert.deepStrictEqual(outbox?.forwarding.deliveries?.map((delivery) => [delivery.recipient, delivery.status]), [
      ['stored-primary@example.com', 'uncertain'],
      ['stored-copy@example.com', 'uncertain'],
    ]);
  });

  it('recovers a seen Boss candidate whose process stopped before a routing outbox was durable', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-boss-pending-score-recovery';
    const candidate = { candidateId: 'boss-pending-score-recovery' };
    const detailPage = createDetailPage();
    let scoreCalls = 0;
    let parseCalls = 0;
    let forwardCalls = 0;
    let failScorePersistence = true;
    const originalSaveCandidateScoreArtifact = store.saveCandidateScoreArtifact.bind(store);
    store.saveCandidateScoreArtifact = async (...args) => {
      if (failScorePersistence) {
        throw new Error('simulated score persistence interruption');
      }
      return originalSaveCandidateScoreArtifact(...args);
    };
    const adapter = {
      ...indexModule.resolvePlatformAdapter('boss'),
      openDirectSearch: async () => createSearchPage(),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({ candidates: [candidate] }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => {
        parseCalls += 1;
        return buildResume(candidate.candidateId);
      },
      closeResumeDetail: async () => undefined,
    } satisfies import('../platforms/types.js').PlatformAdapter;
    const screeningSettings = buildModelScreeningSettings();
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => {
      scoreCalls += 1;
      return {
        score: buildScore(),
        evaluations: [buildModelRequirementEvaluation('satisfied', '明确证据')],
      };
    };
    indexModule.forwardBossResumeRef.fn = async () => {
      forwardCalls += 1;
    };

    const first = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T01:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossScreening: screeningSettings,
      },
    );
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), [candidate.candidateId]);
    assert.deepStrictEqual(
      (await store.listBossScreeningWorkItems('boss', jobKey)).map((item) => item.candidateId),
      [candidate.candidateId],
    );
    assert.match(first.runResult.failedCandidates.at(-1)?.error ?? '', /score persistence interruption/);
    assert.equal(forwardCalls, 0);

    failScorePersistence = false;
    const second = await indexModule.runResumeCaptureFlow(
      'boss',
      jobKey,
      buildNormalizedJob(),
      '物业电工',
      store,
      { page: { id: 'root-page' }, context: { id: 'browser-context' } } as never,
      '2026-08-01T02:00:00.000Z',
      adapter,
      {
        searchSource: 'direct',
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary@example.com',
        bossScreening: screeningSettings,
      },
    );

    assert.deepStrictEqual(second.newCandidates, []);
    assert.deepStrictEqual(second.runResult.bossRouting?.qualifiedCandidateIds, [candidate.candidateId]);
    assert.deepStrictEqual(second.runResult.failedCandidates, []);
    assert.deepStrictEqual(await store.listBossScreeningWorkItems('boss', jobKey), []);
    assert.equal(scoreCalls, 2);
    assert.equal(parseCalls, 2);
    assert.equal(forwardCalls, 1);
    assert.deepStrictEqual(second.runResult.bossSeenViewSync?.coveredByProcessingCandidateIds, [candidate.candidateId]);
  });

  it('keeps normal Boss capture forwarding job-scoped without changing auto-chat defaults', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const keyword = `Boss岗位级转发-${Date.now()}-${Math.random()}`;
    const jobKey = buildJobKey(keyword, '');
    const forwardingCalls: Array<{ mode?: string; recipient?: string; ccEmails?: string[] }> = [];
    const originalAfterResumeDetailOpened = bossAdapter.afterResumeDetailOpened;

    await store.saveBossAutomationSettings({
      forwarding: {
        mode: 'email',
        recipient: 'auto-chat-default@example.com',
      },
      summaryDelivery: {
        recipientEmail: 'summary@example.com',
      },
    });
    stubSuccessfulRun(indexModule);
    bossAdapter.afterResumeDetailOpened = async (_page, _candidate, actions) => {
      forwardingCalls.push({
        mode: actions.bossForwardMode,
        recipient: actions.bossForwardRecipient,
        ccEmails: actions.bossForwardCcEmails,
      });
    };

    try {
      await captureConsole(async () => {
        await indexModule.main([
          '--platform',
          'boss',
          '--keyword',
          keyword,
          '--jd',
          '职位名称：工业设计师',
          '--search-source',
          'direct',
          '--boss-forward-mode',
          'email',
          '--boss-forward-recipient',
          'job-specific@example.com',
          '--boss-forward-cc',
          'job-specific-audit@example.com',
        ]);
      });
    } finally {
      bossAdapter.afterResumeDetailOpened = originalAfterResumeDetailOpened;
    }

    assert.deepStrictEqual(forwardingCalls, [{
      mode: 'email',
      recipient: 'job-specific@example.com',
      ccEmails: ['job-specific-audit@example.com'],
    }]);
    assert.deepStrictEqual((await store.readJobRecord('boss', jobKey)).bossForwarding, {
      mode: 'email',
      recipient: 'job-specific@example.com',
      ccEmails: ['job-specific-audit@example.com'],
    });
    assert.deepStrictEqual(await store.readBossAutomationSettings(), {
      forwarding: {
        mode: 'email',
        recipient: 'auto-chat-default@example.com',
      },
      summaryDelivery: {
        recipientEmail: 'summary@example.com',
      },
    });
  });

  it('uses platform candidate pacing between every pair of new candidates', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-platform-candidate-pace';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const paceCalls: string[] = [];
    const originalWaitPlatformCandidatePace = indexModule.waitPlatformCandidatePaceRef.fn;

    const adapter = {
      ...indexModule.resolvePlatformAdapter('zhilian'),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({
        candidates: [
          { candidateId: 'cand-1' },
          { candidateId: 'cand-2' },
          { candidateId: 'cand-3' },
        ],
      }),
      openResumeDetail: async () => createDetailPage(),
      parseResumeDetail: async (_page, candidate) => buildResume(candidate.candidateId),
    } satisfies import('../platforms/types.js').PlatformAdapter;

    indexModule.waitPlatformCandidatePaceRef.fn = async (_page, platform) => {
      paceCalls.push(platform);
    };
    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    try {
      await indexModule.runResumeCaptureFlow(
        'zhilian',
        jobKey,
        buildNormalizedJob(),
        'search keyword',
        store,
        {
          page: { id: 'root-page' },
          context: { id: 'browser-context' },
        } as never,
        fetchedAt,
        adapter,
      );
    } finally {
      indexModule.waitPlatformCandidatePaceRef.fn = originalWaitPlatformCandidatePace;
    }

    assert.deepStrictEqual(paceCalls, ['zhilian', 'zhilian']);
  });

  it('stops Liepin flow on candidate failure and leaves the failed detail page open', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-liepin-stop-on-failure';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const callOrder: string[] = [];
    let failedDetailClosed = false;

    const failedDetailPage = {
      locator: () => ({ innerText: async () => 'raw resume text' }),
      close: async () => {
        failedDetailClosed = true;
      },
    } as never;

    const adapter = {
      ...indexModule.resolvePlatformAdapter('liepin'),
      openSubscribeSearch: async () => createSearchPage(),
      extractCandidateList: async () => ({
        candidates: [
          { candidateId: 'cand-fails' },
          { candidateId: 'cand-should-not-open' },
        ],
      }),
      openResumeDetail: async (_context, _searchPage, candidate) => {
        callOrder.push(`open:${candidate.candidateId}`);
        return failedDetailPage;
      },
      afterResumeDetailOpened: async (_page, candidate) => {
        callOrder.push(`forward:${candidate.candidateId}`);
        throw new Error('forward failed');
      },
      parseResumeDetail: async (_page, candidate) => {
        callOrder.push(`parse:${candidate.candidateId}`);
        return buildResume(candidate.candidateId);
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    await assert.rejects(
      () => indexModule.runResumeCaptureFlow(
        'liepin',
        jobKey,
        {
          title: 'Test Job',
          majors: [],
          languageRequirements: [],
          responsibilities: [],
          hardRequirements: [],
          preferredRequirements: [],
          regionPreferences: [],
          industryTags: [],
        },
        'search keyword',
        store,
        {
          page: { id: 'root-page' },
          context: { id: 'browser-context' },
        } as never,
        fetchedAt,
        adapter,
        { liepinForwardContact: '王经理' },
      ),
      /Liepin candidate cand-fails failed; stopping flow and leaving the browser open for inspection\. Original error: forward failed/,
    );

    assert.deepStrictEqual(callOrder, [
      'open:cand-fails',
      'forward:cand-fails',
    ]);
    assert.equal(failedDetailClosed, false);
    assert.deepStrictEqual(await store.readSeenIds('liepin', jobKey), []);
  });

  it('closes successful Liepin detail pages and leaves the session on the search page', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-liepin-return-search';
    const fetchedAt = '2026-04-20T12:34:56.000Z';
    const searchPage = createSearchPage() as Page;
    const session = {
      page: { id: 'root-page' },
      context: { id: 'browser-context' },
    } as unknown as BrowserSession;
    let detailClosed = false;
    let searchFocused = false;
    const callOrder: string[] = [];
    const originalWaitPlatformActionPace = indexModule.waitPlatformActionPaceRef.fn;
    let actionPaceCalls = 0;

    const detailPage = {
      locator: () => ({ innerText: async () => 'raw resume text' }),
      close: async () => {
        detailClosed = true;
        callOrder.push('close');
      },
    } as never;
    searchPage.bringToFront = async () => {
      searchFocused = true;
      callOrder.push('focus-search');
    };

    const adapter = {
      ...indexModule.resolvePlatformAdapter('liepin'),
      openSubscribeSearch: async () => searchPage,
      extractCandidateList: async () => ({
        candidates: [{ candidateId: 'cand-new' }],
      }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => {
        callOrder.push('parse');
        return buildResume('cand-new');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.waitPlatformActionPaceRef.fn = async (page, platform) => {
      assert.equal(page, detailPage);
      assert.equal(platform, 'liepin');
      actionPaceCalls += 1;
      callOrder.push(actionPaceCalls === 1 ? 'pace-after-open' : 'pace-before-close');
    };
    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    try {
      await indexModule.runResumeCaptureFlow(
        'liepin',
        jobKey,
        buildNormalizedJob(),
        'search keyword',
        store,
        session,
        fetchedAt,
        adapter,
      );
    } finally {
      indexModule.waitPlatformActionPaceRef.fn = originalWaitPlatformActionPace;
    }

    assert.equal(detailClosed, true);
    assert.equal(searchFocused, true);
    assert.equal(session.page, searchPage);
    assert.deepStrictEqual(callOrder, ['pace-after-open', 'parse', 'pace-before-close', 'close', 'focus-search']);
  });

  it('paces a same-page resume modal after opening and before adapter cleanup', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-modal-detail-pace';
    const fetchedAt = '2026-07-24T12:34:56.000Z';
    const searchPage = createSearchPage() as Page;
    const session = {
      page: searchPage,
      context: { id: 'browser-context' },
    } as unknown as BrowserSession;
    const callOrder: string[] = [];
    const originalWaitPlatformActionPace = indexModule.waitPlatformActionPaceRef.fn;
    let actionPaceCalls = 0;

    const adapter = {
      ...indexModule.resolvePlatformAdapter('zhilian'),
      openSubscribeSearch: async () => searchPage,
      extractCandidateList: async () => ({ candidates: [{ candidateId: 'cand-modal' }] }),
      openResumeDetail: async () => {
        callOrder.push('open');
        return searchPage;
      },
      afterResumeDetailOpened: async () => undefined,
      parseResumeDetail: async () => {
        callOrder.push('parse');
        return buildResume('cand-modal');
      },
      closeResumeDetail: async () => {
        callOrder.push('close-modal');
      },
    } satisfies import('../platforms/types.js').PlatformAdapter;

    indexModule.waitPlatformActionPaceRef.fn = async (page, platform) => {
      assert.equal(page, searchPage);
      assert.equal(platform, 'zhilian');
      actionPaceCalls += 1;
      callOrder.push(actionPaceCalls === 1 ? 'pace-after-open' : 'pace-before-close');
    };
    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

    try {
      await indexModule.runResumeCaptureFlow(
        'zhilian',
        jobKey,
        buildNormalizedJob(),
        'search keyword',
        store,
        session,
        fetchedAt,
        adapter,
      );
    } finally {
      indexModule.waitPlatformActionPaceRef.fn = originalWaitPlatformActionPace;
    }

    assert.deepStrictEqual(callOrder, [
      'open',
      'pace-after-open',
      'parse',
      'pace-before-close',
      'close-modal',
    ]);
  });

  it('keeps upstream extraction failures retryable by not marking them as seen', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = 'job-orchestration-extraction-failure';
    const fetchedAt = '2026-04-20T12:34:56.000Z';

    let saveCandidateResumeCalls = 0;
    let saveCandidateScoreArtifactCalls = 0;

    indexModule.extractCandidateListRef.fn = async () => ({
      candidates: [
        { candidateId: 'cand-open-fails' },
      ],
    });
    indexModule.extractionBoundary.extractCandidateListFromPage = async () => ({
      candidates: [
        { candidateId: 'cand-open-fails' },
      ],
    });
    indexModule.openSubscribeSearchRef.fn = (async () => ({ id: 'search-page' } as never)) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openResumeDetailRef.fn = async () => {
      throw new Error('Resume detail failed to open');
    };

    store.saveCandidateResume = async () => {
      saveCandidateResumeCalls += 1;
      return '';
    };
    store.saveCandidateScoreArtifact = async () => {
      saveCandidateScoreArtifactCalls += 1;
      return '';
    };

    const session = {
      page: { id: 'root-page' },
      context: { id: 'browser-context' },
    } as never;

    const result = await indexModule.runResumeCaptureFlow(
      '51job',
      jobKey,
      {
        title: 'Test Job',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      'search keyword',
      store,
      session,
      fetchedAt,
      indexModule.resolvePlatformAdapter('51job'),
    );

    assert.equal(saveCandidateResumeCalls, 0);
    assert.equal(saveCandidateScoreArtifactCalls, 0);
    assert.deepStrictEqual(await store.readSeenIds('51job', jobKey), []);
    assert.deepStrictEqual(result.runResult.scoredCandidates, []);
    assert.deepStrictEqual(result.runResult.failedCandidates, [
      { candidateId: 'cand-open-fails', error: 'Resume detail failed to open' },
    ]);
  });

  it('uses the injectable JD parser when running the main flow', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let parsedText = '';
    const freshKeyword = `测试注入解析器-${Date.now()}-${Math.random()}`;

    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async (rawText: string) => {
      parsedText = rawText;
      return buildNormalizedJob();
    };

    await captureConsole(async () => {
      process.argv = [
        'node',
        'index.ts',
        '--keyword',
        freshKeyword,
        '--jd',
        '职位名称：测试注入解析器',
      ];
      await indexModule.main();
    });

    assert.equal(parsedText, '职位名称：测试注入解析器');
  });

  it('answers candidate questions from a stored JD without browser work or JD reparsing', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('东南亚 销售', buildNormalizedJob().title);
    const questionInputs: Array<{ platform: string; jobKey: string; question: string }> = [];
    let browserCalls = 0;
    let parseCalls = 0;

    await store.saveJobRecord('51job', {
      jobKey,
      platform: '51job',
      searchKeyword: '东南亚 销售',
      rawText: '职位名称：东南亚销售经理\n薪资范围：15-25K',
      normalizedJob: {
        ...buildNormalizedJob(),
        salaryRange: { raw: '15-25K' },
      },
      createdAt: '2026-04-01T00:00:00.000Z',
    });

    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser should not start in JD question mode');
    };
    indexModule.parseJobDescriptionRef.fn = async () => {
      parseCalls += 1;
      throw new Error('JD parser should not run for stored JD question mode');
    };
    indexModule.answerCandidateQuestionFromJdRef.fn = async () => {
      throw new Error('lightweight JD fallback should not run for stored JD question mode');
    };
    indexModule.answerQuestionWithRagRef.fn = async (input) => {
      questionInputs.push({
        platform: input.platform,
        jobKey: input.jobKey,
        question: input.question,
      });
      return {
        answer: '该岗位薪资范围为15-25K。',
        sources: [{
          id: 'job-summary',
          label: '结构化 JD 摘要',
          text: '薪资：15-25K',
          score: 10,
          sourceType: 'jd',
          sourceId: 'jd-v1',
          chunkId: 'job-summary',
          verified: true,
          active: true,
        }],
      };
    };

    const output = await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        '东南亚 销售',
        '--jd-question',
        '这个岗位薪资是多少？',
      ]);
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
      platform?: string;
      jobKey?: string;
      question?: string;
      answer?: string;
      sources?: unknown[];
    };

    assert.equal(browserCalls, 0);
    assert.equal(parseCalls, 0);
    assert.deepStrictEqual(questionInputs, [{
      platform: '51job',
      jobKey,
      question: '这个岗位薪资是多少？',
    }]);
    assert.equal(summary.platform, '51job');
    assert.equal(summary.jobKey, jobKey);
    assert.equal(summary.question, '这个岗位薪资是多少？');
    assert.equal(summary.answer, '该岗位薪资范围为15-25K。');
    assert.equal(summary.sources?.length, 1);
  });

  it('answers candidate questions from inline JD text without creating a job record', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const questionInputs: Array<{ rawJdText: string; normalizedTitle?: string }> = [];

    indexModule.parseJobDescriptionRef.fn = async () => {
      throw new Error('JD parser should not run for inline JD question mode');
    };
    indexModule.answerCandidateQuestionFromJdRef.fn = async (input) => {
      questionInputs.push({
        rawJdText: input.rawJdText,
        normalizedTitle: input.normalizedJob?.title,
      });
      return {
        answer: 'JD中未说明。',
        sources: [{ id: 'jd-1', label: 'JD 原文片段 1', text: input.rawJdText, score: 0 }],
      };
    };

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        '临时问答岗位',
        '--jd',
        '职位名称：临时问答岗位\n工作地点：上海',
        '--rag-question',
        '是否提供住宿？',
      ]);
    });

    assert.deepStrictEqual(questionInputs, [{
      rawJdText: '职位名称：临时问答岗位\n工作地点：上海',
      normalizedTitle: undefined,
    }]);
    assert.equal(await store.readJobRecordIfExists('51job', '临时问答岗位'), undefined);
    assert.equal(await pathExists(path.join(tempDir, '51job', 'jobs', '临时问答岗位', 'rag', 'answer-logs.jsonl')), false);
  });

  it('rejects capture-only switches in JD question mode before browser work starts', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let browserCalls = 0;

    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser should not start before JD question validation rejects');
    };

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        '东南亚 销售',
        '--jd-question',
        '薪资多少？',
        '--include-viewed',
        'true',
      ]),
      /--jd-question cannot be combined .*--include-viewed/,
    );
    assert.equal(browserCalls, 0);
  });

  it('rejects empty JD questions before browser work starts', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let browserCalls = 0;

    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser should not start before empty JD question validation rejects');
    };

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        '东南亚 销售',
        '--jd-question',
        '   ',
      ]),
      /--jd-question must be a non-empty string/,
    );
    assert.equal(browserCalls, 0);
  });

  it('keeps viewed candidates excluded by default when opening 51job search from the CLI', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const observedIncludeViewedValues: Array<boolean | undefined> = [];

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async (_page, _keyword, options) => {
      observedIncludeViewedValues.push(options?.includeViewedCandidates);
      return createSearchPage();
    }) as typeof indexModule.openSubscribeSearchRef.fn;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `默认不含已看-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：默认不含已看',
      ]);
    });

    assert.deepStrictEqual(observedIncludeViewedValues, [false]);
  });

  it('passes --include-viewed true through to 51job search opening', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const observedIncludeViewedValues: Array<boolean | undefined> = [];

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async (_page, _keyword, options) => {
      observedIncludeViewedValues.push(options?.includeViewedCandidates);
      return createSearchPage();
    }) as typeof indexModule.openSubscribeSearchRef.fn;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `包含已看-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：包含已看',
        '--include-viewed',
        'true',
      ]);
    });

    assert.deepStrictEqual(observedIncludeViewedValues, [true]);
  });

  it('runs direct 51job search with application filters and viewed-switch options', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const applicationFilterOptionsPath = path.join(tempDir, '51job', 'filter-catalog', 'application-filter-options.latest.json');
    const applicationFilterInputPath = path.join(tempDir, 'filter-input.json');
    const directCalls: Array<{
      keyword: string;
      includeViewedCandidates?: boolean;
      conditions: import('../types/job.js').SearchCondition[];
    }> = [];
    const keyword = `direct-51job-${Date.now()}-${Math.random()}`;

    await fs.mkdir(path.dirname(applicationFilterOptionsPath), { recursive: true });
    await fs.writeFile(applicationFilterOptionsPath, JSON.stringify({
      platform: '51job',
      capturedAt: '2026-06-01T00:00:00.000Z',
      keyword: 'direct',
      fieldCount: 1,
      fieldIds: ['education'],
      fieldIdByLabel: { 学历要求: 'education' },
      groups: {
        singleSelect: ['education'],
        textInput: [],
        salaryRange: [],
        numberRange: [],
      },
      fieldsById: {
        education: {
          fieldId: 'education',
          filterKey: 'education',
          label: '学历要求',
          kind: 'singleSelect',
          restrictInput: true,
          valueShape: 'string',
          acceptedInputShapes: ['string'],
          allowedValues: ['本科'],
          options: [
            { label: '本科', value: '本科', disabled: false, selected: false },
          ],
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(applicationFilterInputPath, JSON.stringify({ education: '本科' }), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async () => {
      throw new Error('saved search should not be used for direct mode');
    }) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openDirectSearchRef.fn = (async (_page, keyword, conditions, options) => {
      directCalls.push({
        keyword,
        includeViewedCandidates: options?.includeViewedCandidates,
        conditions,
      });
      return createSearchPage();
    }) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        keyword,
        '--jd',
        '职位名称：direct 51job',
        '--search-source',
        'direct',
        '--application-filter-input-file',
        applicationFilterInputPath,
        '--include-viewed',
        'true',
      ]);
    });

    await fs.rm(applicationFilterInputPath);
    await fs.rm(applicationFilterOptionsPath);
    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        keyword,
      ]);
    });

    assert.equal(directCalls.length, 2);
    assert.equal(directCalls[0]?.includeViewedCandidates, true);
    assert.equal(directCalls[1]?.includeViewedCandidates, false);
    assert.equal(directCalls[0]?.conditions.length, 1);
    assert.deepStrictEqual(directCalls[0]?.conditions[0], {
      kind: 'applicationFilter',
      fieldId: 'education',
      label: '学历要求',
      fieldKind: 'singleSelect',
      value: '本科',
      values: [{ value: '本科', pathLabels: undefined }],
    });
    assert.equal(
      JSON.stringify(directCalls[1]?.conditions),
      JSON.stringify(directCalls[0]?.conditions),
    );

    const storedJob = await new indexModule.JobStore().readJobRecord('51job', buildJobKey(keyword, ''));
    assert.deepStrictEqual(storedJob.searchSettings, {
      source: 'direct',
      applicationFilterInput: { education: '本科' },
      conditions: directCalls[1]?.conditions,
    });
  });

  it('pins a reusable condition-set revision in a direct-capture job and reuses its snapshot after later revisions', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const applicationFilterOptionsPath = path.join(tempDir, '51job', 'filter-catalog', 'application-filter-options.latest.json');
    const keyword = `condition-set-51job-${Date.now()}-${Math.random()}`;
    const directConditions: import('../types/job.js').SearchCondition[][] = [];

    await fs.mkdir(path.dirname(applicationFilterOptionsPath), { recursive: true });
    await fs.writeFile(applicationFilterOptionsPath, JSON.stringify({
      platform: '51job',
      capturedAt: '2026-07-30T00:00:00.000Z',
      keyword: 'condition-set',
      fieldCount: 1,
      fieldIds: ['education'],
      fieldIdByLabel: { 学历要求: 'education' },
      groups: { singleSelect: ['education'], textInput: [], salaryRange: [], numberRange: [] },
      fieldsById: {
        education: {
          fieldId: 'education', filterKey: 'education', label: '学历要求', kind: 'singleSelect', restrictInput: true,
          valueShape: 'string', acceptedInputShapes: ['string'], allowedValues: ['本科', '硕士'],
          options: [
            { label: '本科', value: '本科', disabled: false, selected: false },
            { label: '硕士', value: '硕士', disabled: false, selected: false },
          ],
        },
      },
    }, null, 2), 'utf8');

    const conditionSetService = new SearchConditionSetService({ dataDir: tempDir });
    const conditionSet = await conditionSetService.create({
      platform: '51job',
      name: '本科资深设计师',
      defaultKeyword: '铝',
      applicationFilterInput: { education: '本科' },
    });

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async () => {
      throw new Error('saved search should not be used after selecting a condition set');
    }) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openDirectSearchRef.fn = (async (_page, _keyword, conditions) => {
      directConditions.push(conditions);
      return createSearchPage();
    }) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform', '51job', '--keyword', keyword, '--jd', '职位名称：条件集直接搜索',
        '--search-source', 'direct', '--search-condition-set', `${conditionSet.conditionSetId}@1`,
      ]);
    });

    await conditionSetService.revise({ platform: '51job', conditionSetId: conditionSet.conditionSetId }, {
      expectedRevision: 1,
      applicationFilterInput: { education: '硕士' },
    });
    await captureConsole(async () => {
      await indexModule.main(['--platform', '51job', '--keyword', keyword]);
    });

    assert.equal(directConditions.length, 2);
    assert.deepStrictEqual(directConditions.map((conditions) => (conditions[0] as { value?: unknown })?.value), ['本科', '本科']);
    const storedJob = await new indexModule.JobStore().readJobRecord('51job', buildJobKey(keyword, ''));
    assert.deepStrictEqual(storedJob.searchSettings?.conditionSetRef, {
      conditionSetId: conditionSet.conditionSetId,
      platform: '51job',
      revision: 1,
    });
    assert.equal(storedJob.searchSettings?.resolution?.selectedFieldsFingerprint.length, 64);
  });

  it('uses a stable Boss job identity with its saved condition set and records the separate page keyword', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const bossJobId = 'boss-position-554c';
    const jobName = '全铝箱包设计';
    const jobKey = buildBossSyncedJobKey(jobName, bossJobId);
    const directCalls: Array<{
      keyword: string;
      conditions: import('../types/job.js').SearchCondition[];
      includeViewedCandidates?: boolean;
    }> = [];

    await writeBossApplicationFilterOptions(tempDir);
    const conditionSets = new SearchConditionSetService({ dataDir: tempDir });
    const conditionSet = await conditionSets.create({
      platform: 'boss',
      name: '全铝箱包设计保存设置',
      defaultKeyword: '铝',
      applicationFilterInput: { education: '大专及以上' },
    });
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: jobName,
      rawText: '职位名称：全铝箱包设计',
      normalizedJob: { ...buildNormalizedJob(), title: jobName },
      searchSettings: {
        source: 'direct',
        conditions: [],
        conditionSetRef: {
          conditionSetId: conditionSet.conditionSetId,
          platform: 'boss',
          revision: 1,
        },
      },
      bossPosition: {
        bossJobId,
        status: 'open',
        syncedAt: '2026-07-30T00:00:00.000Z',
        sourceHash: 'source-hash',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    });

    stubSuccessfulRun(indexModule);
    bossAdapter.openSubscribeSearch = (async () => {
      throw new Error('saved Boss search should not run when saved settings contain a condition set');
    }) as typeof bossAdapter.openSubscribeSearch;
    bossAdapter.openDirectSearch = (async (_page, keyword, conditions, options) => {
      directCalls.push({ keyword, conditions, includeViewedCandidates: options?.includeViewedCandidates });
      return createSearchPage();
    }) as NonNullable<typeof bossAdapter.openDirectSearch>;

    const result = await indexModule.main([
      '--platform', 'boss', '--keyword', jobName, '--boss-job-id', bossJobId,
    ]) as import('../index.js').MainRunSummary;

    assert.equal(result.jobKey, jobKey);
    assert.equal(result.bossJobId, bossJobId);
    assert.equal(result.searchExecution?.pageKeyword, '铝');
    assert.equal(result.searchExecution?.keywordSource, 'condition-set-default');
    assert.deepStrictEqual(result.searchExecution?.conditionSetRef, {
      conditionSetId: conditionSet.conditionSetId,
      platform: 'boss',
      revision: 1,
    });
    assert.deepStrictEqual(directCalls.map((call) => call.keyword), ['铝']);
    assert.equal(directCalls[0]?.conditions.length, 1);
    assert.equal(directCalls[0]?.includeViewedCandidates, false);
    assert.deepStrictEqual(await store.readSeenIds('boss', jobKey), ['boss-cand-1']);
    assert.equal(await pathExists(path.join(tempDir, 'boss', 'jobs', jobName)), false);
    const storedRun = (await store.listRunResults('boss', jobKey)).at(-1)!;
    assert.equal(storedRun.searchExecution?.pageKeyword, '铝');
    assert.equal(storedRun.searchExecution?.includeViewedCandidates, false);
    assert.equal((await store.readJobRecord('boss', jobKey)).searchSettings?.pageKeyword, '铝');
    assert.equal(await pathExists(path.join(tempDir, 'boss', 'runtime', 'search-lease.lock')), false);

    const explicitConditionSet = await conditionSets.create({
      platform: 'boss',
      name: '全铝箱包设计显式覆盖',
      defaultKeyword: '铝合金',
      applicationFilterInput: { education: '大专及以上' },
    });
    const explicitResult = await indexModule.main([
      '--platform', 'boss', '--keyword', jobName, '--boss-job-id', bossJobId,
      '--search-source', 'saved',
      '--boss-search-condition-set', `${explicitConditionSet.conditionSetId}@1`,
    ]) as import('../index.js').MainRunSummary;
    assert.deepStrictEqual(directCalls.map((call) => call.keyword), ['铝', '铝合金']);
    assert.equal(explicitResult.searchExecution?.source, 'direct');
    assert.equal(explicitResult.searchExecution?.pageKeyword, '铝合金');
    assert.deepStrictEqual(explicitResult.searchExecution?.conditionSetRef, {
      conditionSetId: explicitConditionSet.conditionSetId,
      platform: 'boss',
      revision: 1,
    });
  });

  it('lets explicit CLI saved source reuse the complete reference on the current saved Boss job', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const bossJobId = 'boss-position-explicit-saved';
    const jobName = '全铝箱包设计';
    const jobKey = buildBossSyncedJobKey(jobName, bossJobId);
    const conditionIdentity = {
      jobScope: jobName,
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'explicit-saved-native',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: jobName,
      rawText: '职位名称：全铝箱包设计',
      normalizedJob: { ...buildNormalizedJob(), title: jobName },
      searchSettings: {
        source: 'saved',
        pageKeyword: savedSearch.expectedKeyword,
        conditions: [],
        savedSearch,
        sortPolicy: 'match-priority',
      },
      bossPosition: {
        bossJobId,
        status: 'open',
        syncedAt: '2026-07-30T00:00:00.000Z',
        sourceHash: 'source-hash',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    });

    stubSuccessfulRun(indexModule);
    const originalOpenSavedSearch = bossAdapter.openSavedSearch;
    const opened: SavedSearchReference[] = [];
    bossAdapter.openSavedSearch = async (_page, target) => {
      opened.push(target);
      return createSearchPage();
    };
    let result: import('../index.js').MainRunSummary;
    try {
      result = await indexModule.main([
        '--platform', 'boss', '--keyword', jobName, '--boss-job-id', bossJobId,
        '--search-source', 'saved',
      ]) as import('../index.js').MainRunSummary;
    } finally {
      bossAdapter.openSavedSearch = originalOpenSavedSearch;
    }

    assert.equal(result.jobKey, jobKey);
    assert.deepEqual(opened, [savedSearch]);
    assert.equal(result.searchExecution?.source, 'saved');
    assert.equal(result.searchExecution?.pageKeyword, savedSearch.expectedKeyword);
    assert.deepEqual(result.searchExecution?.savedSearch, savedSearch);
    assert.equal(result.searchExecution?.sortPolicy, 'match-priority');
  });

  it('keeps Boss identity and page-query fields scoped to the Boss stage for all-platform and batch capture', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const bossJobId = 'boss-position-all-batch';
    const jobName = '全铝箱包设计';
    const jobKey = buildBossSyncedJobKey(jobName, bossJobId);
    const directKeywords: string[] = [];

    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: jobName,
      rawText: '职位名称：全铝箱包设计',
      normalizedJob: { ...buildNormalizedJob(), title: jobName },
      searchSettings: {
        source: 'direct',
        pageKeyword: '铝',
        conditions: [],
      },
      bossPosition: {
        bossJobId,
        status: 'open',
        syncedAt: '2026-07-30T00:00:00.000Z',
        sourceHash: 'source-hash',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    stubSuccessfulRun(indexModule);
    bossAdapter.openDirectSearch = (async (_page, keyword) => {
      directKeywords.push(keyword);
      return createSearchPage();
    }) as NonNullable<typeof bossAdapter.openDirectSearch>;

    const allResult = await indexModule.main([
      '--platform', 'all', '--include-boss', 'true', '--keyword', jobName,
      '--jd', '职位名称：全铝箱包设计', '--boss-job-id', bossJobId,
    ]);
    const allSummaries = assertAllPlatformsSummary(allResult);
    assert.deepStrictEqual(allSummaries.map((summary) => summary.platform), ['51job', 'liepin', 'zhilian', 'boss']);
    assert.equal(allSummaries[3]?.summary.jobKey, jobKey);
    assert.equal(allSummaries[3]?.summary.searchExecution?.pageKeyword, '铝');

    const jobsFilePath = path.join(tempDir, 'boss-jobs.json');
    await fs.writeFile(jobsFilePath, JSON.stringify([{
      keyword: jobName,
      bossJobId,
      bossSearchKeyword: '铝合金',
    }], null, 2), 'utf8');
    const batchResult = await indexModule.main([
      '--platform', 'boss', '--jobs-file', jobsFilePath,
    ]);
    const batchSummaries = assertBatchSummary(batchResult);
    assert.equal(batchSummaries[0]?.summary.jobKey, jobKey);
    assert.equal(batchSummaries[0]?.summary.searchExecution?.pageKeyword, '铝合金');
    assert.deepStrictEqual(directKeywords, ['铝', '铝合金']);
    assert.equal(await pathExists(path.join(tempDir, 'boss', 'jobs', jobName)), false);
  });

  it('uses a complete Boss saved-search reference supplied by one jobs-file item', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const bossJobId = 'boss-position-batch-saved-reference';
    const jobName = '全铝箱包设计';
    const jobKey = buildBossSyncedJobKey(jobName, bossJobId);
    const conditionIdentity = {
      jobScope: jobName,
      city: '广东',
      inline: { education: ['本科及以上'] },
      more: {},
      toggles: { filter_recent_viewed: false },
    };
    const savedSearch = {
      version: 1 as const,
      platform: 'boss' as const,
      name: '铝镁合金',
      nativeId: 'batch-native-subscription',
      expectedKeyword: '铝镁合金 拉杆箱',
      conditionIdentity,
      conditionFingerprint: fingerprintSavedSearchConditionIdentity(conditionIdentity),
    };
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: jobName,
      rawText: '职位名称：全铝箱包设计',
      normalizedJob: { ...buildNormalizedJob(), title: jobName },
      searchSettings: {
        source: 'saved',
        pageKeyword: savedSearch.expectedKeyword,
        conditions: [],
      },
      bossPosition: {
        bossJobId,
        status: 'open',
        syncedAt: '2026-08-04T00:00:00.000Z',
        sourceHash: 'source-hash',
      },
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    const jobsFilePath = path.join(tempDir, 'boss-saved-jobs.json');
    await fs.writeFile(jobsFilePath, JSON.stringify([{
      keyword: jobName,
      bossJobId,
      bossSearchKeyword: savedSearch.expectedKeyword,
      searchSource: 'saved',
      bossSavedSearchReference: savedSearch,
    }], null, 2), 'utf8');
    stubSuccessfulRun(indexModule);
    const opened: unknown[] = [];
    bossAdapter.openSavedSearch = async (_page, target) => {
      opened.push(target);
      return createSearchPage();
    };

    const result = await indexModule.main([
      '--platform', 'boss', '--jobs-file', jobsFilePath,
    ]);
    const summaries = assertBatchSummary(result);
    assert.equal(summaries.length, 1);
    assert.deepEqual(opened, [savedSearch]);
    assert.deepEqual(summaries[0]?.summary.searchExecution?.savedSearch, savedSearch);
  });

  it('rejects an unresolved Boss position ID before browser or capture side effects', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let browserCalls = 0;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser must not start for an unresolved Boss position');
    };

    await assert.rejects(
      () => indexModule.main([
        '--platform', 'boss', '--keyword', '全铝箱包设计', '--boss-job-id', 'missing-boss-position',
      ]),
      /Missing stored Boss JD.*missing-boss-position/,
    );
    assert.equal(browserCalls, 0);
    assert.equal(await pathExists(path.join(tempDir, 'boss', 'jobs', '全铝箱包设计')), false);
  });

  it('rejects application filter input files unless direct search is selected', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const filterPath = path.join(tempDir, 'filter-input.json');

    await fs.writeFile(filterPath, '{}', 'utf8');

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `filter-saved-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：filter saved',
        '--application-filter-input-file',
        filterPath,
      ]),
      /--application-filter-input-file requires --search-source direct/,
    );
  });

  it('rejects invalid direct search source values before browser work starts', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let browserCalls = 0;

    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser should not start before search-source validation rejects');
    };

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `invalid-source-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：invalid source',
        '--search-source',
        'manual',
      ]),
      /--search-source must be saved or direct/,
    );
    assert.equal(browserCalls, 0);
  });

  it('rejects normal-capture direct flags in search-subscription mode', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const subscriptionPath = path.join(tempDir, 'search-subscription.json');

    await fs.writeFile(subscriptionPath, JSON.stringify({ keyword: '订阅搜索', conditions: [] }), 'utf8');

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--search-subscription-file',
        subscriptionPath,
        '--search-source',
        'direct',
      ]),
      /--search-subscription-file cannot be combined .*--search-source/,
    );
  });

  it('rejects Liepin forwarding contact on non-Liepin single-platform runs', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `转发联系人-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：转发联系人',
        '--liepin-forward-contact',
        '王经理',
      ]),
      /--liepin-forward-contact can only be used with --platform liepin or --platform all/,
    );
  });

  it('rejects incomplete and cross-platform Boss forwarding arguments', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'boss',
        '--keyword',
        `Boss转发-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：物业电工',
        '--boss-forward-mode',
        'colleague',
      ]),
      /--boss-forward-mode and --boss-forward-recipient must be provided together/,
    );

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `Boss邮件转发-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：物业电工',
        '--boss-forward-mode',
        'email',
        '--boss-forward-recipient',
        'recruiter@example.com',
      ]),
      /--boss-forward-mode and --boss-forward-recipient can only be used with --platform boss/,
    );
  });

  it('keeps Boss screening arguments inside ordinary Boss capture and rejects legacy secondary forwarding', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        '51job',
        '--keyword',
        `非Boss筛选-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：测试岗位',
        '--boss-screening-enabled',
        'true',
      ]),
      /--boss-screening-enabled.*require --platform boss or --platform all --include-boss true/,
    );

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'boss',
        '--keyword',
        `筛选副转发-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：测试岗位',
        '--boss-secondary-forward-mode',
        'email',
        '--boss-secondary-forward-recipient',
        'legacy@example.com',
      ]),
      /no longer supported.*--boss-secondary-email/,
    );

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'boss',
        '--boss-auto-chat',
        'true',
        '--boss-screening-enabled',
        'true',
      ]),
      /--boss-auto-chat cannot be combined .*--boss-screening-enabled/,
    );
  });

  it('keeps Boss auto-chat isolated to Boss with explicit forwarding', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'all',
        '--boss-auto-chat',
        'true',
        '--boss-forward-mode',
        'email',
        '--boss-forward-recipient',
        'recruiter@example.com',
      ]),
      /--boss-forward-mode and --boss-forward-recipient can only be used with --platform boss|--boss-auto-chat can only be used with --platform boss/,
    );

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'boss',
        '--boss-auto-chat',
        'true',
        '--boss-chat-score-threshold',
        '101',
        '--boss-forward-mode',
        'email',
        '--boss-forward-recipient',
        'recruiter@example.com',
      ]),
      /--boss-chat-score-threshold must be a number from 0 to 100/,
    );
  });

  it('requires all Boss hard requirements before forwarding and sends one summary email', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('物业电工', '');
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '物业电工',
      rawText: '负责物业电气维修',
      normalizedJob: {
        ...buildNormalizedJob(),
        title: '物业电工',
        hardRequirements: ['年龄小于47岁', '高压电工证', '低压电工证', '物业电工经验', '一家公司工作2年以上', '上海人'],
      },
      createdAt: '2026-07-12T00:00:00.000Z',
    });

    const chatPage = {} as Page;
    const forwardedCandidates: string[] = [];
    const contactedCandidates: string[] = [];
    const rejectedCandidates: string[] = [];
    const qualifiedActionOrder: string[] = [];
    const summaryDeliveries: Array<{ recipient: string; ccEmails?: string[] }> = [];
    let scoreCalled = false;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({
      page: chatPage,
      context: {},
    }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => [{
      conversationId: 'conversation-matched',
      candidateName: '候选人甲',
      jobName: '物业电工',
      unreadCount: 2,
    }, {
      conversationId: 'conversation-unmatched',
      candidateName: '候选人乙',
      jobName: '物业电工',
      unreadCount: 1,
    }, {
      conversationId: 'conversation-without-jd',
      candidateName: '候选人丙',
      jobName: '未保存岗位',
      unreadCount: 1,
    }];
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => {
      const matched = conversation.conversationId === 'conversation-matched';
      const candidateId = matched ? 'candidate-matched' : 'candidate-unmatched';
      return {
        conversation,
        candidate: {
          candidateId,
          name: matched ? '候选人甲' : '候选人乙',
        },
        resume: buildResume(candidateId),
        previousChat: {
          previouslyChatted: false,
          basis: 'none',
          visibleMessageCount: conversation.unreadCount,
          unreadCountAtOpen: conversation.unreadCount,
        },
      };
    };
    indexModule.openAndParseBossChatResumeRef.fn = async (_page, opened) => opened.resume;
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      scoreCalled = true;
      return buildScore();
    };
    indexModule.evaluateBossChatHardRequirementsRef.fn = (resume) => ({
      allMet: resume.candidateId === 'candidate-matched',
      criteria: [],
      rejectionReasons: resume.candidateId === 'candidate-matched' ? [] : ['缺少高压电工证'],
    });
    indexModule.forwardBossResumeRef.fn = async (_page, candidate) => {
      qualifiedActionOrder.push('forward');
      forwardedCandidates.push(candidate.candidateId);
    };
    indexModule.contactBossQualifiedCandidateRef.fn = async () => {
      qualifiedActionOrder.push('contact');
      contactedCandidates.push('candidate-matched');
      return {
        messageSent: true,
        messageAlreadyPresent: false,
        phoneExchangeRequested: true,
        phoneExchangeAlreadyRequested: false,
      };
    };
    indexModule.contactBossUnqualifiedCandidateRef.fn = async () => {
      rejectedCandidates.push('candidate-unmatched');
      return {
        messageSent: true,
        messageAlreadyPresent: false,
      };
    };
    indexModule.closeBossChatResumeRef.fn = async () => undefined;
    indexModule.sendBossChatSummaryRef.fn = async (_run, delivery) => {
      summaryDeliveries.push(delivery);
      return {
        recipient: delivery.recipient,
        subject: '物业电工 Boss未读候选人审查总结',
      };
    };

    const result = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
      '--boss-chat-score-threshold',
      '80',
      '--boss-chat-require-all',
      'true',
      '--boss-chat-reply-unqualified',
      'true',
      '--boss-forward-mode',
      'email',
      '--boss-forward-recipient',
      'recruiter@example.com',
      '--boss-chat-summary-email',
      'summary@qq.com',
      '--boss-chat-summary-cc',
      'audit@hotmail.com',
    ]);

    assert.equal(Array.isArray(result), false);
    const summary = result as import('../index.js').BossAutoChatRunSummary;
    assert.equal(summary.unreadConversations, 3);
    assert.equal(summary.reviewedConversations, 3);
    assert.equal(summary.matchedCandidates, 1);
    assert.equal(summary.previouslyChattedConversations, 0);
    assert.equal(summary.firstContactConversations, 3);
    assert.equal(summary.followUpConversations, 0);
    assert.equal(summary.newReplyMessages, 0);
    assert.equal(summary.forwardedCandidates, 1);
    assert.equal(summary.chatMessagesSent, 2);
    assert.equal(summary.phoneExchangeRequests, 1);
    assert.equal(summary.skippedConversations, 0);
    assert.equal(summary.failedConversations, 1);
    assert.equal(summary.matchMode, 'all-hard-requirements');
    assert.equal(summary.replyToUnqualifiedCandidates, true);
    assert.equal(summary.summaryEmailRecipient, 'summary@qq.com');
    assert.equal(scoreCalled, false);
    assert.deepStrictEqual(forwardedCandidates, ['candidate-matched']);
    assert.deepStrictEqual(contactedCandidates, ['candidate-matched']);
    assert.deepStrictEqual(rejectedCandidates, ['candidate-unmatched']);
    assert.deepStrictEqual(qualifiedActionOrder, ['forward', 'contact']);
    assert.deepStrictEqual(summaryDeliveries, [{
      recipient: 'summary@qq.com',
      ccEmails: ['audit@hotmail.com'],
    }]);
    assert.equal(summary.items[1]?.status, 'not_matched');
    assert.equal(summary.items[0]?.previousChat?.previouslyChatted, false);
    assert.equal(summary.items[1]?.previousChat?.previouslyChatted, false);
    assert.equal(summary.items[1]?.chatMessageSent, true);
    assert.equal(summary.items[2]?.status, 'failed');
    assert.match(summary.items[2]?.error ?? '', /Missing stored Boss JD/);
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), ['conversation-matched', 'conversation-unmatched']);
    assert.deepStrictEqual((await store.readBossChatRetryItems()).map((item) => item.conversationId), ['conversation-without-jd']);
    assert.deepStrictEqual(await store.readBossAutomationSettings(), {
      forwarding: {
        mode: 'email',
        recipient: 'recruiter@example.com',
      },
      summaryDelivery: {
        recipientEmail: 'summary@qq.com',
        ccEmails: ['audit@hotmail.com'],
      },
    });
    assert.deepStrictEqual((await store.readJobRecord('boss', jobKey)).bossForwarding, {
      mode: 'email',
      recipient: 'recruiter@example.com',
    });
  });

  it('records follow-up replies without JD actions and processes a new red dot for a reviewed conversation', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    await store.saveBossChatReviewedConversationIds(['conversation-follow-up']);

    const chatPage = {} as Page;
    let collection = 0;
    let opened = 0;
    let forbiddenActions = 0;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({ page: chatPage, context: {} }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => {
      collection += 1;
      return [{
        conversationId: 'conversation-follow-up',
        candidateName: '候选人跟进',
        jobName: '未保存岗位',
        unreadCount: 2,
        hasUnreadBadge: collection === 1,
      }];
    };
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => {
      opened += 1;
      return {
        conversation,
        candidate: { candidateId: 'candidate-follow-up', name: '候选人跟进' },
        resume: buildResume('candidate-follow-up'),
        previousChat: {
          previouslyChatted: true,
          basis: 'boss-both-talked',
          visibleMessageCount: 5,
          unreadCountAtOpen: 2,
        },
        newCandidateReplies: [{
          messageId: 'reply-1',
          type: 'text' as const,
          content: '周三可以面试',
        }, {
          messageId: 'reply-2',
          type: 'image' as const,
          content: '[图片]',
        }],
      };
    };
    indexModule.openAndParseBossChatResumeRef.fn = async () => {
      forbiddenActions += 1;
      throw new Error('resume should not open for a follow-up reply');
    };
    indexModule.scoreResumeAgainstJobRef.fn = async () => {
      forbiddenActions += 1;
      return buildScore();
    };
    indexModule.evaluateBossChatHardRequirementsRef.fn = () => {
      forbiddenActions += 1;
      return { allMet: false, criteria: [], rejectionReasons: [] };
    };
    indexModule.forwardBossResumeRef.fn = async () => {
      forbiddenActions += 1;
    };
    indexModule.contactBossQualifiedCandidateRef.fn = async () => {
      forbiddenActions += 1;
      throw new Error('qualified contact should not run for a follow-up reply');
    };
    indexModule.contactBossUnqualifiedCandidateRef.fn = async () => {
      forbiddenActions += 1;
      return { messageSent: false, messageAlreadyPresent: false };
    };
    indexModule.contactBossShanghaiOriginCandidateRef.fn = async () => {
      forbiddenActions += 1;
      return { messageSent: false, messageAlreadyPresent: false };
    };
    indexModule.closeBossChatResumeRef.fn = async () => {
      forbiddenActions += 1;
    };

    const firstResult = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(opened, 1);
    assert.equal(forbiddenActions, 0);
    assert.equal(firstResult.items[0]?.status, 'follow_up_reply');
    assert.equal(firstResult.followUpConversations, 1);
    assert.equal(firstResult.newReplyMessages, 2);
    assert.deepStrictEqual(firstResult.items[0]?.newCandidateReplies?.map((reply) => reply.content), [
      '周三可以面试',
      '[图片]',
    ]);
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), ['conversation-follow-up']);

    const recoveryResult = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(opened, 1);
    assert.equal(forbiddenActions, 0);
    assert.equal(recoveryResult.items[0]?.status, 'skipped_previously_reviewed');
  });

  it('asks for Shanghai-origin clarification without forwarding, rejecting, or marking the conversation reviewed', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('物业电工', '');
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '物业电工',
      rawText: '物业电工，要求上海人',
      normalizedJob: {
        ...buildNormalizedJob(),
        title: '物业电工',
        hardRequirements: ['年龄小于47岁', '高压电工证', '低压电工证', '物业电工经验', '一家公司工作2年以上', '上海人'],
      },
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const chatPage = {} as Page;
    let clarificationCalls = 0;
    let forbiddenActionCalls = 0;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({ page: chatPage, context: {} }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => [{
      conversationId: 'conversation-shanghai-clarification',
      candidateName: '候选人待确认',
      jobName: '物业电工',
      unreadCount: 1,
    }];
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => ({
      conversation,
      candidate: { candidateId: 'candidate-shanghai-clarification', name: '候选人待确认' },
      resume: buildResume('candidate-shanghai-clarification'),
      previousChat: {
        previouslyChatted: false,
        basis: 'none',
        visibleMessageCount: 1,
        unreadCountAtOpen: 1,
      },
    });
    indexModule.openAndParseBossChatResumeRef.fn = async (_page, opened) => opened.resume;
    indexModule.evaluateBossChatHardRequirementsRef.fn = () => ({
      allMet: false,
      criteria: [],
      rejectionReasons: ['简历未明确是否为上海人，但发现上海就读线索，需要确认'],
      clarification: {
        criterionKey: 'shanghai_origin',
        question: '是上海人吗？',
        evidence: ['上海电机学院'],
        reason: '简历未明确是否为上海人，但发现上海就读线索，需要确认',
      },
    });
    indexModule.closeBossChatResumeRef.fn = async () => undefined;
    indexModule.contactBossShanghaiOriginCandidateRef.fn = async () => {
      clarificationCalls += 1;
      return { messageSent: true, messageAlreadyPresent: false };
    };
    indexModule.forwardBossResumeRef.fn = async () => {
      forbiddenActionCalls += 1;
    };
    indexModule.contactBossQualifiedCandidateRef.fn = async () => {
      forbiddenActionCalls += 1;
      throw new Error('qualified contact should not run');
    };
    indexModule.contactBossUnqualifiedCandidateRef.fn = async () => {
      forbiddenActionCalls += 1;
      return { messageSent: true, messageAlreadyPresent: false };
    };

    const result = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
      '--boss-chat-require-all',
      'true',
      '--boss-forward-mode',
      'email',
      '--boss-forward-recipient',
      'recruiter@example.com',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(clarificationCalls, 1);
    assert.equal(forbiddenActionCalls, 0);
    assert.equal(result.reviewedConversations, 1);
    assert.equal(result.matchedCandidates, 0);
    assert.equal(result.previouslyChattedConversations, 0);
    assert.equal(result.firstContactConversations, 1);
    assert.equal(result.chatMessagesSent, 1);
    assert.equal(result.forwardedCandidates, 0);
    assert.equal(result.phoneExchangeRequests, 0);
    assert.equal(result.items[0]?.status, 'awaiting_clarification');
    assert.equal(result.items[0]?.matched, undefined);
    assert.equal(result.items[0]?.clarificationQuestionSent, true);
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), []);
    assert.deepStrictEqual(await store.readBossChatRetryItems(), []);
  });

  it('reuses saved per-job forwarding and Boss summary email settings', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('物业电工', '');
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '物业电工',
      bossForwarding: {
        mode: 'email',
        recipient: 'job-specific@example.com',
        ccEmails: ['job-specific-audit@example.com'],
      },
      rawText: '负责物业电气维修',
      normalizedJob: {
        ...buildNormalizedJob(),
        title: '物业电工',
        hardRequirements: ['年龄小于47岁', '高压电工证', '低压电工证', '物业电工经验', '一家公司工作2年以上', '上海人'],
      },
      createdAt: '2026-07-12T00:00:00.000Z',
    });
    await store.saveBossAutomationSettings({
      forwarding: {
        mode: 'email',
        recipient: 'platform-default@example.com',
      },
      summaryDelivery: {
        recipientEmail: 'summary@qq.com',
        ccEmails: ['audit@hotmail.com', 'audit@hotmail.com'],
      },
    });

    const chatPage = {} as Page;
    const forwardingCalls: Array<{ mode: string; recipient: string; ccEmails?: readonly string[] }> = [];
    const summaryDeliveries: Array<{ recipient: string; ccEmails?: string[] }> = [];
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({ page: chatPage, context: {} }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => [{
      conversationId: 'conversation-saved-settings',
      candidateName: '候选人甲',
      jobName: '物业电工',
      unreadCount: 1,
    }];
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => ({
      conversation,
      candidate: { candidateId: 'candidate-saved-settings', name: '候选人甲' },
      resume: buildResume('candidate-saved-settings'),
      previousChat: {
        previouslyChatted: false,
        basis: 'none',
        visibleMessageCount: 1,
        unreadCountAtOpen: 1,
      },
    });
    indexModule.openAndParseBossChatResumeRef.fn = async (_page, opened) => opened.resume;
    indexModule.evaluateBossChatHardRequirementsRef.fn = () => ({
      allMet: true,
      criteria: [],
      rejectionReasons: [],
    });
    indexModule.forwardBossResumeRef.fn = async (_page, _candidate, mode, recipient, _actionMode, ccEmails) => {
      forwardingCalls.push({ mode, recipient, ccEmails });
    };
    indexModule.closeBossChatResumeRef.fn = async () => undefined;
    indexModule.contactBossQualifiedCandidateRef.fn = async () => ({
      messageSent: true,
      messageAlreadyPresent: false,
      phoneExchangeRequested: true,
      phoneExchangeAlreadyRequested: false,
    });
    indexModule.sendBossChatSummaryRef.fn = async (_run, delivery) => {
      summaryDeliveries.push(delivery);
      return { recipient: delivery.recipient, subject: 'Boss summary' };
    };

    const result = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
      '--boss-chat-require-all',
      'true',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(result.forwardedCandidates, 1);
    assert.equal(result.summaryEmailRecipient, 'summary@qq.com');
    assert.deepStrictEqual(forwardingCalls, [{
      mode: 'email',
      recipient: 'job-specific@example.com',
      ccEmails: ['job-specific-audit@example.com'],
    }]);
    assert.deepStrictEqual(summaryDeliveries, [{
      recipient: 'summary@qq.com',
      ccEmails: ['audit@hotmail.com'],
    }]);
  });

  it('opens a first-contact conversation without forwarding config and retries it after config is supplied', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('物业电工', '');
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '物业电工',
      rawText: '负责物业电气维修',
      normalizedJob: {
        ...buildNormalizedJob(),
        title: '物业电工',
        hardRequirements: ['年龄小于47岁', '高压电工证', '低压电工证', '物业电工经验', '一家公司工作2年以上', '上海人'],
      },
      createdAt: '2026-07-12T00:00:00.000Z',
    });

    const chatPage = {} as Page;
    let opened = 0;
    let collection = 0;
    let unqualifiedContactCalls = 0;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({ page: chatPage, context: {} }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => {
      collection += 1;
      return [{
        conversationId: 'conversation-without-forwarding',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 1,
        hasUnreadBadge: collection === 1,
      }];
    };
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => {
      opened += 1;
      return {
        conversation,
        candidate: { candidateId: 'candidate-without-forwarding', name: '候选人甲' },
        resume: buildResume('candidate-without-forwarding'),
        previousChat: {
          previouslyChatted: false,
          basis: 'none',
          visibleMessageCount: 1,
          unreadCountAtOpen: 1,
        },
      };
    };
    indexModule.openAndParseBossChatResumeRef.fn = async (_page, openedConversation) => openedConversation.resume;
    indexModule.evaluateBossChatHardRequirementsRef.fn = () => ({
      allMet: false,
      criteria: [],
      rejectionReasons: ['缺少高压电工证'],
    });
    indexModule.closeBossChatResumeRef.fn = async () => undefined;
    indexModule.contactBossUnqualifiedCandidateRef.fn = async () => {
      unqualifiedContactCalls += 1;
      return {
        messageSent: true,
        messageAlreadyPresent: false,
      };
    };

    const firstResult = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(opened, 1);
    assert.equal(firstResult.skippedConversations, 0);
    assert.equal(firstResult.failedConversations, 1);
    assert.equal(firstResult.items[0]?.status, 'failed');
    assert.match(firstResult.items[0]?.error ?? '', /Missing stored Boss forwarding configuration/);
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), []);
    assert.deepStrictEqual((await store.readBossChatRetryItems()).map((item) => item.conversationId), ['conversation-without-forwarding']);

    const secondResult = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
      '--boss-chat-require-all',
      'true',
      '--boss-forward-mode',
      'email',
      '--boss-forward-recipient',
      'recruiter@example.com',
    ]) as import('../index.js').BossAutoChatRunSummary;

    assert.equal(opened, 2);
    assert.equal(secondResult.failedConversations, 0);
    assert.equal(secondResult.items[0]?.status, 'not_matched');
    assert.equal(secondResult.items[0]?.chatMessageSent, undefined);
    assert.equal(secondResult.replyToUnqualifiedCandidates, false);
    assert.equal(unqualifiedContactCalls, 0);
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), ['conversation-without-forwarding']);
    assert.deepStrictEqual(await store.readBossChatRetryItems(), []);
  });

  it('preserves successful Boss forwarding when a later contact action fails', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobKey = buildJobKey('物业电工', '');
    await store.saveJobRecord('boss', {
      jobKey,
      platform: 'boss',
      searchKeyword: '物业电工',
      rawText: '负责物业电气维修',
      normalizedJob: {
        ...buildNormalizedJob(),
        title: '物业电工',
        hardRequirements: ['年龄小于47岁', '高压电工证', '低压电工证', '物业电工经验', '一家公司工作2年以上', '上海人'],
      },
      createdAt: '2026-07-12T00:00:00.000Z',
    });

    const chatPage = {} as Page;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({
      page: chatPage,
      context: {},
    }) as never;
    indexModule.closeBrowserSessionRef.fn = async () => undefined;
    indexModule.openBossChatPageRef.fn = async () => chatPage;
    indexModule.collectBossUnreadConversationsRef.fn = async () => [{
      conversationId: 'conversation-contact-failure',
      candidateName: '候选人甲',
      jobName: '物业电工',
      unreadCount: 1,
    }];
    indexModule.openBossUnreadConversationRef.fn = async (_page, conversation) => ({
      conversation,
      candidate: {
        candidateId: 'candidate-contact-failure',
        name: '候选人甲',
      },
      resume: buildResume('candidate-contact-failure'),
      previousChat: {
        previouslyChatted: false,
        basis: 'none',
        visibleMessageCount: 1,
        unreadCountAtOpen: 1,
      },
    });
    indexModule.openAndParseBossChatResumeRef.fn = async (_page, opened) => opened.resume;
    indexModule.evaluateBossChatHardRequirementsRef.fn = () => ({
      allMet: true,
      criteria: [],
      rejectionReasons: [],
    });
    indexModule.forwardBossResumeRef.fn = async () => undefined;
    indexModule.closeBossChatResumeRef.fn = async () => undefined;
    indexModule.contactBossQualifiedCandidateRef.fn = async () => {
      throw new Error('换电话确认失败');
    };
    indexModule.sendBossChatSummaryRef.fn = async (_run, delivery) => ({
      recipient: delivery.recipient,
      subject: '物业电工 Boss未读候选人审查总结',
    });

    const result = await indexModule.main([
      '--platform',
      'boss',
      '--boss-auto-chat',
      'true',
      '--boss-chat-require-all',
      'true',
      '--boss-forward-mode',
      'email',
      '--boss-forward-recipient',
      'recruiter@example.com',
    ]);

    const summary = result as import('../index.js').BossAutoChatRunSummary;
    assert.equal(summary.forwardedCandidates, 1);
    assert.equal(summary.failedConversations, 1);
    assert.equal(summary.items[0]?.forwarded, true);
    assert.equal(summary.items[0]?.status, 'failed');
    assert.equal(summary.items[0]?.error, '换电话确认失败');
    assert.deepStrictEqual(await store.readBossChatReviewedConversationIds(), ['conversation-contact-failure']);
    assert.deepStrictEqual(await store.readBossChatRetryItems(), []);
  });

  it('persists JD file contents as rawText for a first-time job record', async () => {
    const tempDir = await makeIsolatedTempDir();
    const freshDataDir = path.join(tempDir, 'fresh-data');
    const jdFilePath = path.join(tempDir, 'job-description.txt');
    const jdText = '职位名称：东南亚销售经理\n职责描述：负责东南亚销售';
    const freshKeyword = '东南亚 销售 fresh';

    await fs.writeFile(jdFilePath, jdText, 'utf8');
    await fs.mkdir(freshDataDir, { recursive: true });

    const firstRunModule = await loadIndexModule(freshDataDir);
    stubSuccessfulRun(firstRunModule);
    firstRunModule.parseJobDescriptionRef.fn = async () => ({
      ...buildNormalizedJob(),
      title: `${buildNormalizedJob().title} fresh`,
    });

    const output = await captureConsole(async () => {
      process.argv = [
        'node',
        'index.ts',
        '--keyword',
        freshKeyword,
        '--jd-file',
        jdFilePath,
      ];
      await firstRunModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as { jobKey?: string };
    const store = new firstRunModule.JobStore();
    const jobRecord = await store.readJobRecord('51job', summary.jobKey ?? '');

    assert.equal(summary.jobKey, buildJobKey(freshKeyword, `${buildNormalizedJob().title} fresh`));
    assert.equal(jobRecord.rawText, jdText);
  });

  it('reuses the stored job record payload when the jobKey already exists', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    let parseCallCount = 0;
    const existingRecord: import('../types/job.js').JobRecord = {
      jobKey: buildJobKey('东南亚 销售', buildNormalizedJob().title),
      platform: '51job',
      searchKeyword: '东南亚 销售',
      recipientEmail: 'stored@example.com',
      ccEmails: ['stored-cc@example.com'],
      rawText: '旧JD文本',
      normalizedJob: {
        title: '已保存职位',
        majors: ['国际贸易'],
        languageRequirements: ['英语'],
        responsibilities: ['维护客户'],
        hardRequirements: ['可出差'],
        preferredRequirements: ['有零售经验'],
        regionPreferences: ['东南亚'],
        industryTags: ['服饰'],
      },
      createdAt: '2026-04-01T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', existingRecord);
    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async () => {
      parseCallCount += 1;
      throw new Error('JD parser should not run for an existing jobKey');
    };

    const output = await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true, ccArg: 'override-cc@example.com' });
      await indexModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as { jobKey?: string };
    const savedJobRecord = await store.readJobRecord('51job', summary.jobKey ?? '');

    assert.equal(parseCallCount, 0);
    assert.equal(savedJobRecord.jobKey, existingRecord.jobKey);
    assert.equal(savedJobRecord.rawText, '旧JD文本');
    assert.deepStrictEqual(savedJobRecord.normalizedJob, existingRecord.normalizedJob);
    assert.equal(savedJobRecord.recipientEmail, 'ops@example.com');
    assert.deepStrictEqual(savedJobRecord.ccEmails, ['override-cc@example.com']);
    assert.equal(savedJobRecord.createdAt, '2026-04-01T00:00:00.000Z');
  });

  it('does not reuse a stored job record across platforms for the same keyword', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const keyword = `shared-platform-keyword-${Date.now()}`;
    const parsedTexts: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async (rawText: string) => {
      parsedTexts.push(rawText);
      return buildNormalizedJob();
    };

    await indexModule.main([
      '--platform',
      '51job',
      '--keyword',
      keyword,
      '--jd',
      '51job jd',
    ]);
    await indexModule.main([
      '--platform',
      'liepin',
      '--keyword',
      keyword,
      '--jd',
      'liepin jd',
    ]);

    const store = new indexModule.JobStore();
    const fiftyOneJobRecord = await store.readJobRecord('51job', keyword);
    const liepinJobRecord = await store.readJobRecord('liepin', keyword);

    assert.deepStrictEqual(parsedTexts, ['51job jd', 'liepin jd']);
    assert.equal(fiftyOneJobRecord.platform, '51job');
    assert.equal(fiftyOneJobRecord.rawText, '51job jd');
    assert.equal(liepinJobRecord.platform, 'liepin');
    assert.equal(liepinJobRecord.rawText, 'liepin jd');
  });

  it('runs every supported platform in registry order when --platform all is provided', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const keyword = `all-platform-keyword-${Date.now()}`;
    const authenticatedPlatforms: string[] = [];
    const exportPlatforms: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async (platform) => {
      authenticatedPlatforms.push(platform);
      return {
        page: { id: `${platform}-root-page`, close: async () => undefined },
        context: { close: async () => undefined },
        browser: { close: async () => undefined },
      } as never;
    };
    indexModule.exportJobResultsRef.fn = async (platform: string, jobKey: string) => {
      exportPlatforms.push(platform);
      return {
        jobKey,
        exportPath: `/tmp/${platform}-export.md`,
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        markdown: '# export',
      };
    };

    const output = await captureConsole(async () => {
      const result = assertAllPlatformsSummary(await indexModule.main([
        '--platform',
        'all',
        '--keyword',
        keyword,
        '--jd',
        '职位名称：多平台测试',
      ]));

      assert.deepStrictEqual(result.map((entry) => entry.platform), ['51job', 'liepin', 'zhilian']);
      assert.deepStrictEqual(result.map((entry) => entry.summary.jobKey), [keyword, keyword, keyword]);
    });

    const printedSummary = JSON.parse(output.stdout.at(-1) ?? '[]') as Array<{ platform: string; summary: { jobKey: string } }>;
    const store = new indexModule.JobStore();
    const fiftyOneJobRecord = await store.readJobRecord('51job', keyword);
    const liepinJobRecord = await store.readJobRecord('liepin', keyword);
    const zhilianJobRecord = await store.readJobRecord('zhilian', keyword);

    assert.deepStrictEqual(authenticatedPlatforms, ['51job', 'liepin', 'zhilian']);
    assert.deepStrictEqual(exportPlatforms, ['51job', 'liepin', 'zhilian']);
    assert.deepStrictEqual(printedSummary.map((entry) => entry.platform), ['51job', 'liepin', 'zhilian']);
    assert.equal(fiftyOneJobRecord.platform, '51job');
    assert.equal(liepinJobRecord.platform, 'liepin');
    assert.equal(zhilianJobRecord.platform, 'zhilian');
    assert.equal(fiftyOneJobRecord.rawText, '职位名称：多平台测试');
    assert.equal(liepinJobRecord.rawText, '职位名称：多平台测试');
    assert.equal(zhilianJobRecord.rawText, '职位名称：多平台测试');
  });

  it('adds Boss as the fourth capture platform only when --include-boss true is provided', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const keyword = `all-platform-boss-${Date.now()}`;
    const authenticatedPlatforms: string[] = [];
    const exportPlatforms: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async (platform) => {
      authenticatedPlatforms.push(platform);
      return {
        page: { id: `${platform}-root-page`, close: async () => undefined },
        context: { close: async () => undefined },
        browser: { close: async () => undefined },
      } as never;
    };
    indexModule.exportJobResultsRef.fn = async (platform: string, jobKey: string) => {
      exportPlatforms.push(platform);
      return {
        jobKey,
        exportPath: `/tmp/${platform}-export.md`,
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        markdown: '# export',
      };
    };

    const output = await captureConsole(async () => {
      const result = assertAllPlatformsSummary(await indexModule.main([
        '--platform',
        'all',
        '--include-boss',
        'true',
        '--keyword',
        keyword,
        '--jd',
        '职位名称：含直猎邦全平台测试',
        '--search-source',
        'direct',
      ]));

      assert.deepStrictEqual(result.map((entry) => entry.platform), ['51job', 'liepin', 'zhilian', 'boss']);
    });

    assert.deepStrictEqual(authenticatedPlatforms, ['51job', 'liepin', 'zhilian', 'boss']);
    assert.deepStrictEqual(exportPlatforms, ['51job', 'liepin', 'zhilian', 'boss']);
    assert.match(output.stderr.join('\n'), /may open resume details and reuse saved Boss forwarding settings/);
    const store = new indexModule.JobStore();
    assert.equal((await store.readJobRecord('boss', keyword)).platform, 'boss');
  });

  it('rejects --include-boss outside all-platform capture even when false', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'boss',
        '--include-boss',
        'false',
        '--keyword',
        `include-boss-single-${Date.now()}`,
        '--jd',
        '职位名称：直猎邦参数隔离',
      ]),
      /--include-boss can only be used with --platform all/,
    );
  });

  it('preflights every opt-in capture platform before opening a browser', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const keyword = `all-platform-preflight-${Date.now()}`;
    const authenticatedPlatforms: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async (platform) => {
      authenticatedPlatforms.push(platform);
      return {
        page: { id: `${platform}-root-page`, close: async () => undefined },
        context: { close: async () => undefined },
        browser: { close: async () => undefined },
      } as never;
    };

    for (const platform of ['51job', 'liepin', 'zhilian'] as const) {
      await indexModule.main([
        '--platform',
        platform,
        '--keyword',
        keyword,
        '--jd',
        '职位名称：预检测试',
      ]);
    }
    authenticatedPlatforms.length = 0;

    await assert.rejects(
      () => indexModule.main([
        '--platform',
        'all',
        '--include-boss',
        'true',
        '--keyword',
        keyword,
        '--search-source',
        'direct',
      ]),
      new RegExp(`Capture preflight failed before opening a browser:[\\s\\S]*${keyword} / boss: Missing required argument --jd or --jd-file`),
    );
    assert.deepStrictEqual(authenticatedPlatforms, []);
  });

  it('runs direct search for every supported platform in registry order when --platform all is provided', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const directOrder: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async () => {
      throw new Error('saved 51job search should not run in direct all-platform mode');
    }) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openDirectSearchRef.fn = (async () => {
      directOrder.push('51job');
      return createSearchPage();
    }) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;
    liepinAdapter.openSubscribeSearch = async () => {
      throw new Error('saved Liepin search should not run in direct all-platform mode');
    };
    liepinAdapter.openDirectSearch = async () => {
      directOrder.push('liepin');
      return createSearchPage();
    };
    zhilianAdapter.openSubscribeSearch = async () => {
      throw new Error('saved Zhilian search should not run in direct all-platform mode');
    };
    zhilianAdapter.openDirectSearch = async () => {
      directOrder.push('zhilian');
      return createSearchPage();
    };

    await captureConsole(async () => {
      const result = assertAllPlatformsSummary(await indexModule.main([
        '--platform',
        'all',
        '--keyword',
        `direct-all-${Date.now()}-${Math.random()}`,
        '--jd',
        '职位名称：direct all',
        '--search-source',
        'direct',
      ]));

      assert.deepStrictEqual(result.map((entry) => entry.platform), ['51job', 'liepin', 'zhilian']);
    });

    assert.deepStrictEqual(directOrder, ['51job', 'liepin', 'zhilian']);
  });

  it('runs batch jobs in file order with their own JD payloads', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'jobs.json');
    const jdFilePath = path.join(tempDir, 'jd-file.txt');
    const parsedTexts: string[] = [];

    await fs.writeFile(jdFilePath, '职位名称：第二批量岗位', 'utf8');
    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch keyword one', jd: '职位名称：第一批量岗位' },
      { keyword: 'batch keyword two', jdFile: jdFilePath },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async (rawText: string) => {
      parsedTexts.push(rawText);
      return buildNormalizedJob();
    };

    const output = await captureConsole(async () => {
      const result = assertBatchSummary(await indexModule.main([
        '--platform',
        '51job',
        '--jobs-file',
        jobsFilePath,
      ]));

      assert.deepStrictEqual(result.map((entry) => entry.keyword), ['batch keyword one', 'batch keyword two']);
      assert.deepStrictEqual(result.map((entry) => entry.platform), ['51job', '51job']);
      assert.deepStrictEqual(result.map((entry) => entry.summary.jobKey), ['batch-keyword-one', 'batch-keyword-two']);
    });

    const printedSummary = JSON.parse(output.stdout.at(-1) ?? '[]') as Array<{
      keyword: string;
      platform: string;
      summary: { jobKey: string };
    }>;
    const store = new indexModule.JobStore();
    const firstJobRecord = await store.readJobRecord('51job', 'batch-keyword-one');
    const secondJobRecord = await store.readJobRecord('51job', 'batch-keyword-two');

    assert.deepStrictEqual(parsedTexts, ['职位名称：第一批量岗位', '职位名称：第二批量岗位']);
    assert.deepStrictEqual(printedSummary.map((entry) => `${entry.keyword}:${entry.platform}:${entry.summary.jobKey}`), [
      'batch keyword one:51job:batch-keyword-one',
      'batch keyword two:51job:batch-keyword-two',
    ]);
    assert.equal(firstJobRecord.rawText, '职位名称：第一批量岗位');
    assert.equal(secondJobRecord.rawText, '职位名称：第二批量岗位');
  });

  it('lets each Boss jobs-file item override primary forwarding and rejection-email targets', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'boss-routing-jobs.json');
    const policyFilePath = path.join(tempDir, 'boss-negative-policy.json');
    await fs.writeFile(policyFilePath, JSON.stringify({
      version: 2,
      decisionMode: 'reject-on-any-missing',
      requirements: [buildModelScreeningSettings().requirements[0]],
    }), 'utf8');
    await fs.writeFile(jobsFilePath, JSON.stringify([
      {
        keyword: 'Boss batch routing one',
        jd: '职位名称：Boss批量分流一',
        email: 'primary-one@example.com',
        cc: ['primary-report-one@example.com'],
        bossForwardMode: 'email',
        bossForwardRecipient: 'primary-forward-one@example.com',
        bossForwardCc: ['primary-forward-audit-one@example.com'],
        bossScreeningEnabled: true,
        bossScreeningPolicyFile: './boss-negative-policy.json',
        bossSecondaryEmail: 'secondary-report-one@example.com',
        bossSecondaryCc: ['secondary-report-audit-one@example.com'],
      },
      {
        keyword: 'Boss batch routing two',
        jd: '职位名称：Boss批量分流二',
        email: 'primary-two@example.com',
        cc: [],
        bossForwardMode: 'colleague',
        bossForwardRecipient: '主招聘同事二',
        bossForwardCc: [],
        bossScreeningEnabled: true,
        bossScreeningPolicyFile: './boss-negative-policy.json',
        bossSecondaryEmail: 'secondary-report-two@example.com',
        bossSecondaryCc: [],
      },
    ]), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.scoreAndEvaluateBossScreeningRef.fn = async () => ({
      score: buildScore(),
      evaluations: [buildModelRequirementEvaluation('satisfied', 'batch routing evidence')],
    });
    indexModule.forwardBossResumeRef.fn = async () => undefined;
    const originalSendJobReportEmail = sendJobReportEmailRef.fn;
    sendJobReportEmailRef.fn = async ({ recipient, subject }) => ({ recipient, subject });
    try {
      await captureConsole(async () => {
        await indexModule.main([
          '--platform',
          'boss',
          '--jobs-file',
          jobsFilePath,
          '--search-source',
          'direct',
          '--boss-forward-mode',
          'email',
          '--boss-forward-recipient',
          'run-level-should-not-win@example.com',
        ]);
      });
    } finally {
      sendJobReportEmailRef.fn = originalSendJobReportEmail;
    }

    const store = new indexModule.JobStore();
    const first = await store.readJobRecord('boss', 'boss-batch-routing-one');
    const second = await store.readJobRecord('boss', 'boss-batch-routing-two');
    assert.deepStrictEqual(first.bossForwarding, {
      mode: 'email',
      recipient: 'primary-forward-one@example.com',
      ccEmails: ['primary-forward-audit-one@example.com'],
    });
    assert.deepStrictEqual(first.ccEmails, ['primary-report-one@example.com']);
    assert.deepStrictEqual(first.bossScreening?.secondaryDelivery, {
      recipientEmail: 'secondary-report-one@example.com',
      ccEmails: ['secondary-report-audit-one@example.com'],
    });
    assert.deepStrictEqual(second.bossForwarding, {
      mode: 'colleague',
      recipient: '主招聘同事二',
      ccEmails: [],
    });
    assert.deepStrictEqual(second.ccEmails, []);
    assert.deepStrictEqual(second.bossScreening?.secondaryDelivery?.ccEmails, []);
  });

  it('runs batch jobs outer and supported platforms inner for --platform all', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'jobs-all.json');
    const exportOrder: string[] = [];

    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch all one', jd: '职位名称：批量全平台一' },
      { keyword: 'batch all two', jd: '职位名称：批量全平台二' },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.exportJobResultsRef.fn = async (platform: string, jobKey: string) => {
      exportOrder.push(`${jobKey}:${platform}`);
      return {
        jobKey,
        exportPath: `/tmp/${platform}-${jobKey}.md`,
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        markdown: '# export',
      };
    };

    const output = await captureConsole(async () => {
      const result = assertBatchSummary(await indexModule.main([
        '--platform',
        'all',
        '--jobs-file',
        jobsFilePath,
      ]));

      assert.deepStrictEqual(result.map((entry) => `${entry.summary.jobKey}:${entry.platform}`), [
        'batch-all-one:51job',
        'batch-all-one:liepin',
        'batch-all-one:zhilian',
        'batch-all-two:51job',
        'batch-all-two:liepin',
        'batch-all-two:zhilian',
      ]);
    });

    const printedSummary = JSON.parse(output.stdout.at(-1) ?? '[]') as Array<{ platform: string; summary: { jobKey: string } }>;

    assert.deepStrictEqual(exportOrder, [
      'batch-all-one:51job',
      'batch-all-one:liepin',
      'batch-all-one:zhilian',
      'batch-all-two:51job',
      'batch-all-two:liepin',
      'batch-all-two:zhilian',
    ]);
    assert.deepStrictEqual(printedSummary.map((entry) => `${entry.summary.jobKey}:${entry.platform}`), exportOrder);
  });

  it('runs batch jobs outer and includes Boss fourth only with --include-boss true', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'jobs-all-boss.json');
    const exportOrder: string[] = [];

    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch boss one', jd: '职位名称：批量直猎邦一' },
      { keyword: 'batch boss two', jd: '职位名称：批量直猎邦二' },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.exportJobResultsRef.fn = async (platform: string, jobKey: string) => {
      exportOrder.push(`${jobKey}:${platform}`);
      return {
        jobKey,
        exportPath: `/tmp/${platform}-${jobKey}.md`,
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        markdown: '# export',
      };
    };

    await captureConsole(async () => {
      const result = assertBatchSummary(await indexModule.main([
        '--platform',
        'all',
        '--include-boss',
        'true',
        '--jobs-file',
        jobsFilePath,
        '--search-source',
        'direct',
      ]));

      assert.deepStrictEqual(result.map((entry) => `${entry.summary.jobKey}:${entry.platform}`), [
        'batch-boss-one:51job',
        'batch-boss-one:liepin',
        'batch-boss-one:zhilian',
        'batch-boss-one:boss',
        'batch-boss-two:51job',
        'batch-boss-two:liepin',
        'batch-boss-two:zhilian',
        'batch-boss-two:boss',
      ]);
    });

    assert.deepStrictEqual(exportOrder, [
      'batch-boss-one:51job',
      'batch-boss-one:liepin',
      'batch-boss-one:zhilian',
      'batch-boss-one:boss',
      'batch-boss-two:51job',
      'batch-boss-two:liepin',
      'batch-boss-two:zhilian',
      'batch-boss-two:boss',
    ]);
  });

  it('allows batch jobs to override direct application filter input files relative to the jobs file', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsDir = path.join(tempDir, 'batch');
    const jobsFilePath = path.join(jobsDir, 'jobs.json');
    const applicationFilterOptionsPath = path.join(tempDir, '51job', 'filter-catalog', 'application-filter-options.latest.json');
    const directConditionsByKeyword = new Map<string, import('../types/job.js').SearchCondition[]>();

    await fs.mkdir(path.dirname(applicationFilterOptionsPath), { recursive: true });
    await fs.mkdir(jobsDir, { recursive: true });
    await fs.writeFile(applicationFilterOptionsPath, JSON.stringify({
      platform: '51job',
      capturedAt: '2026-06-01T00:00:00.000Z',
      keyword: 'batch',
      fieldCount: 1,
      fieldIds: ['education'],
      fieldIdByLabel: { 学历要求: 'education' },
      groups: {
        singleSelect: ['education'],
        textInput: [],
        salaryRange: [],
        numberRange: [],
      },
      fieldsById: {
        education: {
          fieldId: 'education',
          filterKey: 'education',
          label: '学历要求',
          kind: 'singleSelect',
          restrictInput: true,
          valueShape: 'string',
          acceptedInputShapes: ['string'],
          allowedValues: ['本科', '硕士'],
          options: [
            { label: '本科', value: '本科', disabled: false, selected: false },
            { label: '硕士', value: '硕士', disabled: false, selected: false },
          ],
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(jobsDir, 'first-filter.json'), JSON.stringify({ education: '本科' }), 'utf8');
    await fs.writeFile(path.join(jobsDir, 'second-filter.json'), JSON.stringify({ education: '硕士' }), 'utf8');
    await fs.writeFile(jobsFilePath, JSON.stringify([
      {
        keyword: 'batch direct one',
        jd: '职位名称：批量直接一',
        searchSource: 'direct',
        applicationFilterInputFile: 'first-filter.json',
      },
      {
        keyword: 'batch direct two',
        jd: '职位名称：批量直接二',
        searchSource: 'direct',
        applicationFilterInputFile: 'second-filter.json',
      },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.openDirectSearchRef.fn = (async (_page, keyword, conditions) => {
      directConditionsByKeyword.set(keyword, conditions);
      return createSearchPage();
    }) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--jobs-file',
        jobsFilePath,
      ]);
    });

    const firstFilterConditions = directConditionsByKeyword.get('batch direct one')?.filter((condition) => condition.kind === 'applicationFilter');
    const secondFilterConditions = directConditionsByKeyword.get('batch direct two')?.filter((condition) => condition.kind === 'applicationFilter');
    assert.deepStrictEqual(firstFilterConditions?.map((condition) => (condition as { values?: Array<{ value: string }> }).values?.[0]?.value), ['本科']);
    assert.deepStrictEqual(secondFilterConditions?.map((condition) => (condition as { values?: Array<{ value: string }> }).values?.[0]?.value), ['硕士']);
  });

  it('allows a batch job to override a CLI direct default back to saved search', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'jobs.json');
    const applicationFilterOptionsPath = path.join(tempDir, '51job', 'filter-catalog', 'application-filter-options.latest.json');
    const applicationFilterInputPath = path.join(tempDir, 'filter-input.json');
    const searchCalls: string[] = [];

    await fs.mkdir(path.dirname(applicationFilterOptionsPath), { recursive: true });
    await fs.writeFile(applicationFilterOptionsPath, JSON.stringify({
      platform: '51job',
      capturedAt: '2026-06-01T00:00:00.000Z',
      keyword: 'batch',
      fieldCount: 1,
      fieldIds: ['education'],
      fieldIdByLabel: { 学历要求: 'education' },
      groups: {
        singleSelect: ['education'],
        textInput: [],
        salaryRange: [],
        numberRange: [],
      },
      fieldsById: {
        education: {
          fieldId: 'education',
          filterKey: 'education',
          label: '学历要求',
          kind: 'singleSelect',
          restrictInput: true,
          valueShape: 'string',
          acceptedInputShapes: ['string'],
          allowedValues: ['本科'],
          options: [
            { label: '本科', value: '本科', disabled: false, selected: false },
          ],
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(applicationFilterInputPath, JSON.stringify({ education: '本科' }), 'utf8');
    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch saved override', jd: '职位名称：批量保存入口', searchSource: 'saved' },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.openSubscribeSearchRef.fn = (async () => {
      searchCalls.push('saved');
      return createSearchPage();
    }) as typeof indexModule.openSubscribeSearchRef.fn;
    indexModule.openDirectSearchRef.fn = (async () => {
      searchCalls.push('direct');
      return createSearchPage();
    }) as NonNullable<typeof indexModule.openDirectSearchRef.fn>;

    await captureConsole(async () => {
      await indexModule.main([
        '--platform',
        '51job',
        '--jobs-file',
        jobsFilePath,
        '--search-source',
        'direct',
        '--application-filter-input-file',
        applicationFilterInputPath,
      ]);
    });

    assert.deepStrictEqual(searchCalls, ['saved']);
  });

  it('allows batch reruns without JD input when the jobKey already exists', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const jobsFilePath = path.join(tempDir, 'jobs-existing.json');
    const existingRecord: import('../types/job.js').JobRecord = {
      jobKey: 'batch-existing-keyword',
      platform: '51job',
      searchKeyword: 'batch existing keyword',
      rawText: '已保存批量JD',
      normalizedJob: buildNormalizedJob(),
      createdAt: '2026-04-01T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', existingRecord);
    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch existing keyword' },
    ], null, 2), 'utf8');

    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async () => {
      throw new Error('JD parser should not run for an existing batch jobKey');
    };

    const output = await captureConsole(async () => {
      const result = assertBatchSummary(await indexModule.main([
        '--platform',
        '51job',
        '--jobs-file',
        jobsFilePath,
      ]));

      assert.deepStrictEqual(result.map((entry) => entry.summary.jobKey), ['batch-existing-keyword']);
    });

    const printedSummary = JSON.parse(output.stdout.at(-1) ?? '[]') as Array<{ summary: { jobKey: string } }>;
    const savedRecord = await store.readJobRecord('51job', 'batch-existing-keyword');

    assert.deepStrictEqual(printedSummary.map((entry) => entry.summary.jobKey), ['batch-existing-keyword']);
    assert.equal(savedRecord.rawText, '已保存批量JD');
  });

  it('rejects --jobs-file combined with single-job arguments before browser work starts', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jobsFilePath = path.join(tempDir, 'jobs.json');
    let browserCalls = 0;
    let parseCalls = 0;

    await fs.writeFile(jobsFilePath, JSON.stringify([
      { keyword: 'batch keyword', jd: '职位名称：批量岗位' },
    ], null, 2), 'utf8');
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => {
      browserCalls += 1;
      throw new Error('browser should not start before jobs-file validation rejects');
    };
    indexModule.parseJobDescriptionRef.fn = async () => {
      parseCalls += 1;
      throw new Error('JD parser should not run before jobs-file validation rejects');
    };

    await assert.rejects(
      () => indexModule.main([
        '--jobs-file',
        jobsFilePath,
        '--keyword',
        'single keyword',
      ]),
      /--jobs-file cannot be combined with --keyword, --jd, or --jd-file/,
    );
    assert.equal(browserCalls, 0);
    assert.equal(parseCalls, 0);
  });

  it('allows reruns without JD arguments when the jobKey already exists', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const existingRecord: import('../types/job.js').JobRecord = {
      jobKey: buildJobKey('东南亚 销售', buildNormalizedJob().title),
      platform: '51job',
      searchKeyword: '东南亚 销售',
      rawText: '旧JD文本',
      normalizedJob: buildNormalizedJob(),
      createdAt: '2026-04-01T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', existingRecord);
    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async () => {
      throw new Error('JD parser should not run when rerun omits JD arguments');
    };

    const output = await captureConsole(async () => {
      await indexModule.main(['--keyword', '东南亚 销售']);
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as { jobKey?: string };

    assert.equal(summary.jobKey, existingRecord.jobKey);
  });

  it('skips jd-file reads when the jobKey already exists', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const store = new indexModule.JobStore();
    const existingRecord: import('../types/job.js').JobRecord = {
      jobKey: buildJobKey('东南亚 销售', buildNormalizedJob().title),
      platform: '51job',
      searchKeyword: '东南亚 销售',
      rawText: '旧JD文本',
      normalizedJob: buildNormalizedJob(),
      createdAt: '2026-04-01T00:00:00.000Z',
    };

    await store.saveJobRecord('51job', existingRecord);
    stubSuccessfulRun(indexModule);
    indexModule.parseJobDescriptionRef.fn = async () => {
      throw new Error('JD parser should not run when existing jobKey short-circuits file input');
    };

    const output = await captureConsole(async () => {
      await indexModule.main(['--keyword', '东南亚 销售', '--jd-file', path.join(tempDir, 'missing-jd.txt')]);
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as { jobKey?: string };

    assert.equal(summary.jobKey, existingRecord.jobKey);
  });

  it('rejects mutually exclusive --jd and --jd-file arguments', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const jdFilePath = path.join(tempDir, 'job-description.txt');

    await fs.writeFile(jdFilePath, '职位名称：东南亚销售经理', 'utf8');

    await assert.rejects(
      () => indexModule.main([
        '--keyword',
        '东南亚 销售',
        '--jd',
        '职位名称：东南亚销售经理',
        '--jd-file',
        jdFilePath,
      ]),
      /mutually exclusive/,
    );
  });

  it('rejects first-time runs with neither --jd nor --jd-file', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    stubSuccessfulRun(indexModule);

    await assert.rejects(
      () => indexModule.main(['--keyword', '首次运行 fresh']),
      /--jd or --jd-file/,
    );
  });

  it('exports a report after a successful run completes', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const exportCalls: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.exportJobResultsRef.fn = async (_platform: string, jobKey: string) => {
      exportCalls.push(jobKey);
      return {
        jobKey,
        exportPath: '/tmp/export.md',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
        markdown: '# export',
      };
    };
    indexModule.sendJobReportRef.fn = async (_platform: string, _jobKey: string) => {
      throw new Error('email should not run without recipient');
    };

    await captureConsole(async () => {
      process.argv = buildArgs();
      await indexModule.main();
    });

    assert.equal(exportCalls.length, 1);
  });

  it('keeps the run successful when export fails', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    stubSuccessfulRun(indexModule);
    indexModule.exportJobResultsRef.fn = async (_platform: string, _jobKey: string) => {
      throw new Error('export failed');
    };
    indexModule.sendJobReportRef.fn = async (_platform: string, _jobKey: string) => {
      throw new Error('email should be skipped when export fails');
    };

    const output = await captureConsole(async () => {
      process.argv = buildArgs();
      await indexModule.main();
    });

    assert.match(output.stderr.join('\n'), /export failed/);
    assert.match(output.stdout.join('\n'), /"resultPath"/);
  });

  it('marks emailDelivered true when export fails for an empty latest run but email succeeds', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    stubSuccessfulRun(indexModule);
    indexModule.extractCandidateListRef.fn = async () => ({
      candidates: [],
    });
    indexModule.extractionBoundary.extractCandidateListFromPage = async () => ({
      candidates: [],
    });
    indexModule.exportJobResultsRef.fn = async (_platform: string, _jobKey: string) => {
      throw new Error('No score artifacts found for latest run of job key 东南亚销售经理; expected candidate IDs: (none)');
    };
    indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => ({
      jobKey,
      recipient: deliveryOverrides.recipientEmail ?? 'ops@example.com',
      subject: '东南亚销售经理 本次无新增候选人',
      summary: { candidateCount: 0, successCount: 0, failureCount: 0 },
    });

    const output = await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true });
      await indexModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
      newCandidates?: number;
      emailDelivered?: boolean;
      emailSubject?: string;
      exportError?: string;
      resultPath?: string;
    };

    assert.equal(summary.newCandidates, 0);
    assert.equal(summary.emailDelivered, true);
    assert.equal(summary.emailSubject, '东南亚销售经理 本次无新增候选人');
    assert.ok(summary.exportError?.includes('No score artifacts found for latest run'));

    const latestSavedRun = JSON.parse(await fs.readFile(summary.resultPath ?? '', 'utf8')) as {
      totalCandidates: number;
      capturedCandidateIds: string[];
      scoredCandidates: string[];
      failedCandidates: Array<{ candidateId: string; error: string }>;
    };

    assert.equal(latestSavedRun.totalCandidates, 0);
    assert.deepStrictEqual(latestSavedRun.capturedCandidateIds, []);
    assert.equal('newCandidateIds' in latestSavedRun, false);
    assert.deepStrictEqual(latestSavedRun.scoredCandidates, []);
    assert.deepStrictEqual(latestSavedRun.failedCandidates, []);
  });

  it('keeps the run successful when email delivery fails', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);

    stubSuccessfulRun(indexModule);
    indexModule.sendJobReportRef.fn = async (_platform: string, _jobKey: string) => {
      throw new Error('smtp failed');
    };

    const output = await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true });
      await indexModule.main();
    });

    assert.match(output.stderr.join('\n'), /smtp failed/);
    assert.match(output.stdout.join('\n'), /"exportPath": "\/tmp\/export.md"/);
    assert.match(output.stdout.join('\n'), /"emailDelivered": false/);
  });

  it('delivers email to the stored recipient across reruns without --email', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const deliveredRecipients: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => {
      deliveredRecipients.push(deliveryOverrides.recipientEmail ?? 'ops@example.com');
      return {
        jobKey,
        recipient: deliveryOverrides.recipientEmail ?? 'ops@example.com',
        subject: 'subject',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      };
    };

    await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true });
      await indexModule.main();
    });

    const output = await captureConsole(async () => {
      process.argv = buildArgs();
      await indexModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
      jobKey?: string;
      emailDelivered?: boolean;
      emailRecipient?: string;
    };
    const store = new indexModule.JobStore();
    const jobRecord = await store.readJobRecord('51job', summary.jobKey ?? '');

    assert.equal(jobRecord.recipientEmail, 'ops@example.com');
    assert.equal(summary.emailDelivered, true);
    assert.equal(summary.emailRecipient, 'ops@example.com');
    assert.deepStrictEqual(deliveredRecipients, ['ops@example.com', 'ops@example.com']);
  });

  it('uses the stored recipient when available on reruns without a CLI email', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const receivedRecipients: string[] = [];

    stubSuccessfulRun(indexModule);
    indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => {
      receivedRecipients.push(deliveryOverrides.recipientEmail ?? '');
      return {
        jobKey,
        recipient: deliveryOverrides.recipientEmail ?? 'ops@example.com',
        subject: 'subject',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      };
    };

    await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true });
      await indexModule.main();
    });

    const output = await captureConsole(async () => {
      process.argv = buildArgs();
      await indexModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
      emailAttempted?: boolean;
      emailDelivered?: boolean;
      emailRecipient?: string;
    };

    assert.deepStrictEqual(receivedRecipients, ['ops@example.com', 'ops@example.com']);
    assert.equal(summary.emailAttempted, true);
    assert.equal(summary.emailDelivered, true);
    assert.equal(summary.emailRecipient, 'ops@example.com');
  });

  it('passes the CLI cc list through to report delivery', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    let receivedCcEmails: string[] | undefined;

    stubSuccessfulRun(indexModule);
    indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => {
      receivedCcEmails = deliveryOverrides.ccEmails;
      return {
        jobKey,
        recipient: deliveryOverrides.recipientEmail ?? '',
        subject: 'subject',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      };
    };

    await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true, ccArg: 'cc1@example.com, cc2@example.com' });
      await indexModule.main();
    });

    assert.deepStrictEqual(receivedCcEmails, ['cc1@example.com', 'cc2@example.com']);
  });

  it('clears stored cc emails when --cc is provided as an empty string', async () => {
    const tempDir = await makeIsolatedTempDir();
    const indexModule = await loadIndexModule(tempDir);
    const deliveredCcLists: Array<string[] | undefined> = [];

    stubSuccessfulRun(indexModule);
    indexModule.sendJobReportRef.fn = async (_platform: string, jobKey: string, deliveryOverrides = {}) => {
      deliveredCcLists.push(deliveryOverrides.ccEmails);
      return {
        jobKey,
        recipient: deliveryOverrides.recipientEmail ?? 'ops@example.com',
        subject: 'subject',
        summary: { candidateCount: 1, successCount: 1, failureCount: 0 },
      };
    };

    await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true, ccArg: 'cc1@example.com,cc2@example.com' });
      await indexModule.main();
    });

    const output = await captureConsole(async () => {
      process.argv = buildArgs({ includeEmail: true, ccArg: '' });
      await indexModule.main();
    });

    const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
      jobKey?: string;
    };
    const store = new indexModule.JobStore();
    const jobRecord = await store.readJobRecord('51job', summary.jobKey ?? '');

    assert.deepStrictEqual(jobRecord.ccEmails, []);
    assert.deepStrictEqual(deliveredCcLists, [
      ['cc1@example.com', 'cc2@example.com'],
      [],
    ]);
  });

});

describe('OpenAI config resolution', () => {
  it('ignores legacy env vars when resolving scoring settings', () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalOpenAIModel = process.env.OPENAI_MODEL;
    const originalLegacyKey = process.env.LEGACY_API_KEY;

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    process.env.LEGACY_API_KEY = 'legacy-test-key';

    try {
      assert.throws(
        () => resolveOpenAISettings('scoring', 'SCORING_MODEL'),
        /Missing required environment variable: OPENAI_API_KEY/,
      );
    } finally {
      if (originalOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
      }

      if (originalOpenAIModel === undefined) {
        delete process.env.OPENAI_MODEL;
      } else {
        process.env.OPENAI_MODEL = originalOpenAIModel;
      }

      if (originalLegacyKey === undefined) {
        delete process.env.LEGACY_API_KEY;
      } else {
        process.env.LEGACY_API_KEY = originalLegacyKey;
      }
    }
  });
});

describe('extractCandidateScoreFromTextResponse', () => {
  it('parses a raw JSON score response', () => {
    const score = extractCandidateScoreFromTextResponse(JSON.stringify({
      totalScore: 87,
      dimensionScores: {
        education: { score: 80, reason: '本科且专业相关。' },
        language: { score: 90, reason: '英语可工作沟通。' },
        experience: { score: 88, reason: '有多年相关岗位经验。' },
        industryMatch: { score: 84, reason: '行业背景较接近。' },
        regionMatch: { score: 86, reason: '常驻目标区域。' },
        responsibilityMatch: { score: 94, reason: '职责经历高度重合。' },
      },
      risks: ['Limited direct factory background'],
      summary: 'Strong commercial fit with one industry gap.',
    }));

    assert.deepStrictEqual(score, {
      totalScore: 87,
      dimensionScores: {
        education: { score: 80, reason: '本科且专业相关。' },
        language: { score: 90, reason: '英语可工作沟通。' },
        experience: { score: 88, reason: '有多年相关岗位经验。' },
        industryMatch: { score: 84, reason: '行业背景较接近。' },
        regionMatch: { score: 86, reason: '常驻目标区域。' },
        responsibilityMatch: { score: 94, reason: '职责经历高度重合。' },
      },
      risks: ['Limited direct factory background'],
      summary: 'Strong commercial fit with one industry gap.',
    });
  });

  it('rejects malformed score JSON', () => {
    assert.throws(
      () => extractCandidateScoreFromTextResponse('not json'),
      /Unexpected token|Unexpected end of JSON input/,
    );
  });
});
