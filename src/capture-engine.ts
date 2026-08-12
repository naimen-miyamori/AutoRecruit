import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { config } from './config.js';
import { JobStore } from './storage/job-store.js';
import type { BrowserSession } from './browser/session.js';
import { handoffPlatformWorkPage } from './browser/platform-runtime.js';
import { waitPlatformActionPace, waitPlatformCandidatePace } from './browser/pacing.js';
import { createProductionExtractionBoundary } from './extraction/production-extractor.js';
import { getPlatformAdapter } from './platforms/registry.js';
import { fiftyOneJobAdapter } from './platforms/51job-adapter.js';
import {
  BossForwardUncertainError,
  BossUnexpectedContactDialogError,
  BossResumeDetailCloseError,
  BossResumeIdentityVerificationError,
  forwardBossResume,
} from './platforms/boss-adapter.js';
import {
  BossSeenCandidateDetailError,
  visitBossSeenCandidateDetail,
} from './platforms/boss/actions/candidate-detail-actions.js';
import {
  assertCoreSavedSearchTarget,
  assertPlatformSavedSearchOpenEvidence,
  isZhilianNativeSavedSearchOpenEvidence,
  isZhilianNativeSavedSearchTarget,
} from './search/saved-search-target.js';
import {
  bossActionPaceUpperBoundMs,
  waitBossActionPaceWithinDeadline,
} from './platforms/boss/actions/context.js';
import { readBossColleagueCommunicationFlag } from './platforms/boss/actions/resume-detail-actions.js';
import type {
  BossForwardMode,
  CandidatePostOpenActions,
  CandidatePostOpenResult,
  CandidateProfileDetailOptions,
  CoreSavedSearchVerificationRequest,
  PlatformAdapter,
  SupportedPlatform,
} from './platforms/types.js';
import { scoreResumeAgainstJob } from './scoring/score-resume.js';
import { getCodexSessionFailureDiagnostic } from './llm/codex-session-provider.js';
import {
  hashBossScreeningPolicy,
  hashPostScoreRoutingPolicy,
  resolveBossRoutingDecision,
  resolvePostScoreRoutingDecision,
  scoreAndEvaluateBossScreening,
  scoreAndEvaluatePostScoreRouting,
} from './scoring/boss-screening.js';
import {
  assertSmtpConfigurationReady,
  sendJobReportEmail,
} from './reporting/mailer.js';
import {
  buildBossRejectionEmailMessageId,
  buildBossRejectionEmailPayload,
} from './reporting/boss-rejection-email.js';
import {
  BOSS_REJECTION_EMAIL_MINIMUM_ATTEMPT_GAP_MS,
  bossRejectionEmailImmutableFactsMatch,
  createBossRejectionEmailDispatcher,
  executeBossRejectionEmailDeliveryForTest,
  isUnresolvedBossRejectionEmail,
  type BossRejectionEmailDispatcher,
} from './reporting/boss-rejection-email-dispatcher.js';
import { sendJobReportEmailRef } from './scripts/send-job-report-email.js';
import type {
  BossCandidateRoutingArtifact,
  BossForwardingDeliveryState,
  BossForwardingOutboxEntry,
  BossForwardingSettings,
  BossForwardingStatus,
  BossRejectionEmailDispatchPauseCode,
  BossRejectionEmailOutboxEntry,
  BossRoutingDecision,
  BossScreeningWorkItem,
  BossScreeningSettings,
  CandidateRoutingArtifact,
  PostScoreRoutingSettings,
  PostScoreRoutingWorkItem,
  CaptureFailureStage,
  CandidateListItem,
  CandidateResume,
  CandidateScore,
  CandidateScoreArtifact,
  CodexSessionFailureDiagnostic,
  ResumeDomSnapshot,
  JobSearchSource,
  CoreSavedSearchTarget,
  PlatformSavedSearchOpenEvidence,
  NormalizedJob,
  ReportDeliveryOptions,
  RunResult,
  SavedSearchReference,
  SearchCondition,
  SearchSortPolicy,
  RunCaptureFailure,
  RunProcessingFailure,
  BossSeenViewSyncFailure,
  BossSeenViewSyncResult,
} from './types/job.js';

export function createCaptureEngine() {
interface CandidateProcessResult {
  candidateId: string;
  captured: boolean;
  detailVerified: boolean;
  detailLifecycle: BossDetailLifecycleState;
  failureStage?: CaptureFailureStage;
  failureReason?: string;
}

interface BossDetailLifecycleState {
  detailOpened: boolean;
  detailIdentityVerified: boolean;
  detailClosed: boolean;
}

function createBossDetailLifecycleOptions(options: { forwarding?: boolean } = {}): CandidateProfileDetailOptions {
  const cleanupReserveMs = Math.max(1_000, bossActionPaceUpperBoundMs());
  // Browser actions remain bounded even when a workflow keeps the same Boss
  // detail visible during an unbounded model turn. After model completion the
  // workflow explicitly starts one bounded same-detail continuation budget.
  const operationBudgetMs = options.forwarding
    ? Math.max(120_000, config.playwright.resumeDetailTimeoutMs * 4)
    : config.playwright.resumeDetailTimeoutMs;
  const timeoutMs = Math.max(
    operationBudgetMs,
    cleanupReserveMs + 1,
  );
  return {
    deadline: Date.now() + timeoutMs,
    cleanupReserveMs,
  };
}

function createCandidateDetailLifecycleOptions(
  platform: SupportedPlatform,
  platformAdapter: PlatformAdapter,
): CandidateProfileDetailOptions | undefined {
  if (platform === 'boss') {
    return createBossDetailLifecycleOptions();
  }

  const estimate = platformAdapter.estimateCandidateDetailBudget?.();
  if (!estimate) return undefined;
  if (!Number.isFinite(estimate.timeoutMs) || estimate.timeoutMs <= 0) {
    throw new Error(`Platform ${platform} returned an invalid candidate detail timeout estimate.`);
  }
  const cleanupReserveMs = estimate.cleanupReserveMs ?? 0;
  if (!Number.isFinite(cleanupReserveMs) || cleanupReserveMs < 0 || cleanupReserveMs >= estimate.timeoutMs) {
    throw new Error(`Platform ${platform} returned an invalid candidate detail cleanup reserve.`);
  }
  return {
    deadline: Date.now() + estimate.timeoutMs,
    ...(cleanupReserveMs > 0 ? { cleanupReserveMs } : {}),
  };
}

async function waitCandidateDetailPaceWithinDeadline(
  page: Page,
  platform: SupportedPlatform,
  options: CandidateProfileDetailOptions,
  cleanupReserveMs = options.cleanupReserveMs ?? 0,
): Promise<void> {
  const paceUpperBoundMs = config.playwright.actionDelayMaxMsByPlatform[platform];
  if (Date.now() + paceUpperBoundMs + cleanupReserveMs >= options.deadline) {
    throw new Error(`Platform ${platform} candidate detail deadline cannot accommodate the required pacing interval.`);
  }
  await waitPlatformActionPaceRef.fn(page, platform);
  if (Date.now() + cleanupReserveMs >= options.deadline) {
    throw new Error(`Platform ${platform} candidate detail deadline was exhausted during pacing.`);
  }
}

function continueBossDetailLifecycleAfterModel(
  options: CandidateProfileDetailOptions | undefined,
  forwarding: boolean,
): void {
  if (!options) return;
  Object.assign(options, createBossDetailLifecycleOptions({ forwarding }));
}

interface BossScreeningCandidateResult {
  candidateId: string;
  scoreArtifact: CandidateScoreArtifact;
  routingArtifact: BossCandidateRoutingArtifact;
  forwardingOutbox?: BossForwardingOutboxEntry;
  rejectionEmailOutbox?: BossRejectionEmailOutboxEntry;
}

interface CandidateScoreFailure {
  candidateId: string;
  error: string;
  diagnostic?: CodexSessionFailureDiagnostic;
}

interface CandidateScoringResult {
  scoredCandidates: string[];
  failedCandidates: CandidateScoreFailure[];
  routingArtifacts?: CandidateRoutingArtifact[];
}

type BossScreeningPreparationResult =
  | { status: 'decided'; result: BossScreeningCandidateResult }
  | { status: 'pending-score'; failure: CandidateScoreFailure; scoreArtifact: CandidateScoreArtifact };

const extractionBoundary = createProductionExtractionBoundary();
const openSubscribeSearchRef = { fn: fiftyOneJobAdapter.openSubscribeSearch };
const openBoundSavedSearchRef = {
  fn: async (
    adapter: PlatformAdapter,
    page: Page,
    target: Parameters<NonNullable<PlatformAdapter['openBoundSavedSearch']>>[1],
    options: Parameters<NonNullable<PlatformAdapter['openBoundSavedSearch']>>[2],
  ) => {
    if (!adapter.openBoundSavedSearch) {
      throw new Error(`Platform ${adapter.platform} does not register strict saved-search opening.`);
    }
    return adapter.openBoundSavedSearch(page, target, options);
  },
};
const openDirectSearchRef = { fn: fiftyOneJobAdapter.openDirectSearch };
const openResumeDetailRef = { fn: fiftyOneJobAdapter.openResumeDetail };
const visitBossSeenCandidateDetailRef = { fn: visitBossSeenCandidateDetail };
const readBossColleagueCommunicationFlagRef = { fn: readBossColleagueCommunicationFlag };
const extractCandidateListRef = {
  // Compatibility seam for 51job orchestration tests. Its production target
  // is the platform-owned candidate action, never the legacy page extractor.
  fn: fiftyOneJobAdapter.extractCandidateList,
};
const extractCandidateListWithAdapterRef = {
  fn: async (
    adapter: PlatformAdapter,
    page: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
    options?: Parameters<PlatformAdapter['extractCandidateList']>[1],
  ) => adapter.extractCandidateList(page, options),
};
const extractResumeFromPageRef = {
  fn: extractionBoundary.extractResumeFromPage,
};
const scoreResumeAgainstJobRef = { fn: scoreResumeAgainstJob };
/** Test seam for the combined Boss score-and-negative-condition evaluation. */
const scoreAndEvaluateBossScreeningRef = { fn: scoreAndEvaluateBossScreening };
const scoreAndEvaluatePostScoreRoutingRef = { fn: scoreAndEvaluatePostScoreRouting };
const waitBossRejectionEmailRetryRef = { fn: waitBossRejectionEmailRetry };
/** Test seam for rejection-email preflight, one bounded retry, and recovery. */
const executeBossRejectionEmailDeliveryRef = {
  fn: async (
    store: JobStore,
    jobKey: string,
    input: BossRejectionEmailOutboxEntry,
    onSmtpAttempt?: () => void,
  ) => executeBossRejectionEmailDeliveryForTest(store, jobKey, input, {
    assertSmtpConfigurationReady: () => {
      if (sendJobReportEmailRef.fn === sendJobReportEmail) assertSmtpConfigurationReady();
    },
    sendMail: (params) => sendJobReportEmailRef.fn(params),
    waitImmediateRetry: () => waitBossRejectionEmailRetryRef.fn(),
    ...(onSmtpAttempt ? { onSmtpAttempt: () => onSmtpAttempt() } : {}),
  }),
};
const waitPlatformActionPaceRef = { fn: waitPlatformActionPace };
const waitPlatformCandidatePaceRef = { fn: waitPlatformCandidatePace };
const forwardBossResumeRef = { fn: forwardBossResume };

function formatResumeSnapshot(resume: CandidateResume): string {
  const lines: string[] = [
    `候选人ID：${resume.candidateId}`,
    resume.name ? `姓名：${resume.name}` : '',
    resume.age ? `年龄：${resume.age}` : '',
    resume.nativePlace ? `籍贯：${resume.nativePlace}` : '',
    resume.education ? `学历：${resume.education}` : '',
    resume.regions.length > 0 ? `地区：${resume.regions.join('、')}` : '',
  ].filter(Boolean);

  if (resume.pr.length > 0) {
    lines.push('', '个人优势', ...resume.pr);
  }

  if (resume.workExperiences.length > 0) {
    lines.push('', '工作经历');
    for (const work of resume.workExperiences) {
      lines.push([
        work.start && work.end ? `${work.start}-${work.end}` : work.start ?? work.end,
        work.company,
        work.title,
      ].filter(Boolean).join(' | '));
      lines.push(...work.details);
    }
  }

  if (resume.projectExperiences.length > 0) {
    lines.push('', '项目经历');
    for (const project of resume.projectExperiences) {
      lines.push([
        project.start && project.end ? `${project.start}-${project.end}` : project.start ?? project.end,
        project.company,
        project.name,
      ].filter(Boolean).join(' | '));
      lines.push(...project.details);
    }
  }

  if (resume.educationExperiences.length > 0) {
    lines.push('', '教育经历');
    for (const education of resume.educationExperiences) {
      lines.push([
        education.start && education.end ? `${education.start}-${education.end}` : education.start ?? education.end,
        education.school,
        education.degree,
        education.major,
      ].filter(Boolean).join(' | '));
      lines.push(...education.details);
    }
  }

  if (resume.certificates.length > 0) {
    lines.push('', '证书/技能', ...resume.certificates);
  }

  return `${lines.filter((line, index, values) => line || values[index - 1]).join('\n')}\n`;
}

const BOSS_REJECTION_EMAIL_DELIVERY_VERSION = 1 as const;

function createBossRejectionEmailDeliveryId(jobKey: string, candidateId: string): string {
  return createHash('sha256').update(JSON.stringify({
    jobKey,
    candidateId,
    delivery: 'boss-rejection-email',
    version: BOSS_REJECTION_EMAIL_DELIVERY_VERSION,
  })).digest('hex');
}

function createBossRejectionEmailOutboxEntry(input: {
  jobKey: string;
  jobTitle: string;
  resume: CandidateResume;
  artifact: BossCandidateRoutingArtifact;
  secondaryDelivery: NonNullable<BossScreeningSettings['secondaryDelivery']>;
  requirements: BossScreeningSettings['requirements'];
  now: string;
}): BossRejectionEmailOutboxEntry {
  const payload = buildBossRejectionEmailPayload({
    jobKey: input.jobKey,
    jobTitle: input.jobTitle,
    decidedAt: input.artifact.decidedAt,
    artifact: input.artifact,
    resume: input.resume,
    requirements: input.requirements,
  });
  const deliveryId = createBossRejectionEmailDeliveryId(input.jobKey, input.resume.candidateId);
  return {
    version: BOSS_REJECTION_EMAIL_DELIVERY_VERSION,
    deliveryId,
    candidateId: input.resume.candidateId,
    routingDecisionId: input.artifact.routingDecisionId ?? deliveryId,
    routingArtifact: input.artifact,
    policyHash: input.artifact.policyHash,
    recipientEmail: input.secondaryDelivery.recipientEmail,
    ccEmails: [...new Set(input.secondaryDelivery.ccEmails ?? [])],
    messageId: buildBossRejectionEmailMessageId(deliveryId),
    subject: payload.subject,
    markdown: payload.markdown,
    contentHash: payload.contentHash,
    status: 'pending',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const BOSS_REJECTION_EMAIL_RETRY_DELAY_MS = 1_500;

async function waitBossRejectionEmailRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, BOSS_REJECTION_EMAIL_RETRY_DELAY_MS));
}

