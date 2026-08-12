import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  BossRejectionEmailDeliveryBusyError,
  BossRejectionEmailDispatchBusyError,
  JobStore,
} from '../storage/job-store.js';
import type {
  BossCandidateRoutingArtifact,
  BossForwardingStatus,
  BossRejectionEmailDispatchPauseCode,
  BossRejectionEmailOutboxEntry,
} from '../types/job.js';
export type { BossRejectionEmailDispatchPauseCode } from '../types/job.js';
import {
  assertDeliverableEmailAddress,
  assertSmtpConfigurationReady,
  normalizeMailDeliveryError,
  sendJobReportEmail,
  type SendJobReportEmailParams,
  type SendJobReportEmailResult,
} from './mailer.js';

const BOSS_REJECTION_EMAIL_MAX_ATTEMPTS = 2;
const BOSS_REJECTION_EMAIL_RETRY_DELAY_MS = 1_500;
export const BOSS_REJECTION_EMAIL_MINIMUM_ATTEMPT_GAP_MS = 3_000;

export interface BossRejectionEmailDeliveryDependencies {
  now: () => Date;
  assertSmtpConfigurationReady: () => void;
  sendMail: (input: SendJobReportEmailParams) => Promise<SendJobReportEmailResult>;
  waitImmediateRetry: () => Promise<void>;
  beforeAttemptReservation?: () => Promise<void>;
  onSmtpAttempt?: (attemptedAt: string) => Promise<void> | void;
}

export interface BossRejectionEmailDispatcherDependencies {
  now: () => Date;
  delay: (delayMs: number) => Promise<void>;
  minimumAttemptGapMs: number;
  assertSmtpConfigurationReady: () => void;
  sendMail: (input: SendJobReportEmailParams) => Promise<SendJobReportEmailResult>;
}

export interface BossRejectionEmailDispatchPause {
  code: BossRejectionEmailDispatchPauseCode;
  deliveryId: string;
  message: string;
}

export interface BossRejectionEmailDispatchSummary {
  entries: BossRejectionEmailOutboxEntry[];
  smtpAttemptCount: number;
  pause?: BossRejectionEmailDispatchPause;
}

export interface BossRejectionEmailDispatcher {
  enqueueLive(entry: BossRejectionEmailOutboxEntry): 'accepted' | 'duplicate' | 'closed';
  closeAndDrain(): Promise<BossRejectionEmailDispatchSummary>;
}

interface DispatchQueueItem {
  deliveryId: string;
  lane: 'live' | 'recovery' | 'recovery-sending';
}

class BossRejectionEmailDispatchInvariantError extends Error {
  constructor(
    readonly pauseCode: BossRejectionEmailDispatchPauseCode,
    message: string,
  ) {
    super(message);
    this.name = 'BossRejectionEmailDispatchInvariantError';
  }
}

function nowIso(dependencies: Pick<BossRejectionEmailDeliveryDependencies, 'now'>): string {
  return dependencies.now().toISOString();
}

function composeBossRejectionEmailOutboxState(
  entry: BossRejectionEmailOutboxEntry,
  status: BossForwardingStatus,
  updatedAt: string,
  error?: string,
): BossRejectionEmailOutboxEntry {
  return {
    ...entry,
    status,
    updatedAt,
    ...(status === 'sent' ? { completedAt: updatedAt } : {}),
    ...(error && status !== 'sent' ? { error } : {}),
  };
}

export function normalizedBossRejectionEmailAttemptCount(entry: BossRejectionEmailOutboxEntry): number {
  if (entry.attemptCount === undefined) return 0;
  if (!Number.isInteger(entry.attemptCount)
    || entry.attemptCount < 0
    || entry.attemptCount > BOSS_REJECTION_EMAIL_MAX_ATTEMPTS) {
    throw new Error(`Invalid Boss rejection email attempt count for ${entry.deliveryId}.`);
  }
  return entry.attemptCount;
}

export function hasRetryableBossRejectionEmail(entry: BossRejectionEmailOutboxEntry): boolean {
  return entry.status === 'pending'
    || (entry.status === 'retryable-failed'
      && entry.retryExhausted !== true
      && normalizedBossRejectionEmailAttemptCount(entry) < BOSS_REJECTION_EMAIL_MAX_ATTEMPTS);
}

