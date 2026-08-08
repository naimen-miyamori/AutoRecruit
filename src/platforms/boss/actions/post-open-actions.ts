import type { Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { CandidatePostOpenActions, CandidateProfileDetailOptions } from '../../types.js';
import {
  BossResumeDetailCloseError,
  closeBossResumeDetailStrict,
  forwardBossResume,
} from './resume-detail-actions.js';

function createResumeDetailDeadline(): number {
  return Date.now() + Math.max(config.playwright.resumeDetailTimeoutMs, 1);
}

export async function runBossPostOpenActions(
  page: Page,
  candidate: CandidateListItem,
  actions: CandidatePostOpenActions,
  options?: CandidateProfileDetailOptions,
): Promise<void> {
  const hasMode = actions.bossForwardMode !== undefined;
  const hasRecipient = actions.bossForwardRecipient !== undefined;
  if (hasMode !== hasRecipient) {
    throw new Error('Boss forward mode and recipient must be provided together.');
  }
  if (actions.bossForwardCcEmails !== undefined && !hasMode) {
    throw new Error('Boss forward CC requires a Boss forward mode and recipient.');
  }

  // Normal capture may pass the configured target through this hook for
  // compatibility/observability, while the workflow itself owns the durable
  // per-recipient pre-capture transaction. Never issue a second external send.
  if (actions.bossForwardTransactionManaged) return;

  if (actions.bossForwardMode && actions.bossForwardRecipient) {
    await forwardBossResume(
      page,
      candidate,
      actions.bossForwardMode,
      actions.bossForwardRecipient,
      actions.bossForwardActionMode,
      actions.bossForwardCcEmails,
      true,
      options,
    );
  }
}

export async function closeBossResumeDetail(
  page: Page,
  _detailPage?: Page,
  _candidate?: CandidateListItem,
  options?: CandidateProfileDetailOptions,
): Promise<void> {
  // Lightweight orchestration doubles used by offline tests expose no DOM
  // locator API. Real Boss pages always do; keep the adapter seam compatible
  // without weakening the strict browser-side postcondition below.
  if (typeof (page as Partial<Page>).locator !== 'function') return;
  const deadline = options?.deadline ?? createResumeDetailDeadline();
  try {
    await closeBossResumeDetailStrict(page, deadline, {
      pace: false,
      cleanupReserveMs: options?.cleanupReserveMs,
    });
  } catch (error) {
    if (error instanceof BossResumeDetailCloseError) throw error;
    throw new BossResumeDetailCloseError(
      `Boss resume detail close failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