function createBossForwardingOutboxEntry(
  candidateId: string,
  policyHash: string,
  decision: BossRoutingDecision,
  forwarding: BossForwardingSettings,
  now: string,
  metadata?: {
    routingDecisionId?: string;
    routingFacts?: BossForwardingOutboxEntry['routingFacts'];
  },
): BossForwardingOutboxEntry {
  const deliveries = createBossForwardingDeliveries(forwarding, 'pending');
  return {
    candidateId,
    workflow: 'post-score',
    ...(metadata?.routingDecisionId ? { routingDecisionId: metadata.routingDecisionId } : {}),
    ...(metadata?.routingFacts ? { routingFacts: metadata.routingFacts } : {}),
    policyHash,
    classification: decision.classification,
    audience: decision.audience,
    createdAt: now,
    updatedAt: now,
    forwarding: {
      status: 'pending',
      mode: forwarding.mode,
      recipient: forwarding.recipient,
      ...(forwarding.ccEmails === undefined ? {} : { ccEmails: forwarding.ccEmails }),
      deliveries,
    },
  };
}

function createBossRoutingDecisionId(input: {
  jobKey: string;
  candidateId: string;
  policyHash: string;
  scoredAt?: string;
  decision: BossRoutingDecision;
}): string {
  return createHash('sha256').update(JSON.stringify({
    jobKey: input.jobKey,
    candidateId: input.candidateId,
    policyHash: input.policyHash,
    scoredAt: input.scoredAt,
    classification: input.decision.classification,
    audience: input.decision.audience,
    matchedRequirementIds: input.decision.matchedRequirementIds,
    unknownRequirementIds: input.decision.unknownRequirementIds,
    reason: input.decision.reason,
  })).digest('hex');
}

/**
 * Disabled screening keeps the historical "forward before parse" order, but
 * it still needs the same durable per-recipient state as post-score routing.
 * The synthetic policy hash identifies this pre-capture workflow and prevents
 * an entry from being interpreted as a screening decision during recovery.
 */
const BOSS_PRE_CAPTURE_FORWARDING_POLICY_HASH = 'boss-pre-capture-forwarding-v1';

function createBossPreCaptureForwardingOutboxEntry(
  candidateId: string,
  forwarding: BossForwardingSettings,
  now: string,
): BossForwardingOutboxEntry {
  const decision: BossRoutingDecision = {
    classification: 'qualified',
    audience: 'primary',
    matchedRequirementIds: [],
    unknownRequirementIds: [],
    reason: 'Boss screening disabled; legacy pre-capture forwarding.',
  };
  return {
    ...createBossForwardingOutboxEntry(
      candidateId,
      BOSS_PRE_CAPTURE_FORWARDING_POLICY_HASH,
      decision,
      forwarding,
      now,
    ),
    workflow: 'pre-capture',
  };
}

function createBossForwardingDeliveries(
  forwarding: Pick<BossForwardingSettings, 'mode' | 'recipient' | 'ccEmails'>,
  status: BossForwardingStatus,
): BossForwardingDeliveryState[] {
  const primaryRecipient = forwarding.recipient.trim();
  if (!primaryRecipient) {
    throw new Error('Boss forwarding recipient must be non-empty.');
  }
  const ccEmails = forwarding.ccEmails?.map((email) => email.trim()).filter(Boolean) ?? [];
  if (forwarding.mode !== 'email' && ccEmails.length > 0) {
    throw new Error('Boss forward CC is only supported for email forwarding.');
  }

  const deliveries: BossForwardingDeliveryState[] = [];
  const seenRecipients = new Set<string>();
  const addDelivery = (role: BossForwardingDeliveryState['role'], recipient: string) => {
    const key = forwarding.mode === 'email' ? recipient.toLocaleLowerCase('en-US') : recipient;
    if (seenRecipients.has(key)) return;
    seenRecipients.add(key);
    deliveries.push({ role, recipient, status });
  };
  addDelivery('recipient', primaryRecipient);
  for (const ccEmail of ccEmails) addDelivery('cc', ccEmail);
  return deliveries;
}

function aggregateBossForwardingStatus(deliveries: readonly BossForwardingDeliveryState[]): BossForwardingStatus {
  if (deliveries.length > 0 && deliveries.every((delivery) => delivery.status === 'superseded')) return 'superseded';
  if (deliveries.some((delivery) => delivery.status === 'sending')) return 'sending';
  // Uncertain means at least one external confirmation may already have been
  // accepted. Keep that safety signal visible even if another target remains
  // retryable; retry selection is deliberately based on the delivery rows.
  if (deliveries.some((delivery) => delivery.status === 'uncertain')) return 'uncertain';
  if (deliveries.some((delivery) => delivery.status === 'retryable-failed')) return 'retryable-failed';
  if (deliveries.some((delivery) => delivery.status === 'pending')) return 'pending';
  if (deliveries.some((delivery) => delivery.status === 'superseded')) return 'superseded';
  return 'sent';
}

function latestIsoTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

// Filesystem artifact names are ordered by decidedAt. Keep decisions from a
// fast, zero-pacing test or live loop strictly monotonic so report selection
// cannot depend on directory ordering when several candidates finish inside
// one millisecond.
let lastBossRoutingTimestampMs = 0;

function createMonotonicBossRoutingTimestamp(): string {
  const next = Math.max(Date.now(), lastBossRoutingTimestampMs + 1);
  lastBossRoutingTimestampMs = next;
  return new Date(next).toISOString();
}