export function isUnresolvedBossRejectionEmail(entry: BossRejectionEmailOutboxEntry): boolean {
  return entry.status === 'pending'
    || entry.status === 'sending'
    || entry.status === 'retryable-failed'
    || entry.status === 'uncertain';
}

function redactRejectionEmailError(value: string): string {
  return value.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/gu, '[redacted-email]');
}

function immutableDeliveryFields(entry: BossRejectionEmailOutboxEntry): object {
  return {
    version: entry.version,
    deliveryId: entry.deliveryId,
    candidateId: entry.candidateId,
    routingDecisionId: entry.routingDecisionId,
    routingArtifact: entry.routingArtifact,
    policyHash: entry.policyHash,
    recipientEmail: entry.recipientEmail,
    ccEmails: entry.ccEmails,
    messageId: entry.messageId,
    subject: entry.subject,
    markdown: entry.markdown,
    contentHash: entry.contentHash,
    detailClosedAt: entry.detailClosedAt,
  };
}

function assertRoutingArtifactMatchesEntry(
  entry: BossRejectionEmailOutboxEntry,
  artifact: BossCandidateRoutingArtifact,
): void {
  if (!entry.routingDecisionId
    || artifact.routingDecisionId !== entry.routingDecisionId
    || artifact.candidateId !== entry.candidateId
    || artifact.policyHash !== entry.policyHash
    || artifact.classification !== 'rejected'
    || artifact.audience !== 'secondary'
    || artifact.deliveryKind !== 'rejection-email'
    || !isDeepStrictEqual(artifact, entry.routingArtifact)) {
    throw new BossRejectionEmailDispatchInvariantError(
      'routing-conflict',
      `Boss rejection email ${entry.deliveryId} conflicts with its immutable routing evidence.`,
    );
  }
}

const defaultDeliveryDependencies: BossRejectionEmailDeliveryDependencies = {
  now: () => new Date(),
  assertSmtpConfigurationReady,
  sendMail: sendJobReportEmail,
  waitImmediateRetry: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, BOSS_REJECTION_EMAIL_RETRY_DELAY_MS));
  },
};

async function executeBossRejectionEmailDelivery(
  store: JobStore,
  jobKey: string,
  input: BossRejectionEmailOutboxEntry,
  dependencyOverrides: Partial<BossRejectionEmailDeliveryDependencies> = {},
): Promise<BossRejectionEmailOutboxEntry> {
  const dependencies: BossRejectionEmailDeliveryDependencies = {
    ...defaultDeliveryDependencies,
    ...dependencyOverrides,
  };
  return store.withBossRejectionEmailDeliveryLock('boss', jobKey, input.deliveryId, async ({ token }) => {
    const persisted = await store.readBossRejectionEmailOutboxEntry('boss', jobKey, input.deliveryId);
    return executeBossRejectionEmailDeliveryLocked(
      store,
      jobKey,
      persisted ?? input,
      token,
      dependencies,
    );
  });
}

/** Test-only seam for the existing delivery transition matrix. Production must use the dispatcher. */
export async function executeBossRejectionEmailDeliveryForTest(
  store: JobStore,
  jobKey: string,
  input: BossRejectionEmailOutboxEntry,
  dependencyOverrides: Partial<BossRejectionEmailDeliveryDependencies> = {},
): Promise<BossRejectionEmailOutboxEntry> {
  return executeBossRejectionEmailDelivery(store, jobKey, input, dependencyOverrides);
}

