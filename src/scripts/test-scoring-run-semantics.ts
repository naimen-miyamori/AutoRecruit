import assert from 'node:assert/strict';
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
import { liepinAdapter } from '../platforms/liepin-adapter.js';
import { zhilianAdapter } from '../platforms/zhilian-adapter.js';
import { extractCandidateScoreFromTextResponse } from '../scoring/score-resume.js';
import { openResumeByUrl } from './capture-resume-dom-snapshot.js';
import { runManualLoginSessionSave } from './login-and-save-session.js';
import type { AllPlatformsRunSummary, BatchJobRunSummary, MainResult } from '../index.js';

const tempDirs: string[] = [];
const originalDataDir = config.dataDir;

async function makeIsolatedTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-scoring-'));
  tempDirs.push(tempDir);
  return tempDir;
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
  return import(moduleUrl);
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
  const cardWaitForCalls: Array<{ state?: string; timeout?: number }> = [];
  const cardSelectorWaits = new Map<string, number>();
  const pageSelectorWaits = new Map<string, number>();
  let popupPage: Record<string, unknown> | null = null;
  let currentUrl = 'https://example.com/subscribe';
  let searchTriggerHref: string | null = null;
  let cardCountSequence: number[] = [];
  let availableCardSelectors = new Set<string>();
  let availablePageSelectors = new Set<string>();
  let cardTextTriggerReady = false;
  let pageTextTriggerReady = false;
  let viewedFilterChecked = false;
  let viewedFilterClicks = 0;

  const viewedFilterLocator = {
    first: () => ({
      waitFor: async () => {
        if (!viewedFilterChecked) {
          throw new Error('viewed filter not visible');
        }
      },
      evaluate: async () => viewedFilterChecked,
      click: async () => {
        viewedFilterClicks += 1;
        viewedFilterChecked = false;
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

  const makeWaitable = (kind: 'card' | 'page', key: string, isReady: () => boolean) => ({
    first: () => ({
      waitFor: async () => {
        const waits = kind === 'card' ? cardSelectorWaits : pageSelectorWaits;
        waits.set(key, (waits.get(key) ?? 0) + 1);
        if (!isReady()) {
          throw new Error(`missing trigger: ${key}`);
        }
      },
      click: async () => undefined,
      getAttribute: async (name: string) => (name === 'href' ? searchTriggerHref : null),
    }),
    filter: () => ({
      first: () => ({
        waitFor: async () => {
          const waits = kind === 'card' ? cardSelectorWaits : pageSelectorWaits;
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

  let bodyText = '100228050 在线简历 工作经历 教育经历';

  const card = {
    scrollIntoViewIfNeeded: async () => undefined,
    hover: async () => undefined,
    locator: (selector?: string) => makeWaitable('card', selector ?? '', () => availableCardSelectors.has(selector ?? '')),
    getByText: (text?: string) => makeWaitable('card', `text:${text ?? ''}`, () => cardTextTriggerReady),
    getByRole: (role?: string, options?: { name?: RegExp }) => makeWaitable('card', `role:${role ?? ''}:${options?.name?.toString() ?? ''}`, () => cardTextTriggerReady),
  };

  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
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
      if (selector === 'body') {
        return {
          innerText: async () => bodyText,
        };
      }
      return makeWaitable('page', selector ?? '', () => availablePageSelectors.has(selector ?? ''));
    },
    getByText: (text?: string) => makeWaitable('page', `text:${text ?? ''}`, () => pageTextTriggerReady),
    getByRole: (role?: string, options?: { name?: RegExp }) => makeWaitable('page', `role:${role ?? ''}:${options?.name?.toString() ?? ''}`, () => pageTextTriggerReady),
    context: () => ({
      waitForEvent: async () => popupPage,
    }),
    waitForURL: async () => {
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
    setAvailablePageSelectors(selectors: string[]) {
      availablePageSelectors = new Set(selectors);
    },
    showCardTextTrigger() {
      cardTextTriggerReady = true;
    },
    showPageTextTrigger() {
      pageTextTriggerReady = true;
    },
    showPopup() {
      popupPage = {
        waitForLoadState: async (state: string) => {
          popupWaitForLoadStateCalls.push(state);
        },
        waitForTimeout: async (timeout: number) => {
          popupWaitForTimeoutCalls.push(timeout);
        },
        locator: page.locator,
      };
    },
    setSearchTriggerHref(href: string | null) {
      searchTriggerHref = href;
    },
    setBodyText(text: string) {
      bodyText = text;
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
    getViewedFilterClicks: () => viewedFilterClicks,
    isViewedFilterChecked: () => viewedFilterChecked,
    getCurrentUrl: () => currentUrl,
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
      locator: () => createClickableLocator(label),
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
  indexModule.extractCandidateListWithAdapterRef.fn = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  indexModule.openSubscribeSearchRef.fn = (async () => createSearchPage()) as typeof indexModule.openSubscribeSearchRef.fn;
  indexModule.openResumeDetailRef.fn = (async () => createDetailPage()) as typeof indexModule.openResumeDetailRef.fn;
  indexModule.extractCandidateListRef.fn = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  indexModule.extractionBoundary.extractResumeFromPage = async () => ({
    resume: buildResume('cand-1'),
    domSnapshot: { workLines: [] },
  });
  liepinAdapter.openSubscribeSearch = (async () => createSearchPage()) as typeof liepinAdapter.openSubscribeSearch;
  liepinAdapter.openResumeDetail = (async () => createDetailPage()) as typeof liepinAdapter.openResumeDetail;
  liepinAdapter.extractCandidateList = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  liepinAdapter.parseResumeDetail = async () => buildResume('cand-1');
  zhilianAdapter.openSubscribeSearch = (async () => createSearchPage()) as typeof zhilianAdapter.openSubscribeSearch;
  zhilianAdapter.openResumeDetail = (async () => createDetailPage()) as typeof zhilianAdapter.openResumeDetail;
  zhilianAdapter.extractCandidateList = async () => ({
    candidates: [{ candidateId: 'cand-1' }],
  });
  zhilianAdapter.parseResumeDetail = async () => buildResume('cand-1');
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

  it('opens subscription search without extra fixed waits once the target page is ready', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    const originalOpenAuthenticatedSubscribePage = openAuthenticatedSubscribePageRef.fn;
    const originalFindSubscriptionCard = findSubscriptionCardRef.fn;
    const originalWaitForSearchTriggerReady = waitForSearchTriggerReadyRef.fn;
    const originalClickSearchTrigger = clickSearchTriggerRef.fn;

    openAuthenticatedSubscribePageRef.fn = (async () => searchOpen.page) as typeof openAuthenticatedSubscribePageRef.fn;
    findSubscriptionCardRef.fn = (async () => ({
      scrollIntoViewIfNeeded: async () => undefined,
      hover: async () => undefined,
      locator: () => ({
        first: () => ({
          waitFor: async () => undefined,
        }),
      }),
    } as never)) as typeof findSubscriptionCardRef.fn;
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

  it('falls back to page-level triggers when the matched card exposes no descendant trigger', async () => {
    const searchOpen = createSubscribeSearchOpenStub();
    searchOpen.showPopup();
    searchOpen.setAvailablePageSelectors(['[class*="talent-search"]']);
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

    assert.equal(searchOpen.getCardSelectorWaits().get('[class*="talent-search"]') ?? 0, 1);
    assert.equal(searchOpen.getPageSelectorWaits().get('[class*="talent-search"]'), 1);
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

  it('retries clicking the subscription search trigger without fixed backoff waits', async () => {
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
    assert.deepStrictEqual(searchOpen.getPageWaitForTimeoutCalls(), []);
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
    assert.deepStrictEqual(detailPage.getWaitForTimeoutCalls(), [500]);
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
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card']);
    assert.deepStrictEqual(detailPage.getGotoCalls(), []);
    assert.equal(candidate.resumeUrl, 'https://example.com/resume/100228050');
    assert.deepStrictEqual(detailPage.getWaitForTimeoutCalls(), []);
  });

  it('accepts same-page resume detail content when online resume marker is present', async () => {
    const detailPage = createResumeDetailPageStub();
    const candidate = {
      candidateId: '100228050',
    };

    detailPage.showTrigger();

    const result = await openResumeDetail(detailPage.context, detailPage.page, candidate);

    assert.equal(result, detailPage.page);
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card']);
    assert.deepStrictEqual(detailPage.getGotoCalls(), []);
    assert.deepStrictEqual(detailPage.getWaitForTimeoutCalls(), []);
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
    assert.deepStrictEqual(detailPage.getClickCalls(), ['card']);
    assert.deepStrictEqual(detailPage.getWaitForTimeoutCalls(), []);
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

  it('supports reusable browser sessions per platform without changing 51job and Zhilian defaults', () => {
    const originalReuseBrowser = { ...config.playwright.reuseBrowserByPlatform };
    const originalHeadless = config.playwright.headless;

    try {
      (config.playwright as { headless: boolean }).headless = false;
      assert.equal(isReusableBrowserEnabled('liepin'), true);
      assert.equal(isReusableBrowserEnabled('51job'), false);
      assert.equal(isReusableBrowserEnabled('zhilian'), false);

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

  it('carries parsed Zhilian share links into score artifacts', async () => {
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
      parseResumeDetail: async () => ({
        candidateId: 'cand-share-link',
        candidateShareUrl,
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

    const detailPage = {
      locator: () => ({ innerText: async () => 'raw resume text' }),
      close: async () => {
        detailClosed = true;
      },
    } as never;
    searchPage.bringToFront = async () => {
      searchFocused = true;
    };

    const adapter = {
      ...indexModule.resolvePlatformAdapter('liepin'),
      openSubscribeSearch: async () => searchPage,
      extractCandidateList: async () => ({
        candidates: [{ candidateId: 'cand-new' }],
      }),
      openResumeDetail: async () => detailPage,
      parseResumeDetail: async () => buildResume('cand-new'),
    } satisfies import('../platforms/types.js').PlatformAdapter;
    indexModule.scoreResumeAgainstJobRef.fn = async () => buildScore();

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

    assert.equal(detailClosed, true);
    assert.equal(searchFocused, true);
    assert.equal(session.page, searchPage);
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
      newCandidateIds: string[];
      scoredCandidates: string[];
      failedCandidates: Array<{ candidateId: string; error: string }>;
    };

    assert.equal(latestSavedRun.totalCandidates, 0);
    assert.deepStrictEqual(latestSavedRun.newCandidateIds, []);
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
