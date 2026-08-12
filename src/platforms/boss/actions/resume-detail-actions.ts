import type { Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem, CandidateResume } from '../../../types/job.js';
import type { BossForwardMode, CandidatePostOpenActions, CandidateProfileDetailOptions } from '../../types.js';
import {
  parseBossResumePayload,
  type BossResumeApiPayload,
} from '../parsing/resume-parser.js';
import {
  clickBossControl,
  clickBossControlNatively,
  runBossAction,
  runBossActionWithinDeadline,
} from './context.js';

const bossResumePayloadCache = new WeakMap<Page, Map<string, BossResumeApiPayload>>();
const bossLegacyResumeFrameSelector = 'iframe[src*="/web/frame/c-resume/"]';
const bossNativeResumeRootSelector = '.dialog-lib-resume .resume-detail-wrap';
const bossNativeResumeDomAncestorDepth = 6;
const bossNativeResumeComponentParentDepth = 8;

export type BossNativeResumePendingReason =
  | 'native-root-unavailable'
  | 'root-not-current'
  | 'detail-not-visible'
  | 'payload-source-unavailable'
  | 'root-changed-before-payload'
  | 'detail-not-visible-before-payload'
  | 'resume-state-loading-before-payload'
  | 'resume-state-replaced-before-payload'
  | 'resume-identity-missing-before-payload'
  | 'resume-state-loading-after-payload'
  | 'resume-state-replaced-after-payload'
  | 'resume-identity-missing-after-payload'
  | 'resume-identity-drift-after-payload'
  | 'root-replaced-after-payload'
  | 'detail-not-visible-after-payload';

type BossNativeResumePendingObservation = {
  status: 'pending';
  reason: BossNativeResumePendingReason;
};
type BossNativeResumeAmbiguousObservation = {
  status: 'ambiguous';
  source: 'roots' | 'payloads';
  count: number;
};
type BossNativeResumeReadinessObservation =
  | BossNativeResumePendingObservation
  | BossNativeResumeAmbiguousObservation
  | { status: 'ready' };
type BossNativeResumePayloadObservation =
  | BossNativeResumePendingObservation
  | BossNativeResumeAmbiguousObservation
  | { status: 'ready'; payload: BossResumeApiPayload };
export type BossNativeResumeObservationMode = 'readiness' | 'payload';

type BossNativeResumeObservationDiagnostics = {
  observedPendingReasons: BossNativeResumePendingReason[];
  pendingReasonCounts: Partial<Record<BossNativeResumePendingReason, number>>;
  lastPendingReason?: BossNativeResumePendingReason;
};

export type BossNativeResumeObservationTimeoutCode =
  | 'boss-resume-readiness-timeout'
  | 'boss-native-payload-unavailable-before-deadline';

/**
 * Redacted native-detail timeout evidence. Only stable state-transition codes
 * and counts are exposed; candidate IDs, resume fields, and page text never
 * enter this error.
 */
export class BossNativeResumeObservationTimeoutError extends Error {
  readonly code: BossNativeResumeObservationTimeoutCode;
  readonly observationMode: BossNativeResumeObservationMode;
  readonly observedPendingReasons: readonly BossNativeResumePendingReason[];
  readonly pendingReasonCounts: Readonly<Partial<Record<BossNativeResumePendingReason, number>>>;
  readonly lastPendingReason?: BossNativeResumePendingReason;

  constructor(input: {
    code: BossNativeResumeObservationTimeoutCode;
    observationMode: BossNativeResumeObservationMode;
    message: string;
    diagnostics: BossNativeResumeObservationDiagnostics;
  }) {
    const observed = [...input.diagnostics.observedPendingReasons];
    super(`${input.message}${observed.length > 0
      ? ` Observed native pending reasons: ${observed.join(', ')}.`
      : ''}`);
    this.name = 'BossNativeResumeObservationTimeoutError';
    this.code = input.code;
    this.observationMode = input.observationMode;
    this.observedPendingReasons = Object.freeze(observed);
    this.pendingReasonCounts = Object.freeze({ ...input.diagnostics.pendingReasonCounts });
    this.lastPendingReason = input.diagnostics.lastPendingReason;
  }
}

function createBossNativeResumeObservationDiagnostics(): BossNativeResumeObservationDiagnostics {
  return {
    observedPendingReasons: [],
    pendingReasonCounts: {},
  };
}

function recordBossNativeResumePendingReason(
  diagnostics: BossNativeResumeObservationDiagnostics,
  reason: BossNativeResumePendingReason,
): void {
  if (diagnostics.pendingReasonCounts[reason] === undefined) {
    diagnostics.observedPendingReasons.push(reason);
  }
  diagnostics.pendingReasonCounts[reason] = (diagnostics.pendingReasonCounts[reason] ?? 0) + 1;
  diagnostics.lastPendingReason = reason;
}

type BossNativeResumeObservationResult<TMode extends BossNativeResumeObservationMode> =
  TMode extends 'readiness'
    ? BossNativeResumeReadinessObservation
    : BossNativeResumePayloadObservation;