async function executeBossRejectionEmailDeliveryLocked(
  store: JobStore,
  jobKey: string,
  input: BossRejectionEmailOutboxEntry,
  leaseToken: string,
  dependencies: BossRejectionEmailDeliveryDependencies,
): Promise<BossRejectionEmailOutboxEntry> {
  const saveEntry = (entry: BossRejectionEmailOutboxEntry): Promise<string> =>
    store.saveBossRejectionEmailOutboxEntry('boss', jobKey, entry, { leaseToken });
  let entry: BossRejectionEmailOutboxEntry = {
    ...input,
    ...(input.attemptCount === undefined ? { attemptCount: 0 } : {}),
  };
  if (entry.status === 'sending') {
    entry = composeBossRejectionEmailOutboxState(
      entry,
      'uncertain',
      nowIso(dependencies),
      'The prior process ended after the rejection email send began; verify the mailbox before any manual action.',
    );
    await saveEntry(entry);
    return entry;
  }
  if (!hasRetryableBossRejectionEmail(entry)
    || entry.status === 'sent'
    || entry.status === 'uncertain'
    || entry.status === 'superseded') {
    return entry;
  }
  if (!entry.recipientEmail.trim() || !entry.subject.trim() || !entry.markdown.trim()) {
    const failed = composeBossRejectionEmailOutboxState(
      entry,
      'superseded',
      nowIso(dependencies),
      'Rejection email payload is incomplete and immutable; delivery was superseded and no SMTP call was attempted.',
    );
    await saveEntry(failed);
    return failed;
  }
  try {
    assertDeliverableEmailAddress(entry.recipientEmail, 'recipient');
    for (const [index, ccEmail] of entry.ccEmails.entries()) {
      assertDeliverableEmailAddress(ccEmail, `cc[${index}]`);
    }
  } catch {
    const failed = composeBossRejectionEmailOutboxState(
      entry,
      'superseded',
      nowIso(dependencies),
      'Rejection email has an invalid immutable recipient; delivery was superseded and no SMTP call was attempted.',
    );
    await saveEntry(failed);
    return failed;
  }
  try {
    dependencies.assertSmtpConfigurationReady();
  } catch {
    const failed = composeBossRejectionEmailOutboxState(
      entry,
      'retryable-failed',
      nowIso(dependencies),
      'Rejection email SMTP configuration is incomplete; no SMTP call was attempted.',
    );
    await saveEntry(failed);
    return failed;
  }
  const contentHash = createHash('sha256').update(entry.markdown).digest('hex');
  if (contentHash !== entry.contentHash) {
    const failed = composeBossRejectionEmailOutboxState(
      entry,
      'superseded',
      nowIso(dependencies),
      'Rejection email immutable content hash changed; delivery was superseded and no SMTP call was attempted.',
    );
    await saveEntry(failed);
    return failed;
  }

  while (true) {
    const previousAttemptCount = normalizedBossRejectionEmailAttemptCount(entry);
    if (entry.retryExhausted === true || previousAttemptCount >= BOSS_REJECTION_EMAIL_MAX_ATTEMPTS) {
      return entry;
    }
    await dependencies.beforeAttemptReservation?.();
    const attemptCount = previousAttemptCount + 1;
    const attemptedAt = nowIso(dependencies);
    entry = {
      ...entry,
      status: 'sending',
      attemptCount,
      attemptedAt,
      updatedAt: attemptedAt,
      error: undefined,
      lastSmtpFailure: undefined,
    };
    await saveEntry(entry);
    try {
      await dependencies.onSmtpAttempt?.(attemptedAt);
      await dependencies.sendMail({
        recipient: entry.recipientEmail,
        ccEmails: entry.ccEmails,
        subject: entry.subject,
        markdown: entry.markdown,
        messageId: entry.messageId,
      });
      entry = {
        ...composeBossRejectionEmailOutboxState(entry, 'sent', nowIso(dependencies)),
        error: undefined,
        lastSmtpFailure: undefined,
        retryExhausted: undefined,
      };
      await saveEntry(entry);
      return entry;
    } catch (error) {
      const normalizedError = normalizeMailDeliveryError(error);
      const evidence = normalizedError.evidence;
      const updatedAt = nowIso(dependencies);
      const summary = redactRejectionEmailError(normalizedError.message).slice(0, 500);
      const knownNotSent = evidence.retrySafety === 'known-not-sent';
      entry = {
        ...composeBossRejectionEmailOutboxState(
          entry,
          knownNotSent ? 'retryable-failed' : 'uncertain',
          updatedAt,
          summary,
        ),
        lastSmtpFailure: {
          ...evidence,
          occurredAt: updatedAt,
          summary,
        },
        ...(knownNotSent && !entry.retryAuthorization ? {
          retryAuthorization: {
            ...evidence,
            failedAttempt: 1 as const,
            occurredAt: updatedAt,
            summary,
          },
        } : {}),
        ...(knownNotSent && attemptCount >= BOSS_REJECTION_EMAIL_MAX_ATTEMPTS
          ? { retryExhausted: true }
          : {}),
      };
      await saveEntry(entry);
      if (!knownNotSent
        || attemptCount >= BOSS_REJECTION_EMAIL_MAX_ATTEMPTS
        || evidence.retryDisposition !== 'immediate-once') {
        return entry;
      }
      await dependencies.waitImmediateRetry();
    }
  }
}