function composeBossForwardingState(
  base: BossForwardingOutboxEntry['forwarding'],
  deliveries: BossForwardingDeliveryState[],
  fallbackError?: string,
): BossForwardingOutboxEntry['forwarding'] {
  const status = aggregateBossForwardingStatus(deliveries);
  const attemptedAt = latestIsoTimestamp(deliveries.map((delivery) => delivery.attemptedAt));
  const completedAt = status === 'sent'
    ? latestIsoTimestamp(deliveries.map((delivery) => delivery.completedAt))
    : undefined;
  const error = deliveries.find((delivery) => delivery.status === 'uncertain')?.error
    ?? deliveries.find((delivery) => delivery.status === 'retryable-failed')?.error
    ?? fallbackError;
  return {
    status,
    mode: base.mode,
    recipient: base.recipient,
    ...(base.ccEmails === undefined ? {} : { ccEmails: base.ccEmails }),
    deliveries,
    ...(attemptedAt ? { attemptedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(error && status !== 'sent' ? { error } : {}),
  };
}

function migrateBossForwardingState(
  forwarding: BossForwardingOutboxEntry['forwarding'],
): BossForwardingOutboxEntry['forwarding'] {
  if (forwarding.deliveries && forwarding.deliveries.length > 0) {
    return composeBossForwardingState(forwarding, forwarding.deliveries, forwarding.error);
  }

  // Legacy entries represented the entire configured target set with one
  // status. A pre-confirmation pending/failure is safe to replay. A prior
  // sending/uncertain operation might already have delivered the whole set,
  // so every target becomes uncertain and is never retried automatically.
  const deliveryStatus: BossForwardingStatus = forwarding.status === 'sending'
    ? 'uncertain'
    : forwarding.status;
  const recoveryError = forwarding.status === 'sending'
    ? forwarding.error ?? 'The prior process ended after an external forwarding attempt began; verify on Boss before any retry.'
    : forwarding.error;
  const deliveries = createBossForwardingDeliveries(forwarding, deliveryStatus).map((delivery) => ({
    ...delivery,
    ...(forwarding.attemptedAt ? { attemptedAt: forwarding.attemptedAt } : {}),
    ...(deliveryStatus === 'sent' && forwarding.completedAt ? { completedAt: forwarding.completedAt } : {}),
    ...(recoveryError && (deliveryStatus === 'uncertain' || deliveryStatus === 'retryable-failed')
      ? { error: recoveryError }
      : {}),
  }));
  return composeBossForwardingState(forwarding, deliveries, recoveryError);
}

function hasRetryableBossForwardingDelivery(entry: BossForwardingOutboxEntry): boolean {
  const forwarding = migrateBossForwardingState(entry.forwarding);
  return forwarding.deliveries!.some((delivery) =>
    delivery.status === 'pending' || delivery.status === 'retryable-failed');
}

async function ensureBossRoutingArtifactFromOutbox(
  store: JobStore,
  jobKey: string,
  entry: BossForwardingOutboxEntry,
): Promise<void> {
  const facts = entry.routingFacts;
  if (!facts || entry.workflow === 'pre-capture') return;
  const artifacts = await store.listBossCandidateRoutingArtifacts('boss', jobKey);
  const matches = artifacts.filter((artifact) => entry.routingDecisionId
    ? artifact.routingDecisionId === entry.routingDecisionId
    : artifact.candidateId === facts.candidateId
      && artifact.policyHash === facts.policyHash
      && artifact.decidedAt === facts.decidedAt);
  const expected: BossCandidateRoutingArtifact = {
    ...facts,
    ...(entry.routingDecisionId ? { routingDecisionId: entry.routingDecisionId } : {}),
    forwarding: entry.forwarding,
  };
  if (matches.length > 1) {
    throw new Error(`Expected at most one Boss routing artifact for decision ${entry.routingDecisionId ?? `${facts.candidateId}/${facts.decidedAt}`}, found ${matches.length}.`);
  }
    if (matches.length === 1) {
      const actual = matches[0]!;
      const comparable = (artifact: BossCandidateRoutingArtifact) => {
        const { forwarding: _forwarding, ...immutable } = artifact;
        return {
          ...immutable,
          deliveryKind: artifact.deliveryKind ?? 'boss-forwarding',
        };
      };
    if (JSON.stringify(comparable(actual)) !== JSON.stringify(comparable(expected))) {
      throw new Error(`Boss routing artifact conflicts with durable outbox decision ${entry.routingDecisionId ?? facts.candidateId}.`);
    }
    return;
  }
  await store.saveBossCandidateRoutingArtifact('boss', jobKey, expected);
}

function replaceBossForwardingDelivery(
  entry: BossForwardingOutboxEntry,
  deliveryIndex: number,
  delivery: BossForwardingDeliveryState,
  updatedAt: string,
): BossForwardingOutboxEntry {
  const forwarding = migrateBossForwardingState(entry.forwarding);
  const deliveries = forwarding.deliveries!.map((value, index) => index === deliveryIndex ? delivery : value);
  return {
    ...entry,
    updatedAt,
    forwarding: composeBossForwardingState(forwarding, deliveries),
  };
}

async function executeBossForwardingDeliveries(input: {
  jobKey: string;
  candidate: CandidateListItem;
  entry: BossForwardingOutboxEntry;
  detailPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
  store: JobStore;
  detailOptions?: CandidateProfileDetailOptions;
  hasColleagueCommunication?: boolean;
}): Promise<BossForwardingOutboxEntry> {
  const { jobKey, candidate, detailPage, store, detailOptions } = input;
  let current: BossForwardingOutboxEntry = {
    ...input.entry,
    forwarding: migrateBossForwardingState(input.entry.forwarding),
  };
  await store.saveBossForwardingOutboxEntry('boss', jobKey, current);

  for (let index = 0; index < current.forwarding.deliveries!.length; index += 1) {
    const delivery = current.forwarding.deliveries![index]!;
    if (delivery.status !== 'pending' && delivery.status !== 'retryable-failed') continue;

    const attemptedAt = new Date().toISOString();
    current = replaceBossForwardingDelivery(current, index, {
      role: delivery.role,
      recipient: delivery.recipient,
      status: 'sending',
      attemptedAt,
    }, attemptedAt);
    await store.saveBossForwardingOutboxEntry('boss', jobKey, current);

    try {
      // Each Boss dialog has only one recipient field. A configured CC is an
      // independent delivery: the page action reopens a fresh dialog and the
      // candidate ID and optional colleague-communication note are written to
      // that delivery's message field as well.
      await forwardBossResumeRef.fn(
        detailPage as never,
        candidate,
        current.forwarding.mode,
        delivery.recipient,
        'confirm',
        undefined,
        false,
        detailOptions,
        input.hasColleagueCommunication === true,
      );
      const completedAt = new Date().toISOString();
      current = replaceBossForwardingDelivery(current, index, {
        role: delivery.role,
        recipient: delivery.recipient,
        status: 'sent',
        attemptedAt,
        completedAt,
      }, completedAt);
    } catch (error) {
      if (error instanceof BossUnexpectedContactDialogError) {
        throw error;
      }
      const updatedAt = new Date().toISOString();
      current = replaceBossForwardingDelivery(current, index, {
        role: delivery.role,
        recipient: delivery.recipient,
        status: error instanceof BossForwardUncertainError ? 'uncertain' : 'retryable-failed',
        attemptedAt,
        error: error instanceof Error ? error.message : String(error),
      }, updatedAt);
      await store.saveBossForwardingOutboxEntry('boss', jobKey, current);
      return current;
    }
    await store.saveBossForwardingOutboxEntry('boss', jobKey, current);
  }

  return current;
}

/** Scores the persisted resume while its verified Boss detail remains open. */
async function scoreAndPrepareBossCapturedCandidate(input: {
  jobKey: string;
  job: NormalizedJob;
  candidate: CandidateListItem;
  resume: CandidateResume;
  store: JobStore;
  fetchedAt: string;
  screening: BossScreeningSettings;
  primaryForwarding: BossForwardingSettings;
}): Promise<BossScreeningPreparationResult> {
  const {
    jobKey,
    job,
    candidate,
    resume,
    store,
    fetchedAt,
    screening,
    primaryForwarding,
  } = input;
  const scoredAt = new Date().toISOString();
  const scoreArtifactBase = {
    candidateId: resume.candidateId,
    candidateShareUrl: resume.candidateShareUrl,
    model: config.scoring.model,
    scoredAt,
  };
  let result: Awaited<ReturnType<typeof scoreAndEvaluateBossScreeningRef.fn>>;

  try {
    result = await scoreAndEvaluateBossScreeningRef.fn({
      job,
      resume,
      policy: screening,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = getCodexSessionFailureDiagnostic(error);
    const scoreArtifact: CandidateScoreArtifact = {
      ...scoreArtifactBase,
      status: 'failed',
      error: message,
      ...(diagnostic ? { diagnostic } : {}),
    };
    await store.saveCandidateScoreArtifact('boss', jobKey, scoreArtifact);
    return {
      status: 'pending-score',
      failure: {
        candidateId: candidate.candidateId,
        error: message,
        ...(diagnostic ? { diagnostic } : {}),
      },
      scoreArtifact,
    };
  }

  const scoreArtifact: CandidateScoreArtifact = {
    ...scoreArtifactBase,
    ...(result.resumeInputHash ? { resumeInputHash: result.resumeInputHash } : {}),
    status: 'success',
    score: result.score,
  };
  await store.saveCandidateScoreArtifact('boss', jobKey, scoreArtifact);
  const policyHash = hashBossScreeningPolicy(screening);
  const decision = resolveBossRoutingDecision(scoreArtifact, result.evaluations, screening);

  const now = createMonotonicBossRoutingTimestamp();
  const routingFacts: NonNullable<BossForwardingOutboxEntry['routingFacts']> = {
    candidateId: candidate.candidateId,
    fetchedAt,
    scoredAt,
    decidedAt: now,
    policyHash,
    scoreStatus: scoreArtifact.status,
    classification: decision.classification,
    audience: decision.audience,
    requirementEvaluations: result.evaluations,
    matchedRequirementIds: decision.matchedRequirementIds,
    unknownRequirementIds: decision.unknownRequirementIds,
    reason: decision.reason,
  };
  const routingDecisionId = createBossRoutingDecisionId({
    jobKey,
    candidateId: candidate.candidateId,
    policyHash,
    scoredAt,
    decision,
  });
  if (decision.classification === 'rejected') {
    if (!screening.secondaryDelivery?.recipientEmail) {
      throw new Error(`Boss rejection email for ${candidate.candidateId} has no secondary recipient`);
    }
    const routingArtifact: BossCandidateRoutingArtifact = {
      ...routingFacts,
      routingDecisionId,
      deliveryKind: 'rejection-email',
    };
    // Rejected delivery cannot be materialized until the same detail has
    // strictly closed. The caller keeps the pending-score handoff until its
    // close callback atomically anchors the rejection outbox and artifact.
    return {
      status: 'decided',
      result: {
        candidateId: candidate.candidateId,
        scoreArtifact,
        routingArtifact,
      },
    };
  }

  const pendingOutbox = createBossForwardingOutboxEntry(
    candidate.candidateId,
    policyHash,
    decision,
    primaryForwarding,
    now,
    { routingDecisionId, routingFacts },
  );
  const routingArtifact: BossCandidateRoutingArtifact = {
    ...routingFacts,
    routingDecisionId,
    deliveryKind: 'boss-forwarding',
    forwarding: pendingOutbox.forwarding,
  };
  // The outbox is the recovery anchor. Persist it before the immutable
  // artifact so an interruption cannot leave a routing decision with no
  // durable target set; recovery can rebuild the artifact from routingFacts.
  await store.saveBossForwardingOutboxEntry('boss', jobKey, pendingOutbox);
  await store.saveBossCandidateRoutingArtifact('boss', jobKey, routingArtifact);
  return {
    status: 'decided',
    result: {
      candidateId: candidate.candidateId,
      scoreArtifact,
      routingArtifact,
      forwardingOutbox: pendingOutbox,
    },
  };
}

async function finalizeBossRejectedCandidateAfterDetailClose(input: {
  jobKey: string;
  job: NormalizedJob;
  resume: CandidateResume;
  store: JobStore;
  screening: BossScreeningSettings;
  result: BossScreeningCandidateResult;
  detailClosedAt: string;
}): Promise<BossScreeningCandidateResult> {
  if (input.result.routingArtifact.classification !== 'rejected'
    || input.result.routingArtifact.audience !== 'secondary') {
    throw new Error(`Boss rejected close finalization received a non-rejected decision for ${input.resume.candidateId}.`);
  }
  if (!input.screening.secondaryDelivery?.recipientEmail) {
    throw new Error(`Boss rejection email for ${input.resume.candidateId} has no secondary recipient.`);
  }
  const createdAt = new Date().toISOString();
  const rejectionEmailOutbox: BossRejectionEmailOutboxEntry = {
    ...createBossRejectionEmailOutboxEntry({
      jobKey: input.jobKey,
      jobTitle: input.job.title,
      resume: input.resume,
      artifact: input.result.routingArtifact,
      secondaryDelivery: input.screening.secondaryDelivery,
      requirements: input.screening.requirements,
      now: createdAt,
    }),
    detailClosedAt: input.detailClosedAt,
  };
  // The outbox embeds the immutable routing fact. Persist it first so an
  // interruption between writes can rebuild the standalone artifact without
  // rescoring or reopening this rejected candidate.
  await input.store.saveBossRejectionEmailOutboxEntry('boss', input.jobKey, rejectionEmailOutbox);
  await input.store.saveBossCandidateRoutingArtifact('boss', input.jobKey, input.result.routingArtifact);
  const [persistedOutbox, persistedArtifact] = await Promise.all([
    input.store.readBossRejectionEmailOutboxEntry('boss', input.jobKey, rejectionEmailOutbox.deliveryId),
    input.store.readBossCandidateRoutingArtifactByDecisionId(
      'boss',
      input.jobKey,
      rejectionEmailOutbox.routingDecisionId,
    ),
  ]);
  if (!persistedOutbox
    || persistedOutbox.status !== 'pending'
    || persistedOutbox.detailClosedAt !== input.detailClosedAt
    || !bossRejectionEmailImmutableFactsMatch(persistedOutbox, rejectionEmailOutbox)
    || !persistedArtifact
    || JSON.stringify(persistedArtifact) !== JSON.stringify(input.result.routingArtifact)) {
    throw new Error(
      `Boss rejection email ${rejectionEmailOutbox.deliveryId} was not durably read back with its exact close and routing evidence.`,
    );
  }
  return {
    ...input.result,
    rejectionEmailOutbox: persistedOutbox,
  };
}

interface BossScreeningOutboxRecovery {
  entries: BossForwardingOutboxEntry[];
  recoveredUncertainEntries: BossForwardingOutboxEntry[];
}

async function recoverBossScreeningOutbox(
  store: JobStore,
  jobKey: string,
  candidateIds?: ReadonlySet<string>,
  workflow?: BossForwardingOutboxEntry['workflow'],
): Promise<BossScreeningOutboxRecovery> {
  const allEntries = await store.listBossForwardingOutboxEntries('boss', jobKey);
  // The ordinary Boss capture cap is applied before recovery writes. Reading
  // the directory is harmless, but an outbox outside this run's first twenty
  // visible cards must not be migrated, marked uncertain, or retried here.
  const entries = allEntries.filter((entry) => {
    if (candidateIds && !candidateIds.has(entry.candidateId)) return false;
    if (workflow === 'pre-capture' && entry.workflow !== 'pre-capture') return false;
    // Legacy outboxes predate the workflow marker and are post-score entries
    // for compatibility. Explicit pre-capture rows must never be pulled into
    // an enabled screening run.
    if (workflow === 'post-score' && entry.workflow === 'pre-capture') return false;
    return true;
  });
  const legacySendingCandidateIds = new Set(entries
    .filter((entry) => !entry.forwarding.deliveries?.length && entry.forwarding.status === 'sending')
    .map((entry) => entry.candidateId));
  const normalizedEntries = await Promise.all(entries.map(async (entry) => {
    const hadDeliveries = Boolean(entry.forwarding.deliveries?.length);
    const migrated: BossForwardingOutboxEntry = {
      ...entry,
      forwarding: migrateBossForwardingState(entry.forwarding),
    };
    if (!hadDeliveries) {
      await store.saveBossForwardingOutboxEntry('boss', jobKey, migrated);
    }
    await ensureBossRoutingArtifactFromOutbox(store, jobKey, migrated);
    return migrated;
  }));
  const recoveredUncertainEntries = await Promise.all(normalizedEntries
    .filter((entry) => legacySendingCandidateIds.has(entry.candidateId)
      || entry.forwarding.deliveries!.some((delivery) => delivery.status === 'sending'))
    .map(async (entry) => {
      const updatedAt = new Date().toISOString();
      const recoveryError = 'The prior process ended after an external forwarding attempt began; verify on Boss before any retry.';
      const recoveredDeliveries = entry.forwarding.deliveries!.map((delivery) => delivery.status === 'sending'
        ? {
          ...delivery,
          status: 'uncertain' as const,
          error: delivery.error ?? recoveryError,
        }
        : legacySendingCandidateIds.has(entry.candidateId) && delivery.status === 'uncertain'
          ? { ...delivery, error: delivery.error ?? recoveryError }
          : delivery);
      const recovered: BossForwardingOutboxEntry = {
        ...entry,
        updatedAt,
        forwarding: composeBossForwardingState(entry.forwarding, recoveredDeliveries, recoveryError),
      };
      await store.saveBossForwardingOutboxEntry('boss', jobKey, recovered);
      return recovered;
    }));
  const recoveredByCandidateId = new Map(
    recoveredUncertainEntries.map((entry) => [entry.candidateId, entry]),
  );
  return {
    entries: normalizedEntries.map((entry) => recoveredByCandidateId.get(entry.candidateId) ?? entry),
    recoveredUncertainEntries,
  };
}

/**
 * Replays only outbox work that is known not to have completed. The stored
 * recipient and CC are authoritative for the retry; current job settings must
 * not redirect an already-decided candidate.
 */
async function retryBossScreeningForwarding(input: {
  jobKey: string;
  candidate: CandidateListItem;
  entry: BossForwardingOutboxEntry;
  store: JobStore;
  session: BrowserSession;
  searchPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
  platformAdapter: PlatformAdapter;
  lifecycle?: BossDetailLifecycleState;
}): Promise<BossForwardingOutboxEntry> {
  const { jobKey, candidate, store, session, searchPage, platformAdapter } = input;
  const lifecycle = input.lifecycle ?? {
    detailOpened: false,
    detailIdentityVerified: false,
    detailClosed: false,
  };
  let entry: BossForwardingOutboxEntry = {
    ...input.entry,
    forwarding: migrateBossForwardingState(input.entry.forwarding),
  };
  let detailPage = session.page;
  let detailOpened = false;
  const detailOptions = platformAdapter.platform === 'boss'
    ? createBossDetailLifecycleOptions({ forwarding: true })
    : undefined;

  try {
    try {
      detailPage = await platformAdapter.openResumeDetail(session.context, searchPage, candidate, detailOptions);
      detailOpened = true;
      lifecycle.detailOpened = true;
      if (detailOptions) {
        await waitBossActionPaceWithinDeadline(detailPage, detailOptions.deadline, detailOptions.cleanupReserveMs);
      } else {
        await waitPlatformActionPaceRef.fn(detailPage, 'boss');
      }
    } catch (error) {
      if (platformAdapter.platform === 'boss' && error instanceof BossUnexpectedContactDialogError) {
        throw error;
      }
      const updatedAt = new Date().toISOString();
      const deliveryIndex = entry.forwarding.deliveries!.findIndex((delivery) =>
        delivery.status === 'pending' || delivery.status === 'retryable-failed');
      const priorDelivery = entry.forwarding.deliveries![deliveryIndex];
      const failed = priorDelivery
        ? replaceBossForwardingDelivery(entry, deliveryIndex, {
          role: priorDelivery.role,
          recipient: priorDelivery.recipient,
          status: 'retryable-failed',
          ...(priorDelivery.attemptedAt ? { attemptedAt: priorDelivery.attemptedAt } : {}),
          error: error instanceof Error ? error.message : String(error),
        }, updatedAt)
        : entry;
      await store.saveBossForwardingOutboxEntry('boss', jobKey, failed);
      return failed;
    }
    const hasColleagueCommunication = entry.workflow !== 'pre-capture'
      && entry.forwarding.mode === 'email'
      ? (await readBossColleagueCommunicationFlagRef.fn(detailPage, candidate, detailOptions!))
        .hasColleagueCommunication
      : false;
    entry = await executeBossForwardingDeliveries({
      jobKey,
      candidate,
      entry,
      detailPage,
      store,
      detailOptions,
      hasColleagueCommunication,
    });
    // `forwardBossResume` performs the live detail identity check before
    // each recipient dialog. Treat the forwarding action's successful return
    // as the workflow receipt for this retry lifecycle.
    if (platformAdapter.platform === 'boss') {
      lifecycle.detailIdentityVerified = true;
    }
    return entry;
  } finally {
    if (detailOpened) {
      if (platformAdapter.closeResumeDetail) {
        try {
          await platformAdapter.closeResumeDetail(searchPage, detailPage, candidate, detailOptions);
          lifecycle.detailClosed = true;
        } catch (error) {
          if (platformAdapter.platform === 'boss') {
            throw error instanceof BossResumeDetailCloseError
              ? error
              : new BossResumeDetailCloseError(
                `Boss resume detail close failed during forwarding recovery for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}`,
              );
          }
          // Other platform cleanup remains best effort for compatibility.
        }
      } else if (detailPage !== session.page && detailPage !== searchPage) {
        try {
          await detailPage.close();
          lifecycle.detailClosed = true;
        } catch {
          // Leave the page for the caller's normal error/recovery handling.
        }
      }
      session.page = searchPage;
    }
  }
}

async function captureCandidateResume(
  platform: SupportedPlatform,
  jobKey: string,
  candidate: CandidateListItem,
  store: JobStore,
  session: BrowserSession,
  searchPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
  platformAdapter: PlatformAdapter,
  /** null skips legacy post-open hooks for the explicit post-score Boss path. */
  postOpenActions: CandidatePostOpenActions | null = {},
  afterResumeSaved?: (input: {
    detailPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
    resume: CandidateResume;
    detailOptions?: CandidateProfileDetailOptions;
  }) => Promise<void>,
  /** Boss screening-disabled forwarding runs before parsing, but is durable. */
  beforeResumeParsed?: (input: {
    detailPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
    detailOptions?: CandidateProfileDetailOptions;
  }) => Promise<void>,
  /** Runs immediately after a verified detail close and before this lifecycle returns. */
  afterResumeDetailClosed?: () => Promise<void>,
): Promise<CandidateProcessResult> {
  let detailPage = session.page;
  let detailOpened = false;
  let detailVerified = false;
  const detailOptions = createCandidateDetailLifecycleOptions(platform, platformAdapter);
  const detailLifecycle: BossDetailLifecycleState = {
    detailOpened: false,
    detailIdentityVerified: false,
    detailClosed: false,
  };
  let failureStage: CaptureFailureStage = 'detail-open';
  let preserveDetailPageForInspection = false;

  try {
    detailPage = await platformAdapter.openResumeDetail(session.context, searchPage, candidate, detailOptions);
    detailOpened = true;
    detailLifecycle.detailOpened = true;
    if (platform === 'boss' && detailOptions) {
      await waitBossActionPaceWithinDeadline(detailPage, detailOptions.deadline, detailOptions.cleanupReserveMs);
    } else if (detailOptions) {
      await waitCandidateDetailPaceWithinDeadline(detailPage, platform, detailOptions);
    } else {
      await waitPlatformActionPaceRef.fn(detailPage, platform);
    }
    failureStage = 'identity-verify';
    let postOpenResult: void | CandidatePostOpenResult = undefined;
    if (postOpenActions !== null && platformAdapter.afterResumeDetailOpened) {
      failureStage = 'forward';
      postOpenResult = await platformAdapter.afterResumeDetailOpened(
        detailPage,
        candidate,
        postOpenActions,
        detailOptions,
      );
    }
    failureStage = 'forward';
    await beforeResumeParsed?.({
      detailPage: detailPage as Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
      detailOptions,
    });
    failureStage = 'parse';
    let extraction: { resume: CandidateResume; domSnapshot?: ResumeDomSnapshot };
    try {
      extraction = platformAdapter.platform === '51job'
        ? await extractResumeFromPageRef.fn(detailPage, candidate)
        : {
          resume: await platformAdapter.parseResumeDetail(detailPage, candidate, detailOptions),
        };
    } catch (error) {
      if (error instanceof BossResumeIdentityVerificationError) {
        failureStage = 'identity-verify';
      }
      throw error;
    }
    if (extraction.resume.candidateId !== candidate.candidateId) {
      const message = `Parsed resume identity ${extraction.resume.candidateId} does not match candidate ${candidate.candidateId}.`;
      if (platform === 'boss') {
        failureStage = 'identity-verify';
      }
      throw platform === 'boss'
        ? new BossResumeIdentityVerificationError(message)
        : new Error(message);
    }
    detailVerified = true;
    detailLifecycle.detailIdentityVerified = true;
    failureStage = 'persist';
    const resume = postOpenResult?.candidateShareUrl
      ? { ...extraction.resume, candidateShareUrl: postOpenResult.candidateShareUrl }
      : extraction.resume;
    const { domSnapshot } = extraction;
    const rawSource = platform === 'boss'
      ? formatResumeSnapshot(resume)
      : await detailPage.locator('body').innerText().catch(() => undefined);
    await store.saveCandidateResume(platform, jobKey, resume, rawSource, domSnapshot);
    await afterResumeSaved?.({
      detailPage: detailPage as Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
      resume,
      detailOptions,
    });

    return {
      candidateId: candidate.candidateId,
      captured: true,
      detailVerified: true,
      detailLifecycle,
    };
  } catch (error) {
    if (platform === 'boss' && error instanceof BossUnexpectedContactDialogError) {
      throw error;
    }
    if (platform === 'liepin') {
      preserveDetailPageForInspection = true;
      throw new Error(`Liepin candidate ${candidate.candidateId} failed; stopping flow and leaving the browser open for inspection. Original error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      candidateId: candidate.candidateId,
      captured: false,
      detailVerified,
      detailLifecycle,
      failureStage,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const usesSeparateDetailPage = detailPage !== session.page && detailPage !== searchPage;
    const canCloseDetail = detailOpened && (usesSeparateDetailPage || platformAdapter.closeResumeDetail !== undefined);
    if (!preserveDetailPageForInspection && canCloseDetail) {
      if (!detailOptions) {
        await waitPlatformActionPaceRef.fn(detailPage, platform);
      } else if (platform !== 'boss') {
        await waitCandidateDetailPaceWithinDeadline(detailPage, platform, detailOptions, 0);
      }
      if (platformAdapter.closeResumeDetail) {
        let closed = false;
        try {
          await platformAdapter.closeResumeDetail(searchPage, detailPage, candidate, detailOptions);
          closed = true;
        } catch (error) {
          // Boss close is a hard safety boundary. Returning a successful
          // capture while its modal remains visible allows the next card
          // click to operate on the wrong candidate, so stop the whole run
          // and leave the page available for inspection.
          if (platform === 'boss') {
            throw error instanceof BossResumeDetailCloseError
              ? error
              : new BossResumeDetailCloseError(
                `Boss resume detail close failed for candidate ${candidate.candidateId}: ${error instanceof Error ? error.message : String(error)}`,
              );
          }
          // Other platform cleanup remains best effort; the lifecycle audit
          // still prevents the candidate from being treated as synchronized.
        }
        if (closed) {
          detailLifecycle.detailClosed = true;
          await afterResumeDetailClosed?.();
        }
      } else {
        let closed = false;
        try {
          await detailPage.close();
          detailLifecycle.detailClosed = true;
          closed = true;
        } catch {
          // Keep the detail page available for inspection.
        }
        if (closed) await afterResumeDetailClosed?.();
      }
      if (usesSeparateDetailPage) {
        await (searchPage as Partial<Pick<typeof searchPage, 'bringToFront'>>).bringToFront?.call(searchPage).catch(() => undefined);
      }
      session.page = searchPage;
    }
  }
}

async function scoreCapturedResumes(
  platform: SupportedPlatform,
  jobKey: string,
  job: NormalizedJob,
  store: JobStore,
  capturedCandidateIds: string[],
  options: {
    postScoreRouting?: PostScoreRoutingSettings;
    pendingCandidateIds?: string[];
    fetchedAt?: string;
  } = {},
): Promise<CandidateScoringResult> {
  const routingEnabled = platform !== 'boss' && options.postScoreRouting?.enabled === true;
  const candidateIds = [...new Set([
    ...capturedCandidateIds,
    ...(routingEnabled ? options.pendingCandidateIds ?? [] : []),
  ])];
  if (candidateIds.length === 0) {
    return {
      scoredCandidates: [],
      failedCandidates: [],
      ...(routingEnabled ? { routingArtifacts: [] } : {}),
    };
  }

  const capturedCandidateIdSet = new Set(candidateIds);
  const storedResumes = await store.listStoredResumes(platform, jobKey);
  const resumesById = new Map(storedResumes.map((resume) => [resume.candidateId, resume]));
  const scoredCandidates: string[] = [];
  const failedCandidates: CandidateScoreFailure[] = [];
  const routingArtifacts: CandidateRoutingArtifact[] = [];
  const routingWorkItemsByCandidateId = routingEnabled
    ? new Map((await store.listPostScoreRoutingWorkItems(platform, jobKey))
      .map((item) => [item.candidateId, item]))
    : new Map<string, PostScoreRoutingWorkItem>();
  const preservePendingScoreFailure = async (
    candidateId: string,
    error: string,
    diagnostic?: CodexSessionFailureDiagnostic,
  ): Promise<void> => {
    if (!routingEnabled) return;
    const existing = routingWorkItemsByCandidateId.get(candidateId);
    if (!existing) return;
    const failedAt = new Date().toISOString();
    const updated: PostScoreRoutingWorkItem = {
      ...existing,
      updatedAt: failedAt,
      scoreAttemptCount: (existing.scoreAttemptCount ?? 0) + 1,
      lastScoreFailure: {
        failedAt,
        error,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
    await store.savePostScoreRoutingWorkItem(platform, jobKey, updated);
    routingWorkItemsByCandidateId.set(candidateId, updated);
  };

  for (const candidateId of candidateIds) {
    const resume = resumesById.get(candidateId);

    if (!resume) {
      const error = `Stored resume not found for captured candidate ${candidateId}`;
      failedCandidates.push({ candidateId, error });
      await preservePendingScoreFailure(candidateId, error);
      continue;
    }

    const scoredAt = new Date().toISOString();
    const scoreArtifactBase = {
      candidateId: resume.candidateId,
      candidateShareUrl: resume.candidateShareUrl,
      model: config.scoring.model,
      scoredAt,
    };

    try {
      let score: CandidateScore;
      let evaluations: CandidateRoutingArtifact['requirementEvaluations'] = [];
      let resumeInputHash: string | undefined;
      if (routingEnabled) {
        const result = await scoreAndEvaluatePostScoreRoutingRef.fn({
          job,
          resume,
          policy: options.postScoreRouting!,
        });
        score = result.score;
        evaluations = result.evaluations;
        resumeInputHash = result.resumeInputHash;
      } else {
        score = await scoreResumeAgainstJobRef.fn(job, resume);
      }
      const scoreArtifact: CandidateScoreArtifact = {
        ...scoreArtifactBase,
        ...(resumeInputHash ? { resumeInputHash } : {}),
        status: 'success',
        score,
      };
      await store.saveCandidateScoreArtifact(platform, jobKey, {
        ...scoreArtifact,
      });
      if (routingEnabled) {
        const policy = options.postScoreRouting!;
        const policyHash = hashPostScoreRoutingPolicy(policy);
        const scoredAt = scoreArtifact.scoredAt;
        const decidedAt = new Date().toISOString();
        const decision = resolvePostScoreRoutingDecision(scoreArtifact, evaluations, policy);
        const routingDecisionId = createHash('sha256').update(JSON.stringify({
          platform,
          jobKey,
          candidateId: resume.candidateId,
          policyHash,
          scoredAt,
          classification: decision.classification,
          audience: decision.audience,
          matchedRequirementIds: decision.matchedRequirementIds,
          unknownRequirementIds: decision.unknownRequirementIds,
          reason: decision.reason,
        })).digest('hex');
        const artifact: CandidateRoutingArtifact = {
          routingDecisionId,
          candidateId: resume.candidateId,
          fetchedAt: options.fetchedAt ?? scoredAt,
          scoredAt,
          decidedAt,
          policyHash,
          scoreStatus: scoreArtifact.status,
          classification: decision.classification,
          audience: decision.audience,
          requirementEvaluations: evaluations,
          matchedRequirementIds: decision.matchedRequirementIds,
          unknownRequirementIds: decision.unknownRequirementIds,
          reason: decision.reason,
        };
        await store.saveCandidateRoutingArtifact(platform, jobKey, artifact);
        await store.deletePostScoreRoutingWorkItem(platform, jobKey, resume.candidateId);
        routingArtifacts.push(artifact);
      }
      scoredCandidates.push(resume.candidateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = getCodexSessionFailureDiagnostic(error);
      const failedScoreArtifact: CandidateScoreArtifact = {
        ...scoreArtifactBase,
        status: 'failed',
        error: message,
        ...(diagnostic ? { diagnostic } : {}),
      };
      await store.saveCandidateScoreArtifact(platform, jobKey, failedScoreArtifact);
      await preservePendingScoreFailure(resume.candidateId, message, diagnostic);
      failedCandidates.push({
        candidateId: resume.candidateId,
        error: message,
        ...(diagnostic ? { diagnostic } : {}),
      });
    }
  }

  if (routingEnabled) {
    // A pending work item means the detail was already opened and persisted;
    // this marks it captured during recovery without re-opening the page.
    await store.markCapturedCandidatesSeen(platform, jobKey, candidateIds.filter((candidateId) => resumesById.has(candidateId)));
  }

  return {
    scoredCandidates: scoredCandidates.filter((candidateId) => capturedCandidateIdSet.has(candidateId)),
    failedCandidates,
    ...(routingEnabled ? { routingArtifacts } : {}),
  };
}

const BOSS_RESUME_CAPTURE_CANDIDATE_LIMIT = 20;

async function runResumeCaptureFlow(platform: SupportedPlatform, jobKey: string, job: NormalizedJob, pageKeyword: string, store: JobStore, session: BrowserSession, fetchedAt: string, platformAdapter: PlatformAdapter, options: {
  includeViewedCandidates?: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  /** Enabled only for ordinary Boss capture; other platform stages ignore it. */
  bossScreening?: BossScreeningSettings;
  /** Generic post-score result routing for non-Boss capture stages. */
  postScoreRouting?: PostScoreRoutingSettings;
  searchSource?: JobSearchSource;
  searchConditions?: SearchCondition[];
  savedSearch?: SavedSearchReference;
  coreSavedSearchTarget?: CoreSavedSearchTarget;
  coreSavedSearchVerificationRequest?: CoreSavedSearchVerificationRequest;
  sortPolicy?: SearchSortPolicy;
  /** Immutable report targets captured before the run; used by routed replay. */
  reportDelivery?: ReportDeliveryOptions;
  secondaryReportDelivery?: ReportDeliveryOptions;
  searchExecution?: Omit<NonNullable<RunResult['searchExecution']>, 'includeViewedCandidates'>;
  onSavedSearchOpenEvidence?: (
    evidence: PlatformSavedSearchOpenEvidence,
    target?: CoreSavedSearchTarget,
  ) => Promise<void>;
  /** Releases the platform runtime after the last detail cleanup and before dispatcher drain/offline report work. */
  releaseBrowserPhase?: () => Promise<void>;
} = {}): Promise<{ candidates: CandidateListItem[]; newCandidates: CandidateListItem[]; capturedCandidateIds: string[]; runResult: RunResult; resultPath: string }> {
  const bossScreeningEnabled = platform === 'boss' && options.bossScreening?.enabled === true;
  const bossScreeningPolicyHash = bossScreeningEnabled
    ? hashBossScreeningPolicy(options.bossScreening!)
    : undefined;
  const postScoreRoutingEnabled = platform !== 'boss' && options.postScoreRouting?.enabled === true;
  const postScoreRoutingPolicyHash = postScoreRoutingEnabled
    ? hashPostScoreRoutingPolicy(options.postScoreRouting!)
    : undefined;
  if (bossScreeningEnabled && (!options.bossForwardMode || !options.bossForwardRecipient)) {
    throw new Error('Enabled Boss screening requires a primary Boss forwarding mode and recipient.');
  }
  if (bossScreeningEnabled && !options.bossScreening?.secondaryDelivery?.recipientEmail) {
    throw new Error('Enabled Boss screening requires a secondary rejection-email recipient.');
  }
  let preloadedScreeningWorkItems: BossScreeningWorkItem[] = [];
  let preloadedRejectionEmailOutbox: BossRejectionEmailOutboxEntry[] = [];
  let reportableRecoveredRejectionEmails: BossRejectionEmailOutboxEntry[] = [];
  let rejectionEmailDispatcher: BossRejectionEmailDispatcher | undefined;
  let rejectionEmailSmtpAttemptCount = 0;
  let rejectionEmailDispatcherPauseCode: BossRejectionEmailDispatchPauseCode | undefined;
  if (bossScreeningEnabled) {
    const [pendingItems, outboxEntries, rejectionEmailEntries] = await Promise.all([
      store.listBossScreeningWorkItems('boss', jobKey),
      store.listBossForwardingOutboxEntries('boss', jobKey),
      store.listBossRejectionEmailOutboxEntries('boss', jobKey),
    ]);
    const incompatibleWorkItemCount = pendingItems.filter((item) => item.policyHash !== bossScreeningPolicyHash).length;
    const incompatibleOutboxCount = outboxEntries.filter((entry) =>
      entry.policyHash !== bossScreeningPolicyHash && hasRetryableBossForwardingDelivery(entry),
    ).length;
    const incompatibleRejectionEmailCount = rejectionEmailEntries.filter((entry) =>
      entry.policyHash !== bossScreeningPolicyHash
        && (entry.status === 'sending' || entry.status === 'retryable-failed'),
    ).length;
    if (incompatibleWorkItemCount > 0 || incompatibleOutboxCount > 0 || incompatibleRejectionEmailCount > 0) {
      throw new Error(
        `Boss job ${jobKey} has ${incompatibleWorkItemCount} pending score item(s), ${incompatibleOutboxCount} unfinished forwarding outbox entr${incompatibleOutboxCount === 1 ? 'y' : 'ies'} and ${incompatibleRejectionEmailCount} unfinished rejection email(s) from an older policy; run migrate:boss-model-screening before opening the browser.`,
      );
    }
    preloadedScreeningWorkItems = pendingItems;
    preloadedRejectionEmailOutbox = rejectionEmailEntries;
    reportableRecoveredRejectionEmails = rejectionEmailEntries.filter((entry) =>
      entry.policyHash === bossScreeningPolicyHash && isUnresolvedBossRejectionEmail(entry));
    rejectionEmailDispatcher = createBossRejectionEmailDispatcher({
      store,
      jobKey,
      policyHash: bossScreeningPolicyHash!,
      recoveryEntries: reportableRecoveredRejectionEmails,
      dependencies: {
        now: () => new Date(),
        delay: async (delayMs) => {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        },
        minimumAttemptGapMs: BOSS_REJECTION_EMAIL_MINIMUM_ATTEMPT_GAP_MS,
        assertSmtpConfigurationReady: () => {
          if (sendJobReportEmailRef.fn === sendJobReportEmail) assertSmtpConfigurationReady();
        },
        sendMail: (params) => sendJobReportEmailRef.fn(params),
      },
    });
  }
  try {
  let preloadedPostScoreRoutingWorkItems: PostScoreRoutingWorkItem[] = [];
  let recoveredPostScoreRoutingArtifacts: CandidateRoutingArtifact[] = [];
  if (postScoreRoutingEnabled) {
    const [pendingItems, existingArtifacts, priorRuns] = await Promise.all([
      store.listPostScoreRoutingWorkItems(platform, jobKey),
      store.listCandidateRoutingArtifacts(platform, jobKey),
      store.listRunResults(platform, jobKey),
    ]);
    const incompatibleCount = pendingItems.filter((item) => item.policyHash !== postScoreRoutingPolicyHash).length;
    if (incompatibleCount > 0) {
      throw new Error(
        `Job ${platform}/${jobKey} has ${incompatibleCount} pending result-routing score item(s) from an older policy; resolve or migrate them before rerunning.`,
      );
    }
    const indexedCandidateIds = new Set(priorRuns.flatMap((run) => run.postScoreRouting?.enabled
      ? [
        ...run.postScoreRouting.qualifiedCandidateIds,
        ...run.postScoreRouting.reviewCandidateIds,
        ...run.postScoreRouting.rejectedCandidateIds,
      ]
      : []));
    const orphanArtifacts = existingArtifacts.filter((artifact) =>
      artifact.policyHash === postScoreRoutingPolicyHash && !indexedCandidateIds.has(artifact.candidateId));
    const artifactByCandidateId = new Map<string, CandidateRoutingArtifact>();
    for (const artifact of orphanArtifacts) {
      if (artifactByCandidateId.has(artifact.candidateId)) {
        throw new Error(`Job ${platform}/${jobKey} has multiple unreported result-routing decisions for ${artifact.candidateId}; refusing to reprocess it.`);
      }
      artifactByCandidateId.set(artifact.candidateId, artifact);
    }
    recoveredPostScoreRoutingArtifacts = [...artifactByCandidateId.values()];
    if (recoveredPostScoreRoutingArtifacts.length > 0) {
      await store.markCapturedCandidatesSeen(
        platform,
        jobKey,
        recoveredPostScoreRoutingArtifacts.map((artifact) => artifact.candidateId),
      );
    }
    const stalePendingItems = pendingItems.filter((item) => {
      const matches = existingArtifacts.filter((artifact) =>
        artifact.policyHash === postScoreRoutingPolicyHash && artifact.candidateId === item.candidateId);
      if (matches.length > 1) {
        throw new Error(`Job ${platform}/${jobKey} has multiple result-routing decisions for pending candidate ${item.candidateId}; refusing to reprocess it.`);
      }
      return matches.length === 0;
    });
    await Promise.all(pendingItems
      .filter((item) => !stalePendingItems.includes(item))
      .map((item) => store.deletePostScoreRoutingWorkItem(platform, jobKey, item.candidateId)));
    preloadedPostScoreRoutingWorkItems = stalePendingItems;
  }
  if (platform === 'boss') {
    await store.assertSeenIdsHaveResumes('boss', jobKey);
  }
  const searchSource = options.searchSource ?? 'saved';
  const searchConditions = options.searchConditions ?? [];
  if (platform === 'boss' && searchSource === 'saved' && !options.savedSearch) {
    throw new Error('Boss saved-reference-required: ordinary saved capture requires a complete verified native subscription reference.');
  }
  const platformEstimatedTimeoutMs = platformAdapter.estimateSearchTimeoutMs?.({
    source: searchSource,
    conditions: searchConditions,
    includeViewedCandidates: options.includeViewedCandidates,
  });
  const searchTimeoutMs = Math.max(
    config.playwright.searchPageTimeoutMs,
    typeof platformEstimatedTimeoutMs === 'number' && Number.isFinite(platformEstimatedTimeoutMs)
      ? Math.max(1, platformEstimatedTimeoutMs)
      : 0,
  );
  // This deadline is deliberately created once. It is shared by the platform
  // search action, its final verification, and candidate-list extraction.
  const searchDeadline = Date.now() + searchTimeoutMs;
  const searchOptions = {
    deadline: searchDeadline,
    includeViewedCandidates: options.includeViewedCandidates,
    sortPolicy: options.sortPolicy,
  };
  let savedSearchOpenEvidence: PlatformSavedSearchOpenEvidence | undefined;
  let verifiedCoreSavedSearchTarget: CoreSavedSearchTarget | undefined;
  const searchPage = searchSource === 'direct'
    ? await (async () => {
      if (!platformAdapter.openDirectSearch) {
        throw new Error(`Platform ${platformAdapter.platform} does not support direct search for resume capture.`);
      }

      return platformAdapter.openDirectSearch(session.page, pageKeyword, searchConditions, searchOptions);
    })()
    : platform === 'boss'
      ? await (async () => {
        if (!options.savedSearch || !platformAdapter.openSavedSearch || !platformAdapter.openBoundSavedSearch) {
          throw new Error('Boss saved-reference-required: native saved-search action is not registered; refusing the legacy saved-search fallback.');
        }
        const opened = await openBoundSavedSearchRef.fn(platformAdapter, session.page, options.savedSearch, {
          ...searchOptions,
          boundJobKey: jobKey,
        });
        savedSearchOpenEvidence = opened.evidence;
        return opened.page;
      })()
      : options.coreSavedSearchTarget
        ? await (async () => {
          if (!platformAdapter.openBoundSavedSearch) {
            throw new Error(`Platform ${platform} does not register strict saved-search opening for bound target ${options.coreSavedSearchTarget!.name}.`);
          }
          const opened = await openBoundSavedSearchRef.fn(platformAdapter, session.page, options.coreSavedSearchTarget!, {
            ...searchOptions,
            boundJobKey: jobKey,
          });
          savedSearchOpenEvidence = opened.evidence;
          verifiedCoreSavedSearchTarget = options.coreSavedSearchTarget;
          return opened.page;
        })()
        : options.coreSavedSearchVerificationRequest
          ? await (async () => {
            const request = options.coreSavedSearchVerificationRequest!;
            if (platform !== 'zhilian'
              || request.platform !== platform
              || request.boundJobKey !== jobKey
              || request.expectedKeyword !== pageKeyword
              || !platformAdapter.verifySavedSearchTarget) {
              throw new Error('Prospective core saved-search verification request is invalid or unsupported.');
            }
            const opened = await platformAdapter.verifySavedSearchTarget(session.page, request, {
              ...searchOptions,
              boundJobKey: jobKey,
            });
            savedSearchOpenEvidence = opened.evidence;
            verifiedCoreSavedSearchTarget = opened.target;
            return opened.page;
          })()
        : await platformAdapter.openSubscribeSearch(session.page, pageKeyword, searchOptions);
  if (savedSearchOpenEvidence) {
    if (platform !== 'boss') {
      if (!verifiedCoreSavedSearchTarget) {
        throw new Error(`Platform ${platform} returned saved-search evidence without an executable core target.`);
      }
      verifiedCoreSavedSearchTarget = assertCoreSavedSearchTarget(verifiedCoreSavedSearchTarget, {
        platform,
        boundJobKey: jobKey,
        label: 'capture saved-search target',
      });
      savedSearchOpenEvidence = assertPlatformSavedSearchOpenEvidence(
        savedSearchOpenEvidence,
        'capture saved-search open evidence',
      );
      const commonMismatch = savedSearchOpenEvidence.platform !== platform
        || savedSearchOpenEvidence.boundJobKey !== jobKey
        || savedSearchOpenEvidence.targetFingerprint !== verifiedCoreSavedSearchTarget.targetFingerprint
        || savedSearchOpenEvidence.observedKeyword !== verifiedCoreSavedSearchTarget.expectedKeyword
        || savedSearchOpenEvidence.postcondition !== 'opened-and-verified';
      const identityMismatch = isZhilianNativeSavedSearchTarget(verifiedCoreSavedSearchTarget)
        ? !isZhilianNativeSavedSearchOpenEvidence(savedSearchOpenEvidence)
          || savedSearchOpenEvidence.observedNativeConditionId !== verifiedCoreSavedSearchTarget.nativeConditionId
          || savedSearchOpenEvidence.observedConditionFingerprint !== verifiedCoreSavedSearchTarget.conditionFingerprint
        : isZhilianNativeSavedSearchOpenEvidence(savedSearchOpenEvidence)
          || savedSearchOpenEvidence.observedName !== verifiedCoreSavedSearchTarget.name;
      if (commonMismatch || identityMismatch) {
        throw new Error(`Platform ${platform} returned saved-search evidence for another capture target.`);
      }
    }
    await options.onSavedSearchOpenEvidence?.(savedSearchOpenEvidence, verifiedCoreSavedSearchTarget);
  }
  if (session.runtimeLease && searchPage !== session.page) {
    await handoffPlatformWorkPage(session, session.page, searchPage);
  }
  session.page = searchPage;
  const { candidates: extractedCandidates } = await extractCandidateListWithAdapterRef.fn(
    platformAdapter,
    searchPage,
    { deadline: searchDeadline },
  );
  // An ordinary Boss capture run is deliberately bounded by visible result
  // order. Apply the cap before seen/recovery filtering so candidates beyond
  // the first twenty cannot be recorded or reach any detail/score/forwarding
  // action in this run.
  const candidates = platform === 'boss'
    ? extractedCandidates.slice(0, BOSS_RESUME_CAPTURE_CANDIDATE_LIMIT)
    : extractedCandidates;
  if (platform === 'boss') {
    const duplicateCandidateIds = candidates
      .map((candidate) => candidate.candidateId)
      .filter((candidateId, index, ids) => ids.indexOf(candidateId) !== index);
    if (duplicateCandidateIds.length > 0) {
      throw new Error(`Boss candidate list contains duplicate stable IDs inside the first twenty: ${[...new Set(duplicateCandidateIds)].join(', ')}`);
    }
  }
  const candidateIdsInRun = new Set(candidates.map((candidate) => candidate.candidateId));
  const seenCandidateIdsBeforeRun = await store.readSeenIds(platform, jobKey);
  const seenCandidateIdsSet = new Set(seenCandidateIdsBeforeRun);
  const outboxRecovery: BossScreeningOutboxRecovery = platform === 'boss'
    ? await recoverBossScreeningOutbox(
      store,
      jobKey,
      candidateIdsInRun,
      bossScreeningEnabled ? 'post-score' : 'pre-capture',
    )
    : { entries: [], recoveredUncertainEntries: [] };
  const unreportedRecoveryRoutingArtifacts: BossCandidateRoutingArtifact[] = bossScreeningEnabled
    ? await (async () => {
      const policyHash = hashBossScreeningPolicy(options.bossScreening!);
      const [priorRuns, routingArtifacts] = await Promise.all([
        store.listRunResults('boss', jobKey),
        store.listBossCandidateRoutingArtifacts('boss', jobKey),
      ]);
      const indexedCandidateIds = new Set(priorRuns.flatMap((run) => run.bossRouting?.enabled
        ? [
          ...run.bossRouting.qualifiedCandidateIds,
          ...run.bossRouting.reviewCandidateIds,
          ...run.bossRouting.rejectedCandidateIds,
        ]
        : []));
      const orphanCandidateIds = new Set(outboxRecovery.entries
        .filter((entry) => candidateIdsInRun.has(entry.candidateId)
          && entry.policyHash === policyHash
          && !indexedCandidateIds.has(entry.candidateId))
        .map((entry) => entry.candidateId));
      for (const entry of preloadedRejectionEmailOutbox) {
        if (candidateIdsInRun.has(entry.candidateId)
          && entry.policyHash === policyHash
          && !indexedCandidateIds.has(entry.candidateId)) {
          orphanCandidateIds.add(entry.candidateId);
        }
      }
      const selected: BossCandidateRoutingArtifact[] = [];
      for (const candidateId of orphanCandidateIds) {
        const matches = routingArtifacts.filter((artifact) =>
          artifact.candidateId === candidateId && artifact.policyHash === policyHash);
        if (matches.length !== 1) {
          throw new Error(`Expected one unreported Boss routing fact for candidate ${candidateId}, found ${matches.length}.`);
        }
        selected.push(matches[0]!);
      }
      return selected;
    })()
    : [];
  const screeningWorkItems = preloadedScreeningWorkItems
    .filter((item) => candidateIdsInRun.has(item.candidateId));
  const retryableOutboxByCandidateId = new Map(outboxRecovery.entries
    .filter(hasRetryableBossForwardingDelivery)
    .map((entry) => [entry.candidateId, entry]));
  const retryCandidates = candidates.filter((candidate) => retryableOutboxByCandidateId.has(candidate.candidateId));
  const retryCandidateIds = new Set(retryCandidates.map((candidate) => candidate.candidateId));
  const existingOutboxCandidateIds = new Set([
    ...outboxRecovery.entries.map((entry) => entry.candidateId),
    ...preloadedRejectionEmailOutbox.map((entry) => entry.candidateId),
  ]);
  const staleScreeningWorkItems = screeningWorkItems
    .filter((item) => existingOutboxCandidateIds.has(item.candidateId));
  await Promise.all(staleScreeningWorkItems.map((item) =>
    store.deleteBossScreeningWorkItem('boss', jobKey, item.candidateId),
  ));
  const screeningWorkByCandidateId = new Map(screeningWorkItems
    .filter((item) => !existingOutboxCandidateIds.has(item.candidateId))
    .map((item) => [item.candidateId, item]));
  const pendingScoreCandidates = bossScreeningEnabled
    ? candidates.filter((candidate) => screeningWorkByCandidateId.has(candidate.candidateId))
    : [];
  const pendingScoreCandidateIds = new Set(pendingScoreCandidates.map((candidate) => candidate.candidateId));
  const postScoreRoutingWorkByCandidateId = new Map(preloadedPostScoreRoutingWorkItems
    .map((item) => [item.candidateId, item]));
  const pendingPostScoreRoutingCandidateIds = new Set(preloadedPostScoreRoutingWorkItems.map((item) => item.candidateId));
  const preCaptureForwardingCompletedCandidateIds = new Set(outboxRecovery.entries
    .filter((entry) => entry.workflow === 'pre-capture'
      && entry.forwarding.status === 'sent'
      && !seenCandidateIdsSet.has(entry.candidateId))
    .map((entry) => entry.candidateId));
  const newCandidates = candidates.filter((candidate) =>
    !seenCandidateIdsSet.has(candidate.candidateId)
    && !retryCandidateIds.has(candidate.candidateId)
    && !pendingScoreCandidateIds.has(candidate.candidateId)
    && !pendingPostScoreRoutingCandidateIds.has(candidate.candidateId)
    && (!existingOutboxCandidateIds.has(candidate.candidateId)
      || preCaptureForwardingCompletedCandidateIds.has(candidate.candidateId)));
  const bossSeenEligibleCandidates = platform === 'boss'
    ? candidates.filter((candidate) => seenCandidateIdsSet.has(candidate.candidateId))
    : [];
  const bossSeenViewOnlyCandidates = platform === 'boss'
    ? bossSeenEligibleCandidates.filter((candidate) =>
      !retryCandidateIds.has(candidate.candidateId)
      && !pendingScoreCandidateIds.has(candidate.candidateId))
    : [];
  const candidateResults: CandidateProcessResult[] = [];
  const bossScreeningResults: BossScreeningCandidateResult[] = [];
  const bossForwardingRetryResults: BossForwardingOutboxEntry[] = [];
  const bossPreCaptureForwardingResults: BossForwardingOutboxEntry[] = [];
  const bossScreeningScoreFailures: CandidateScoreFailure[] = [];
  const bossScreeningFailures: Array<{ candidateId: string; error: string }> = [];
  const bossSeenViewAttemptedCandidateIds = new Set<string>();
  const bossSeenViewCompletedCandidateIds = new Set<string>();
  const bossSeenViewCoveredByProcessingCandidateIds = new Set<string>();
  const bossSeenViewFailures: BossSeenViewSyncFailure[] = [];
  const bossSeenEligibleCandidateIds = new Set(bossSeenEligibleCandidates.map((candidate) => candidate.candidateId));

  const recordBossSeenProcessingLifecycle = (
    candidateId: string,
    lifecycle: BossDetailLifecycleState,
    error?: string,
  ): void => {
    if (!bossSeenEligibleCandidateIds.has(candidateId)) return;
    if (lifecycle.detailOpened && lifecycle.detailIdentityVerified && lifecycle.detailClosed) {
      bossSeenViewCoveredByProcessingCandidateIds.add(candidateId);
      return;
    }
    const stage: BossSeenViewSyncFailure['stage'] = !lifecycle.detailOpened
      ? 'detail-open'
      : !lifecycle.detailIdentityVerified
        ? 'identity-verify'
        : 'detail-close';
    bossSeenViewFailures.push({
      candidateId,
      stage,
      detailOpened: lifecycle.detailOpened,
      detailIdentityVerified: lifecycle.detailIdentityVerified,
      detailClosed: lifecycle.detailClosed,
      error: error ?? 'Boss detail lifecycle did not complete during processing.',
    });
  };
  const seenCandidateIdsDuringRun = new Set(seenCandidateIdsBeforeRun);
  let processedCandidateCount = 0;

  for (const candidate of retryCandidates) {
    if (processedCandidateCount > 0) {
      await waitPlatformCandidatePaceRef.fn(searchPage, platform);
    }
    processedCandidateCount += 1;
    const entry = retryableOutboxByCandidateId.get(candidate.candidateId)!;
    const lifecycle: BossDetailLifecycleState = {
      detailOpened: false,
      detailIdentityVerified: false,
      detailClosed: false,
    };
    try {
      const retryResult = await retryBossScreeningForwarding({
        jobKey,
        candidate,
        entry,
        store,
        session,
        searchPage,
        platformAdapter,
        lifecycle,
      });
      bossForwardingRetryResults.push(retryResult);
      if (retryResult.workflow === 'pre-capture'
        && retryResult.forwarding.status === 'sent'
        && !seenCandidateIdsSet.has(candidate.candidateId)) {
        // The pre-capture external action can finish before the resume was
        // parsed. Keep this candidate in a capture-only pass below; no
        // delivery row will be opened again.
        preCaptureForwardingCompletedCandidateIds.add(candidate.candidateId);
      }
      recordBossSeenProcessingLifecycle(candidate.candidateId, lifecycle);
    } catch (error) {
      recordBossSeenProcessingLifecycle(candidate.candidateId, lifecycle, error instanceof Error ? error.message : String(error));
      if (platformAdapter.platform === 'boss' && lifecycle.detailOpened && !lifecycle.detailClosed) {
        // A failed Boss close leaves an ambiguous modal active. Do not move to
        // another card or attempt a second click in the same page session.
        throw error;
      }
      bossScreeningFailures.push({
        candidateId: candidate.candidateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const preCaptureRecoveryCaptureCandidates = bossScreeningEnabled
    ? []
    : candidates.filter((candidate) => preCaptureForwardingCompletedCandidateIds.has(candidate.candidateId)
      && !seenCandidateIdsSet.has(candidate.candidateId));
  const captureCandidates = bossScreeningEnabled
    ? [...pendingScoreCandidates, ...newCandidates]
    : [...newCandidates, ...preCaptureRecoveryCaptureCandidates.filter((candidate) =>
      !newCandidates.some((item) => item.candidateId === candidate.candidateId))];
  let bossSeenViewOnlyProcessed = false;
  const processBossSeenViewOnlyCandidates = async (): Promise<void> => {
    if (bossSeenViewOnlyProcessed) return;
    bossSeenViewOnlyProcessed = true;
    // A seen candidate with no pending score or retryable forwarding work gets
    // a dedicated read-only detail visit. It runs after pending-score work and
    // before new-capture work so a close failure stops later card mutations.
    for (const candidate of bossSeenViewOnlyCandidates) {
      if (processedCandidateCount > 0) {
        await waitPlatformCandidatePaceRef.fn(searchPage, platform);
      }
      processedCandidateCount += 1;
      bossSeenViewAttemptedCandidateIds.add(candidate.candidateId);
      try {
        const receipt = await visitBossSeenCandidateDetailRef.fn(
          searchPage,
          candidate,
          createBossDetailLifecycleOptions(),
        );
        if (receipt.detailOpened && receipt.detailIdentityVerified && receipt.detailClosed) {
          bossSeenViewCompletedCandidateIds.add(candidate.candidateId);
        } else {
          bossSeenViewFailures.push({
            candidateId: candidate.candidateId,
            stage: 'detail-close',
            detailOpened: receipt.detailOpened,
            detailIdentityVerified: receipt.detailIdentityVerified,
            detailClosed: receipt.detailClosed,
            error: 'Boss history detail visit returned an incomplete lifecycle.',
          });
        }
      } catch (error) {
        const detailError = error instanceof BossSeenCandidateDetailError ? error : undefined;
        bossSeenViewFailures.push({
          candidateId: candidate.candidateId,
          stage: detailError?.stage ?? 'detail-open',
          detailOpened: detailError?.detailOpened ?? false,
          detailIdentityVerified: detailError?.detailIdentityVerified ?? false,
          detailClosed: detailError?.detailClosed ?? false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (detailError?.fatalCloseFailure) {
          throw error;
        }
      }
    }
  };
  if (!bossScreeningEnabled || pendingScoreCandidates.length === 0) {
    await processBossSeenViewOnlyCandidates();
  }
  for (let captureIndex = 0; captureIndex < captureCandidates.length; captureIndex += 1) {
    if (bossScreeningEnabled && captureIndex === pendingScoreCandidates.length) {
      await processBossSeenViewOnlyCandidates();
    }
    const candidate = captureCandidates[captureIndex]!;
    if (processedCandidateCount > 0) {
      await waitPlatformCandidatePaceRef.fn(searchPage, platform);
    }
    processedCandidateCount += 1;

    if (bossScreeningEnabled) {
      const screening = options.bossScreening!;
      const primaryForwarding: BossForwardingSettings = {
        mode: options.bossForwardMode!,
        recipient: options.bossForwardRecipient!,
        ...(options.bossForwardCc === undefined ? {} : { ccEmails: options.bossForwardCc }),
      };
      let resumeForScreening: CandidateResume | undefined;
      let rejectedAwaitingClose: BossScreeningCandidateResult | undefined;
      const candidateResult = await captureCandidateResume(
        platform,
        jobKey,
        candidate,
        store,
        session,
        searchPage,
        platformAdapter,
        null,
        async ({ detailPage, resume, detailOptions }) => {
          if (!screeningWorkByCandidateId.has(candidate.candidateId)) {
            const now = new Date().toISOString();
            const workItem: BossScreeningWorkItem = {
              candidateId: candidate.candidateId,
              policyHash: hashBossScreeningPolicy(screening),
              createdAt: now,
              updatedAt: now,
            };
            await store.saveBossScreeningWorkItem('boss', jobKey, workItem);
            screeningWorkByCandidateId.set(candidate.candidateId, workItem);
          }
          resumeForScreening = resume;
          // A successfully saved resume becomes seen before model work. This
          // intentionally prevents fetch retries from repeating external work.
          // The durable work item above lets an interrupted pre-decision run
          // resume this exact candidate despite that seen marker.
          seenCandidateIdsDuringRun.add(candidate.candidateId);
          await store.markCapturedCandidatesSeen(platform, jobKey, [candidate.candidateId]);

          try {
            const prepared = await scoreAndPrepareBossCapturedCandidate({
              jobKey,
              job,
              candidate,
              resume,
              store,
              fetchedAt,
              screening,
              primaryForwarding,
            });
            continueBossDetailLifecycleAfterModel(detailOptions, true);

            if (prepared.status === 'pending-score') {
              const existingWorkItem = screeningWorkByCandidateId.get(candidate.candidateId)!;
              const failedAt = new Date().toISOString();
              const updatedWorkItem: BossScreeningWorkItem = {
                ...existingWorkItem,
                updatedAt: failedAt,
                scoreAttemptCount: (existingWorkItem.scoreAttemptCount ?? 0) + 1,
                lastScoreFailure: {
                  failedAt,
                  error: prepared.failure.error,
                  ...(prepared.failure.diagnostic ? { diagnostic: prepared.failure.diagnostic } : {}),
                },
              };
              await store.saveBossScreeningWorkItem('boss', jobKey, updatedWorkItem);
              screeningWorkByCandidateId.set(candidate.candidateId, updatedWorkItem);
              bossScreeningScoreFailures.push(prepared.failure);
              return;
            }

            const screeningResult = prepared.result;
            if (screeningResult.routingArtifact.classification === 'rejected') {
              rejectedAwaitingClose = screeningResult;
              return;
            }

            bossScreeningResults.push(screeningResult);
            // The immutable decision and forwarding outbox now own recovery;
            // the pre-decision work item must not survive external execution.
            await store.deleteBossScreeningWorkItem('boss', jobKey, candidate.candidateId);
            screeningWorkByCandidateId.delete(candidate.candidateId);
            if (!screeningResult.forwardingOutbox) {
              throw new Error(`Boss non-rejected decision for ${candidate.candidateId} has no forwarding outbox.`);
            }

            try {
              const hasColleagueCommunication = primaryForwarding.mode === 'email'
                ? (await readBossColleagueCommunicationFlagRef.fn(detailPage, candidate, detailOptions!))
                  .hasColleagueCommunication
                : false;
              screeningResult.forwardingOutbox = await executeBossForwardingDeliveries({
                jobKey,
                candidate,
                entry: screeningResult.forwardingOutbox,
                detailPage,
                store,
                detailOptions,
                hasColleagueCommunication,
              });
            } catch (error) {
              screeningResult.forwardingOutbox = await store.readBossForwardingOutboxEntry(
                'boss',
                jobKey,
                candidate.candidateId,
              ) ?? screeningResult.forwardingOutbox;
              if (error instanceof BossUnexpectedContactDialogError) {
                throw error;
              }
              bossScreeningFailures.push({
                candidateId: candidate.candidateId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } catch (error) {
            // Capture and seen state are already durable. Browser work after
            // the model gets a fresh bounded continuation, while any
            // non-fatal routing/persistence failure remains recoverable and
            // must not relabel the successful resume capture as failed.
            continueBossDetailLifecycleAfterModel(detailOptions, true);
            if (error instanceof BossUnexpectedContactDialogError) {
              throw error;
            }
            bossScreeningFailures.push({
              candidateId: candidate.candidateId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        undefined,
        async () => {
          if (!rejectedAwaitingClose || !resumeForScreening) return;
          try {
            const finalized = await finalizeBossRejectedCandidateAfterDetailClose({
              jobKey,
              job,
              resume: resumeForScreening,
              store,
              screening,
              result: rejectedAwaitingClose,
              detailClosedAt: new Date().toISOString(),
            });
            const enqueueResult = rejectionEmailDispatcher?.enqueueLive(finalized.rejectionEmailOutbox!);
            if (enqueueResult === 'closed') {
              throw new Error(
                `Boss rejection email ${finalized.rejectionEmailOutbox!.deliveryId} could not enter the closed run dispatcher.`,
              );
            }
            bossScreeningResults.push(finalized);
            await store.deleteBossScreeningWorkItem('boss', jobKey, candidate.candidateId);
            screeningWorkByCandidateId.delete(candidate.candidateId);
          } catch (error) {
            bossScreeningFailures.push({
              candidateId: candidate.candidateId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      candidateResults.push(candidateResult);
      recordBossSeenProcessingLifecycle(candidate.candidateId, candidateResult.detailLifecycle, candidateResult.failureReason);
    } else {
      const preCaptureForwarding = platform === 'boss' && options.bossForwardMode && options.bossForwardRecipient
        ? {
          mode: options.bossForwardMode,
          recipient: options.bossForwardRecipient,
          ...(options.bossForwardCc === undefined ? {} : { ccEmails: options.bossForwardCc }),
        } satisfies BossForwardingSettings
        : undefined;
      const usesWorkflowOwnedBossForwarding = platform !== 'boss'
        || platformAdapter.afterResumeDetailOpened === undefined
        || platformAdapter.afterResumeDetailOpened === getPlatformAdapter('boss').afterResumeDetailOpened;
      const beforeResumeParsed = preCaptureForwarding
        && usesWorkflowOwnedBossForwarding
        && !preCaptureForwardingCompletedCandidateIds.has(candidate.candidateId)
        ? async ({
          detailPage,
          detailOptions,
        }: {
          detailPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
          detailOptions?: CandidateProfileDetailOptions;
        }) => {
          const now = new Date().toISOString();
          const pendingOutbox = createBossPreCaptureForwardingOutboxEntry(candidate.candidateId, preCaptureForwarding, now);
          // Persist the exact target set before opening the first forwarding
          // dialog. Each recipient is then advanced independently by the
          // shared outbox executor, so a failed copy never repeats a sent one.
          await store.saveBossForwardingOutboxEntry('boss', jobKey, pendingOutbox);
          const completedOutbox = await executeBossForwardingDeliveries({
            jobKey,
            candidate,
            entry: pendingOutbox,
            detailPage,
            store,
            detailOptions,
          });
          bossPreCaptureForwardingResults.push(completedOutbox);
          if (completedOutbox.forwarding.status !== 'sent') {
            throw new Error(
              `Boss pre-capture forwarding ${completedOutbox.forwarding.status}: ${completedOutbox.forwarding.error ?? 'manual review required'}`,
            );
          }
        }
        : undefined;
      const postOpenActions: CandidatePostOpenActions | null = platform === 'boss'
        ? preCaptureForwarding
          ? {
            bossForwardMode: preCaptureForwarding.mode,
            bossForwardRecipient: preCaptureForwarding.recipient,
            bossForwardCcEmails: preCaptureForwarding.ccEmails,
            bossForwardTransactionManaged: true,
          }
          : null
        : {
          liepinForwardContact: platform === 'liepin' ? options.liepinForwardContact : undefined,
        };
      candidateResults.push(await captureCandidateResume(
        platform,
        jobKey,
        candidate,
        store,
        session,
        searchPage,
        platformAdapter,
        postOpenActions,
        postScoreRoutingEnabled
          ? async ({ resume }) => {
            if (postScoreRoutingWorkByCandidateId.has(resume.candidateId)) return;
            const now = new Date().toISOString();
            const workItem: PostScoreRoutingWorkItem = {
              candidateId: resume.candidateId,
              policyHash: postScoreRoutingPolicyHash,
              createdAt: now,
              updatedAt: now,
            };
            await store.savePostScoreRoutingWorkItem(platform, jobKey, workItem);
            postScoreRoutingWorkByCandidateId.set(resume.candidateId, workItem);
          }
          : undefined,
        beforeResumeParsed,
      ));
      const result = candidateResults[candidateResults.length - 1]!;
      recordBossSeenProcessingLifecycle(candidate.candidateId, result.detailLifecycle, result.failureReason);
    }
  }
  await processBossSeenViewOnlyCandidates();

  const capturedCandidateIds = [...new Set(candidateResults
    .filter((result) => result.captured)
    .map((result) => result.candidateId))];

  if (!bossScreeningEnabled) {
    await store.markCapturedCandidatesSeen(platform, jobKey, capturedCandidateIds);
  }

  await options.releaseBrowserPhase?.();

  if (bossScreeningEnabled && rejectionEmailDispatcher) {
    const reportableDeliveryIds = new Set(reportableRecoveredRejectionEmails.map((entry) => entry.deliveryId));
    const rejectionEmailDispatchSummary = await rejectionEmailDispatcher.closeAndDrain();
    rejectionEmailSmtpAttemptCount = rejectionEmailDispatchSummary.smtpAttemptCount;
    rejectionEmailDispatcherPauseCode = rejectionEmailDispatchSummary.pause?.code;
    const latestEntryByDeliveryId = new Map(rejectionEmailDispatchSummary.entries
      .map((entry) => [entry.deliveryId, entry]));
    preloadedRejectionEmailOutbox = preloadedRejectionEmailOutbox.map((entry) =>
      latestEntryByDeliveryId.get(entry.deliveryId) ?? entry);
    reportableRecoveredRejectionEmails = preloadedRejectionEmailOutbox
      .filter((entry) => reportableDeliveryIds.has(entry.deliveryId));
    for (const result of bossScreeningResults) {
      if (!result.rejectionEmailOutbox) continue;
      result.rejectionEmailOutbox = latestEntryByDeliveryId.get(result.rejectionEmailOutbox.deliveryId)
        ?? result.rejectionEmailOutbox;
    }
  }

  const scoringResult: CandidateScoringResult = bossScreeningEnabled
    ? {
      scoredCandidates: [
        ...unreportedRecoveryRoutingArtifacts
          .filter((artifact) => artifact.scoreStatus === 'success')
          .map((artifact) => artifact.candidateId),
        ...bossScreeningResults
          .filter((result) => result.scoreArtifact.status === 'success')
          .map((result) => result.candidateId),
      ],
      failedCandidates: [
        ...unreportedRecoveryRoutingArtifacts
          .filter((artifact) => artifact.scoreStatus === 'failed')
          .map((artifact) => ({
            candidateId: artifact.candidateId,
            error: artifact.scoreError ?? 'Unknown Boss screening score error',
          })),
        ...bossScreeningScoreFailures,
      ],
    }
    : await scoreCapturedResumes(platform, jobKey, job, store, capturedCandidateIds, {
      ...(postScoreRoutingEnabled ? { postScoreRouting: options.postScoreRouting } : {}),
      ...(postScoreRoutingEnabled ? {
        pendingCandidateIds: [...pendingPostScoreRoutingCandidateIds],
        fetchedAt,
      } : {}),
    });
  if (postScoreRoutingEnabled && recoveredPostScoreRoutingArtifacts.length > 0) {
    scoringResult.scoredCandidates = [...new Set([
      ...recoveredPostScoreRoutingArtifacts
        .filter((artifact) => artifact.scoreStatus === 'success')
        .map((artifact) => artifact.candidateId),
      ...scoringResult.scoredCandidates,
    ])];
    scoringResult.failedCandidates = [
      ...recoveredPostScoreRoutingArtifacts
        .filter((artifact) => artifact.scoreStatus === 'failed')
        .map((artifact) => ({
          candidateId: artifact.candidateId,
          error: artifact.scoreError ?? 'Unknown result-routing score error',
        })),
      ...scoringResult.failedCandidates,
    ];
    scoringResult.routingArtifacts = [
      ...recoveredPostScoreRoutingArtifacts,
      ...(scoringResult.routingArtifacts ?? []),
    ];
  }
  const latestForwardingEntries = new Map<string, BossForwardingOutboxEntry>();
  for (const entry of [
    ...outboxRecovery.recoveredUncertainEntries,
    ...bossForwardingRetryResults,
    ...bossPreCaptureForwardingResults,
    ...bossScreeningResults.flatMap((result) => result.forwardingOutbox ? [result.forwardingOutbox] : []),
  ]) {
    latestForwardingEntries.set(entry.candidateId, entry);
  }
  const forwardingOutcomeEntries = [...latestForwardingEntries.values()];
  const latestRejectionEmailEntries = new Map<string, BossRejectionEmailOutboxEntry>();
  const unreportedRejectedCandidateIds = new Set(unreportedRecoveryRoutingArtifacts
    .filter((artifact) => artifact.classification === 'rejected')
    .map((artifact) => artifact.candidateId));
  for (const entry of reportableRecoveredRejectionEmails) {
    latestRejectionEmailEntries.set(entry.candidateId, entry);
  }
  for (const entry of preloadedRejectionEmailOutbox.filter((item) => unreportedRejectedCandidateIds.has(item.candidateId))) {
    latestRejectionEmailEntries.set(entry.candidateId, entry);
  }
  for (const entry of bossScreeningResults.flatMap((result) => result.rejectionEmailOutbox ? [result.rejectionEmailOutbox] : [])) {
    latestRejectionEmailEntries.set(entry.candidateId, entry);
  }
  const rejectionEmailOutcomeEntries = [...latestRejectionEmailEntries.values()];
  const captureFailures: RunCaptureFailure[] = candidateResults
    .filter((result) => !result.captured)
    .map((result) => ({
      candidateId: result.candidateId,
      stage: result.failureStage ?? 'persist',
      detailVerified: result.detailVerified,
      error: result.failureReason ?? 'Unknown capture failure',
    }));
  const processingFailures: RunProcessingFailure[] = [
    ...scoringResult.failedCandidates.map((failure) => ({
      candidateId: failure.candidateId,
      stage: 'score' as const,
      error: failure.error,
      ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    })),
    ...bossScreeningFailures.map((failure) => ({
      candidateId: failure.candidateId,
      stage: 'routing' as const,
      error: failure.error,
    })),
    ...rejectionEmailOutcomeEntries
      .filter((entry) => entry.status !== 'sent')
      .map((entry) => ({
        candidateId: entry.candidateId,
        stage: 'rejection-email' as const,
        error: `Boss rejection email ${entry.status}: ${entry.error ?? 'manual review required'}`,
      })),
    ...forwardingOutcomeEntries
      .filter((entry) => entry.forwarding.status !== 'sent')
      .map((entry) => ({
        candidateId: entry.candidateId,
        stage: 'forward' as const,
        error: `Boss forwarding ${entry.forwarding.status}: ${entry.forwarding.error ?? 'manual review required'}`,
      })),
  ];
  const failedCandidates = [
    ...candidateResults
      .filter((result) => !result.captured)
      .map((result) => ({
        candidateId: result.candidateId,
        error: result.failureReason ?? 'Unknown error',
      })),
    ...scoringResult.failedCandidates,
    ...bossScreeningFailures,
    ...rejectionEmailOutcomeEntries
      .filter((entry) => entry.status !== 'sent')
      .map((entry) => ({
        candidateId: entry.candidateId,
        error: `Boss rejection email ${entry.status}: ${entry.error ?? 'manual review required'}`,
      })),
    ...forwardingOutcomeEntries
      .filter((entry) => entry.forwarding.status !== 'sent')
      .map((entry) => ({
        candidateId: entry.candidateId,
        error: `Boss forwarding ${entry.forwarding.status}: ${entry.forwarding.error ?? 'manual review required'}`,
      })),
  ];
  const scoreFailureStatusCounts = (failures: readonly CandidateScoreFailure[]): Record<string, number> =>
    failures.reduce<Record<string, number>>((counts, failure) => {
      const key = failure.diagnostic
        ? `${failure.diagnostic.kind}@${failure.diagnostic.phase}`
        : 'score-error@evaluation';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});

  const bossRouting = bossScreeningEnabled
    ? (() => {
      const policyHash = hashBossScreeningPolicy(options.bossScreening!);
      const routingArtifactsByCandidateId = new Map<string, BossCandidateRoutingArtifact>();
      for (const artifact of [
        ...unreportedRecoveryRoutingArtifacts,
        ...reportableRecoveredRejectionEmails.map((entry) => entry.routingArtifact),
        ...bossScreeningResults.map((result) => result.routingArtifact),
      ]) {
        if (artifact.policyHash === policyHash) {
          routingArtifactsByCandidateId.set(artifact.candidateId, artifact);
        }
      }
      const routingArtifactsForCurrentReport = [...routingArtifactsByCandidateId.values()];
      const forwardingStatusCounts = forwardingOutcomeEntries.reduce<Record<string, number>>((counts, entry) => {
        const status = entry.forwarding.status;
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {});
      const rejectionEmailStatusCounts = rejectionEmailOutcomeEntries.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.status] = (counts[entry.status] ?? 0) + 1;
        return counts;
      }, {});
      const rejectionEmailRetryExhaustedCount = rejectionEmailOutcomeEntries
        .filter((entry) => entry.status === 'retryable-failed' && entry.retryExhausted === true)
        .length;
      return {
        enabled: true as const,
        policyHash,
        ...(options.reportDelivery || options.secondaryReportDelivery ? {
          reportDelivery: {
            ...(options.reportDelivery ? { primary: options.reportDelivery } : {}),
            ...(options.secondaryReportDelivery ? { secondary: options.secondaryReportDelivery } : {}),
          },
        } : {}),
        qualifiedCandidateIds: routingArtifactsForCurrentReport
          .filter((artifact) => artifact.classification === 'qualified')
          .map((artifact) => artifact.candidateId),
        reviewCandidateIds: routingArtifactsForCurrentReport
          .filter((artifact) => artifact.classification === 'review')
          .map((artifact) => artifact.candidateId),
        rejectedCandidateIds: routingArtifactsForCurrentReport
          .filter((artifact) => artifact.classification === 'rejected')
          .map((artifact) => artifact.candidateId),
        ...(bossScreeningScoreFailures.length > 0 ? {
          pendingScoreCandidateIds: bossScreeningScoreFailures.map((failure) => failure.candidateId),
          scoreFailureStatusCounts: scoreFailureStatusCounts(bossScreeningScoreFailures),
        } : {}),
        forwardingStatusCounts,
        rejectionEmailStatusCounts,
        rejectionEmailSmtpAttemptCount,
        rejectionEmailRetryExhaustedCount,
        ...(rejectionEmailDispatcherPauseCode
          ? { rejectionEmailDispatcherPauseCode }
          : {}),
      };
    })()
    : undefined;

  const postScoreRouting = postScoreRoutingEnabled
    ? (() => {
      const artifacts = scoringResult.routingArtifacts ?? [];
      const decidedCandidateIds = new Set(artifacts.map((artifact) => artifact.candidateId));
      const pendingFailures = scoringResult.failedCandidates
        .filter((failure) => !decidedCandidateIds.has(failure.candidateId));
      return {
        enabled: true as const,
        policyHash: postScoreRoutingPolicyHash!,
        ...(options.reportDelivery || options.secondaryReportDelivery ? {
          reportDelivery: {
            ...(options.reportDelivery ? { primary: options.reportDelivery } : {}),
            ...(options.secondaryReportDelivery ? { secondary: options.secondaryReportDelivery } : {}),
          },
        } : {}),
        qualifiedCandidateIds: artifacts.filter((artifact) => artifact.classification === 'qualified').map((artifact) => artifact.candidateId),
        reviewCandidateIds: artifacts.filter((artifact) => artifact.classification === 'review').map((artifact) => artifact.candidateId),
        rejectedCandidateIds: artifacts.filter((artifact) => artifact.classification === 'rejected').map((artifact) => artifact.candidateId),
        ...(pendingFailures.length > 0 ? {
          pendingScoreCandidateIds: pendingFailures.map((failure) => failure.candidateId),
          scoreFailureStatusCounts: scoreFailureStatusCounts(pendingFailures),
        } : {}),
      };
    })()
    : undefined;

  const runResult: RunResult = {
    jobKey,
    platform: platformAdapter.platform,
    fetchedAt,
    totalCandidates: candidates.length,
    runResultVersion: 2,
    capturedCandidateIds,
    captureAttemptCount: captureCandidates.length,
    detailAttemptCount: retryCandidates.length
      + captureCandidates.length
      + bossSeenViewAttemptedCandidateIds.size,
    captureFailures,
    processingFailures,
    ...(platform === 'boss' ? {
      bossSeenViewSync: {
        eligibleCandidateIds: bossSeenEligibleCandidates.map((candidate) => candidate.candidateId),
        attemptedCandidateIds: [...bossSeenViewAttemptedCandidateIds],
        completedCandidateIds: [...bossSeenViewCompletedCandidateIds],
        coveredByProcessingCandidateIds: [...bossSeenViewCoveredByProcessingCandidateIds],
        failures: bossSeenViewFailures,
      } satisfies BossSeenViewSyncResult,
    } : {}),
    scoredCandidates: scoringResult.scoredCandidates,
    failedCandidates,
    ...(bossRouting ? { bossRouting } : {}),
    ...(postScoreRouting ? { postScoreRouting } : {}),
    ...(options.searchExecution ? {
      searchExecution: {
        ...options.searchExecution,
        includeViewedCandidates: options.includeViewedCandidates ?? false,
        ...(options.coreSavedSearchTarget ? { coreSavedSearchTarget: options.coreSavedSearchTarget } : {}),
        ...(savedSearchOpenEvidence ? { savedSearchOpenEvidence } : {}),
      },
    } : {}),
  };

  const resultPath = await store.saveRunResult(platform, jobKey, runResult);

  return { candidates, newCandidates, capturedCandidateIds, runResult, resultPath };
  } catch (error) {
    // On a browser or workflow failure, browser ownership is released before
    // the browser-independent mail lane is closed and reconciled. Preserve
    // the original failure even if cleanup evidence is itself malformed.
    if (rejectionEmailDispatcher) {
      try {
        await options.releaseBrowserPhase?.();
      } catch {
        // The outer capture owner retains its own idempotent release/finally.
      }
      try {
        await rejectionEmailDispatcher.closeAndDrain();
      } catch {
        // The original browser/workflow error remains the primary failure.
      }
    }
    throw error;
  }
}

return {
  executeBossRejectionEmailDeliveryRef,
  extractCandidateListRef,
  extractCandidateListWithAdapterRef,
  extractionBoundary,
  extractResumeFromPageRef,
  formatResumeSnapshot,
  forwardBossResumeRef,
  openDirectSearchRef,
  openBoundSavedSearchRef,
  openResumeDetailRef,
  openSubscribeSearchRef,
  readBossColleagueCommunicationFlagRef,
  runResumeCaptureFlow,
  scoreAndEvaluateBossScreeningRef,
  scoreAndEvaluatePostScoreRoutingRef,
  scoreResumeAgainstJobRef,
  visitBossSeenCandidateDetailRef,
  waitBossRejectionEmailRetryRef,
  waitPlatformActionPaceRef,
  waitPlatformCandidatePaceRef,
};
}