function observeBossNativeResume<TMode extends BossNativeResumeObservationMode>(
  root: Locator,
  mode: TMode,
): Promise<BossNativeResumeObservationResult<TMode>> {
  return root.evaluate((candidateRoot, input) => {
    const limits = input.limits;
    const observationMode = input.mode;
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    type VueResumeComponent = {
      $options?: { name?: string };
      $props?: { resumeInfo?: Record<string, unknown> };
      $data?: { loading?: boolean; resumeInfo?: Record<string, unknown> };
      $parent?: VueResumeComponent;
    };
    type NativeObservation =
      | { status: 'pending'; reason: BossNativeResumePendingReason }
      | { status: 'ambiguous'; source: 'roots' | 'payloads'; count: number }
      | { status: 'ready' }
      | { status: 'ready'; payload: BossResumeApiPayload };
    type PayloadSource = {
      component: VueResumeComponent;
      resumeInfo: Record<string, unknown>;
    };

    const currentVisibleRoots = (): HTMLElement[] =>
      [...document.querySelectorAll('.dialog-wrap.active .dialog-lib-resume .resume-detail-wrap')]
        .filter(isVisible);

    const rootsBefore = currentVisibleRoots();
    if (rootsBefore.length > 1) {
      return { status: 'ambiguous', source: 'roots', count: rootsBefore.length } satisfies NativeObservation;
    }
    if (!candidateRoot.isConnected
      || (rootsBefore.length === 1 && rootsBefore[0] !== candidateRoot)) {
      return { status: 'pending', reason: 'root-not-current' } satisfies NativeObservation;
    }
    // The visible base-info section is opening/readiness evidence, not payload
    // identity evidence. Boss may geometrically collapse or replace that top
    // section after the detail has already hydrated. Payload reads instead
    // rely on the unique visible root plus stable state and identity below.
    if (!isVisible(candidateRoot)
      || (observationMode === 'readiness'
        && !isVisible(candidateRoot.querySelector('.geek-base-info-wrap')))) {
      return { status: 'pending', reason: 'detail-not-visible' } satisfies NativeObservation;
    }
    if (rootsBefore.length !== 1) {
      return { status: 'pending', reason: 'root-not-current' } satisfies NativeObservation;
    }

    const visitedStarts = new Set<VueResumeComponent>();
    const selectedComponents = new Set<VueResumeComponent>();
    const payloadSources: PayloadSource[] = [];
    let host: HTMLElement | null = candidateRoot;
    for (let domDepth = 0;
      host && domDepth <= limits.domAncestorDepth;
      domDepth += 1, host = host.parentElement) {
      const component = Object.prototype.hasOwnProperty.call(host, '__vue__')
        ? (host as HTMLElement & { __vue__?: VueResumeComponent }).__vue__
        : undefined;
      if (!component || visitedStarts.has(component)) continue;
      visitedStarts.add(component);

      const visitedChain = new Set<VueResumeComponent>();
      const validChainSources: PayloadSource[] = [];
      let current: VueResumeComponent | undefined = component;
      for (let componentDepth = 0;
        current && componentDepth < limits.componentParentDepth && !visitedChain.has(current);
        componentDepth += 1, current = current.$parent) {
        visitedChain.add(current);
        const currentResumeInfo = current.$data?.resumeInfo ?? current.$props?.resumeInfo;
        if (currentResumeInfo
          && current.$data?.loading !== true
          && currentResumeInfo.expectId !== undefined
          && currentResumeInfo.expectId !== null
          && String(currentResumeInfo.expectId).trim()) {
          validChainSources.push({ component: current, resumeInfo: currentResumeInfo });
          if (current.$options?.name === 'ResumeRoot') break;
        }
      }
      if (validChainSources.length === 0) continue;

      const chainIdentities = new Set(validChainSources.map((source) => String(source.resumeInfo.expectId).trim()));
      if (chainIdentities.size > 1) {
        return {
          status: 'ambiguous',
          source: 'payloads',
          count: validChainSources.length,
        } satisfies NativeObservation;
      }

      const selected = validChainSources.find((source) => source.component.$options?.name === 'ResumeRoot')
        ?? validChainSources[validChainSources.length - 1]!;
      if (!selectedComponents.has(selected.component)) {
        selectedComponents.add(selected.component);
        payloadSources.push(selected);
      }
    }
    if (payloadSources.length > 1) {
      return { status: 'ambiguous', source: 'payloads', count: payloadSources.length } satisfies NativeObservation;
    }
    if (payloadSources.length === 0) {
      return { status: 'pending', reason: 'payload-source-unavailable' } satisfies NativeObservation;
    }

    const currentRoots = currentVisibleRoots();
    if (currentRoots.length > 1) {
      return { status: 'ambiguous', source: 'roots', count: currentRoots.length } satisfies NativeObservation;
    }
    if (!candidateRoot.isConnected
      || (currentRoots.length === 1 && currentRoots[0] !== candidateRoot)) {
      return { status: 'pending', reason: 'root-changed-before-payload' } satisfies NativeObservation;
    }
    if (!isVisible(candidateRoot)
      || (observationMode === 'readiness'
        && !isVisible(candidateRoot.querySelector('.geek-base-info-wrap')))) {
      return { status: 'pending', reason: 'detail-not-visible-before-payload' } satisfies NativeObservation;
    }
    if (currentRoots.length !== 1) {
      return { status: 'pending', reason: 'root-changed-before-payload' } satisfies NativeObservation;
    }

    const selectedSource = payloadSources[0]!;
    const currentResumeInfo = selectedSource.component.$data?.resumeInfo
      ?? selectedSource.component.$props?.resumeInfo;
    if (selectedSource.component.$data?.loading === true) {
      return { status: 'pending', reason: 'resume-state-loading-before-payload' } satisfies NativeObservation;
    }
    if (currentResumeInfo !== selectedSource.resumeInfo) {
      return { status: 'pending', reason: 'resume-state-replaced-before-payload' } satisfies NativeObservation;
    }
    if (currentResumeInfo.expectId === undefined
      || currentResumeInfo.expectId === null
      || !String(currentResumeInfo.expectId).trim()) {
      return { status: 'pending', reason: 'resume-identity-missing-before-payload' } satisfies NativeObservation;
    }
    if (observationMode === 'readiness') {
      return { status: 'ready' } satisfies NativeObservation;
    }

    const resumeInfo = currentResumeInfo;
    const expectId = resumeInfo.expectId;
    const expectedIdentity = String(expectId).trim();

    const detailKeys = [
      'geekBaseInfo',
      'geekExpectList',
      'highestEduExp',
      'geekCertificationList',
      'certList',
      'professionalSkill',
      'resumeSummary',
      'showExpectPosition',
      'geekWorkExpList',
      'geekProjExpList',
      'geekEduExpList',
    ];
    const geekDetail: Record<string, unknown> = {};
    let showExpectPosition: unknown;
    for (const key of detailKeys) {
      const value = resumeInfo[key];
      if (key === 'showExpectPosition') showExpectPosition = value;
      if (value !== undefined) geekDetail[key] = value;
    }
    const payload = JSON.parse(JSON.stringify({
      code: 0,
      zpData: {
        expectId,
        geekDetail,
        ...(showExpectPosition === undefined
          ? {}
          : { showExpectPosition }),
      },
    })) as BossResumeApiPayload;

    const finalResumeInfo = selectedSource.component.$data?.resumeInfo
      ?? selectedSource.component.$props?.resumeInfo;
    const finalLoading = Reflect.get(selectedSource.component.$data ?? {}, 'loading') as unknown;
    const rootsAfter = currentVisibleRoots();
    if (rootsAfter.length > 1) {
      return { status: 'ambiguous', source: 'roots', count: rootsAfter.length } satisfies NativeObservation;
    }
    if (finalLoading === true) {
      return { status: 'pending', reason: 'resume-state-loading-after-payload' } satisfies NativeObservation;
    }
    if (finalResumeInfo !== resumeInfo) {
      return { status: 'pending', reason: 'resume-state-replaced-after-payload' } satisfies NativeObservation;
    }
    if (finalResumeInfo.expectId === undefined
      || finalResumeInfo.expectId === null
      || !String(finalResumeInfo.expectId).trim()) {
      return { status: 'pending', reason: 'resume-identity-missing-after-payload' } satisfies NativeObservation;
    }
    if (String(finalResumeInfo.expectId).trim() !== expectedIdentity) {
      return { status: 'pending', reason: 'resume-identity-drift-after-payload' } satisfies NativeObservation;
    }
    if (!candidateRoot.isConnected
      || (rootsAfter.length === 1 && rootsAfter[0] !== candidateRoot)) {
      return { status: 'pending', reason: 'root-replaced-after-payload' } satisfies NativeObservation;
    }
    if (!isVisible(candidateRoot)) {
      return { status: 'pending', reason: 'detail-not-visible-after-payload' } satisfies NativeObservation;
    }
    if (rootsAfter.length !== 1) {
      return { status: 'pending', reason: 'root-replaced-after-payload' } satisfies NativeObservation;
    }
    return { status: 'ready', payload } satisfies NativeObservation;
  }, {
    mode,
    limits: {
      domAncestorDepth: bossNativeResumeDomAncestorDepth,
      componentParentDepth: bossNativeResumeComponentParentDepth,
    },
  }) as Promise<BossNativeResumeObservationResult<TMode>>;
}

function bossResumeDetailDialogs(page: Page): Locator {
  return page.locator([
    `.dialog-wrap.active:visible:has(${bossLegacyResumeFrameSelector})`,
    `.dialog-wrap.active:visible:has(${bossNativeResumeRootSelector})`,
  ].join(', '));
}

function bossNativeResumeRoots(page: Page): Locator {
  return page.locator(`.dialog-wrap.active:visible ${bossNativeResumeRootSelector}:visible`);
}