const defaultDispatcherDependencies: BossRejectionEmailDispatcherDependencies = {
  now: () => new Date(),
  delay: async (delayMs) => {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  },
  minimumAttemptGapMs: BOSS_REJECTION_EMAIL_MINIMUM_ATTEMPT_GAP_MS,
  assertSmtpConfigurationReady,
  sendMail: sendJobReportEmail,
};

function sortRecoveryEntries(
  entries: readonly BossRejectionEmailOutboxEntry[],
): BossRejectionEmailOutboxEntry[] {
  return [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.deliveryId.localeCompare(right.deliveryId));
}

export function createBossRejectionEmailDispatcher(input: {
  store: JobStore;
  jobKey: string;
  policyHash: string;
  recoveryEntries?: readonly BossRejectionEmailOutboxEntry[];
  dependencies?: Partial<BossRejectionEmailDispatcherDependencies>;
}): BossRejectionEmailDispatcher {
  const dependencies: BossRejectionEmailDispatcherDependencies = {
    ...defaultDispatcherDependencies,
    ...input.dependencies,
  };
  if (!Number.isFinite(dependencies.minimumAttemptGapMs) || dependencies.minimumAttemptGapMs < 0) {
    throw new Error('Boss rejection email minimum SMTP attempt gap must be a non-negative finite number.');
  }

  const trackedDeliveryIds: string[] = [];
  const trackedDeliveryIdSet = new Set<string>();
  const trackedEntriesByDeliveryId = new Map<string, BossRejectionEmailOutboxEntry>();
  const liveQueue: DispatchQueueItem[] = [];
  const recoveryQueue: DispatchQueueItem[] = [];
  let closed = false;
  let worker: Promise<void> | undefined;
  let smtpAttemptCount = 0;
  let pause: BossRejectionEmailDispatchPause | undefined;
  let pendingRecoveryPause: BossRejectionEmailDispatchPause | undefined;

  const track = (entry: BossRejectionEmailOutboxEntry): boolean => {
    if (trackedDeliveryIdSet.has(entry.deliveryId)) return false;
    trackedDeliveryIdSet.add(entry.deliveryId);
    trackedDeliveryIds.push(entry.deliveryId);
    trackedEntriesByDeliveryId.set(entry.deliveryId, structuredClone(entry));
    return true;
  };

  const setPause = (
    code: BossRejectionEmailDispatchPauseCode,
    deliveryId: string,
    message: string,
  ): void => {
    if (pause) return;
    pause = {
      code,
      deliveryId,
      message: redactRejectionEmailError(message).slice(0, 500),
    };
  };

  const assertDispatchableEvidence = async (
    queuedDeliveryId: string,
  ): Promise<BossRejectionEmailOutboxEntry> => {
    const entry = await input.store.readBossRejectionEmailOutboxEntry('boss', input.jobKey, queuedDeliveryId);
    if (!entry) {
      throw new BossRejectionEmailDispatchInvariantError(
        'delivery-not-executable',
        `Boss rejection email ${queuedDeliveryId} is missing from the durable outbox.`,
      );
    }
    const queuedEntry = trackedEntriesByDeliveryId.get(queuedDeliveryId);
    if (!queuedEntry || !bossRejectionEmailImmutableFactsMatch(entry, queuedEntry)) {
      throw new BossRejectionEmailDispatchInvariantError(
        'routing-conflict',
        `Boss rejection email ${queuedDeliveryId} changed after it entered this run's authorized delivery set.`,
      );
    }
    if (!entry.detailClosedAt || !Number.isFinite(Date.parse(entry.detailClosedAt))) {
      throw new BossRejectionEmailDispatchInvariantError(
        'delivery-not-executable',
        `Boss rejection email ${entry.deliveryId} has no valid strict-detail-close proof.`,
      );
    }
    if (entry.policyHash !== input.policyHash) {
      throw new BossRejectionEmailDispatchInvariantError(
        'routing-conflict',
        `Boss rejection email ${entry.deliveryId} belongs to a different screening policy.`,
      );
    }
    assertRoutingArtifactMatchesEntry(entry, entry.routingArtifact);
    let persistedArtifact = await input.store.readBossCandidateRoutingArtifactByDecisionId(
      'boss',
      input.jobKey,
      entry.routingDecisionId,
    );
    if (!persistedArtifact) {
      await input.store.saveBossCandidateRoutingArtifact('boss', input.jobKey, entry.routingArtifact);
      persistedArtifact = await input.store.readBossCandidateRoutingArtifactByDecisionId(
        'boss',
        input.jobKey,
        entry.routingDecisionId,
      );
    }
    if (!persistedArtifact) {
      throw new BossRejectionEmailDispatchInvariantError(
        'routing-conflict',
        `Boss rejection email ${entry.deliveryId} routing evidence was not durable after write-back.`,
      );
    }
    assertRoutingArtifactMatchesEntry(entry, persistedArtifact);
    return entry;
  };

  const waitForCadence = async (leaseToken: string): Promise<void> => {
    const state = await input.store.readBossRejectionEmailDispatchState(
      'boss',
      input.jobKey,
      leaseToken,
    );
    if (!state) return;
    const elapsedMs = dependencies.now().getTime() - Date.parse(state.lastAttemptStartedAt);
    if (elapsedMs < 0) {
      throw new Error('Boss rejection email dispatch cadence state is ahead of the current clock.');
    }
    const remainingMs = dependencies.minimumAttemptGapMs - elapsedMs;
    if (remainingMs > 0) {
      await dependencies.delay(remainingMs);
      const elapsedAfterDelayMs = dependencies.now().getTime() - Date.parse(state.lastAttemptStartedAt);
      if (elapsedAfterDelayMs < dependencies.minimumAttemptGapMs) {
        throw new Error('Boss rejection email dispatch cadence delay completed before the minimum gap elapsed.');
      }
    }
  };

  const dispatchOne = async (item: DispatchQueueItem): Promise<BossRejectionEmailOutboxEntry> => {
    return input.store.withBossRejectionEmailDispatchLock('boss', input.jobKey, async ({ token }) => {
      const persisted = await assertDispatchableEvidence(item.deliveryId);
      return executeBossRejectionEmailDelivery(input.store, input.jobKey, persisted, {
        now: dependencies.now,
        assertSmtpConfigurationReady: dependencies.assertSmtpConfigurationReady,
        sendMail: dependencies.sendMail,
        waitImmediateRetry: async () => dependencies.delay(BOSS_REJECTION_EMAIL_RETRY_DELAY_MS),
        beforeAttemptReservation: async () => waitForCadence(token),
        onSmtpAttempt: async (attemptedAt) => {
          await input.store.saveBossRejectionEmailDispatchState('boss', input.jobKey, {
            version: 1,
            lastAttemptStartedAt: attemptedAt,
          }, token);
          smtpAttemptCount += 1;
        },
      });
    });
  };

  const handleDispatchError = (item: DispatchQueueItem, error: unknown): void => {
    if (error instanceof BossRejectionEmailDispatchInvariantError) {
      setPause(error.pauseCode, item.deliveryId, error.message);
      return;
    }
    if (error instanceof BossRejectionEmailDispatchBusyError) {
      setPause('dispatch-busy', item.deliveryId, error.message);
      return;
    }
    if (error instanceof BossRejectionEmailDeliveryBusyError) {
      setPause('delivery-busy', item.deliveryId, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    setPause(
      message.includes('dispatch cadence')
        ? 'dispatch-state-invalid'
        : 'internal-error',
      item.deliveryId,
      message,
    );
  };

  const runWorker = async (): Promise<void> => {
    while (true) {
      const inheritedSending = recoveryQueue[0]?.lane === 'recovery-sending'
        ? recoveryQueue.shift()
        : undefined;
      if (!inheritedSending && pendingRecoveryPause && !pause) {
        setPause(
          pendingRecoveryPause.code,
          pendingRecoveryPause.deliveryId,
          pendingRecoveryPause.message,
        );
        pendingRecoveryPause = undefined;
      }
      if (pause) return;
      const item = inheritedSending ?? liveQueue.shift() ?? recoveryQueue.shift();
      if (!item) return;
      try {
        const result = await dispatchOne(item);
        if (result.status === 'uncertain') {
          const uncertainPause: BossRejectionEmailDispatchPause = {
            code: 'uncertain',
            deliveryId: result.deliveryId,
            message: result.error ?? `Boss rejection email ${result.deliveryId} has an uncertain SMTP outcome.`,
          };
          if (item.lane === 'recovery-sending') {
            pendingRecoveryPause ??= uncertainPause;
          } else {
            setPause(uncertainPause.code, uncertainPause.deliveryId, uncertainPause.message);
          }
        } else if (result.status === 'retryable-failed') {
          setPause(
            'known-not-sent',
            result.deliveryId,
            result.error ?? `Boss rejection email ${result.deliveryId} was not sent.`,
          );
        } else if (result.status === 'superseded') {
          setPause(
            'delivery-not-executable',
            result.deliveryId,
            result.error ?? `Boss rejection email ${result.deliveryId} was superseded.`,
          );
        }
      } catch (error) {
        handleDispatchError(item, error);
      }
    }
  };

  const kick = (): void => {
    if (worker || pause || (liveQueue.length === 0 && recoveryQueue.length === 0)) return;
    worker = runWorker()
      .catch((error: unknown) => {
        const deliveryId = liveQueue[0]?.deliveryId
          ?? recoveryQueue[0]?.deliveryId
          ?? trackedDeliveryIds[trackedDeliveryIds.length - 1]
          ?? 'unknown';
        handleDispatchError({ deliveryId, lane: 'recovery' }, error);
      })
      .finally(() => {
        worker = undefined;
        if (!pause && (liveQueue.length > 0 || recoveryQueue.length > 0)) kick();
      });
  };

  const sortedRecovery = sortRecoveryEntries(input.recoveryEntries ?? [])
    .filter((entry) => entry.policyHash === input.policyHash && isUnresolvedBossRejectionEmail(entry));
  for (const entry of sortedRecovery) track(entry);
  const existingUncertain = sortedRecovery.find((entry) => entry.status === 'uncertain');
  if (existingUncertain) {
    pendingRecoveryPause = {
      code: 'uncertain',
      deliveryId: existingUncertain.deliveryId,
      message: existingUncertain.error
        ?? `Boss rejection email ${existingUncertain.deliveryId} already has an uncertain SMTP outcome.`,
    };
  }
  const inheritedSendingEntries = sortedRecovery.filter((candidate) => candidate.status === 'sending');
  for (const entry of inheritedSendingEntries) {
    recoveryQueue.push({ deliveryId: entry.deliveryId, lane: 'recovery-sending' });
  }
  for (const entry of sortedRecovery.filter((candidate) =>
    candidate.status !== 'sending' && hasRetryableBossRejectionEmail(candidate))) {
    recoveryQueue.push({ deliveryId: entry.deliveryId, lane: 'recovery' });
  }
  if (inheritedSendingEntries.length === 0 && pendingRecoveryPause) {
    setPause(
      pendingRecoveryPause.code,
      pendingRecoveryPause.deliveryId,
      pendingRecoveryPause.message,
    );
    pendingRecoveryPause = undefined;
  }
  kick();

  return {
    enqueueLive(entry) {
      if (closed) return 'closed';
      if (!track(entry)) return 'duplicate';
      liveQueue.push({ deliveryId: entry.deliveryId, lane: 'live' });
      kick();
      return 'accepted';
    },
    async closeAndDrain() {
      closed = true;
      kick();
      while (worker) {
        const currentWorker = worker;
        await currentWorker;
      }
      const entries: BossRejectionEmailOutboxEntry[] = [];
      for (const deliveryId of trackedDeliveryIds) {
        const entry = await input.store.readBossRejectionEmailOutboxEntry('boss', input.jobKey, deliveryId);
        if (entry) entries.push(entry);
      }
      return {
        entries,
        smtpAttemptCount,
        ...(pause ? { pause } : {}),
      };
    },
  };
}

/** Used by close finalization to prove the dispatcher will observe identical immutable facts. */
export function bossRejectionEmailImmutableFactsMatch(
  left: BossRejectionEmailOutboxEntry,
  right: BossRejectionEmailOutboxEntry,
): boolean {
  return isDeepStrictEqual(immutableDeliveryFields(left), immutableDeliveryFields(right));
}
