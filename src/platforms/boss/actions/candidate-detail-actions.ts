import type { BrowserContext, Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { CandidateProfileDetailOptions } from '../../types.js';
import {
  clickBossControlNatively,
  waitBossActionPaceWithinDeadline,
} from './context.js';
import {
  assertNoBossPurchaseChatDialog,
  BossUnexpectedContactDialogError,
  closeBossResumeDetailStrict,
  closeExistingBossResumeDialog,
  isBossResumeDetailVisible,
  verifyBossResumeDetailIdentity,
  waitForBossResumeDetailOrPurchase,
} from './resume-detail-actions.js';
import { waitForBossSearchFrame } from './search-actions.js';

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

async function resolveBossCandidateAnchorIndex(page: Page, candidate: CandidateListItem, deadline: number): Promise<number> {
  const frame = await waitForBossSearchFrame(page, deadline);
  const anchors = frame.locator('a[ka="search_click_open_resume"], a[data-expect], a[data-jid], a[data-lid]');
  const anchorCount = await anchors.count();
  if (anchorCount === 0) {
    throw new Error(`Could not open Boss resume detail for candidate ${candidate.candidateId}: no candidate cards are visible.`);
  }

  if (candidate.candidateId.startsWith('boss-card-')) {
    throw new Error(`Could not open Boss resume detail for candidate ${candidate.candidateId}: card has no stable Boss identity.`);
  }

  const matchedIndexes = await anchors.evaluateAll((elements, candidateId) => {
    return elements.flatMap((element, index) => {
      const dataExpect = element.getAttribute('data-expect') ?? '';
      const dataJid = element.getAttribute('data-jid') ?? '';
      const dataLid = element.getAttribute('data-lid') ?? '';

      return (dataExpect === candidateId
        || dataJid === candidateId
        || dataLid === candidateId
        || (dataJid && dataLid && `${dataJid}_${dataLid}` === candidateId)) ? [index] : [];
    });
  }, candidate.candidateId);

  if (matchedIndexes.length !== 1) {
    throw new Error(`Could not uniquely find Boss candidate card for ${candidate.candidateId}; matched ${matchedIndexes.length}.`);
  }

  return matchedIndexes[0]!;
}

export async function openBossResumeDetail(
  _context: BrowserContext,
  searchPage: Page,
  candidate: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<Page> {
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  if (options) {
    if (await isBossResumeDetailVisible(searchPage)) {
      await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
    }
  } else {
    await closeExistingBossResumeDialog(searchPage, deadline);
  }
  await assertNoBossPurchaseChatDialog(searchPage, deadline);

  const frame = await waitForBossSearchFrame(searchPage, deadline);
  const targetIndex = await resolveBossCandidateAnchorIndex(searchPage, candidate, deadline);
  const candidateAnchor = frame.locator('a[ka="search_click_open_resume"], a[data-expect], a[data-jid], a[data-lid]').nth(targetIndex);
  const marker = `boss-detail-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await candidateAnchor.evaluate((element, input) => {
    const identifiers = [
      element.getAttribute('data-expect'),
      element.getAttribute('data-jid'),
      element.getAttribute('data-lid'),
    ].filter((value): value is string => Boolean(value));
    if (!identifiers.includes(input.candidateId)
      && !(identifiers.includes(input.candidateId.split('_')[0] ?? '') && identifiers.includes(input.candidateId.split('_')[1] ?? ''))) {
      throw new Error(`Boss detail target was replaced before marking candidate ${input.candidateId}.`);
    }
    element.setAttribute('data-autorecruit-boss-detail-target', input.marker);
  }, { candidateId: candidate.candidateId, marker });
  const markedAnchor = frame.locator(`[data-autorecruit-boss-detail-target="${marker}"]`);
  const safeClickTargetCandidates = markedAnchor.locator('.geek-info-detail:visible, .search-geek-info:visible, .card-inner:visible');
  const findTopLevelSafeClickTargetIndexes = async (): Promise<number[]> => safeClickTargetCandidates.evaluateAll((elements) => {
    const visible = (element: Element): boolean => element instanceof HTMLElement
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      && window.getComputedStyle(element).visibility !== 'hidden';
    const visibleElements = elements.filter(visible);
    return visibleElements
      .filter((element) => !visibleElements.some((other) => other !== element && other.contains(element)))
      .map((element) => elements.indexOf(element));
  });
  const initialSafeClickTargetIndexes = await findTopLevelSafeClickTargetIndexes();
  if (initialSafeClickTargetIndexes.length !== 1) {
    throw new Error(
      `Could not uniquely find a safe Boss detail click target for candidate ${candidate.candidateId}; found ${initialSafeClickTargetIndexes.length}.`,
    );
  }
  const clickTargetMarker = `${marker}-click`;
  await safeClickTargetCandidates.nth(initialSafeClickTargetIndexes[0]!).evaluate((element, expectedMarker) => {
    element.setAttribute('data-autorecruit-boss-detail-click-target', expectedMarker);
  }, clickTargetMarker);
  const markedSafeClickTarget = markedAnchor.locator(`[data-autorecruit-boss-detail-click-target="${clickTargetMarker}"]`);
  const assertSafeClickTargetStillCurrent = async (): Promise<void> => {
    const markedCount = await markedAnchor.count().catch(() => 0);
    if (markedCount !== 1) {
      throw new Error(`Boss detail target for candidate ${candidate.candidateId} was replaced before click; found ${markedCount}.`);
    }
    const identityMatches = await markedAnchor.evaluate((element, candidateId) => {
      const identifiers = [
        element.getAttribute('data-expect'),
        element.getAttribute('data-jid'),
        element.getAttribute('data-lid'),
      ].filter((value): value is string => Boolean(value));
      return identifiers.includes(candidateId)
        || (candidateId.includes('_')
          && identifiers.includes(candidateId.split('_')[0] ?? '')
          && identifiers.includes(candidateId.split('_')[1] ?? ''));
    }, candidate.candidateId).catch(() => false);
    if (!identityMatches) {
      throw new Error(`Boss detail target identity changed before clicking candidate ${candidate.candidateId}.`);
    }
    const currentTargetIndexes = await findTopLevelSafeClickTargetIndexes();
    if (currentTargetIndexes.length !== 1) {
      throw new Error(
        `Could not uniquely find a safe Boss detail click target for candidate ${candidate.candidateId}; found ${currentTargetIndexes.length}.`,
      );
    }
    const currentTopLevelTarget = safeClickTargetCandidates.nth(currentTargetIndexes[0]!);
    if (await currentTopLevelTarget.getAttribute('data-autorecruit-boss-detail-click-target') !== clickTargetMarker) {
      throw new Error(`Boss detail click target changed before clicking candidate ${candidate.candidateId}.`);
    }
    if (await markedSafeClickTarget.count().catch(() => 0) !== 1) {
      throw new Error(`Boss detail click target marker was lost before clicking candidate ${candidate.candidateId}.`);
    }
  };

  try {
    await assertSafeClickTargetStillCurrent();
    await clickBossControlNatively(searchPage, markedSafeClickTarget, remainingTime(deadline), {
      deadline,
      cleanupReserveMs: options?.cleanupReserveMs ?? 0,
      beforeClick: assertSafeClickTargetStillCurrent,
    });
    await waitForBossResumeDetailOrPurchase(searchPage, deadline, options?.cleanupReserveMs ?? 0);
    return searchPage;
  } finally {
    await candidateAnchor.evaluate((element, expectedMarker) => {
      if (element.getAttribute('data-autorecruit-boss-detail-target') === expectedMarker) {
        element.removeAttribute('data-autorecruit-boss-detail-target');
      }
      for (const child of element.querySelectorAll('[data-autorecruit-boss-detail-click-target]')) {
        if (child.getAttribute('data-autorecruit-boss-detail-click-target') === `${expectedMarker}-click`) {
          child.removeAttribute('data-autorecruit-boss-detail-click-target');
        }
      }
    }, marker).catch(() => undefined);
  }
}

export type BossSeenCandidateDetailFailureStage = 'card-resolve' | 'detail-open' | 'identity-verify' | 'detail-close';

export class BossSeenCandidateDetailError extends Error {
  readonly stage: BossSeenCandidateDetailFailureStage;
  readonly detailOpened: boolean;
  readonly detailIdentityVerified: boolean;
  readonly detailClosed: boolean;
  readonly fatalCloseFailure: boolean;

  constructor(input: {
    message: string;
    stage: BossSeenCandidateDetailFailureStage;
    detailOpened: boolean;
    detailIdentityVerified: boolean;
    detailClosed: boolean;
    fatalCloseFailure: boolean;
  }) {
    super(input.message);
    this.name = 'BossSeenCandidateDetailError';
    this.stage = input.stage;
    this.detailOpened = input.detailOpened;
    this.detailIdentityVerified = input.detailIdentityVerified;
    this.detailClosed = input.detailClosed;
    this.fatalCloseFailure = input.fatalCloseFailure;
  }
}

export interface BossSeenCandidateDetailVisitReceipt {
  candidateId: string;
  detailOpened: true;
  detailIdentityVerified: true;
  detailClosed: true;
}

/**
 * Opens one already-seen search card, verifies the live detail identity, and
 * closes the detail again. This is intentionally a read-only history-view
 * action: it never parses/persists a resume and never invokes forwarding or
 * contact controls.
 */
export async function visitBossSeenCandidateDetail(
  searchPage: Page,
  candidate: CandidateListItem,
  options: CandidateProfileDetailOptions = { deadline: createResumeDetailDeadline() },
): Promise<BossSeenCandidateDetailVisitReceipt> {
  const deadline = options.deadline;
  let detailOpened = false;
  let detailIdentityVerified = false;
  let detailClosed = false;
  let closeAttempted = false;

  try {
    await assertNoBossPurchaseChatDialog(searchPage, deadline);
    await openBossResumeDetail(searchPage.context(), searchPage, candidate, options);
    detailOpened = true;
    await waitBossActionPaceWithinDeadline(searchPage, deadline, options.cleanupReserveMs ?? 0);
  } catch (error) {
    let closeError: unknown;
    const detailVisible = await isBossResumeDetailVisible(searchPage).catch(() => false);
    if ((detailOpened || detailVisible) && !closeAttempted) {
      closeAttempted = true;
      try {
        await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
        detailClosed = true;
      } catch (cleanupError) {
        closeError = cleanupError;
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stage: BossSeenCandidateDetailFailureStage = /Could not (?:open|uniquely find) Boss candidate card|card has no stable Boss identity|no candidate cards are visible/.test(errorMessage)
      ? 'card-resolve'
      : 'detail-open';
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail open failed for candidate ${candidate.candidateId}: ${errorMessage}${closeError ? `; close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}` : ''}`,
      stage,
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: Boolean(closeError) || error instanceof BossUnexpectedContactDialogError,
    });
  }

  try {
    await verifyBossResumeDetailIdentity(searchPage, candidate, deadline, options.cleanupReserveMs ?? 0);
    detailIdentityVerified = true;
    await waitBossActionPaceWithinDeadline(searchPage, deadline, options.cleanupReserveMs ?? 0);
  } catch (error) {
    // Identity failures are retryable, but the modal must still be closed once
    // before the next card is considered. A failed close leaves the page for
    // inspection and stops orchestration rather than clicking again.
    let closeError: unknown;
    if (!closeAttempted) {
      closeAttempted = true;
      try {
        await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
        detailClosed = true;
      } catch (cleanupError) {
        closeError = cleanupError;
      }
    }
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail identity verification failed for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}${closeError ? `; close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}` : ''}`,
      stage: 'identity-verify',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: Boolean(closeError),
    });
  }

  closeAttempted = true;
  try {
    await closeBossResumeDetailStrict(searchPage, deadline, { pace: false });
    detailClosed = true;
  } catch (error) {
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail close failed for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}`,
      stage: 'detail-close',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: true,
    });
  }

  if (!detailOpened || !detailIdentityVerified || !detailClosed) {
    throw new BossSeenCandidateDetailError({
      message: `Boss history detail lifecycle was incomplete for candidate ${candidate.candidateId}.`,
      stage: 'detail-close',
      detailOpened,
      detailIdentityVerified,
      detailClosed,
      fatalCloseFailure: true,
    });
  }
  return {
    candidateId: candidate.candidateId,
    detailOpened: true,
    detailIdentityVerified: true,
    detailClosed: true,
  };
}