function throwBossNativeResumeAmbiguity(
  observation: BossNativeResumeAmbiguousObservation,
): never {
  if (observation.source === 'roots') {
    throw new Error(`Expected at most one hydrated Boss native resume root, found ${observation.count}.`);
  }
  throw new Error(`Expected one Boss native resume payload source, found ${observation.count}.`);
}

/** Returns whether exactly one legacy or native Boss resume detail is visible. */
export async function isBossResumeDetailVisible(page: Page): Promise<boolean> {
  const count = await bossResumeDetailDialogs(page).count().catch(() => 0);
  if (count > 1) {
    throw new Error(`Expected at most one visible Boss resume detail dialog, found ${count}.`);
  }
  return count === 1;
}

/**
 * The external click was accepted but the page did not expose a verifiable
 * completion state. Callers must persist this as uncertain and never retry it
 * automatically, because a second click could send a duplicate resume.
 */
export class BossForwardUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossForwardUncertainError';
  }
}

/** The confirmation action was proven not to dispatch a click event. */
export class BossForwardPreConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossForwardPreConfirmationError';
  }
}

/** A retryable detail target mismatch; no resume/history write is safe. */
export class BossResumeIdentityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossResumeIdentityVerificationError';
  }
}

/**
 * Detail cleanup is a safety boundary for normal capture.  If Boss leaves a
 * resume modal visible, the next card action could target the wrong person;
 * callers must stop and leave the page available for inspection instead of
 * treating cleanup as best-effort.
 */
export class BossResumeDetailCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossResumeDetailCloseError';
  }
}

/**
 * A detail-card interaction exposed the Boss search-chat purchase surface
 * instead of the requested resume.  The page is no longer safe for the next
 * card, even when the purchase dialog can be closed successfully.
 */
export class BossUnexpectedContactDialogError extends Error {
  readonly purchaseDialogClosed: boolean;

  constructor(message: string, options: { purchaseDialogClosed?: boolean } = {}) {
    super(message);
    this.name = 'BossUnexpectedContactDialogError';
    this.purchaseDialogClosed = options.purchaseDialogClosed === true;
  }
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function remainingTimeWithReserve(deadline: number, cleanupReserveMs = 0): number {
  return Math.max(deadline - Date.now() - Math.max(cleanupReserveMs, 0), 1);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeEmailList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const email = value.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
}

export async function closeExistingBossResumeDialog(
  page: Page,
  deadline: number,
  options: { pace?: boolean; allowEscapeFallback?: boolean; cleanupReserveMs?: number } & Partial<CandidateProfileDetailOptions> = {},
): Promise<void> {
  // Forwarding overlays have their own strict close semantics. In particular,
  // the current no-close overlay must never fall through to Escape, which can
  // close the resume underneath while leaving the overlay visible.
  await closeVisibleBossForwardDialogIfPresent(page, deadline);
  const activeDialog = page.locator([
    '.dialog-wrap.active:visible[data-type="boss-dialog"]',
    `.dialog-wrap.active:visible:has(${bossLegacyResumeFrameSelector})`,
    `.dialog-wrap.active:visible:has(${bossNativeResumeRootSelector})`,
  ].join(', ')).first();
  if (await activeDialog.count().catch(() => 0) === 0) return;

  const closeButton = activeDialog.locator('.boss-popup__close, .close-btn, [ka="dialog_close"], .boss-dialog__close').first();
  const closeAction = options.deadline === undefined
    ? () => clickBossControl(closeButton, page, Math.min(remainingTime(deadline), 3000), { pace: options.pace })
    : () => clickBossControlNatively(page, closeButton, Math.min(remainingTime(options.deadline!), 3000), {
      pace: options.pace,
      deadline: options.deadline!,
      cleanupReserveMs: 0,
    });
  await closeAction().catch(async (error) => {
    if (options.allowEscapeFallback === false) {
      throw error;
    }
    const pressEscape = () => page.keyboard.press('Escape');
    if (options.pace === false) {
      await pressEscape().catch(() => undefined);
      return;
    }
    await runBossAction(page, pressEscape).catch(() => undefined);
  });
  await activeDialog.waitFor({ state: 'hidden', timeout: Math.min(remainingTime(deadline), 5000) }).catch(() => undefined);
}

export async function waitForBossResumeDetailReady(page: Page, deadline: number, cleanupReserveMs = 0): Promise<void> {
  const diagnostics = createBossNativeResumeObservationDiagnostics();
  while (remainingTimeWithReserve(deadline, cleanupReserveMs) > 1) {
    const nativeRoots = bossNativeResumeRoots(page);
    const nativeCount = await nativeRoots.count().catch(() => 0);
    if (nativeCount > 1) {
      throw new Error(`Expected at most one hydrated Boss native resume root, found ${nativeCount}.`);
    }
    if (nativeCount === 1) {
      const observation = await observeBossNativeResume(nativeRoots.first(), 'readiness');
      if (observation.status === 'ambiguous') {
        throwBossNativeResumeAmbiguity(observation);
      }
      if (observation.status === 'ready') return;
      recordBossNativeResumePendingReason(diagnostics, observation.reason);
    } else {
      recordBossNativeResumePendingReason(diagnostics, 'native-root-unavailable');
    }

    const detailFrames = page.frames().filter((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
    if (detailFrames.length > 1) {
      throw new Error(`Expected at most one Boss resume detail frame, found ${detailFrames.length}.`);
    }
    if (detailFrames.length === 1
      && await detailFrames[0]!.locator('canvas#resume, #resume canvas').first().isVisible().catch(() => false)) {
      return;
    }
    await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(deadline, cleanupReserveMs))).catch(() => undefined);
  }
  throw new BossNativeResumeObservationTimeoutError({
    code: 'boss-resume-readiness-timeout',
    observationMode: 'readiness',
    message: 'Boss resume detail did not hydrate through either the native DOM or legacy canvas path before the deadline.',
    diagnostics,
  });
}

async function raiseUnexpectedContactDialog(
  page: Page,
  deadline: number,
  context: string,
): Promise<never> {
  try {
    const closed = await closeBossPurchaseChatDialogIfPresent(page, deadline);
    throw new BossUnexpectedContactDialogError(
      `${context}; no forwarding confirmation was attempted; no contact action was attempted.`,
      { purchaseDialogClosed: closed },
    );
  } catch (error) {
    if (error instanceof BossUnexpectedContactDialogError) {
      throw error;
    }
    throw new BossUnexpectedContactDialogError(
      `${context}; purchase dialog cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      { purchaseDialogClosed: false },
    );
  }
}

/**
 * Fails closed when a purchase/contact dialog is visible before a detail
 * lifecycle begins.  Closing the dialog is cleanup only; it never authorizes
 * continuing with another candidate on the same page.
 */
export async function assertNoBossPurchaseChatDialog(page: Page, deadline: number): Promise<void> {
  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) === 0) return;
  await raiseUnexpectedContactDialog(page, deadline, 'Boss search-chat-card purchase dialog was visible before opening the requested resume');
}

/**
 * Waits for the first observable result of a detail click.  A purchase dialog
 * wins over detail readiness and is always converted to a fatal page-safety
 * error; callers must not continue to the next card.
 */
export async function waitForBossResumeDetailOrPurchase(
  page: Page,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = (element: Element): boolean => element instanceof HTMLElement
          && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
          && window.getComputedStyle(element).visibility !== 'hidden';
        const detailVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
          isVisible(dialog)
          && Boolean(dialog.querySelector(
            'iframe[src*="/web/frame/c-resume/"], .dialog-lib-resume .resume-detail-wrap',
          )));
        const purchaseVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
          isVisible(dialog)
          && !dialog.querySelector('iframe[src*="/web/frame/c-resume/"]')
          && !dialog.querySelector('.dialog-lib-resume .resume-detail-wrap')
          && /搜索畅聊卡|立即购买/.test(dialog.textContent ?? ''));
        return detailVisible || purchaseVisible;
      },
      undefined,
      { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 },
    );
  } catch (error) {
    if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
      await raiseUnexpectedContactDialog(page, deadline, 'Boss detail click exposed a search-chat-card purchase dialog');
    }
    throw error;
  }

  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(page, deadline, 'Boss detail click exposed a search-chat-card purchase dialog');
  }
  await waitForBossResumeDetailReady(page, deadline, cleanupReserveMs);
}

async function readBossResumePayload(
  page: Page,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<BossResumeApiPayload> {
  const diagnostics = createBossNativeResumeObservationDiagnostics();
  while (remainingTimeWithReserve(deadline, cleanupReserveMs) > 1) {
    const nativeRoots = bossNativeResumeRoots(page);
    const nativeCount = await nativeRoots.count().catch(() => 0);
    if (nativeCount > 1) {
      throw new Error(`Expected at most one hydrated Boss native resume root, found ${nativeCount}.`);
    }
    if (nativeCount === 1) {
      const observation = await observeBossNativeResume(nativeRoots.first(), 'payload');
      if (observation.status === 'ambiguous') {
        throwBossNativeResumeAmbiguity(observation);
      }
      if (observation.status === 'ready') return observation.payload;
      recordBossNativeResumePendingReason(diagnostics, observation.reason);
      await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(deadline, cleanupReserveMs))).catch(() => undefined);
      continue;
    }
    recordBossNativeResumePendingReason(diagnostics, 'native-root-unavailable');

    const detailFrames = page.frames().filter((frame) => /\/web\/frame\/c-resume\//.test(frame.url()));
    if (detailFrames.length > 1) {
      throw new Error(`Expected at most one Boss resume detail frame, found ${detailFrames.length}.`);
    }
    if (detailFrames.length === 1
      && await detailFrames[0]!.locator('canvas#resume, #resume canvas').first().isVisible().catch(() => false)) {
      const detailFrame = detailFrames[0]!;
      await detailFrame.waitForFunction(
        () => performance.getEntriesByType('resource')
          .some((entry) => /\/wapi\/(?:zpitem\/web\/boss\/search\/geek\/info|zpjob\/view\/geek\/info\/v2)\?/.test(entry.name)),
        undefined,
        { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 },
      );
      return detailFrame.evaluate(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .reverse()
          .find((url) => /\/wapi\/(?:zpitem\/web\/boss\/search\/geek\/info|zpjob\/view\/geek\/info\/v2)\?/.test(url));
        if (!apiUrl) {
          throw new Error('Boss resume detail API resource was not found in the legacy detail frame.');
        }
        const response = await fetch(apiUrl, { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`Boss resume detail API returned HTTP ${response.status}.`);
        }
        return response.json();
      }) as Promise<BossResumeApiPayload>;
    }
    await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(deadline, cleanupReserveMs))).catch(() => undefined);
  }

  throw new BossNativeResumeObservationTimeoutError({
    code: 'boss-native-payload-unavailable-before-deadline',
    observationMode: 'payload',
    message: 'Boss resume detail did not expose one atomically hydrated native payload or ready legacy frame before the deadline.',
    diagnostics,
  });
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

/**
 * Reads the current detail identity without populating the resume parse cache.
 * History-view synchronisation deliberately uses this action so an
 * already-seen card is opened/verified/closed without becoming a capture or
 * causing any resume payload to be reused by a later parse.
 */
export async function verifyBossResumeDetailIdentity(
  page: Page,
  candidate: CandidateListItem,
  deadline: number = createResumeDetailDeadline(),
  cleanupReserveMs = 0,
): Promise<{ candidateId: string }> {
  bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  const verified = await readVerifiedBossResumePayload(page, candidate, deadline, cleanupReserveMs);
  bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  return { candidateId: verified.detailCandidateId };
}

export interface BossColleagueCommunicationFlag {
  hasColleagueCommunication: boolean;
}

/**
 * Reads only whether the exact, currently open Boss candidate has at least
 * one colleague communication record. No colleague name, time, or detail is
 * returned to orchestration or persistence.
 */
export async function readBossColleagueCommunicationFlag(
  page: Page,
  candidate: CandidateListItem,
  options: CandidateProfileDetailOptions,
): Promise<BossColleagueCommunicationFlag> {
  const cleanupReserveMs = options.cleanupReserveMs ?? 0;
  await verifyBossResumeDetailIdentity(page, candidate, options.deadline, cleanupReserveMs);

  const dialogs = page.locator(`.dialog-wrap.active:visible:has(${bossNativeResumeRootSelector})`);
  await dialogs.first().waitFor({
    state: 'visible',
    timeout: remainingTimeWithReserve(options.deadline, cleanupReserveMs),
  });
  const dialogCount = await dialogs.count();
  if (dialogCount !== 1) {
    throw new Error(`Expected one active Boss native resume detail while reading colleague communication, found ${dialogCount}.`);
  }

  const panels = dialogs.first().locator('.resume-right-side .chat-history-process:visible');
  await panels.first().waitFor({
    state: 'visible',
    timeout: remainingTimeWithReserve(options.deadline, cleanupReserveMs),
  });
  const panelCount = await panels.count();
  if (panelCount !== 1) {
    throw new Error(`Expected one Boss colleague communication panel, found ${panelCount}.`);
  }
  const panel = panels.first();
  const colleagueTabs = panel.locator('.tab-hd span:visible').filter({ hasText: /^同事沟通$/ });
  const tabCount = await colleagueTabs.count();
  if (tabCount !== 1) {
    throw new Error(`Expected one Boss colleague communication tab, found ${tabCount}.`);
  }
  const colleagueTab = colleagueTabs.first();
  if (!(await colleagueTab.evaluate((element) => element.classList.contains('selected')))) {
    await clickBossControlNatively(
      page,
      colleagueTab,
      remainingTimeWithReserve(options.deadline, cleanupReserveMs),
      {
        deadline: options.deadline,
        cleanupReserveMs,
        beforeClick: async () => {
          const currentTabs = panel.locator('.tab-hd span:visible').filter({ hasText: /^同事沟通$/ });
          if (await currentTabs.count() !== 1) {
            throw new Error('Boss colleague communication tab changed before selection.');
          }
          await verifyBossResumeDetailIdentity(page, candidate, options.deadline, cleanupReserveMs);
        },
      },
    );
  }

  // A newly selected tab can retain the prior tab's rows while its request is
  // in flight. Do not interpret either non-empty or empty rows until this
  // bounded hydration window has elapsed.
  const earliestResultAt = Date.now() + 1_500;
  // The current panel can briefly expose an empty list while the selected
  // tab hydrates without a visible loading indicator. Require a full stable
  // window so that transient emptiness cannot silently suppress the note.
  const stableEmptyWindowMs = 1_000;
  let stableEmptySince: number | undefined;
  while (remainingTimeWithReserve(options.deadline, cleanupReserveMs) > 1) {
    const snapshot = await panel.evaluate((root) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const selectedTabs = [...root.querySelectorAll('.tab-hd span')]
        .filter((element) => isVisible(element)
          && (element.textContent ?? '').replace(/\s+/g, ' ').trim() === '同事沟通'
          && element.classList.contains('selected'));
      const recordLists = [...root.querySelectorAll('ul.record')].filter(isVisible);
      const rows = recordLists.length === 1
        ? [...recordLists[0]!.querySelectorAll(':scope > li')].filter(isVisible)
        : [];
      const actions = rows
        .map((row) => row.querySelector('p.action'))
        .filter(isVisible)
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const explicitEmpty = rows.some((row) => /暂无|没有|无.*沟通记录/.test((row.textContent ?? '').replace(/\s+/g, ' ').trim()));
      const loading = [...root.querySelectorAll('.loading, .boss-loading, [class*="loading"]')].some(isVisible);
      return {
        selectedTabCount: selectedTabs.length,
        recordListCount: recordLists.length,
        rowCount: rows.length,
        actionCount: actions.length,
        explicitEmpty,
        loading,
      };
    });

    if (snapshot.selectedTabCount > 1 || snapshot.recordListCount > 1) {
      throw new Error('Boss colleague communication panel became ambiguous while reading it.');
    }
    if (snapshot.selectedTabCount !== 1) {
      stableEmptySince = undefined;
      await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(options.deadline, cleanupReserveMs)));
      continue;
    }
    if (Date.now() < earliestResultAt) {
      stableEmptySince = undefined;
      await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(options.deadline, cleanupReserveMs)));
      continue;
    }
    if (snapshot.recordListCount === 1 && snapshot.actionCount > 0) {
      await verifyBossResumeDetailIdentity(page, candidate, options.deadline, cleanupReserveMs);
      return { hasColleagueCommunication: true };
    }
    const empty = snapshot.recordListCount === 1
      && !snapshot.loading
      && (snapshot.rowCount === 0 || snapshot.explicitEmpty);
    if (empty) {
      stableEmptySince ??= Date.now();
      if (Date.now() - stableEmptySince >= stableEmptyWindowMs) {
        await verifyBossResumeDetailIdentity(page, candidate, options.deadline, cleanupReserveMs);
        return { hasColleagueCommunication: false };
      }
    } else {
      stableEmptySince = undefined;
    }
    await page.waitForTimeout(Math.min(100, remainingTimeWithReserve(options.deadline, cleanupReserveMs)));
  }

  throw new Error('Boss colleague communication panel did not reach a verified record or stable empty state before the deadline.');
}

export function assertBossResumeTarget(payload: BossResumeApiPayload, candidate: CandidateListItem): string {
  const detailCandidateId = payload.zpData?.expectId === undefined || payload.zpData.expectId === null
    ? ''
    : String(payload.zpData.expectId).trim();
  if (!detailCandidateId) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail identity verification failed for candidate ${candidate.candidateId}: detail payload omitted expectId.`);
  }

  const sourceMatches = candidate.sourceText
    ? [...candidate.sourceText.matchAll(/data-(?:expect|jid|lid)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
    : [];
  const sourceIdentifiers = [
    candidate.candidateId,
    ...sourceMatches.map((match) => match[1] ?? match[2] ?? match[3]),
  ].filter((value): value is string => Boolean(value)).map((value) => value.trim());
  if (!sourceIdentifiers.includes(detailCandidateId)) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail identity ${detailCandidateId} does not match requested candidate ${candidate.candidateId}.`);
  }
  return detailCandidateId;
}

async function readVerifiedBossResumePayload(
  page: Page,
  candidate: CandidateListItem,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<{ payload: BossResumeApiPayload; detailCandidateId: string }> {
  const payload = await readBossResumePayload(page, deadline, cleanupReserveMs);
  if (payload.code !== 0) {
    throw new BossResumeIdentityVerificationError(`Boss resume detail payload failed: ${payload.message ?? `code ${payload.code ?? 'omitted'}`}`);
  }
  return {
    payload,
    detailCandidateId: assertBossResumeTarget(payload, candidate),
  };
}

export async function parseBossResumeDetail(
  page: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<CandidateResume> {
  const cachedPayload = takeCachedBossResumePayload(page, candidate.candidateId);
  const verified = cachedPayload
    ? { payload: cachedPayload, detailCandidateId: assertBossResumeTarget(cachedPayload, candidate) }
    : await readVerifiedBossResumePayload(
      page,
      candidate,
      options?.deadline ?? createResumeDetailDeadline(),
      options?.cleanupReserveMs ?? 0,
    );
  const resume = parseBossResumePayload(verified.payload, page.url(), candidate);
  if (resume.candidateId !== candidate.candidateId || resume.candidateId !== verified.detailCandidateId) {
    throw new BossResumeIdentityVerificationError(
      `Boss parsed resume identity ${resume.candidateId} does not match candidate ${candidate.candidateId} or detail ${verified.detailCandidateId}.`,
    );
  }
  return resume;
}

async function waitForBossForwardDialog(page: Page, deadline: number, cleanupReserveMs = 0): Promise<Locator> {
  const dialogs = page.locator('.dialog-wrap.active .c-share-box:visible');
  const dialog = dialogs.first();
  await dialog.waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
  const dialogCount = await dialogs.count();
  if (dialogCount !== 1) {
    throw new Error(`Expected one visible Boss forwarding dialog, found ${dialogCount}.`);
  }
  return dialog;
}

function bossPurchaseChatDialogs(page: Page): Locator {
  return page
    .locator([
      '.dialog-wrap.active:visible',
      `:not(:has(${bossLegacyResumeFrameSelector}))`,
      `:not(:has(${bossNativeResumeRootSelector}))`,
    ].join(''))
    .filter({ hasText: /搜索畅聊卡|立即购买/ });
}

async function closeBossPurchaseChatDialogIfPresent(page: Page, deadline: number): Promise<boolean> {
  const dialogs = bossPurchaseChatDialogs(page);
  const dialogCount = await dialogs.count();
  if (dialogCount === 0) return false;
  if (dialogCount !== 1) {
    throw new Error(`Expected at most one visible Boss search-chat-card purchase dialog, found ${dialogCount}.`);
  }
  const dialog = dialogs.first();
  const closeButtons = dialog.locator('.boss-popup__close:visible, [ka="dialog_close"]:visible');
  const closeCount = await closeButtons.count();
  if (closeCount !== 1) {
    throw new Error(`Expected one close control on the Boss search-chat-card purchase dialog, found ${closeCount}.`);
  }
  const closeButton = closeButtons.first();
  await clickBossControlNatively(page, closeButton, remainingTime(deadline), { deadline, pace: true });
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
  return true;
}

async function closeVisibleBossForwardDialogIfPresent(page: Page, deadline: number): Promise<boolean> {
  const dialogs = page.locator('.dialog-wrap.active:visible:has(.c-share-box:visible)');
  const dialogCount = await dialogs.count();
  if (dialogCount === 0) return false;
  if (dialogCount !== 1) {
    throw new Error(`Expected at most one visible Boss forwarding dialog before detail close, found ${dialogCount}.`);
  }
  const dialog = dialogs.first();
  const closeButtons = dialog.locator('.boss-popup__close:visible, .close-btn:visible, [ka="dialog_close"]:visible, .boss-dialog__close:visible');
  const closeCount = await closeButtons.count();
  if (closeCount > 1) {
    throw new Error(`Expected at most one close control on the visible Boss forwarding dialog, found ${closeCount}.`);
  }
  if (closeCount === 1) {
    await clickBossControlNatively(page, closeButtons.first(), remainingTime(deadline), {
      deadline,
      pace: false,
    });
    await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
    return true;
  }

  // The current native forwarding dialog deliberately exposes no close icon.
  // Its unique full-screen layer is the only supported dismissal target;
  // Escape is unsafe because Boss closes the underlying resume but leaves this
  // forwarding dialog orphaned. Prove an uncovered layer corner, click it, and
  // require both forward dismissal and preservation of the resume underneath.
  const layers = dialog.locator(':scope > .boss-layer__wrapper:visible');
  const layerCount = await layers.count();
  if (layerCount !== 1) {
    throw new Error(`Boss forwarding dialog exposed neither one close control nor one safe dismissal layer; found ${layerCount} layers.`);
  }
  const layer = layers.first();
  const readSafeLayerPosition = async (): Promise<{ x: number; y: number } | undefined> => layer.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return undefined;
    const layerRect = element.getBoundingClientRect();
    const forwardBox = element.parentElement?.querySelector('.c-share-box');
    if (!(forwardBox instanceof HTMLElement)) return undefined;
    const boxRect = forwardBox.getBoundingClientRect();
    const inset = Math.max(2, Math.min(16, layerRect.width / 4, layerRect.height / 4));
    const candidates = [
      { x: inset, y: inset },
      { x: layerRect.width - inset, y: inset },
      { x: inset, y: layerRect.height - inset },
      { x: layerRect.width - inset, y: layerRect.height - inset },
    ];
    return candidates.find((position) => {
      const clientX = layerRect.left + position.x;
      const clientY = layerRect.top + position.y;
      const outsideForwardBox = clientX < boxRect.left
        || clientX > boxRect.right
        || clientY < boxRect.top
        || clientY > boxRect.bottom;
      return outsideForwardBox && document.elementFromPoint(clientX, clientY) === element;
    });
  });
  const safePosition = await readSafeLayerPosition();
  if (!safePosition) {
    throw new Error('Boss forwarding dialog had no proven uncovered dismissal-layer point.');
  }
  const resumeVisibleBeforeLayerClick = await isBossResumeDetailVisible(page);
  await clickBossControlNatively(page, layer, remainingTime(deadline), {
    deadline,
    pace: false,
    position: safePosition,
    beforeClick: async () => {
      if (await dialogs.count() !== 1 || await layers.count() !== 1) {
        throw new Error('Boss forwarding dismissal layer changed before click.');
      }
      const positionStillSafe = await layer.evaluate((element, position) => {
        if (!(element instanceof HTMLElement)) return false;
        const layerRect = element.getBoundingClientRect();
        const forwardBox = element.parentElement?.querySelector('.c-share-box');
        if (!(forwardBox instanceof HTMLElement)) return false;
        const boxRect = forwardBox.getBoundingClientRect();
        const clientX = layerRect.left + position.x;
        const clientY = layerRect.top + position.y;
        return (clientX < boxRect.left
          || clientX > boxRect.right
          || clientY < boxRect.top
          || clientY > boxRect.bottom)
          && document.elementFromPoint(clientX, clientY) === element;
      }, safePosition);
      if (!positionStillSafe) {
        throw new Error('Boss forwarding dismissal-layer point changed before click.');
      }
    },
  });
  await dialog.waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
  if (resumeVisibleBeforeLayerClick && !await isBossResumeDetailVisible(page)) {
    throw new Error('Boss forwarding dismissal layer also closed the underlying resume detail.');
  }
  return true;
}

/**
 * Safety-only semantic action used by non-forwarding detail visits. It keeps
 * the purchase-dialog selector inside the Boss action boundary while allowing
 * callers to fail closed if an accidental contact click opened a purchase UI.
 */
export async function closeBossPurchaseChatDialogForSafety(page: Page, deadline: number): Promise<boolean> {
  return closeBossPurchaseChatDialogIfPresent(page, deadline);
}

/**
 * Closes one visible resume detail dialog and verifies that it is gone. The
 * ordinary adapter close remains tolerant for legacy cleanup; this strict
 * variant is reserved for the history-view action where leaving a modal open
 * would make the next candidate unsafe to operate.
 */
export async function closeBossResumeDetailStrict(
  page: Page,
  deadline: number,
  options: { pace?: boolean; cleanupReserveMs?: number } = {},
): Promise<void> {
  const visibleResumeDialogs = bossResumeDetailDialogs(page);
  const dialogCount = await visibleResumeDialogs.count();
  if (dialogCount !== 1) {
    throw new Error(`Expected one visible Boss resume detail dialog before close, found ${dialogCount}.`);
  }
  // A dispatched forward click can leave the share box visible when the
  // success indication is delayed or absent. Close that nested/overlay dialog
  // first so its layer cannot intercept the detail close control. The strict
  // postcondition below still requires the resume detail itself to disappear.
  await closeVisibleBossForwardDialogIfPresent(page, deadline);
  if (await bossPurchaseChatDialogs(page).count() > 0) {
    await closeBossPurchaseChatDialogIfPresent(page, deadline);
    throw new Error('Boss resume detail close was blocked by a visible search-chat-card purchase dialog.');
  }
  await closeExistingBossResumeDialog(page, deadline, {
    ...options,
    deadline,
    allowEscapeFallback: false,
    cleanupReserveMs: 0,
  });
  const remaining = await visibleResumeDialogs.count().catch(() => 0);
  if (remaining !== 0) {
    throw new Error('Boss resume detail dialog remained visible after the close action.');
  }
}

async function assertNativeBossForwardAction(action: Locator): Promise<void> {
  const evidence = await action.evaluate((element) => {
    const isVisible = (target: Element | null): target is HTMLElement => {
      if (!(target instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(target);
      const rect = target.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    if (!isVisible(element) || element.getAttribute('aria-label') !== '转发牛人') {
      return { ok: false, reason: 'share control was absent, hidden, or lost its aria-label' };
    }
    const group = element.parentElement;
    if (!group) return { ok: false, reason: 'share control had no operation group' };
    const classNames = ['interested', 'unsuitable', 'report', 'share'];
    const controls = classNames.map((className) => {
      const matches = [...group.querySelectorAll(`.${className}`)].filter(isVisible);
      return matches.length === 1 ? matches[0] : undefined;
    });
    if (controls.some((control) => !control) || controls[3] !== element) {
      return { ok: false, reason: 'expected one visible 收藏/不合适/举报/转发 control in the same group' };
    }
    const shareRect = element.getBoundingClientRect();
    const shareCenterY = (shareRect.top + shareRect.bottom) / 2;
    const leftControls = controls.slice(0, -1) as Element[];
    const rightmost = leftControls.every((control) => {
      const rect = control.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      return rect.left < shareRect.left && Math.abs(centerY - shareCenterY) <= Math.max(rect.height, shareRect.height);
    });
    const expectedOrder = controls.every((control, index) => index === 0
      || control!.getBoundingClientRect().left > controls[index - 1]!.getBoundingClientRect().left);
    return rightmost && expectedOrder
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'share control was not the rightmost item in the expected top operation row' };
  });
  if (!evidence.ok) {
    throw new Error(`Boss native resume forward action failed structural verification: ${evidence.reason}.`);
  }
}

async function openBossForwardDialog(page: Page, deadline: number, cleanupReserveMs = 0): Promise<Locator> {
  await waitForBossResumeDetailReady(page, deadline, cleanupReserveMs);
  if (await bossPurchaseChatDialogs(page).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(
      page,
      deadline,
      'Boss resume forwarding started while a search-chat-card purchase dialog was already visible',
    );
  }
  const legacyActions = page.locator(`.dialog-wrap.active:has(${bossLegacyResumeFrameSelector}) .btn-coop-forward:visible`);
  const nativeActions = bossNativeResumeRoots(page)
    .locator('.geek-base-info-wrap .share[aria-label="转发牛人"]:visible');
  const legacyActionCount = await legacyActions.count();
  const nativeActionCount = await nativeActions.count();
  if (legacyActionCount + nativeActionCount !== 1) {
    throw new Error(`Expected one visible Boss resume forward action, found ${legacyActionCount + nativeActionCount}.`);
  }
  const nativeAction = nativeActionCount === 1;
  const action = nativeAction ? nativeActions : legacyActions;
  if (nativeAction) await assertNativeBossForwardAction(action);
  // The generic coordinate click intentionally follows a continuous pointer
  // path, but the detail footer can reflow while that path is in motion. Use
  // a native locator click after pointer movement so Playwright resolves the
  // forward element again at mutation time instead of clicking a stale point
  // that may now belong to “联系Ta”.
  await clickBossControlNatively(page, action, remainingTime(deadline), {
    deadline,
    cleanupReserveMs,
    beforeClick: async () => {
      if (nativeAction) {
        const currentActions = bossNativeResumeRoots(page)
          .locator('.geek-base-info-wrap .share[aria-label="转发牛人"]:visible');
        if (await currentActions.count() !== 1) {
          throw new Error('Boss native resume forward action changed before click.');
        }
        await assertNativeBossForwardAction(currentActions);
        return;
      }
      const currentActions = page.locator(
        `.dialog-wrap.active:has(${bossLegacyResumeFrameSelector}) .btn-coop-forward:visible`,
      );
      if (await currentActions.count() !== 1) {
        throw new Error('Boss legacy resume forward action changed before click.');
      }
    },
  });
  await page.waitForFunction(() => {
    const isVisible = (element: Element) => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const forwardingVisible = [...document.querySelectorAll('.dialog-wrap.active .c-share-box')].some(isVisible);
    const purchaseVisible = [...document.querySelectorAll('.dialog-wrap.active')].some((dialog) =>
      isVisible(dialog)
      && !dialog.querySelector('iframe[src*="/web/frame/c-resume/"]')
      && !dialog.querySelector('.dialog-lib-resume .resume-detail-wrap')
      && /搜索畅聊卡|立即购买/.test(dialog.textContent ?? ''));
    return forwardingVisible || purchaseVisible;
  }, undefined, { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 });
  if (await bossPurchaseChatDialogs(page).count() > 0) {
    await raiseUnexpectedContactDialog(
      page,
      deadline,
      'Boss resume forward action opened the search-chat-card purchase dialog instead of the forwarding dialog',
    );
  }
  return waitForBossForwardDialog(page, deadline, cleanupReserveMs);
}

async function selectBossForwardMode(
  dialog: Locator,
  mode: BossForwardMode,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<Locator> {
  const label = mode === 'colleague' ? '站内同事' : '邮件转发';
  const tab = dialog.locator('.nav-list .item').filter({ hasText: label });
  const tabCount = await tab.count();
  if (tabCount !== 1) {
    throw new Error(`Expected one Boss forward mode tab "${label}", found ${tabCount}.`);
  }
  if (!normalizeText(await tab.getAttribute('class') ?? '').split(' ').includes('cur')) {
    await clickBossControlNatively(dialog.page(), tab, remainingTime(deadline), {
      deadline,
      cleanupReserveMs,
    });
  }
  const placeholder = mode === 'colleague' ? '姓名、职位、邮箱' : '请输入收件人邮箱';
  const input = dialog.locator(`input[placeholder="${placeholder}"]`);
  await input.waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
  return input;
}

async function selectBossForwardColleague(
  dialog: Locator,
  input: Locator,
  recipient: string,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  await runBossActionWithinDeadline(
    dialog.page(),
    deadline,
    () => input.fill(recipient, { timeout: remainingTime(deadline) }),
    cleanupReserveMs,
  );
  const options = dialog.locator('.check-list li, .selector [class*="option"], .selector [class*="result-item"]');
  await options.first().waitFor({ state: 'visible', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) });
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
  await clickBossControlNatively(dialog.page(), options.nth(matches[0]!.index), remainingTime(deadline), {
    deadline,
    cleanupReserveMs,
  });
}

async function fillBossForwardForm(
  dialog: Locator,
  mode: BossForwardMode,
  recipient: string,
  candidateId: string,
  hasColleagueCommunication: boolean,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<string> {
  const input = await selectBossForwardMode(dialog, mode, deadline, cleanupReserveMs);
  if (mode === 'colleague') {
    await selectBossForwardColleague(dialog, input, recipient, deadline, cleanupReserveMs);
  } else {
    await runBossActionWithinDeadline(
      dialog.page(),
      deadline,
      () => input.fill(recipient, { timeout: remainingTime(deadline) }),
      cleanupReserveMs,
    );
    if (await input.inputValue() !== recipient) {
      throw new Error('Boss email forward recipient input did not retain the configured address.');
    }
  }
  const messageText = mode === 'email' && hasColleagueCommunication
    ? `${candidateId}\n同事已沟通`
    : candidateId;
  const message = dialog.locator('textarea[placeholder="请输入留言"]');
  await runBossActionWithinDeadline(
    dialog.page(),
    deadline,
    () => message.fill(messageText, { timeout: remainingTime(deadline) }),
    cleanupReserveMs,
  );
  if (await message.inputValue() !== messageText) {
    throw new Error(`Boss forward message did not retain the expected text for candidate ${candidateId}.`);
  }
  return messageText;
}

function bossForwardSuccessIndicators(page: Page): Locator {
  return page.locator('[data-boss-forward-success="true"], .boss-toast, .toast-success, .toast-con, [role="alert"]');
}

async function readBossForwardSuccessSignature(page: Page): Promise<string> {
  return bossForwardSuccessIndicators(page).evaluateAll((elements) => elements.flatMap((element, index) => {
    if (!(element instanceof HTMLElement)) return [];
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible = style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return visible && /转发成功|发送成功|已转发|forwarded successfully/i.test(text)
      ? [`${index}:${text}:${element.getAttribute('data-boss-forward-success') ?? ''}`]
      : [];
  }).join('|'));
}

async function waitForBossForwardSuccessEvidence(
  page: Page,
  deadline: number,
  beforeSignature: string,
  cleanupReserveMs = 0,
): Promise<void> {
  await page.waitForFunction((before) => {
    const isVisible = (element: Element): boolean => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      && window.getComputedStyle(element).visibility !== 'hidden';
    const signature = [...document.querySelectorAll('[data-boss-forward-success="true"], .boss-toast, .toast-success, .toast-con, [role="alert"]')]
      .flatMap((element, index) => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return isVisible(element) && /转发成功|发送成功|已转发|forwarded successfully/i.test(text)
          ? [`${index}:${text}:${element.getAttribute('data-boss-forward-success') ?? ''}`]
          : [];
      }).join('|');
    return Boolean(signature) && signature !== before;
  }, beforeSignature, { timeout: remainingTimeWithReserve(deadline, cleanupReserveMs), polling: 100 });
}

async function armBossForwardClickObserver(button: Locator, token: string): Promise<void> {
  await button.evaluate((element, expectedToken) => {
    type ObserverState = {
      token: string;
      dispatched: boolean;
      handler: (event: Event) => void;
    };
    const host = window as Window & { __autorecruitBossForwardClick?: ObserverState };
    const previous = host.__autorecruitBossForwardClick;
    if (previous) {
      document.removeEventListener('click', previous.handler, true);
    }
    const state = {} as ObserverState;
    state.token = expectedToken;
    state.dispatched = false;
    state.handler = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && (target === element || element.contains(target))) {
        state.dispatched = true;
      }
    };
    document.addEventListener('click', state.handler, true);
    host.__autorecruitBossForwardClick = state;
  }, token);
}

async function readBossForwardClickDispatched(page: Page, token: string): Promise<boolean> {
  return page.evaluate((expectedToken) => {
    const state = (window as Window & { __autorecruitBossForwardClick?: { token: string; dispatched: boolean } }).__autorecruitBossForwardClick;
    return Boolean(state && state.token === expectedToken && state.dispatched);
  }, token).catch(() => false);
}

async function clearBossForwardClickObserver(page: Page, token: string): Promise<void> {
  await page.evaluate((expectedToken) => {
    const host = window as Window & { __autorecruitBossForwardClick?: { token: string; handler: (event: Event) => void } };
    const state = host.__autorecruitBossForwardClick;
    if (!state || state.token !== expectedToken) return;
    document.removeEventListener('click', state.handler, true);
    delete host.__autorecruitBossForwardClick;
  }, token).catch(() => undefined);
}

async function confirmBossForward(
  dialog: Locator,
  candidateId: string,
  expectedMessage: string,
  deadline: number,
  cleanupReserveMs = 0,
): Promise<void> {
  const forwardButton = dialog.locator('a[ka="geek_coop_forward"]');
  const buttonCount = await forwardButton.count();
  if (buttonCount !== 1) {
    throw new Error(`Expected one Boss forward confirmation button for candidate ${candidateId}, found ${buttonCount}.`);
  }
  const beforeSuccessSignature = await readBossForwardSuccessSignature(dialog.page());
  const observerToken = `boss-forward-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await armBossForwardClickObserver(forwardButton, observerToken);
  try {
    await clickBossControlNatively(dialog.page(), forwardButton, remainingTime(deadline), {
      deadline,
      cleanupReserveMs,
      beforeClick: async () => {
        const currentButtons = dialog.locator('a[ka="geek_coop_forward"]');
        if (await currentButtons.count() !== 1 || !(await currentButtons.first().isVisible().catch(() => false))) {
          throw new Error(`Boss forward confirmation control changed before candidate ${candidateId} click.`);
        }
        const message = dialog.locator('textarea[placeholder="请输入留言"]');
        if (await message.count() !== 1 || await message.inputValue().catch(() => '') !== expectedMessage) {
          throw new Error(`Boss forward message changed before candidate ${candidateId} click.`);
        }
      },
    });
  } catch (error) {
    const dispatched = await readBossForwardClickDispatched(dialog.page(), observerToken);
    await clearBossForwardClickObserver(dialog.page(), observerToken);
    if (!dispatched) {
      throw new BossForwardPreConfirmationError(`Boss resume forward confirmation did not dispatch for candidate ${candidateId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new BossForwardUncertainError(`Boss resume forward click is uncertain for candidate ${candidateId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dispatched = await readBossForwardClickDispatched(dialog.page(), observerToken);
  await clearBossForwardClickObserver(dialog.page(), observerToken);
  if (!dispatched) {
    throw new BossForwardPreConfirmationError(`Boss resume forward confirmation did not dispatch for candidate ${candidateId}.`);
  }
  await dialog.waitFor({ state: 'hidden', timeout: remainingTimeWithReserve(deadline, cleanupReserveMs) }).catch(async () => {
    const dialogText = await dialog.innerText().catch(() => '');
    throw new BossForwardUncertainError(`Boss resume forward completion is uncertain for candidate ${candidateId}. Dialog text: ${normalizeText(dialogText).slice(0, 500)}`);
  });
  if (await bossPurchaseChatDialogs(dialog.page()).count().catch(() => 0) > 0) {
    await raiseUnexpectedContactDialog(
      dialog.page(),
      deadline,
      'Boss resume forward confirmation exposed the search-chat-card purchase dialog',
    );
  }
  try {
    await waitForBossForwardSuccessEvidence(
      dialog.page(),
      deadline,
      beforeSuccessSignature,
      cleanupReserveMs,
    );
  } catch {
    throw new BossForwardUncertainError(`Boss resume forward success evidence was not observed for candidate ${candidateId}.`);
  }
}

export async function forwardBossResumeAction(
  page: Page,
  input: {
    candidateId: string;
    mode: BossForwardMode;
    recipient: string;
    actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']>;
    ccEmails?: readonly string[];
    /** Adds one simple line to Boss email-forward messages only. */
    hasColleagueCommunication?: boolean;
    deadline: number;
    cleanupReserveMs?: number;
  },
): Promise<void> {
  const recipient = normalizeText(input.recipient);
  if (!recipient) throw new Error('Boss forward recipient must be a non-empty string.');
  const ccEmails = normalizeEmailList(input.ccEmails) ?? [];
  if (input.mode !== 'email' && ccEmails.length) {
    throw new Error('Boss forward CC is only supported for email forwarding.');
  }
  const recipients = input.mode === 'email'
    ? normalizeEmailList([recipient, ...ccEmails])!
    : [recipient];
  if (input.actionMode === 'prepare-only' && recipients.length > 1) {
    throw new Error('Boss copy forwarding requires confirmed sequential actions and cannot be prepared in one dialog.');
  }
  for (const targetRecipient of recipients) {
    const dialog = await openBossForwardDialog(page, input.deadline, input.cleanupReserveMs ?? 0);
    const expectedMessage = await fillBossForwardForm(
      dialog,
      input.mode,
      targetRecipient,
      input.candidateId,
      input.hasColleagueCommunication === true,
      input.deadline,
      input.cleanupReserveMs ?? 0,
    );
    if (input.actionMode !== 'prepare-only') {
      await confirmBossForward(
        dialog,
        input.candidateId,
        expectedMessage,
        input.deadline,
        input.cleanupReserveMs ?? 0,
      );
    }
  }
}

export async function forwardBossResume(
  page: Page,
  candidate: CandidateListItem,
  mode: BossForwardMode,
  recipient: string,
  actionMode: NonNullable<CandidatePostOpenActions['bossForwardActionMode']> = 'confirm',
  ccEmails?: readonly string[],
  cachePayloadForParse = true,
  options?: CandidateProfileDetailOptions,
  hasColleagueCommunication = false,
): Promise<void> {
  const normalizedRecipient = normalizeText(recipient);
  if (!normalizedRecipient) {
    throw new Error('Boss forward recipient must be a non-empty string.');
  }
  if (mode !== 'email' && normalizeEmailList(ccEmails)?.length) {
    throw new Error('Boss forward CC is only supported for email forwarding.');
  }
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  const { payload } = await readVerifiedBossResumePayload(
    page,
    candidate,
    deadline,
    options?.cleanupReserveMs ?? 0,
  );
  if (cachePayloadForParse) {
    cacheBossResumePayload(page, candidate.candidateId, payload);
  } else {
    bossResumePayloadCache.get(page)?.delete(candidate.candidateId);
  }
  await forwardBossResumeAction(page, {
    candidateId: candidate.candidateId,
    mode,
    recipient: normalizedRecipient,
    actionMode,
    ccEmails,
    hasColleagueCommunication,
    deadline,
    cleanupReserveMs: options?.cleanupReserveMs,
  });
}
