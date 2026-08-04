import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildJobKey, parseJobDescription } from './parsers/jd-parser.js';
import { config } from './config.js';
import { JobStore } from './storage/job-store.js';
import { BrowserSession, closeBrowserSession, ensureAuthenticatedBrowserSession } from './browser/session.js';
import { waitPlatformActionPace, waitPlatformCandidatePace } from './browser/pacing.js';
import { createProductionExtractionBoundary } from './extraction/production-extractor.js';
import { isCrawl4aiAdapterAvailable } from './extraction/crawl4ai-extractor.js';
import { getPlatformAdapter, listCapturePlatforms, listSearchSubscriptionPlatforms, listSupportedPlatforms, parsePlatformArg } from './platforms/registry.js';
import { fiftyOneJobAdapter } from './platforms/51job-adapter.js';
import {
  BossForwardUncertainError,
  BossUnexpectedContactDialogError,
  BossResumeDetailCloseError,
  BossResumeIdentityVerificationError,
  forwardBossResume,
} from './platforms/boss-adapter.js';
import { resolveBossCapturePlan } from './platforms/boss/capture-plan.js';
import { acquireBossSearchLease } from './platforms/boss/search-lease.js';
import {
  BossSeenCandidateDetailError,
  visitBossSeenCandidateDetail,
} from './platforms/boss/actions/search-actions.js';
import {
  bossActionPaceUpperBoundMs,
  waitBossActionPaceWithinDeadline,
} from './platforms/boss/actions/context.js';
import { executeBossChatOperation } from './platforms/boss-operations.js';
import { buildBossSyncedJobKey, syncBossPositions } from './platforms/boss-jobs.js';
import { greetBossTalentCandidate, runBossTalentSearch } from './platforms/boss-talent.js';
import {
  closeBossChatResume,
  collectBossUnreadConversations,
  contactBossQualifiedCandidate,
  contactBossShanghaiOriginCandidate,
  contactBossUnqualifiedCandidate,
  openAndParseBossChatResume,
  openBossChatPage,
  openBossUnreadConversation,
} from './platforms/boss-chat.js';
import { normalizeBossCaptureTaskSnapshot, normalizeBossSavedSearchReference } from './server/task-normalizers.js';
import type { BossForwardMode, CandidatePostOpenActions, CandidateProfileDetailOptions, PlatformAdapter, SupportedPlatform } from './platforms/types.js';
import { answerCandidateQuestionFromJd, toJdRagSources, type JdRagSource } from './rag/jd-question-answering.js';
import { answerQuestionWithRag } from './rag/service.js';
import {
  buildApplicationFilterConditions,
  loadApplicationFilterInputFile,
  loadSearchConditionPlanFile,
  runSearchSubscriptionWorkflow,
  SearchSubscriptionRunError,
} from './search/search-subscription.js';
import {
  SearchConditionSetService,
  type SearchConditionSetReference,
} from './search/search-condition-sets.js';
import { scoreResumeAgainstJob } from './scoring/score-resume.js';
import {
  assertBossScreeningJobRecordReady,
  hashBossScreeningPolicy,
  hashPostScoreRoutingPolicy,
  normalizeBossCaptureSettingsSnapshot,
  normalizePostScoreRoutingSettings,
  loadPostScoreRoutingPolicyFile,
  resolveBossCaptureForwardingSettings,
  resolveBossCaptureScreeningSettings,
  resolveBossRoutingDecision,
  resolvePostScoreRoutingDecision,
  scoreAndEvaluateBossScreening,
  scoreAndEvaluatePostScoreRouting,
} from './scoring/boss-screening.js';
import { evaluatePropertyElectricianHardRequirements } from './scoring/boss-chat-hard-requirements.js';
import { sendBossChatSummary } from './reporting/boss-chat-summary.js';
import { exportJobResults, type ExportJobResultsSummary } from './scripts/export-job-results.js';
import {
  sendBossRoutedReports,
  sendPostScoreRoutedReports,
  sendJobReport,
  type SendBossRoutedReportsSummary,
  type SendPostScoreRoutedReportsSummary,
  type SendJobReportSummary,
} from './scripts/send-job-report-email.js';
import { loadTalentMappingPlanFile } from './talent-mapping/plan.js';
import { runTalentMappingWorkflow } from './talent-mapping/workflow.js';
import {
  BossAutomationSettings,
  BossCaptureSettingsSnapshot,
  BossCaptureTaskSnapshot,
  BossCandidateRoutingArtifact,
  BossChatReviewItem,
  BossChatReviewRun,
  BossForwardingDeliveryState,
  BossForwardingOutboxEntry,
  BossForwardingSettings,
  BossForwardingStatus,
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
  ResumeDomSnapshot,
  JobRecord,
  JobSearchSource,
  NormalizedJob,
  parseEmailList,
  ReportDeliveryOptions,
  resolveReportDelivery,
  RunResult,
  SavedSearchReference,
  SearchCondition,
  SearchSortPolicy,
  SearchSubscriptionSummary,
  RunCaptureFailure,
  RunProcessingFailure,
  BossSeenViewSyncFailure,
  BossSeenViewSyncResult,
} from './types/job.js';
import {
  isTalentMappingCorePlatform,
  type TalentMappingPlatformSelection,
  type TalentMappingRunSummary,
  type TalentMappingStage,
} from './types/talent-mapping.js';
import type {
  BossChatOperationInput,
  BossChatOperationResult,
  BossGreetInput,
  BossGreetResult,
  BossJobSyncInput,
  BossJobSyncRun,
  BossTalentSearchInput,
  BossTalentSearchResult,
} from './types/boss.js';

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

function createBossDetailLifecycleOptions(options: { keepOpenForScreening?: boolean } = {}): CandidateProfileDetailOptions {
  const cleanupReserveMs = Math.max(1_000, bossActionPaceUpperBoundMs());
  // Screening deliberately keeps the verified detail open while the model
  // evaluates the resume and while the selected delivery addresses are
  // forwarded. The ordinary 20s detail-read budget is too short for the
  // configured Codex-session completion limit, so allocate one larger,
  // still-bounded lifecycle budget up front. Actions continue to consume this
  // same absolute deadline; no later phase resets it.
  const screeningModelBudgetMs = options.keepOpenForScreening
    ? config.llm.codexSessionTimeoutMs
    : 0;
  const screeningForwardingBudgetMs = options.keepOpenForScreening
    ? Math.max(120_000, config.playwright.resumeDetailTimeoutMs * 4)
    : 0;
  const timeoutMs = Math.max(
    config.playwright.resumeDetailTimeoutMs,
    cleanupReserveMs + 1,
    screeningModelBudgetMs + screeningForwardingBudgetMs + cleanupReserveMs,
  );
  return {
    deadline: Date.now() + timeoutMs,
    cleanupReserveMs,
  };
}

interface BossScreeningCandidateResult {
  candidateId: string;
  scoreArtifact: CandidateScoreArtifact;
  routingArtifact: BossCandidateRoutingArtifact;
  forwardingOutbox: BossForwardingOutboxEntry;
}

interface CandidateScoringResult {
  scoredCandidates: string[];
  failedCandidates: Array<{
    candidateId: string;
    error: string;
  }>;
  routingArtifacts?: CandidateRoutingArtifact[];
}

type CliPlatformSelection = SupportedPlatform | 'all';
type SearchSource = JobSearchSource;

interface RunnableJobInput extends ReportDeliveryOptions {
  searchKeyword: string;
  /** Stable Boss position identity for the Boss stage only. */
  bossJobId?: string;
  /** Explicit Boss page-query override; never affects core-platform searches. */
  bossSearchKeyword?: string;
  /** Complete verified native reference; a name alone is never sufficient. */
  bossSavedSearchReference?: SavedSearchReference;
  /** Fixed Boss-only condition-set override; it never changes core stages. */
  bossSearchConditionSetRef?: SearchConditionSetReference;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  includeBoss: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  /** Optional so an omitted run reuses the saved Boss screening switch. */
  bossScreeningEnabled?: boolean;
  /** Absolute path for CLI inputs; jobs-file paths are resolved per item. */
  bossScreeningPolicyFile?: string;
  bossSecondaryForwardMode?: BossForwardMode;
  bossSecondaryForwardRecipient?: string;
  bossSecondaryForwardCc?: string[];
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  /** Platform-neutral model routing; native forwarding remains Boss-only. */
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  /** Internal HTTP/scheduler snapshot; ordinary CLI and jobs files omit it. */
  bossCaptureSettingsSnapshot?: BossCaptureSettingsSnapshot;
  /** Private server snapshot carried through the queue runner. */
  bossCaptureTaskSnapshot?: BossCaptureTaskSnapshot;
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

interface SingleJobCliInput extends RunnableJobInput {
  mode: 'single';
  platform: CliPlatformSelection;
}

interface BatchCliInput extends ReportDeliveryOptions {
  mode: 'batch';
  platform: CliPlatformSelection;
  jobsFilePath: string;
  includeViewedCandidates: boolean;
  includeBoss: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryForwardMode?: BossForwardMode;
  bossSecondaryForwardRecipient?: string;
  bossSecondaryForwardCc?: string[];
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

interface SearchSubscriptionCliInput {
  mode: 'search-subscription';
  platform: CliPlatformSelection;
  keyword?: string;
  filePath: string;
  includeBoss: boolean;
  save: boolean;
  savedSearchName?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

interface BossSavedSearchBindingCliInput {
  mode: 'boss-saved-search-binding';
  platform: 'boss';
  searchKeyword: string;
  bossJobId?: string;
  savedSearch: SavedSearchReference;
}

interface TalentMappingCliInput {
  mode: 'talent-mapping';
  platform: TalentMappingPlatformSelection;
  filePath: string;
  stage: TalentMappingStage;
  confirmedDetailOpen: boolean;
  sourceScanRunId?: string;
}

interface JdQuestionCliInput {
  mode: 'jd-question';
  platform: CliPlatformSelection;
  keyword?: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  question: string;
}

interface BossAutoChatCliInput {
  mode: 'boss-auto-chat';
  platform: 'boss';
  scoreThreshold: number;
  requireAllHardRequirements: boolean;
  replyToUnqualifiedCandidates: boolean;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  summaryEmail?: string;
  summaryCcEmails?: string[];
  syncJobsBeforeReview: boolean;
}

interface BossTalentSearchCliInput extends BossTalentSearchInput {
  mode: 'boss-talent-search';
}

interface BossGreetCliInput extends BossGreetInput {
  mode: 'boss-greet';
}

interface BossChatOperationCliInput extends BossChatOperationInput {
  mode: 'boss-chat-operation';
}

interface BossJobSyncCliInput extends BossJobSyncInput {
  mode: 'boss-job-sync';
}

interface BatchRunnableJobInput extends RunnableJobInput {
  sourceIndex: number;
}

type CliInput = SingleJobCliInput
  | BatchCliInput
  | SearchSubscriptionCliInput
  | BossSavedSearchBindingCliInput
  | TalentMappingCliInput
  | JdQuestionCliInput
  | BossAutoChatCliInput
  | BossTalentSearchCliInput
  | BossGreetCliInput
  | BossChatOperationCliInput
  | BossJobSyncCliInput;

interface SinglePlatformCliInput extends ReportDeliveryOptions {
  platform: SupportedPlatform;
  searchKeyword: string;
  bossJobId?: string;
  bossSearchKeyword?: string;
  bossSavedSearchReference?: SavedSearchReference;
  bossSearchConditionSetRef?: SearchConditionSetReference;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryForwardMode?: BossForwardMode;
  bossSecondaryForwardRecipient?: string;
  bossSecondaryForwardCc?: string[];
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  bossCaptureSettingsSnapshot?: BossCaptureSettingsSnapshot;
  bossCaptureTaskSnapshot?: BossCaptureTaskSnapshot;
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRef?: SearchConditionSetReference;
}

export interface MainRunSummary {
  jobKey: string;
  /** Present for Boss capture when resolved from a stable Boss position. */
  bossJobId?: string;
  /** Lightweight audit of the effective Boss search. */
  searchExecution?: RunResult['searchExecution'];
  totalCandidates: number;
  captureAttempts: number;
  capturedCandidates: number;
  /** Deprecated alias retained for task/API compatibility; equals capturedCandidates. */
  newCandidates: number;
  scoredCandidates: number;
  failedCandidates: number;
  resultPath: string;
  exportPath?: string;
  exportError?: string;
  /** In routed Boss runs, true when either audience made an SMTP attempt. */
  emailAttempted: boolean;
  /** In routed Boss runs, true only when every non-skipped audience report was delivered. */
  emailDelivered: boolean;
  emailRecipient?: string;
  emailSubject?: string;
  emailError?: string;
  /** Boss-only post-score routing and forwarding state for operator visibility. */
  bossRouting?: RunResult['bossRouting'];
  postScoreRouting?: RunResult['postScoreRouting'];
  /** Present only for a Boss run with enabled post-score routing. */
  reportDeliveries?: SendBossRoutedReportsSummary['reportDeliveries'];
  /** Present for a Boss capture run that synchronised already-seen cards. */
  bossSeenViewSync?: RunResult['bossSeenViewSync'];
  sampleCandidateIds: string[];
}

export function buildBossRoutedMainRunEmailSummary(
  reportDeliveries: SendBossRoutedReportsSummary['reportDeliveries'],
): Pick<MainRunSummary, 'emailAttempted' | 'emailDelivered' | 'emailRecipient' | 'emailSubject' | 'emailError'> {
  const deliveries = [reportDeliveries.primary, reportDeliveries.secondary];
  const requiredDeliveries = deliveries.filter((delivery) => !delivery.skipReason);
  const representative = requiredDeliveries.length === 1
    ? requiredDeliveries[0]
    : requiredDeliveries.find((delivery) => delivery.audience === 'primary');
  const errors = requiredDeliveries.flatMap((delivery) => delivery.error
    ? [{ audience: delivery.audience, message: delivery.error }]
    : []);
  const emailError = errors.length === 1
    ? errors[0]!.message
    : errors.length > 1
      ? errors.map((error) => `${error.audience}: ${error.message}`).join('; ')
      : undefined;

  return {
    emailAttempted: deliveries.some((delivery) => delivery.attempted),
    emailDelivered: requiredDeliveries.length > 0
      && requiredDeliveries.every((delivery) => delivery.delivered),
    emailRecipient: representative?.recipient,
    emailSubject: representative?.subject,
    emailError,
  };
}

export interface AllPlatformsRunSummary {
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export interface BatchJobRunSummary {
  keyword: string;
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export interface JdQuestionRunSummary {
  platform: SupportedPlatform;
  jobKey?: string;
  question: string;
  answer: string;
  sources: JdRagSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

export interface BossAutoChatRunSummary extends BossChatReviewRun {
  resultPath: string;
  summaryEmailRecipient?: string;
  summaryEmailSubject?: string;
}

export interface BossSavedSearchBindingSummary {
  mode: 'boss-saved-search-binding';
  platform: 'boss';
  jobKey: string;
  savedSearch: SavedSearchReference;
  previousRevision: number;
  revision: number;
  verifiedAt: string;
  candidateSideEffects: false;
}

export type MainResult = MainRunSummary
  | AllPlatformsRunSummary[]
  | BatchJobRunSummary[]
  | SearchSubscriptionSummary
  | SearchSubscriptionSummary[]
  | BossSavedSearchBindingSummary
  | JdQuestionRunSummary
  | JdQuestionRunSummary[]
  | BossAutoChatRunSummary
  | BossTalentSearchResult
  | BossGreetResult
  | BossChatOperationResult
  | BossJobSyncRun
  | TalentMappingRunSummary;

export const parseJobDescriptionRef = { fn: parseJobDescription };
export const extractionBoundary = createProductionExtractionBoundary();
export const openSubscribeSearchRef = { fn: fiftyOneJobAdapter.openSubscribeSearch };
export const openDirectSearchRef = { fn: fiftyOneJobAdapter.openDirectSearch };
export const openResumeDetailRef = { fn: fiftyOneJobAdapter.openResumeDetail };
export const visitBossSeenCandidateDetailRef = { fn: visitBossSeenCandidateDetail };
export const extractCandidateListRef = {
  fn: extractionBoundary.extractCandidateListFromPage,
};
export const extractCandidateListWithAdapterRef = {
  fn: async (
    adapter: PlatformAdapter,
    page: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
    options?: Parameters<PlatformAdapter['extractCandidateList']>[1],
  ) => adapter.extractCandidateList(page, options),
};
export const extractResumeFromPageRef = {
  fn: extractionBoundary.extractResumeFromPage,
};
export const scoreResumeAgainstJobRef = { fn: scoreResumeAgainstJob };
/** Test seam for the combined Boss score-and-negative-condition evaluation. */
export const scoreAndEvaluateBossScreeningRef = { fn: scoreAndEvaluateBossScreening };
export const scoreAndEvaluatePostScoreRoutingRef = { fn: scoreAndEvaluatePostScoreRouting };
export const exportJobResultsRef = { fn: exportJobResults };
export const sendJobReportRef = { fn: sendJobReport };
export const sendBossRoutedReportsRef = { fn: sendBossRoutedReports };
export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const runSearchSubscriptionWorkflowRef = { fn: runSearchSubscriptionWorkflow };
export const loadTalentMappingPlanFileRef = { fn: loadTalentMappingPlanFile };
export const runTalentMappingWorkflowRef = { fn: runTalentMappingWorkflow };
export const waitPlatformActionPaceRef = { fn: waitPlatformActionPace };
export const waitPlatformCandidatePaceRef = { fn: waitPlatformCandidatePace };
export const answerCandidateQuestionFromJdRef = { fn: answerCandidateQuestionFromJd };
export const answerQuestionWithRagRef = { fn: answerQuestionWithRag };
export const openBossChatPageRef = { fn: openBossChatPage };
export const collectBossUnreadConversationsRef = { fn: collectBossUnreadConversations };
export const openBossUnreadConversationRef = { fn: openBossUnreadConversation };
export const openAndParseBossChatResumeRef = { fn: openAndParseBossChatResume };
export const forwardBossResumeRef = { fn: forwardBossResume };
export const closeBossChatResumeRef = { fn: closeBossChatResume };
export const contactBossQualifiedCandidateRef = { fn: contactBossQualifiedCandidate };
export const contactBossShanghaiOriginCandidateRef = { fn: contactBossShanghaiOriginCandidate };
export const contactBossUnqualifiedCandidateRef = { fn: contactBossUnqualifiedCandidate };
export const evaluateBossChatHardRequirementsRef = { fn: evaluatePropertyElectricianHardRequirements };
export const sendBossChatSummaryRef = { fn: sendBossChatSummary };
export const runBossTalentSearchRef = { fn: runBossTalentSearch };
export const greetBossTalentCandidateRef = { fn: greetBossTalentCandidate };
export const executeBossChatOperationRef = { fn: executeBossChatOperation };
export const syncBossPositionsRef = { fn: syncBossPositions };
export { JobStore };

export function resolvePlatformAdapter(platform: SupportedPlatform): PlatformAdapter {
  const adapter = getPlatformAdapter(platform);

  if (platform === '51job') {
    return {
      ...adapter,
      openSubscribeSearch: openSubscribeSearchRef.fn,
      ...(openDirectSearchRef.fn ? { openDirectSearch: openDirectSearchRef.fn } : {}),
      extractCandidateList: async (page, options) => extractCandidateListRef.fn(page, options),
      openResumeDetail: openResumeDetailRef.fn,
    };
  }

  return adapter;
}

function parsePlatformSelection(platform?: string): CliPlatformSelection {
  if (platform === 'all') {
    return 'all';
  }

  return parsePlatformArg(platform);
}

function parseOptionalBoolean(value: string | undefined, argumentName: string): boolean {
  if (value === undefined) {
    return true;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${argumentName} must be true or false`);
}

function parseSearchSource(value: string | undefined, argumentName: string): SearchSource {
  if (value === undefined) {
    return 'saved';
  }

  if (value === 'saved' || value === 'direct') {
    return value;
  }

  throw new Error(`${argumentName} must be saved or direct`);
}

function parseSearchConditionSetReferences(
  value: string | undefined,
  options: {
    platform: CliPlatformSelection;
    includeBoss: boolean;
    argumentName: string;
    purpose?: 'capture' | 'search-subscription';
  },
): Partial<Record<SupportedPlatform, SearchConditionSetReference>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${options.argumentName} must contain at least one condition-set reference`);
  }

  const allowedPlatforms = new Set(
    options.platform === 'all'
      ? options.purpose === 'search-subscription'
        ? listSearchSubscriptionPlatforms(options.includeBoss)
        : listCapturePlatforms(options.includeBoss)
      : [options.platform],
  );
  const references: Partial<Record<SupportedPlatform, SearchConditionSetReference>> = {};

  for (const entry of entries) {
    const equalsIndex = entry.indexOf('=');
    let platform: SupportedPlatform;
    let referenceValue: string;

    if (options.platform === 'all') {
      if (equalsIndex <= 0) {
        throw new Error(`${options.argumentName} requires platform=<conditionSetId>@<revision> entries when --platform all`);
      }
      platform = parsePlatformArg(entry.slice(0, equalsIndex));
      referenceValue = entry.slice(equalsIndex + 1);
    } else if (equalsIndex > 0) {
      platform = parsePlatformArg(entry.slice(0, equalsIndex));
      referenceValue = entry.slice(equalsIndex + 1);
    } else {
      platform = options.platform;
      referenceValue = entry;
    }

    if (!allowedPlatforms.has(platform)) {
      const bossHint = platform === 'boss' && options.platform === 'all'
        ? '; Boss requires --include-boss true'
        : '';
      throw new Error(`${options.argumentName} platform ${platform} is not selected${bossHint}`);
    }

    const atIndex = referenceValue.lastIndexOf('@');
    const conditionSetId = atIndex > 0 ? referenceValue.slice(0, atIndex) : '';
    const revisionValue = atIndex > 0 ? referenceValue.slice(atIndex + 1) : '';
    if (!/^scs-[a-z0-9](?:[a-z0-9-]{2,126})$/.test(conditionSetId) || conditionSetId.includes('--')) {
      throw new Error(`${options.argumentName} condition-set ID is invalid for ${platform}`);
    }
    if (!/^[1-9]\d*$/.test(revisionValue)) {
      throw new Error(`${options.argumentName} revision must be a positive integer for ${platform}`);
    }
    if (references[platform]) {
      throw new Error(`${options.argumentName} contains duplicate platform ${platform}`);
    }

    references[platform] = {
      conditionSetId,
      platform,
      revision: Number(revisionValue),
    };
  }

  return references;
}

function parseBossSearchConditionSetReference(value: string | undefined): SearchConditionSetReference | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const atIndex = normalized.lastIndexOf('@');
  const conditionSetId = atIndex > 0 ? normalized.slice(0, atIndex) : '';
  const revisionValue = atIndex > 0 ? normalized.slice(atIndex + 1) : '';
  if (!/^scs-[a-z0-9](?:[a-z0-9-]{2,126})$/.test(conditionSetId) || conditionSetId.includes('--')) {
    throw new Error('--boss-search-condition-set condition-set ID is invalid');
  }
  if (!/^[1-9]\d*$/.test(revisionValue)) {
    throw new Error('--boss-search-condition-set revision must be a positive integer');
  }
  return {
    conditionSetId,
    platform: 'boss',
    revision: Number(revisionValue),
  };
}

function parseTalentMappingStage(value: string | undefined): TalentMappingStage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'scan' || value === 'enrich' || value === 'all') {
    return value;
  }
  throw new Error('--mapping-stage must be scan, enrich, or all');
}

function parseBossForwardMode(
  value: string | undefined,
  argumentName = '--boss-forward-mode',
): BossForwardMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'colleague' || value === 'email') {
    return value;
  }

  throw new Error(`${argumentName} must be colleague or email`);
}

function parseBossChatScoreThreshold(value: string | undefined): number {
  if (value === undefined) {
    return 70;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--boss-chat-score-threshold must be a number from 0 to 100');
  }

  return parsed;
}

function parseStringArrayJson(value: string | undefined, argumentName: string): string[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${argumentName} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${argumentName} must be a JSON array of non-empty strings`);
  }
  return [...new Set(parsed.map((item) => item.trim()))];
}

function parseBossTalentSource(value: string | undefined): BossTalentSearchInput['source'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'recommend' || value === 'deep-search') return value;
  throw new Error('--boss-talent-source must be recommend or deep-search');
}

function parseBossGreetSource(value: string | undefined): BossGreetInput['source'] {
  if (value === 'recommend' || value === 'deep-search' || value === 'normal-search') return value;
  throw new Error('--boss-greet-source must be recommend, deep-search, or normal-search');
}

function parseBatchEmailList(value: unknown, fieldName: string, itemIndex: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return parseEmailList(value);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return parseEmailList(value.join(','));
  }

  throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${fieldName} must be a string or string array`);
}

function parseBatchCcEmails(value: unknown, itemIndex: number): string[] | undefined {
  return parseBatchEmailList(value, 'cc', itemIndex);
}

function parseBatchOptionalBoolean(value: unknown, fieldName: string, itemIndex: number): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${fieldName} must be a boolean`);
  }
  return value;
}

function parseOptionalString(value: unknown, fieldName: string, itemIndex: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${fieldName} must be a string`);
  }

  return value;
}

function parseBatchSearchConditionSetReferences(
  value: unknown,
  itemIndex: number,
  input: BatchCliInput,
): Partial<Record<SupportedPlatform, SearchConditionSetReference>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets must be an object`);
  }

  const allowedPlatforms = new Set(listSelectedCapturePlatforms(input.platform, input.includeBoss));
  const references: Partial<Record<SupportedPlatform, SearchConditionSetReference>> = {};
  for (const [platformKey, rawReference] of Object.entries(value)) {
    const platform = parsePlatformArg(platformKey);
    if (!allowedPlatforms.has(platform)) {
      throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets.${platform} is not selected`);
    }
    if (!rawReference || typeof rawReference !== 'object' || Array.isArray(rawReference)) {
      throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets.${platform} must be an object`);
    }
    const reference = rawReference as Record<string, unknown>;
    const conditionSetId = typeof reference.conditionSetId === 'string' ? reference.conditionSetId.trim() : '';
    const revision = reference.revision;
    if (!/^scs-[a-z0-9](?:[a-z0-9-]{2,126})$/.test(conditionSetId) || conditionSetId.includes('--')) {
      throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets.${platform}.conditionSetId is invalid`);
    }
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets.${platform}.revision must be a positive integer`);
    }
    if (reference.platform !== undefined && reference.platform !== platform) {
      throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets.${platform}.platform must match its key`);
    }
    references[platform] = {
      conditionSetId,
      platform,
      revision: revision as number,
    };
  }

  return references;
}

function parseBatchJobItem(value: unknown, itemIndex: number, input: BatchCliInput): BatchRunnableJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: item must be an object`);
  }

  const item = value as Record<string, unknown>;
  const keyword = parseOptionalString(item.keyword, 'keyword', itemIndex)?.trim();
  const jd = parseOptionalString(item.jd, 'jd', itemIndex);
  const jdFile = parseOptionalString(item.jdFile, 'jdFile', itemIndex);
  const email = parseOptionalString(item.email, 'email', itemIndex);
  const bossJobId = parseOptionalString(item.bossJobId, 'bossJobId', itemIndex)?.trim();
  const bossSearchKeyword = parseOptionalString(item.bossSearchKeyword, 'bossSearchKeyword', itemIndex)?.trim();
  const bossSavedSearchReference = item.bossSavedSearchReference === undefined
    ? undefined
    : (() => {
      try {
        return normalizeBossSavedSearchReference(
          item.bossSavedSearchReference,
          `jobs-file item ${itemIndex}.bossSavedSearchReference`,
        );
      } catch (error) {
        throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  const itemSearchSourceValue = parseOptionalString(item.searchSource, 'searchSource', itemIndex);
  const itemApplicationFilterInputFile = parseOptionalString(item.applicationFilterInputFile, 'applicationFilterInputFile', itemIndex);
  const itemSearchConditionSetRefs = parseBatchSearchConditionSetReferences(item.searchConditionSets, itemIndex, input);
  const itemCcEmails = parseBatchCcEmails(item.cc, itemIndex);
  const itemBossForwardModeValue = parseOptionalString(item.bossForwardMode, 'bossForwardMode', itemIndex);
  const itemBossForwardMode = itemBossForwardModeValue === undefined
    ? undefined
    : parseBossForwardMode(itemBossForwardModeValue.trim(), `jobs-file item ${itemIndex}.bossForwardMode`);
  const itemBossForwardRecipient = parseOptionalString(item.bossForwardRecipient, 'bossForwardRecipient', itemIndex)?.trim();
  const itemBossForwardCc = parseBatchEmailList(item.bossForwardCc, 'bossForwardCc', itemIndex);
  const itemBossScreeningEnabled = parseBatchOptionalBoolean(item.bossScreeningEnabled, 'bossScreeningEnabled', itemIndex);
  const itemBossScreeningPolicyFile = parseOptionalString(item.bossScreeningPolicyFile, 'bossScreeningPolicyFile', itemIndex);
  const itemBossSecondaryForwardModeValue = parseOptionalString(item.bossSecondaryForwardMode, 'bossSecondaryForwardMode', itemIndex);
  const itemBossSecondaryForwardMode = itemBossSecondaryForwardModeValue === undefined
    ? undefined
    : parseBossForwardMode(itemBossSecondaryForwardModeValue.trim(), `jobs-file item ${itemIndex}.bossSecondaryForwardMode`);
  const itemBossSecondaryForwardRecipient = parseOptionalString(item.bossSecondaryForwardRecipient, 'bossSecondaryForwardRecipient', itemIndex)?.trim();
  const itemBossSecondaryEmail = parseOptionalString(item.bossSecondaryEmail, 'bossSecondaryEmail', itemIndex)?.trim();
  const itemBossSecondaryCc = parseBatchEmailList(item.bossSecondaryCc, 'bossSecondaryCc', itemIndex);
  const itemBossSecondaryForwardCc = parseBatchEmailList(item.bossSecondaryForwardCc, 'bossSecondaryForwardCc', itemIndex);
  const itemResultRoutingEnabled = parseBatchOptionalBoolean(item.resultRoutingEnabled, 'resultRoutingEnabled', itemIndex);
  const itemResultRoutingPolicyFile = parseOptionalString(item.resultRoutingPolicyFile, 'resultRoutingPolicyFile', itemIndex);
  const itemSecondaryEmail = parseOptionalString(item.secondaryEmail, 'secondaryEmail', itemIndex)?.trim();
  const itemSecondaryCc = parseBatchEmailList(item.secondaryCc, 'secondaryCc', itemIndex);
  const itemBossCaptureSettingsSnapshot = item.bossCaptureSettingsSnapshot === undefined
    ? undefined
    : (() => {
      try {
        return normalizeBossCaptureSettingsSnapshot(item.bossCaptureSettingsSnapshot);
      } catch (error) {
        throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  const itemBossCaptureTaskSnapshot = item.bossCaptureTaskSnapshot === undefined
    ? undefined
    : (() => {
      try {
        return normalizeBossCaptureTaskSnapshot(item.bossCaptureTaskSnapshot);
      } catch (error) {
        throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  const searchSource = parseSearchSource(itemSearchSourceValue, `jobs-file item ${itemIndex}.searchSource`);
  const hasItemSearchSource = item.searchSource !== undefined;
  const effectiveSearchSource = item.searchSource === undefined ? input.searchSource : searchSource;
  const effectiveSearchSourceExplicit = hasItemSearchSource || input.searchSourceExplicit;
  const effectiveApplicationFilterInputFilePath = itemApplicationFilterInputFile
    ? path.resolve(path.dirname(path.resolve(input.jobsFilePath)), itemApplicationFilterInputFile)
    : (hasItemSearchSource && effectiveSearchSource === 'saved' ? undefined : input.applicationFilterInputFilePath);
  const effectiveSearchConditionSetRefs = hasItemSearchSource && effectiveSearchSource === 'saved'
    ? undefined
    : {
      ...input.searchConditionSetRefs,
      ...itemSearchConditionSetRefs,
    };
  const effectiveBossScreeningEnabled = itemBossScreeningEnabled ?? input.bossScreeningEnabled;
  const effectiveBossScreeningPolicyFile = itemBossScreeningPolicyFile
    ? path.resolve(path.dirname(path.resolve(input.jobsFilePath)), itemBossScreeningPolicyFile)
    : input.bossScreeningPolicyFile;
  const effectiveBossForwardMode = itemBossForwardMode ?? input.bossForwardMode;
  const effectiveBossForwardRecipient = itemBossForwardRecipient ?? input.bossForwardRecipient;
  const effectiveBossForwardCc = item.bossForwardCc === undefined ? input.bossForwardCc : itemBossForwardCc;
  const effectiveBossSecondaryForwardMode = itemBossSecondaryForwardMode ?? input.bossSecondaryForwardMode;
  const effectiveBossSecondaryForwardRecipient = itemBossSecondaryForwardRecipient ?? input.bossSecondaryForwardRecipient;
  const effectiveBossSecondaryEmail = itemBossSecondaryEmail ?? input.bossSecondaryEmail;
  const effectiveBossSecondaryCc = item.bossSecondaryCc === undefined ? input.bossSecondaryCc : itemBossSecondaryCc;
  const effectiveBossSecondaryForwardCc = item.bossSecondaryForwardCc === undefined
    ? input.bossSecondaryForwardCc
    : itemBossSecondaryForwardCc;
  const effectiveResultRoutingEnabled = itemResultRoutingEnabled ?? input.resultRoutingEnabled;
  const effectiveResultRoutingPolicyFile = itemResultRoutingPolicyFile
    ? path.resolve(path.dirname(path.resolve(input.jobsFilePath)), itemResultRoutingPolicyFile)
    : input.resultRoutingPolicyFile;
  const effectiveSecondaryEmail = itemSecondaryEmail ?? input.secondaryEmail;
  const effectiveSecondaryCc = item.secondaryCc === undefined ? input.secondaryCc : itemSecondaryCc;

  if (!keyword) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: keyword must be a non-empty string`);
  }

  if (bossJobId !== undefined && !bossJobId) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossJobId must be a non-empty string`);
  }
  if (bossSearchKeyword !== undefined && !bossSearchKeyword) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSearchKeyword must be a non-empty string`);
  }
  if ((bossJobId || bossSearchKeyword || bossSavedSearchReference)
    && !listSelectedCapturePlatforms(input.platform, input.includeBoss).includes('boss')) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossJobId, bossSearchKeyword, and bossSavedSearchReference require a selected Boss capture stage`);
  }
  if (bossSavedSearchReference && effectiveSearchSource === 'direct') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSavedSearchReference requires searchSource saved or an omitted searchSource`);
  }
  if (bossSavedSearchReference && bossSavedSearchReference.conditionIdentity.jobScope !== keyword) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSavedSearchReference.conditionIdentity.jobScope must match keyword`);
  }
  if (bossSavedSearchReference && bossSearchKeyword
    && bossSavedSearchReference.expectedKeyword !== bossSearchKeyword) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSavedSearchReference.expectedKeyword must match bossSearchKeyword`);
  }

  const hasItemBossScreeningInput = item.bossScreeningEnabled !== undefined
    || item.bossScreeningPolicyFile !== undefined
    || item.bossSecondaryForwardMode !== undefined
    || item.bossSecondaryForwardRecipient !== undefined
    || item.bossSecondaryEmail !== undefined
    || item.bossSecondaryCc !== undefined
    || item.bossSecondaryForwardCc !== undefined
    || item.bossCaptureSettingsSnapshot !== undefined
    || item.bossCaptureTaskSnapshot !== undefined;
  const hasItemResultRoutingInput = item.resultRoutingEnabled !== undefined
    || item.resultRoutingPolicyFile !== undefined
    || item.secondaryEmail !== undefined
    || item.secondaryCc !== undefined;
  if (hasItemResultRoutingInput && input.platform === 'boss') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: generic result routing cannot be used with the standalone Boss stage`);
  }
  const hasItemBossForwardingInput = item.bossForwardMode !== undefined
    || item.bossForwardRecipient !== undefined
    || item.bossForwardCc !== undefined;
  if (hasItemBossForwardingInput && !listSelectedCapturePlatforms(input.platform, input.includeBoss).includes('boss')) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: Boss forwarding fields require a selected Boss capture stage`);
  }
  if (hasItemBossScreeningInput && !listSelectedCapturePlatforms(input.platform, input.includeBoss).includes('boss')) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: Boss screening fields require a selected Boss capture stage`);
  }
  if (hasItemResultRoutingInput && listSelectedCapturePlatforms(input.platform, input.includeBoss).length === 0) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: result routing requires a selected capture stage`);
  }
  if ((itemBossForwardMode === undefined) !== (itemBossForwardRecipient === undefined)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossForwardMode and bossForwardRecipient must be provided together`);
  }
  if ((effectiveBossSecondaryForwardMode === undefined) !== (effectiveBossSecondaryForwardRecipient === undefined)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSecondaryForwardMode and bossSecondaryForwardRecipient must be provided together`);
  }
  if (itemBossSecondaryForwardCc?.length && effectiveBossSecondaryForwardMode === 'colleague') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossSecondaryForwardCc requires bossSecondaryForwardMode email`);
  }
  if (itemBossForwardCc?.length && effectiveBossForwardMode === 'colleague') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossForwardCc requires bossForwardMode email`);
  }

  if (jd !== undefined && jdFile !== undefined) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: jd and jdFile are mutually exclusive`);
  }

  if (effectiveApplicationFilterInputFilePath && effectiveSearchSource !== 'direct') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: applicationFilterInputFile requires searchSource direct`);
  }
  const hasEffectiveSearchConditionSetRefs = Object.keys(effectiveSearchConditionSetRefs ?? {}).length > 0;
  if (effectiveApplicationFilterInputFilePath && hasEffectiveSearchConditionSetRefs) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: applicationFilterInputFile and searchConditionSets are mutually exclusive`);
  }
  if (hasEffectiveSearchConditionSetRefs && effectiveSearchSource !== 'direct') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets requires searchSource direct`);
  }

  return {
    sourceIndex: itemIndex,
    searchKeyword: keyword,
    bossJobId,
    bossSearchKeyword,
    bossSavedSearchReference,
    recipientEmail: email ?? input.recipientEmail,
    ccEmails: item.cc === undefined ? input.ccEmails : itemCcEmails,
    jobDescriptionText: jd,
    jobDescriptionFilePath: jdFile,
    includeViewedCandidates: input.includeViewedCandidates,
    includeBoss: input.includeBoss,
    liepinForwardContact: input.liepinForwardContact,
    bossForwardMode: effectiveBossForwardMode,
    bossForwardRecipient: effectiveBossForwardRecipient,
    bossForwardCc: effectiveBossForwardCc,
    bossScreeningEnabled: effectiveBossScreeningEnabled,
    bossScreeningPolicyFile: effectiveBossScreeningPolicyFile,
    bossSecondaryForwardMode: effectiveBossSecondaryForwardMode,
    bossSecondaryForwardRecipient: effectiveBossSecondaryForwardRecipient,
    bossSecondaryEmail: effectiveBossSecondaryEmail,
    bossSecondaryCc: effectiveBossSecondaryCc,
    resultRoutingEnabled: effectiveResultRoutingEnabled,
    resultRoutingPolicyFile: effectiveResultRoutingPolicyFile,
    secondaryEmail: effectiveSecondaryEmail,
    secondaryCc: effectiveSecondaryCc,
    bossSecondaryForwardCc: effectiveBossSecondaryForwardCc,
    bossCaptureSettingsSnapshot: itemBossCaptureSettingsSnapshot,
    bossCaptureTaskSnapshot: itemBossCaptureTaskSnapshot,
    searchSource: effectiveSearchSource,
    searchSourceExplicit: effectiveSearchSourceExplicit,
    applicationFilterInputFilePath: effectiveApplicationFilterInputFilePath,
    searchConditionSetRefs: hasEffectiveSearchConditionSetRefs
      ? effectiveSearchConditionSetRefs
      : undefined,
  };
}

async function loadBatchJobInputs(input: BatchCliInput): Promise<BatchRunnableJobInput[]> {
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(input.jobsFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in --jobs-file ${input.jobsFilePath}: ${error.message}`);
    }

    throw error;
  }

  if (!Array.isArray(payload)) {
    throw new Error('--jobs-file must contain a JSON array');
  }

  return payload.map((item, index) => parseBatchJobItem(item, index, input));
}

function listSelectedCorePlatforms(platform: CliPlatformSelection): SupportedPlatform[] {
  return platform === 'all' ? listSupportedPlatforms() : [platform];
}

function listSelectedCapturePlatforms(platform: CliPlatformSelection, includeBoss: boolean): SupportedPlatform[] {
  return platform === 'all' ? listCapturePlatforms(includeBoss) : [platform];
}

function listSelectedSearchSubscriptionPlatforms(platform: CliPlatformSelection, includeBoss: boolean): SupportedPlatform[] {
  return platform === 'all' ? listSearchSubscriptionPlatforms(includeBoss) : [platform];
}

function assertBossCaptureArgumentsAllowed(input: {
  platform: CliPlatformSelection;
  includeBoss: boolean;
  bossJobId?: string;
  bossSearchKeyword?: string;
  bossSearchConditionSetRef?: SearchConditionSetReference;
  bossSavedSearchReference?: SavedSearchReference;
}): void {
  if (!input.bossJobId && !input.bossSearchKeyword && !input.bossSearchConditionSetRef && !input.bossSavedSearchReference) return;
  if (input.platform === 'boss' || (input.platform === 'all' && input.includeBoss)) return;
  throw new Error('--boss-job-id, --boss-search-keyword, --boss-search-condition-set, and --boss-saved-search-reference-json require --platform boss or --platform all --include-boss true');
}

function assertBossScreeningArgumentsAllowed(input: {
  platform: CliPlatformSelection;
  includeBoss: boolean;
  hasScreeningInput: boolean;
}): void {
  if (!input.hasScreeningInput) return;
  if (input.platform === 'boss' || (input.platform === 'all' && input.includeBoss)) return;
  throw new Error('--boss-screening-enabled, --boss-screening-policy-file, --boss-secondary-forward-mode, --boss-secondary-forward-recipient, --boss-secondary-forward-cc, --boss-secondary-email, and --boss-secondary-cc require --platform boss or --platform all --include-boss true');
}

function parseArgs(argv: readonly string[]): CliInput {
  const values = new Map<string, string>();
  const flagPresence = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    flagPresence.add(key);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  const searchKeyword = values.get('keyword');
  const platform = parsePlatformSelection(values.get('platform'));
  const jobsFilePath = values.get('jobs-file');
  const jobDescriptionText = values.get('jd');
  const jobDescriptionFilePath = values.get('jd-file');
  const recipientEmail = values.get('email');
  const ccEmails = flagPresence.has('cc') ? parseEmailList(values.get('cc')) : undefined;
  const searchSubscriptionFilePath = values.get('search-subscription-file');
  const saveSearchSubscription = flagPresence.has('save-search-subscription')
    ? parseOptionalBoolean(values.get('save-search-subscription'), '--save-search-subscription')
    : false;
  const searchSubscriptionName = values.get('search-subscription-name');
  const hasJdQuestion = flagPresence.has('jd-question') || flagPresence.has('rag-question');
  const jdQuestion = values.get('jd-question') ?? values.get('rag-question');
  const includeViewedCandidates = flagPresence.has('include-viewed')
    ? parseOptionalBoolean(values.get('include-viewed'), '--include-viewed')
    : false;
  const includeBoss = flagPresence.has('include-boss')
    ? parseOptionalBoolean(values.get('include-boss'), '--include-boss')
    : false;
  const liepinForwardContact = values.get('liepin-forward-contact')?.trim();
  const bossForwardMode = parseBossForwardMode(values.get('boss-forward-mode')?.trim());
  const bossForwardRecipient = values.get('boss-forward-recipient')?.trim();
  const bossForwardCc = flagPresence.has('boss-forward-cc')
    ? parseEmailList(values.get('boss-forward-cc'))
    : undefined;
  const bossScreeningEnabled = flagPresence.has('boss-screening-enabled')
    ? parseOptionalBoolean(values.get('boss-screening-enabled'), '--boss-screening-enabled')
    : undefined;
  const bossScreeningPolicyFile = values.get('boss-screening-policy-file')
    ? path.resolve(values.get('boss-screening-policy-file')!)
    : undefined;
  const bossSecondaryForwardMode = parseBossForwardMode(
    values.get('boss-secondary-forward-mode')?.trim(),
    '--boss-secondary-forward-mode',
  );
  const bossSecondaryForwardRecipient = values.get('boss-secondary-forward-recipient')?.trim();
  const bossSecondaryForwardCc = flagPresence.has('boss-secondary-forward-cc')
    ? parseEmailList(values.get('boss-secondary-forward-cc'))
    : undefined;
  const bossSecondaryEmail = values.get('boss-secondary-email')?.trim();
  const bossSecondaryCc = flagPresence.has('boss-secondary-cc')
    ? parseEmailList(values.get('boss-secondary-cc'))
    : undefined;
  const resultRoutingEnabled = flagPresence.has('result-routing-enabled')
    ? parseOptionalBoolean(values.get('result-routing-enabled'), '--result-routing-enabled')
    : undefined;
  const resultRoutingPolicyFile = values.get('result-routing-policy-file')
    ? path.resolve(values.get('result-routing-policy-file')!)
    : undefined;
  const secondaryEmail = values.get('secondary-email')?.trim();
  const secondaryCc = flagPresence.has('secondary-cc')
    ? parseEmailList(values.get('secondary-cc'))
    : undefined;
  const bossCaptureSettingsSnapshot = flagPresence.has('boss-capture-settings-json')
    ? (() => {
      try {
        return normalizeBossCaptureSettingsSnapshot(JSON.parse(values.get('boss-capture-settings-json')!));
      } catch (error) {
        throw new Error(`Invalid --boss-capture-settings-json: ${error instanceof Error ? error.message : String(error)}`);
      }
    })()
    : undefined;
  const bossCaptureTaskSnapshot = flagPresence.has('boss-capture-task-snapshot-json')
    ? (() => {
      try {
        return normalizeBossCaptureTaskSnapshot(JSON.parse(values.get('boss-capture-task-snapshot-json')!));
      } catch (error) {
        throw new Error(`Invalid --boss-capture-task-snapshot-json: ${error instanceof Error ? error.message : String(error)}`);
      }
    })()
    : undefined;
  const bossSavedSearchReference = flagPresence.has('boss-saved-search-reference-json')
    ? (() => {
      try {
        return normalizeBossSavedSearchReference(
          JSON.parse(values.get('boss-saved-search-reference-json')!),
          '--boss-saved-search-reference-json',
        );
      } catch (error) {
        throw new Error(`Invalid --boss-saved-search-reference-json: ${error instanceof Error ? error.message : String(error)}`);
      }
    })()
    : undefined;
  const hasBossScreeningInput = flagPresence.has('boss-screening-enabled')
    || flagPresence.has('boss-screening-policy-file')
    || flagPresence.has('boss-secondary-forward-mode')
    || flagPresence.has('boss-secondary-forward-recipient')
    || flagPresence.has('boss-secondary-email')
    || flagPresence.has('boss-secondary-cc')
    || flagPresence.has('boss-secondary-forward-cc')
    || flagPresence.has('boss-capture-settings-json')
    || flagPresence.has('boss-capture-task-snapshot-json');
  const hasResultRoutingInput = flagPresence.has('result-routing-enabled')
    || flagPresence.has('result-routing-policy-file')
    || flagPresence.has('secondary-email')
    || flagPresence.has('secondary-cc');
  const hasBossForwardingInput = flagPresence.has('boss-forward-mode')
    || flagPresence.has('boss-forward-recipient')
    || flagPresence.has('boss-forward-cc');
  const bossJobId = values.get('boss-job-id')?.trim();
  const bossSearchKeyword = values.get('boss-search-keyword')?.trim();
  const bossSearchConditionSetRef = parseBossSearchConditionSetReference(values.get('boss-search-condition-set'));
  const bossAutoChat = flagPresence.has('boss-auto-chat')
    ? parseOptionalBoolean(values.get('boss-auto-chat'), '--boss-auto-chat')
    : false;
  const bossChatScoreThreshold = parseBossChatScoreThreshold(values.get('boss-chat-score-threshold'));
  const bossChatRequireAll = flagPresence.has('boss-chat-require-all')
    ? parseOptionalBoolean(values.get('boss-chat-require-all'), '--boss-chat-require-all')
    : false;
  const bossChatReplyUnqualified = flagPresence.has('boss-chat-reply-unqualified')
    ? parseOptionalBoolean(values.get('boss-chat-reply-unqualified'), '--boss-chat-reply-unqualified')
    : false;
  const bossChatSummaryEmail = values.get('boss-chat-summary-email')?.trim();
  const bossChatSummaryCcEmails = flagPresence.has('boss-chat-summary-cc')
    ? parseEmailList(values.get('boss-chat-summary-cc'))
    : undefined;
  const bossSyncJobsBeforeReview = flagPresence.has('boss-sync-jobs-before-review')
    ? parseOptionalBoolean(values.get('boss-sync-jobs-before-review'), '--boss-sync-jobs-before-review')
    : false;
  const bossTalentSource = parseBossTalentSource(values.get('boss-talent-source'));
  const bossCoreRequirements = parseStringArrayJson(values.get('boss-core-requirements-json'), '--boss-core-requirements-json');
  const bossBonusRequirements = parseStringArrayJson(values.get('boss-bonus-requirements-json'), '--boss-bonus-requirements-json');
  const bossTriggerMatch = flagPresence.has('boss-trigger-match')
    ? parseOptionalBoolean(values.get('boss-trigger-match'), '--boss-trigger-match')
    : false;
  const bossGreetCandidateId = values.get('boss-greet-candidate-id')?.trim();
  const bossChatOperationValue = values.get('boss-chat-operation')?.trim();
  const bossJobSync = flagPresence.has('boss-job-sync')
    ? parseOptionalBoolean(values.get('boss-job-sync'), '--boss-job-sync')
    : false;
  const bossBindSavedSearch = flagPresence.has('boss-bind-saved-search')
    ? parseOptionalBoolean(values.get('boss-bind-saved-search'), '--boss-bind-saved-search')
    : false;
  const bossIncludeClosedJobs = flagPresence.has('boss-include-closed-jobs')
    ? parseOptionalBoolean(values.get('boss-include-closed-jobs'), '--boss-include-closed-jobs')
    : true;
  const searchSource = parseSearchSource(values.get('search-source'), '--search-source');
  const searchSourceExplicit = flagPresence.has('search-source');
  const applicationFilterInputFilePath = values.get('application-filter-input-file')
    ? path.resolve(values.get('application-filter-input-file')!)
    : undefined;
  const talentMappingFilePath = values.get('talent-mapping-file')
    ? path.resolve(values.get('talent-mapping-file')!)
    : undefined;
  const mappingStage = parseTalentMappingStage(values.get('mapping-stage'));
  const mappingConfirmedDetailOpen = flagPresence.has('mapping-confirm-detail-open')
    ? parseOptionalBoolean(values.get('mapping-confirm-detail-open'), '--mapping-confirm-detail-open')
    : false;
  const mappingRunId = values.get('mapping-run-id')?.trim();

  if (flagPresence.has('boss-auto-chat') && !bossAutoChat) {
    throw new Error('--boss-auto-chat must be true when provided');
  }

  if (flagPresence.has('boss-chat-summary-email') && !bossChatSummaryEmail) {
    throw new Error('--boss-chat-summary-email must be a non-empty email address');
  }

  if (flagPresence.has('boss-chat-summary-cc') && !bossChatSummaryEmail) {
    throw new Error('--boss-chat-summary-cc requires --boss-chat-summary-email');
  }

  if (flagPresence.has('liepin-forward-contact')) {
    if (!liepinForwardContact) {
      throw new Error('--liepin-forward-contact must be a non-empty string');
    }

    if (platform !== 'liepin' && platform !== 'all') {
      throw new Error('--liepin-forward-contact can only be used with --platform liepin or --platform all');
    }
  }

  if (flagPresence.has('boss-forward-mode') !== flagPresence.has('boss-forward-recipient')) {
    throw new Error('--boss-forward-mode and --boss-forward-recipient must be provided together');
  }

  if (flagPresence.has('boss-forward-recipient') && !bossForwardRecipient) {
    throw new Error('--boss-forward-recipient must be a non-empty string');
  }
  if (flagPresence.has('boss-forward-cc') && bossForwardCc?.length && bossForwardMode === 'colleague') {
    throw new Error('--boss-forward-cc requires --boss-forward-mode email');
  }

  if (flagPresence.has('boss-screening-policy-file') && !bossScreeningPolicyFile) {
    throw new Error('--boss-screening-policy-file must be a non-empty path');
  }

  if (flagPresence.has('boss-secondary-forward-mode') !== flagPresence.has('boss-secondary-forward-recipient')) {
    throw new Error('--boss-secondary-forward-mode and --boss-secondary-forward-recipient must be provided together');
  }

  if (flagPresence.has('boss-secondary-forward-recipient') && !bossSecondaryForwardRecipient) {
    throw new Error('--boss-secondary-forward-recipient must be a non-empty string');
  }

  if (flagPresence.has('boss-secondary-email') && !bossSecondaryEmail) {
    throw new Error('--boss-secondary-email must be a non-empty email address');
  }

  if (flagPresence.has('boss-secondary-forward-cc') && bossSecondaryForwardCc?.length && bossSecondaryForwardMode === 'colleague') {
    throw new Error('--boss-secondary-forward-cc requires --boss-secondary-forward-mode email');
  }

  if (flagPresence.has('boss-job-id') && !bossJobId) {
    throw new Error('--boss-job-id must be a non-empty string');
  }

  if (flagPresence.has('boss-search-keyword') && !bossSearchKeyword) {
    throw new Error('--boss-search-keyword must be a non-empty string');
  }

  if (flagPresence.has('include-boss') && platform !== 'all') {
    throw new Error('--include-boss can only be used with --platform all');
  }

  if (hasBossForwardingInput && platform !== 'boss' && !(platform === 'all' && includeBoss)) {
    throw new Error('--boss-forward-mode and --boss-forward-recipient can only be used with --platform boss or --platform all --include-boss true; --boss-forward-cc follows the same boundary');
  }
  assertBossScreeningArgumentsAllowed({ platform, includeBoss, hasScreeningInput: hasBossScreeningInput });

  if (flagPresence.has('result-routing-policy-file') && !resultRoutingPolicyFile) {
    throw new Error('--result-routing-policy-file must be a non-empty path');
  }
  if (flagPresence.has('secondary-email') && !secondaryEmail) {
    throw new Error('--secondary-email must be a non-empty email address');
  }
  if (hasResultRoutingInput && platform === 'boss') {
    throw new Error('Generic result-routing flags cannot be used with platform=boss; use Boss screening flags so native forwarding remains explicit.');
  }

  if (talentMappingFilePath) {
    const allowedFlags = new Set([
      'platform',
      'talent-mapping-file',
      'mapping-stage',
      'mapping-confirm-detail-open',
      'mapping-run-id',
    ]);
    const incompatibleFlags = [...flagPresence].filter((flag) => !allowedFlags.has(flag));
    if (incompatibleFlags.length > 0) {
      throw new Error(
        `--talent-mapping-file cannot be combined with ${incompatibleFlags.map((flag) => `--${flag}`).join(', ')}`,
      );
    }
    if (platform !== 'all' && !isTalentMappingCorePlatform(platform)) {
      throw new Error('--talent-mapping-file supports 51job, liepin, zhilian, or all; Boss is outside the Talent Mapping product boundary');
    }
    if (!mappingStage) {
      throw new Error('--talent-mapping-file requires explicit --mapping-stage scan, enrich, or all');
    }
    if (mappingStage === 'scan' && flagPresence.has('mapping-confirm-detail-open')) {
      throw new Error('--mapping-confirm-detail-open is valid only with --mapping-stage enrich or all');
    }
    if (mappingRunId && mappingStage !== 'enrich') {
      throw new Error('--mapping-run-id is valid only with --mapping-stage enrich');
    }
    if (flagPresence.has('mapping-run-id') && !mappingRunId) {
      throw new Error('--mapping-run-id must be a non-empty run ID');
    }

    return {
      mode: 'talent-mapping',
      platform,
      filePath: talentMappingFilePath,
      stage: mappingStage,
      confirmedDetailOpen: mappingConfirmedDetailOpen,
      sourceScanRunId: mappingRunId,
    };
  }

  const mappingOnlyFlags = [
    'mapping-stage',
    'mapping-confirm-detail-open',
    'mapping-run-id',
  ].filter((flag) => flagPresence.has(flag));
  if (mappingOnlyFlags.length > 0) {
    throw new Error(`${mappingOnlyFlags.map((flag) => `--${flag}`).join(', ')} require --talent-mapping-file`);
  }

  const assertBossStandalone = (modeName: string, allowedFlags: readonly string[]) => {
    if (platform !== 'boss') throw new Error(`${modeName} can only be used with --platform boss`);
    const allowed = new Set(['platform', ...allowedFlags]);
    const incompatible = [...flagPresence].filter((flag) => !allowed.has(flag));
    if (incompatible.length > 0) {
      throw new Error(`${modeName} cannot be combined with ${incompatible.map((flag) => `--${flag}`).join(', ')}`);
    }
  };

  if (bossBindSavedSearch) {
    assertBossStandalone('--boss-bind-saved-search', [
      'boss-bind-saved-search',
      'keyword',
      'boss-job-id',
      'boss-saved-search-reference-json',
      'boss-confirmed',
    ]);
    if (!searchKeyword) {
      throw new Error('--boss-bind-saved-search requires --keyword with the persisted Boss job name');
    }
    if (!bossSavedSearchReference) {
      throw new Error('--boss-bind-saved-search requires --boss-saved-search-reference-json');
    }
    if (!flagPresence.has('boss-confirmed')
      || parseOptionalBoolean(values.get('boss-confirmed'), '--boss-confirmed') !== true) {
      throw new Error('--boss-bind-saved-search requires --boss-confirmed true');
    }
    return {
      mode: 'boss-saved-search-binding',
      platform: 'boss',
      searchKeyword,
      ...(bossJobId ? { bossJobId } : {}),
      savedSearch: bossSavedSearchReference,
    };
  }

  if (bossTalentSource) {
    assertBossStandalone('--boss-talent-source', [
      'boss-talent-source',
      'boss-job-id',
      'boss-expected-job-name',
      'boss-core-requirements-json',
      'boss-bonus-requirements-json',
      'boss-trigger-match',
      'boss-confirmed',
    ]);
    if (bossTalentSource === 'recommend' && (bossCoreRequirements || bossBonusRequirements || bossTriggerMatch)) {
      throw new Error('Boss recommendation mode does not accept deep-search requirements or --boss-trigger-match');
    }
    return {
      mode: 'boss-talent-search',
      platform: 'boss',
      source: bossTalentSource,
      bossJobId: values.get('boss-job-id')?.trim(),
      expectedJobName: values.get('boss-expected-job-name')?.trim(),
      coreRequirements: bossCoreRequirements,
      bonusRequirements: bossBonusRequirements,
      triggerMatch: bossTriggerMatch,
      confirmed: flagPresence.has('boss-confirmed')
        ? parseOptionalBoolean(values.get('boss-confirmed'), '--boss-confirmed')
        : false,
    };
  }

  if (flagPresence.has('boss-greet-candidate-id') || flagPresence.has('boss-greet-source')) {
    assertBossStandalone('--boss-greet-candidate-id', [
      'boss-greet-candidate-id',
      'boss-greet-source',
      'boss-expected-candidate-name',
      'boss-expected-job-name',
      'boss-job-id',
      'boss-confirmed',
      'boss-intent-id',
    ]);
    if (!bossGreetCandidateId) throw new Error('--boss-greet-candidate-id must be non-empty');
    const expectedCandidateName = values.get('boss-expected-candidate-name')?.trim();
    const expectedJobName = values.get('boss-expected-job-name')?.trim();
    if (!expectedCandidateName || !expectedJobName) {
      throw new Error('Boss greet requires --boss-expected-candidate-name and --boss-expected-job-name');
    }
    return {
      mode: 'boss-greet',
      platform: 'boss',
      source: parseBossGreetSource(values.get('boss-greet-source')),
      candidateId: bossGreetCandidateId,
      expectedCandidateName,
      expectedJobName,
      bossJobId: values.get('boss-job-id')?.trim(),
      confirmed: flagPresence.has('boss-confirmed')
        ? parseOptionalBoolean(values.get('boss-confirmed'), '--boss-confirmed')
        : false,
      intentId: values.get('boss-intent-id')?.trim(),
    };
  }

  if (flagPresence.has('boss-chat-operation')) {
    assertBossStandalone('--boss-chat-operation', [
      'boss-chat-operation',
      'boss-conversation-id',
      'boss-expected-candidate-name',
      'boss-expected-job-name',
      'boss-chat-text',
      'boss-chat-remark',
      'boss-intent-id',
      'boss-unread-only',
      'boss-confirmed',
    ]);
    if (!bossChatOperationValue) throw new Error('--boss-chat-operation must be non-empty');
    const allowedOperations = new Set<BossChatOperationInput['action']>([
      'list-conversations', 'open-conversation', 'read-conversation', 'read-history', 'preview-resume',
      'send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume',
      'exchange-phone', 'exchange-wechat',
    ]);
    if (!allowedOperations.has(bossChatOperationValue as BossChatOperationInput['action'])) {
      throw new Error(`Unsupported --boss-chat-operation: ${bossChatOperationValue}`);
    }
    return {
      mode: 'boss-chat-operation',
      platform: 'boss',
      action: bossChatOperationValue as BossChatOperationInput['action'],
      conversationId: values.get('boss-conversation-id')?.trim(),
      expectedCandidateName: values.get('boss-expected-candidate-name')?.trim(),
      expectedJobName: values.get('boss-expected-job-name')?.trim(),
      text: values.get('boss-chat-text')?.trim(),
      remark: values.get('boss-chat-remark')?.trim(),
      intentId: values.get('boss-intent-id')?.trim(),
      unreadOnly: flagPresence.has('boss-unread-only')
        ? parseOptionalBoolean(values.get('boss-unread-only'), '--boss-unread-only')
        : false,
      confirmed: flagPresence.has('boss-confirmed')
        ? parseOptionalBoolean(values.get('boss-confirmed'), '--boss-confirmed')
        : false,
    };
  }

  if (flagPresence.has('boss-job-sync') || flagPresence.has('boss-job-ids') || flagPresence.has('boss-include-closed-jobs')) {
    assertBossStandalone('--boss-job-sync', ['boss-job-sync', 'boss-job-ids', 'boss-include-closed-jobs']);
    if (!bossJobSync) throw new Error('--boss-job-sync must be true when provided');
    return {
      mode: 'boss-job-sync',
      platform: 'boss',
      bossJobIds: values.get('boss-job-ids')?.split(',').map((value) => value.trim()).filter(Boolean),
      includeClosed: bossIncludeClosedJobs,
    };
  }

  if (bossAutoChat) {
    if (platform !== 'boss') {
      throw new Error('--boss-auto-chat can only be used with --platform boss');
    }

    const incompatibleFlags = [
      'keyword',
      'jobs-file',
      'jd',
      'jd-file',
      'email',
      'cc',
      'include-viewed',
      'include-boss',
      'liepin-forward-contact',
      'search-source',
      'application-filter-input-file',
      'search-condition-set',
      'search-subscription-file',
      'save-search-subscription',
      'search-subscription-name',
      'jd-question',
      'rag-question',
      'boss-talent-source',
      'boss-greet-candidate-id',
      'boss-chat-operation',
      'boss-job-sync',
      'boss-job-id',
      'boss-search-keyword',
      'boss-search-condition-set',
      'boss-saved-search-reference-json',
      'boss-screening-enabled',
      'boss-screening-policy-file',
      'boss-secondary-forward-mode',
      'boss-secondary-forward-recipient',
      'boss-secondary-forward-cc',
      'boss-secondary-email',
      'boss-secondary-cc',
    ].filter((flag) => flagPresence.has(flag));
    if (incompatibleFlags.length > 0) {
      throw new Error(`--boss-auto-chat cannot be combined with ${incompatibleFlags.map((flag) => `--${flag}`).join(', ')}`);
    }

    return {
      mode: 'boss-auto-chat',
      platform: 'boss',
      scoreThreshold: bossChatScoreThreshold,
      requireAllHardRequirements: bossChatRequireAll,
      replyToUnqualifiedCandidates: bossChatReplyUnqualified,
      bossForwardMode,
      bossForwardRecipient,
      bossForwardCc,
      summaryEmail: bossChatSummaryEmail,
      summaryCcEmails: bossChatSummaryCcEmails,
      syncJobsBeforeReview: bossSyncJobsBeforeReview,
    };
  }

  const bossChatOnlyFlags = [
    'boss-chat-score-threshold',
    'boss-chat-require-all',
    'boss-chat-reply-unqualified',
    'boss-chat-summary-email',
    'boss-chat-summary-cc',
    'boss-sync-jobs-before-review',
  ].filter((flag) => flagPresence.has(flag));
  if (bossChatOnlyFlags.length > 0) {
    throw new Error(`${bossChatOnlyFlags.map((flag) => `--${flag}`).join(', ')} require --boss-auto-chat true`);
  }

  if (hasJdQuestion) {
    if (flagPresence.has('jd-question') && flagPresence.has('rag-question')) {
      throw new Error('--jd-question and --rag-question are aliases; provide only one');
    }

    if (!jdQuestion?.trim()) {
      throw new Error('--jd-question must be a non-empty string');
    }

    if (jobsFilePath || searchSubscriptionFilePath || flagPresence.has('email') || flagPresence.has('cc') || flagPresence.has('include-viewed') || flagPresence.has('include-boss') || flagPresence.has('liepin-forward-contact') || hasBossForwardingInput || hasBossScreeningInput || flagPresence.has('boss-job-id') || flagPresence.has('boss-search-keyword') || flagPresence.has('boss-search-condition-set') || flagPresence.has('boss-saved-search-reference-json') || flagPresence.has('search-source') || flagPresence.has('application-filter-input-file') || flagPresence.has('search-condition-set') || saveSearchSubscription || searchSubscriptionName) {
      throw new Error('--jd-question cannot be combined with --jobs-file, --search-subscription-file, --email, --cc, --include-viewed, --include-boss, --liepin-forward-contact, --boss-forward-mode, --boss-forward-recipient, --boss-forward-cc, --boss-job-id, --boss-search-keyword, --boss-search-condition-set, --boss-saved-search-reference-json, --search-source, --application-filter-input-file, --search-condition-set, --save-search-subscription, or --search-subscription-name');
    }

    if (jobDescriptionText && jobDescriptionFilePath) {
      throw new Error('Arguments --jd and --jd-file are mutually exclusive');
    }

    if (!searchKeyword && !jobDescriptionText && !jobDescriptionFilePath) {
      throw new Error('--jd-question requires --keyword for a stored JD or new JD input through --jd/--jd-file');
    }

    return {
      mode: 'jd-question',
      platform,
      keyword: searchKeyword,
      jobDescriptionText,
      jobDescriptionFilePath,
      question: jdQuestion.trim(),
    };
  }

  if (searchSubscriptionFilePath) {
    if (jobsFilePath || flagPresence.has('jd') || flagPresence.has('jd-file') || flagPresence.has('email') || flagPresence.has('cc') || flagPresence.has('include-viewed') || flagPresence.has('liepin-forward-contact') || hasBossForwardingInput || hasBossScreeningInput || flagPresence.has('boss-job-id') || flagPresence.has('boss-search-keyword') || flagPresence.has('boss-search-condition-set') || flagPresence.has('boss-saved-search-reference-json') || flagPresence.has('search-source') || flagPresence.has('application-filter-input-file')) {
      throw new Error('--search-subscription-file cannot be combined with --jobs-file, --jd, --jd-file, --email, --cc, --include-viewed, --liepin-forward-contact, --boss-forward-mode, --boss-forward-recipient, --boss-forward-cc, --boss-job-id, --boss-search-keyword, --boss-search-condition-set, --boss-saved-search-reference-json, --search-source, or --application-filter-input-file');
    }

    const searchConditionSetRefs = parseSearchConditionSetReferences(values.get('search-condition-set'), {
      platform,
      includeBoss,
      argumentName: '--search-condition-set',
      purpose: 'search-subscription',
    });

    return {
      mode: 'search-subscription',
      platform,
      includeBoss,
      keyword: searchKeyword,
      filePath: searchSubscriptionFilePath,
      save: saveSearchSubscription,
      savedSearchName: searchSubscriptionName,
      searchConditionSetRefs,
    };
  }

  if (saveSearchSubscription || searchSubscriptionName) {
    throw new Error('--save-search-subscription and --search-subscription-name require --search-subscription-file');
  }

  if (jobsFilePath) {
    if (bossCaptureSettingsSnapshot || bossCaptureTaskSnapshot) {
      throw new Error('--boss-capture-settings-json and --boss-capture-task-snapshot-json are reserved for a single queued Boss stage; batch snapshots belong inside the jobs snapshot');
    }
    if (flagPresence.has('keyword') || flagPresence.has('jd') || flagPresence.has('jd-file')) {
      throw new Error('--jobs-file cannot be combined with --keyword, --jd, or --jd-file');
    }
    if (flagPresence.has('boss-job-id') || flagPresence.has('boss-search-keyword') || flagPresence.has('boss-search-condition-set') || flagPresence.has('boss-saved-search-reference-json')) {
      throw new Error('--boss-job-id, --boss-search-keyword, --boss-search-condition-set, and --boss-saved-search-reference-json must be specified per jobs-file item');
    }

    const searchConditionSetRefs = parseSearchConditionSetReferences(values.get('search-condition-set'), {
      platform,
      includeBoss,
      argumentName: '--search-condition-set',
    });
    if (applicationFilterInputFilePath && searchConditionSetRefs) {
      throw new Error('--application-filter-input-file and --search-condition-set are mutually exclusive');
    }
    if (applicationFilterInputFilePath && searchSource !== 'direct') {
      throw new Error('--application-filter-input-file requires --search-source direct');
    }
    if (searchConditionSetRefs && searchSource !== 'direct') {
      throw new Error('--search-condition-set requires --search-source direct');
    }

    return {
      mode: 'batch',
      platform,
      jobsFilePath,
      recipientEmail,
      ccEmails,
      includeViewedCandidates,
      includeBoss,
      liepinForwardContact,
      bossForwardMode,
      bossForwardRecipient,
      bossForwardCc,
      bossScreeningEnabled,
      bossScreeningPolicyFile,
      bossSecondaryForwardMode,
      bossSecondaryForwardRecipient,
      bossSecondaryForwardCc,
      bossSecondaryEmail,
      bossSecondaryCc,
      resultRoutingEnabled,
      resultRoutingPolicyFile,
      secondaryEmail,
      secondaryCc,
      searchSource,
      searchSourceExplicit,
      applicationFilterInputFilePath,
      searchConditionSetRefs,
    };
  }

  if (!searchKeyword) {
    throw new Error('Missing required argument --keyword');
  }

  if (jobDescriptionText && jobDescriptionFilePath) {
    throw new Error('Arguments --jd and --jd-file are mutually exclusive');
  }

  const searchConditionSetRefs = parseSearchConditionSetReferences(values.get('search-condition-set'), {
    platform,
    includeBoss,
    argumentName: '--search-condition-set',
  });
  if (applicationFilterInputFilePath && searchConditionSetRefs) {
    throw new Error('--application-filter-input-file and --search-condition-set are mutually exclusive');
  }
  if (applicationFilterInputFilePath && bossSearchConditionSetRef) {
    throw new Error('--application-filter-input-file and --boss-search-condition-set are mutually exclusive');
  }
  if (applicationFilterInputFilePath && searchSource !== 'direct') {
    throw new Error('--application-filter-input-file requires --search-source direct');
  }
  if (searchConditionSetRefs && searchSource !== 'direct') {
    throw new Error('--search-condition-set requires --search-source direct');
  }
  if (bossSearchConditionSetRef && searchConditionSetRefs?.boss) {
    throw new Error('--boss-search-condition-set cannot be combined with a Boss entry in --search-condition-set');
  }
  assertBossCaptureArgumentsAllowed({
    platform,
    includeBoss,
    bossJobId,
    bossSearchKeyword,
    bossSearchConditionSetRef,
    bossSavedSearchReference,
  });

  return {
    mode: 'single',
    platform,
    searchKeyword,
    bossJobId,
    bossSearchKeyword,
    bossSavedSearchReference,
    bossSearchConditionSetRef,
    recipientEmail,
    ccEmails,
    jobDescriptionText,
    jobDescriptionFilePath,
    includeViewedCandidates,
    includeBoss,
    liepinForwardContact,
    bossForwardMode,
    bossForwardRecipient,
    bossForwardCc,
    bossScreeningEnabled,
    bossScreeningPolicyFile,
    bossSecondaryForwardMode,
    bossSecondaryForwardRecipient,
    bossSecondaryForwardCc,
    bossSecondaryEmail,
    bossSecondaryCc,
    resultRoutingEnabled,
    resultRoutingPolicyFile,
    secondaryEmail,
    secondaryCc,
    bossCaptureSettingsSnapshot,
    bossCaptureTaskSnapshot,
    searchSource,
    searchSourceExplicit,
    applicationFilterInputFilePath,
    searchConditionSetRefs,
  };
}

function buildSinglePlatformInput(input: RunnableJobInput, platform: SupportedPlatform): SinglePlatformCliInput {
  return {
    platform,
    searchKeyword: input.searchKeyword,
    ...(platform === 'boss' && input.bossJobId ? { bossJobId: input.bossJobId } : {}),
    ...(platform === 'boss' && input.bossSearchKeyword ? { bossSearchKeyword: input.bossSearchKeyword } : {}),
    ...(platform === 'boss' && input.bossSavedSearchReference ? { bossSavedSearchReference: input.bossSavedSearchReference } : {}),
    ...(platform === 'boss' && input.bossSearchConditionSetRef
      ? { bossSearchConditionSetRef: input.bossSearchConditionSetRef }
      : {}),
    recipientEmail: input.recipientEmail,
    ccEmails: input.ccEmails,
    jobDescriptionText: input.jobDescriptionText,
    jobDescriptionFilePath: input.jobDescriptionFilePath,
    includeViewedCandidates: input.includeViewedCandidates,
    liepinForwardContact: input.liepinForwardContact,
    ...(platform === 'boss' ? {
      bossForwardMode: input.bossForwardMode,
      bossForwardRecipient: input.bossForwardRecipient,
      bossForwardCc: input.bossForwardCc,
      bossScreeningEnabled: input.bossScreeningEnabled,
      bossScreeningPolicyFile: input.bossScreeningPolicyFile,
      bossSecondaryForwardMode: input.bossSecondaryForwardMode,
      bossSecondaryForwardRecipient: input.bossSecondaryForwardRecipient,
      bossSecondaryForwardCc: input.bossSecondaryForwardCc,
      bossSecondaryEmail: input.bossSecondaryEmail,
      bossSecondaryCc: input.bossSecondaryCc,
      bossCaptureSettingsSnapshot: input.bossCaptureSettingsSnapshot,
      bossCaptureTaskSnapshot: input.bossCaptureTaskSnapshot,
    } : {}),
    ...(platform === 'boss' ? {} : {
      resultRoutingEnabled: input.resultRoutingEnabled,
      resultRoutingPolicyFile: input.resultRoutingPolicyFile,
      secondaryEmail: input.secondaryEmail,
      secondaryCc: input.secondaryCc,
    }),
    searchSource: input.searchSource,
    searchSourceExplicit: input.searchSourceExplicit,
    applicationFilterInputFilePath: input.applicationFilterInputFilePath,
    searchConditionSetRef: platform === 'boss'
      ? input.bossSearchConditionSetRef ?? input.searchConditionSetRefs?.[platform]
      : input.searchConditionSetRefs?.[platform],
  };
}

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
      return immutable;
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
      // candidate ID is written to that delivery's message field as well.
      await forwardBossResumeRef.fn(
        detailPage as never,
        candidate,
        current.forwarding.mode,
        delivery.recipient,
        'confirm',
        undefined,
        false,
        detailOptions,
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

/**
 * The enabled Boss path holds the already-verified detail open through scoring
 * and routes only after its immutable decision plus pending outbox are durable.
 * Model/schema failures deliberately become review → primary, never rejected.
 */
async function scoreAndRouteBossCapturedCandidate(input: {
  jobKey: string;
  job: NormalizedJob;
  candidate: CandidateListItem;
  resume: CandidateResume;
  detailPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>;
  store: JobStore;
  fetchedAt: string;
  screening: BossScreeningSettings;
  primaryForwarding: BossForwardingSettings;
  detailOptions?: CandidateProfileDetailOptions;
}): Promise<BossScreeningCandidateResult> {
  const { jobKey, job, candidate, resume, detailPage, store, fetchedAt, screening, primaryForwarding, detailOptions } = input;
  const scoredAt = new Date().toISOString();
  const scoreArtifactBase = {
    candidateId: resume.candidateId,
    candidateShareUrl: resume.candidateShareUrl,
    model: config.scoring.model,
    scoredAt,
  };
  let scoreArtifact: CandidateScoreArtifact;
  let requirementEvaluations: BossCandidateRoutingArtifact['requirementEvaluations'] = [];

  try {
    const result = await scoreAndEvaluateBossScreeningRef.fn({
      job,
      resume,
      policy: screening,
    });
    requirementEvaluations = result.evaluations;
    scoreArtifact = {
      ...scoreArtifactBase,
      ...(result.resumeInputHash ? { resumeInputHash: result.resumeInputHash } : {}),
      status: 'success',
      score: result.score,
    };
  } catch (error) {
    scoreArtifact = {
      ...scoreArtifactBase,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await store.saveCandidateScoreArtifact('boss', jobKey, scoreArtifact);
  const policyHash = hashBossScreeningPolicy(screening);
  const decision = resolveBossRoutingDecision(scoreArtifact, requirementEvaluations, screening);
  const forwarding = decision.audience === 'primary'
    ? primaryForwarding
    : screening.secondaryForwarding;
  if (!forwarding) {
    // This should already be caught by preflight. Keeping the guard local
    // prevents a missing target from falling through to a primary recipient.
    throw new Error(`Boss routing decision for ${candidate.candidateId} has no ${decision.audience} forwarding target`);
  }

  const now = createMonotonicBossRoutingTimestamp();
  const routingFacts: NonNullable<BossForwardingOutboxEntry['routingFacts']> = {
    candidateId: candidate.candidateId,
    fetchedAt,
    scoredAt,
    decidedAt: now,
    policyHash,
    scoreStatus: scoreArtifact.status,
    ...(scoreArtifact.status === 'failed' ? { scoreError: scoreArtifact.error } : {}),
    classification: decision.classification,
    audience: decision.audience,
    requirementEvaluations,
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
  const pendingOutbox = createBossForwardingOutboxEntry(
    candidate.candidateId,
    policyHash,
    decision,
    forwarding,
    now,
    { routingDecisionId, routingFacts },
  );
  const routingArtifact: BossCandidateRoutingArtifact = {
    ...routingFacts,
    routingDecisionId,
    forwarding: pendingOutbox.forwarding,
  };
  // The outbox is the recovery anchor. Persist it before the immutable
  // artifact so an interruption cannot leave a routing decision with no
  // durable target set; recovery can rebuild the artifact from routingFacts.
  await store.saveBossForwardingOutboxEntry('boss', jobKey, pendingOutbox);
  await store.saveBossCandidateRoutingArtifact('boss', jobKey, routingArtifact);
  const completedOutbox = await executeBossForwardingDeliveries({
    jobKey,
    candidate,
    entry: pendingOutbox,
    detailPage,
    store,
    detailOptions,
  });

  return {
    candidateId: candidate.candidateId,
    scoreArtifact,
    routingArtifact,
    forwardingOutbox: completedOutbox,
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
    ? createBossDetailLifecycleOptions()
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
    entry = await executeBossForwardingDeliveries({
      jobKey,
      candidate,
      entry,
      detailPage,
      store,
      detailOptions,
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
  keepDetailOpenForScreening = false,
): Promise<CandidateProcessResult> {
  let detailPage = session.page;
  let detailOpened = false;
  let detailVerified = false;
  const detailOptions = platform === 'boss'
    ? createBossDetailLifecycleOptions({ keepOpenForScreening: keepDetailOpenForScreening })
    : undefined;
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
    if (detailOptions) {
      await waitBossActionPaceWithinDeadline(detailPage, detailOptions.deadline, detailOptions.cleanupReserveMs);
    } else {
      await waitPlatformActionPaceRef.fn(detailPage, platform);
    }
    failureStage = 'identity-verify';
    const postOpenResult = postOpenActions === null
      ? undefined
      : await platformAdapter.afterResumeDetailOpened?.(detailPage, candidate, postOpenActions, detailOptions);
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
      }
      if (platformAdapter.closeResumeDetail) {
        try {
          await platformAdapter.closeResumeDetail(searchPage, detailPage, candidate, detailOptions);
          detailLifecycle.detailClosed = true;
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
      } else {
        try {
          await detailPage.close();
          detailLifecycle.detailClosed = true;
        } catch {
          // Keep the detail page available for inspection.
        }
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
  const failedCandidates: Array<{ candidateId: string; error: string }> = [];
  const routingArtifacts: CandidateRoutingArtifact[] = [];

  for (const candidateId of candidateIds) {
    const resume = resumesById.get(candidateId);

    if (!resume) {
      failedCandidates.push({
        candidateId,
        error: `Stored resume not found for captured candidate ${candidateId}`,
      });
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
      const failedScoreArtifact: CandidateScoreArtifact = {
        ...scoreArtifactBase,
        status: 'failed',
        error: message,
      };
      await store.saveCandidateScoreArtifact(platform, jobKey, failedScoreArtifact);
      if (routingEnabled) {
        const policy = options.postScoreRouting!;
        const policyHash = hashPostScoreRoutingPolicy(policy);
        const scoredAt = failedScoreArtifact.scoredAt;
        const decidedAt = new Date().toISOString();
        const decision = resolvePostScoreRoutingDecision(failedScoreArtifact, [], policy);
        const routingDecisionId = createHash('sha256').update(JSON.stringify({
          platform,
          jobKey,
          candidateId: resume.candidateId,
          policyHash,
          scoredAt,
          classification: decision.classification,
          audience: decision.audience,
          reason: decision.reason,
        })).digest('hex');
        const artifact: CandidateRoutingArtifact = {
          routingDecisionId,
          candidateId: resume.candidateId,
          fetchedAt: options.fetchedAt ?? scoredAt,
          scoredAt,
          decidedAt,
          policyHash,
          scoreStatus: 'failed',
          scoreError: message,
          classification: decision.classification,
          audience: decision.audience,
          requirementEvaluations: [],
          matchedRequirementIds: decision.matchedRequirementIds,
          unknownRequirementIds: decision.unknownRequirementIds,
          reason: decision.reason,
        };
        await store.saveCandidateRoutingArtifact(platform, jobKey, artifact);
        await store.deletePostScoreRoutingWorkItem(platform, jobKey, resume.candidateId);
        routingArtifacts.push(artifact);
      }
      failedCandidates.push({ candidateId: resume.candidateId, error: message });
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

function supportsPropertyElectricianHardRequirements(jobKey: string, job: NormalizedJob): boolean {
  if (jobKey !== buildJobKey('物业电工', '')) {
    return false;
  }

  const requirements = job.hardRequirements.join(' ');
  return /47岁|年龄/.test(requirements)
    && /高压/.test(requirements)
    && /低压/.test(requirements)
    && /物业/.test(requirements)
    && /2年|两年|24个月/.test(requirements)
    && /上海人|沪籍|上海户籍/.test(requirements);
}

function resolveBossAutomationSettings(
  stored: BossAutomationSettings,
  input: BossAutoChatCliInput,
): BossAutomationSettings {
  const forwarding = input.bossForwardMode && input.bossForwardRecipient
    ? {
      mode: input.bossForwardMode,
      recipient: input.bossForwardRecipient,
      ...(input.bossForwardCc === undefined
        ? (stored.forwarding?.ccEmails === undefined ? {} : { ccEmails: stored.forwarding.ccEmails })
        : { ccEmails: input.bossForwardCc }),
    }
    : input.bossForwardCc === undefined
      ? stored.forwarding
      : stored.forwarding
        ? { ...stored.forwarding, ccEmails: input.bossForwardCc }
        : undefined;
  if (forwarding?.ccEmails?.length && forwarding.mode !== 'email') {
    throw new Error('Boss forward CC can only be used with email forwarding.');
  }
  const summaryDelivery = input.summaryEmail
    ? {
      recipientEmail: input.summaryEmail,
      ccEmails: input.summaryCcEmails,
    }
    : stored.summaryDelivery;

  return {
    forwarding,
    summaryDelivery,
  };
}

async function runBossTalentSearchMode(input: BossTalentSearchCliInput): Promise<BossTalentSearchResult> {
  const session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
  try {
    const result = await runBossTalentSearchRef.fn(session.page, input);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

async function runBossGreetMode(input: BossGreetCliInput): Promise<BossGreetResult> {
  const session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
  try {
    const result = await greetBossTalentCandidateRef.fn(session.page, input);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

async function runBossChatOperationMode(input: BossChatOperationCliInput): Promise<BossChatOperationResult> {
  const session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
  try {
    const result = await executeBossChatOperationRef.fn(session.page, input);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

async function runBossJobSyncMode(input: BossJobSyncCliInput): Promise<BossJobSyncRun> {
  const session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
  try {
    const result = await syncBossPositionsRef.fn(session.page, input);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

async function resolveBossConversationJob(
  store: JobStore,
  conversation: { bossJobId?: string; jobName: string },
): Promise<{ jobKey: string; jobRecord: JobRecord }> {
  const jobRecord = await store.resolveBossConversationJobRecord(conversation);
  return { jobKey: jobRecord.jobKey, jobRecord };
}

async function runBossAutoChat(input: BossAutoChatCliInput): Promise<BossAutoChatRunSummary> {
  const store = new JobStore();
  const reviewedAt = new Date().toISOString();
  const storedAutomationSettings = await store.readBossAutomationSettings();
  const automationSettings = resolveBossAutomationSettings(storedAutomationSettings, input);
  if ((input.bossForwardMode && input.bossForwardRecipient) || input.bossForwardCc !== undefined || input.summaryEmail) {
    await store.saveBossAutomationSettings(automationSettings);
  }
  const session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
  const items: BossChatReviewItem[] = [];

  try {
    if (input.syncJobsBeforeReview) {
      const syncRun = await syncBossPositionsRef.fn(session.page, { platform: 'boss', includeClosed: true });
      if (syncRun.failed > 0) {
        throw new Error(`Boss job sync failed for ${syncRun.failed} position(s); aborting auto-chat before conversation review.`);
      }
    }
    const chatPage = await openBossChatPageRef.fn(session.page);
    session.page = chatPage;
    const retryItems = await store.readBossChatRetryItems();
    const conversations = await collectBossUnreadConversationsRef.fn(chatPage, retryItems.map((item) => ({
      conversationId: item.conversationId,
      candidateName: item.candidateName,
      jobName: item.jobName,
      bossJobId: item.bossJobId,
      unreadCount: item.unreadCount,
    })));
    const reviewedConversationIdSet = new Set(await store.readBossChatReviewedConversationIds());

    for (const conversation of conversations) {
      const fallbackJobKey = buildJobKey(conversation.jobName, '');
      const isUnreadEvent = conversation.hasUnreadBadge !== false;
      if (!isUnreadEvent && reviewedConversationIdSet.has(conversation.conversationId)) {
        items.push({
          conversationId: conversation.conversationId,
          candidateName: conversation.candidateName,
          jobName: conversation.jobName,
          bossJobId: conversation.bossJobId,
          jobKey: fallbackJobKey,
          unreadCount: conversation.unreadCount,
          status: 'skipped_previously_reviewed',
        });
        continue;
      }

      let item: BossChatReviewItem = {
        conversationId: conversation.conversationId,
        candidateName: conversation.candidateName,
        jobName: conversation.jobName,
        bossJobId: conversation.bossJobId,
        jobKey: fallbackJobKey,
        unreadCount: conversation.unreadCount,
        status: 'failed',
      };
      let resumeOpened = false;
      let shouldMarkReviewed = false;

      try {
        const opened = await openBossUnreadConversationRef.fn(chatPage, conversation);
        item = {
          ...item,
          candidateId: opened.candidate.candidateId,
          candidateName: opened.candidate.name ?? opened.resume.name ?? conversation.candidateName,
          previousChat: opened.previousChat,
          ...(opened.newCandidateReplies ? { newCandidateReplies: opened.newCandidateReplies } : {}),
        };

        if (opened.previousChat.previouslyChatted) {
          if (opened.newCandidateRepliesError) {
            throw new Error(opened.newCandidateRepliesError);
          }
          if (!opened.newCandidateReplies || opened.newCandidateReplies.length === 0) {
            throw new Error(`Unable to reliably extract unread Boss candidate replies for conversation ${conversation.conversationId}.`);
          }

          item = {
            ...item,
            status: 'follow_up_reply',
          };
          shouldMarkReviewed = true;
        } else {
          const resolvedJob = await resolveBossConversationJob(store, conversation);
          const { jobRecord, jobKey } = resolvedJob;
          item = { ...item, jobKey };

          const forwarding = input.bossForwardMode && input.bossForwardRecipient
            ? {
              mode: input.bossForwardMode,
              recipient: input.bossForwardRecipient,
              ...(input.bossForwardCc === undefined
                ? (jobRecord.bossForwarding?.ccEmails === undefined ? {} : { ccEmails: jobRecord.bossForwarding.ccEmails })
                : { ccEmails: input.bossForwardCc }),
            }
            : input.bossForwardCc === undefined
              ? jobRecord.bossForwarding ?? automationSettings.forwarding
              : jobRecord.bossForwarding
                ? { ...jobRecord.bossForwarding, ccEmails: input.bossForwardCc }
                : automationSettings.forwarding
                  ? { ...automationSettings.forwarding, ccEmails: input.bossForwardCc }
                  : undefined;
          if (!forwarding) {
            throw new Error(`Missing stored Boss forwarding configuration for job ${conversation.jobName}`);
          }
          if (forwarding.ccEmails?.length && forwarding.mode !== 'email') {
            throw new Error('Boss forward CC can only be used with email forwarding.');
          }

          if (jobRecord.bossForwarding?.mode !== forwarding.mode
            || jobRecord.bossForwarding?.recipient !== forwarding.recipient
            || JSON.stringify(jobRecord.bossForwarding?.ccEmails ?? []) !== JSON.stringify(forwarding.ccEmails ?? [])) {
            await store.saveJobRecord('boss', {
              ...jobRecord,
              bossForwarding: forwarding,
            });
          }

          if (input.requireAllHardRequirements && !supportsPropertyElectricianHardRequirements(jobKey, jobRecord.normalizedJob)) {
            item = {
              ...item,
              status: 'skipped_unsupported_hard_requirements',
              error: `All-hard-requirements evaluation is not configured for Boss job ${conversation.jobName}`,
            };
            shouldMarkReviewed = true;
          } else {
            resumeOpened = true;
            const resume = await openAndParseBossChatResumeRef.fn(chatPage, opened);
            item = {
              ...item,
              candidateId: resume.candidateId,
              candidateName: resume.name ?? conversation.candidateName,
            };
            await store.saveCandidateResume('boss', jobKey, resume, formatResumeSnapshot(resume));

            let matched: boolean;
            let clarificationRequired = false;
            if (input.requireAllHardRequirements) {
              const hardRequirementEvaluation = evaluateBossChatHardRequirementsRef.fn(resume);
              matched = hardRequirementEvaluation.allMet;
              clarificationRequired = Boolean(hardRequirementEvaluation.clarification);
              item = {
                ...item,
                hardRequirementEvaluation,
                matched: clarificationRequired ? undefined : matched,
                forwarded: false,
                status: clarificationRequired
                  ? 'awaiting_clarification'
                  : matched
                    ? 'failed'
                    : 'not_matched',
              };
            } else {
              const scoredAt = new Date().toISOString();
              try {
                const score = await scoreResumeAgainstJobRef.fn(jobRecord.normalizedJob, resume);
                await store.saveCandidateScoreArtifact('boss', jobKey, {
                  candidateId: resume.candidateId,
                  candidateShareUrl: resume.candidateShareUrl,
                  model: config.scoring.model,
                  scoredAt,
                  status: 'success',
                  score,
                });
                matched = score.totalScore >= input.scoreThreshold;
                item = {
                  ...item,
                  score,
                  matched,
                  forwarded: false,
                  status: matched ? 'failed' : 'not_matched',
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await store.saveCandidateScoreArtifact('boss', jobKey, {
                  candidateId: resume.candidateId,
                  candidateShareUrl: resume.candidateShareUrl,
                  model: config.scoring.model,
                  scoredAt,
                  status: 'failed',
                  error: message,
                });
                throw error;
              }
            }

            if (clarificationRequired) {
              await closeBossChatResumeRef.fn(chatPage);
              resumeOpened = false;
              const contactResult = await contactBossShanghaiOriginCandidateRef.fn(chatPage);
              item = {
                ...item,
                chatMessageSent: contactResult.messageSent,
                clarificationQuestionSent: contactResult.messageSent,
              };
            } else if (matched) {
              await forwardBossResumeRef.fn(
                chatPage,
                opened.candidate,
                forwarding.mode,
                forwarding.recipient,
                'confirm',
                forwarding.ccEmails,
                false,
              );
              item = {
                ...item,
                forwarded: true,
                status: 'forwarded',
              };
              shouldMarkReviewed = true;
              await closeBossChatResumeRef.fn(chatPage);
              resumeOpened = false;
              const contactResult = await contactBossQualifiedCandidateRef.fn(chatPage);
              item = {
                ...item,
                chatMessageSent: contactResult.messageSent,
                phoneExchangeRequested: contactResult.phoneExchangeRequested,
              };
            } else {
              await closeBossChatResumeRef.fn(chatPage);
              resumeOpened = false;
              if (input.replyToUnqualifiedCandidates) {
                const contactResult = await contactBossUnqualifiedCandidateRef.fn(chatPage);
                item = {
                  ...item,
                  chatMessageSent: contactResult.messageSent,
                };
              }
              shouldMarkReviewed = true;
            }
          }
        }
      } catch (error) {
        item = {
          ...item,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (resumeOpened) {
          await closeBossChatResumeRef.fn(chatPage).catch(() => undefined);
        }
        if (shouldMarkReviewed) {
          reviewedConversationIdSet.add(conversation.conversationId);
          await store.saveBossChatReviewedConversationIds([...reviewedConversationIdSet]);
        }
      }

      items.push(item);
    }

    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt,
      scoreThreshold: input.scoreThreshold,
      matchMode: input.requireAllHardRequirements ? 'all-hard-requirements' : 'score-threshold',
      replyToUnqualifiedCandidates: input.replyToUnqualifiedCandidates,
      unreadConversations: conversations.length,
      reviewedConversations: items.filter((item) => !item.status.startsWith('skipped_')).length,
      matchedCandidates: items.filter((item) => item.matched).length,
      chatMessagesSent: items.filter((item) => item.chatMessageSent).length,
      phoneExchangeRequests: items.filter((item) => item.phoneExchangeRequested).length,
      forwardedCandidates: items.filter((item) => item.forwarded).length,
      skippedConversations: items.filter((item) => item.status.startsWith('skipped_')).length,
      failedConversations: items.filter((item) => item.status === 'failed').length,
      previouslyChattedConversations: items.filter((item) => item.previousChat?.previouslyChatted === true).length,
      firstContactConversations: items.filter((item) => item.previousChat?.previouslyChatted === false).length,
      followUpConversations: items.filter((item) => item.status === 'follow_up_reply').length,
      newReplyMessages: items
        .filter((item) => item.status === 'follow_up_reply')
        .reduce((total, item) => total + (item.newCandidateReplies?.length ?? 0), 0),
      items,
    };
    const resultPath = await store.saveBossChatReviewRun(run);
    const emailSummary = automationSettings.summaryDelivery
      ? await sendBossChatSummaryRef.fn(run, {
        recipient: automationSettings.summaryDelivery.recipientEmail,
        ccEmails: automationSettings.summaryDelivery.ccEmails,
      })
      : undefined;
    const summary = {
      ...run,
      resultPath,
      summaryEmailRecipient: emailSummary?.recipient,
      summaryEmailSubject: emailSummary?.subject,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

const BOSS_RESUME_CAPTURE_CANDIDATE_LIMIT = 20;

export async function runResumeCaptureFlow(platform: SupportedPlatform, jobKey: string, job: NormalizedJob, pageKeyword: string, store: JobStore, session: BrowserSession, fetchedAt: string, platformAdapter: PlatformAdapter, options: {
  includeViewedCandidates?: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  /** Enabled only for ordinary Boss capture; other platform stages ignore it. */
  bossScreening?: BossScreeningSettings;
  /** Generic post-score result routing for non-Boss capture stages. */
  postScoreRouting?: PostScoreRoutingSettings;
  searchSource?: SearchSource;
  searchConditions?: SearchCondition[];
  savedSearch?: SavedSearchReference;
  sortPolicy?: SearchSortPolicy;
  /** Immutable report targets captured before the run; used by routed replay. */
  reportDelivery?: ReportDeliveryOptions;
  secondaryReportDelivery?: ReportDeliveryOptions;
  searchExecution?: Omit<NonNullable<RunResult['searchExecution']>, 'includeViewedCandidates'>;
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
  if (bossScreeningEnabled && !options.bossScreening?.secondaryForwarding) {
    throw new Error('Enabled Boss screening requires a secondary Boss forwarding target.');
  }
  let preloadedScreeningWorkItems: BossScreeningWorkItem[] = [];
  if (bossScreeningEnabled) {
    const [pendingItems, outboxEntries] = await Promise.all([
      store.listBossScreeningWorkItems('boss', jobKey),
      store.listBossForwardingOutboxEntries('boss', jobKey),
    ]);
    const incompatibleWorkItemCount = pendingItems.filter((item) => item.policyHash !== bossScreeningPolicyHash).length;
    const incompatibleOutboxCount = outboxEntries.filter((entry) =>
      entry.policyHash !== bossScreeningPolicyHash && hasRetryableBossForwardingDelivery(entry),
    ).length;
    if (incompatibleWorkItemCount > 0 || incompatibleOutboxCount > 0) {
      throw new Error(
        `Boss job ${jobKey} has ${incompatibleWorkItemCount} pending score item(s) and ${incompatibleOutboxCount} unfinished outbox entr${incompatibleOutboxCount === 1 ? 'y' : 'ies'} from an older policy; run migrate:boss-model-screening before opening the browser.`,
      );
    }
    preloadedScreeningWorkItems = pendingItems;
  }
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
  const searchPage = searchSource === 'direct'
    ? await (async () => {
      if (!platformAdapter.openDirectSearch) {
        throw new Error(`Platform ${platformAdapter.platform} does not support direct search for resume capture.`);
      }

      return platformAdapter.openDirectSearch(session.page, pageKeyword, searchConditions, searchOptions);
    })()
    : platform === 'boss'
      ? await (async () => {
        if (!options.savedSearch || !platformAdapter.openSavedSearch) {
          throw new Error('Boss saved-reference-required: native saved-search action is not registered; refusing the legacy saved-search fallback.');
        }
        return platformAdapter.openSavedSearch(session.page, options.savedSearch, searchOptions);
      })()
      : await platformAdapter.openSubscribeSearch(session.page, pageKeyword, searchOptions);
  session.page = searchPage;
  const { candidates: extractedCandidates } = platformAdapter.platform === '51job'
    ? await extractCandidateListRef.fn(searchPage, { deadline: searchDeadline })
    : await extractCandidateListWithAdapterRef.fn(platformAdapter, searchPage, { deadline: searchDeadline });
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
  const existingOutboxCandidateIds = new Set(outboxRecovery.entries.map((entry) => entry.candidateId));
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
      candidateResults.push(await captureCandidateResume(
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
          // A successfully saved resume becomes seen before model work. This
          // intentionally prevents fetch retries from repeating external work.
          // The durable work item above lets an interrupted pre-decision run
          // resume this exact candidate despite that seen marker.
          seenCandidateIdsDuringRun.add(candidate.candidateId);
          await store.markCapturedCandidatesSeen(platform, jobKey, [candidate.candidateId]);
          try {
            const screeningResult = await scoreAndRouteBossCapturedCandidate({
              jobKey,
              job,
              candidate,
              resume,
              detailPage,
              store,
              fetchedAt,
              screening,
              primaryForwarding,
              detailOptions,
            });
            bossScreeningResults.push(screeningResult);
            await store.deleteBossScreeningWorkItem('boss', jobKey, candidate.candidateId);
            screeningWorkByCandidateId.delete(candidate.candidateId);
          } catch (error) {
            if (error instanceof BossUnexpectedContactDialogError || error instanceof BossResumeDetailCloseError) {
              throw error;
            }
            // A persistence or routing orchestration failure must not turn a
            // saved resume back into an unseen candidate. It is visible in the
            // run failure summary and no external fallback recipient is used.
            bossScreeningFailures.push({
              candidateId: candidate.candidateId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        undefined,
        true,
      ));
      const result = candidateResults[candidateResults.length - 1]!;
      recordBossSeenProcessingLifecycle(candidate.candidateId, result.detailLifecycle, result.failureReason);
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

  const scoringResult = bossScreeningEnabled
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
        ...bossScreeningResults
          .filter((result) => result.scoreArtifact.status === 'failed')
          .map((result) => ({
            candidateId: result.candidateId,
            error: result.scoreArtifact.status === 'failed' ? result.scoreArtifact.error : 'Unknown Boss screening score error',
          })),
        ...bossScreeningFailures,
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
    ...bossScreeningResults.map((result) => result.forwardingOutbox),
  ]) {
    latestForwardingEntries.set(entry.candidateId, entry);
  }
  const forwardingOutcomeEntries = [...latestForwardingEntries.values()];
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
    })),
    ...bossScreeningFailures.map((failure) => ({
      candidateId: failure.candidateId,
      stage: 'routing' as const,
      error: failure.error,
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
    ...forwardingOutcomeEntries
      .filter((entry) => entry.forwarding.status !== 'sent')
      .map((entry) => ({
        candidateId: entry.candidateId,
        error: `Boss forwarding ${entry.forwarding.status}: ${entry.forwarding.error ?? 'manual review required'}`,
      })),
  ];

  const bossRouting = bossScreeningEnabled
    ? (() => {
      const policyHash = hashBossScreeningPolicy(options.bossScreening!);
      const routingArtifactsForCurrentReport = [
        ...unreportedRecoveryRoutingArtifacts,
        ...bossScreeningResults.map((result) => result.routingArtifact),
      ];
      const forwardingStatusCounts = forwardingOutcomeEntries.reduce<Record<string, number>>((counts, entry) => {
        const status = entry.forwarding.status;
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {});
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
        forwardingStatusCounts,
      };
    })()
    : undefined;

  const postScoreRouting = postScoreRoutingEnabled
    ? (() => {
      const artifacts = scoringResult.routingArtifacts ?? [];
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
    detailAttemptCount: retryCandidates.length + captureCandidates.length + bossSeenViewAttemptedCandidateIds.size,
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
      },
    } : {}),
  };

  const resultPath = await store.saveRunResult(platform, jobKey, runResult);

  return { candidates, newCandidates, capturedCandidateIds, runResult, resultPath };
}

async function resolveResumeCaptureSearchSettings(
  input: SinglePlatformCliInput,
  existingJobRecord?: JobRecord,
): Promise<NonNullable<JobRecord['searchSettings']>> {
  if (input.searchConditionSetRef) {
    if (input.searchConditionSetRef.platform !== input.platform) {
      throw new Error(`Search condition set ${input.searchConditionSetRef.conditionSetId} belongs to ${input.searchConditionSetRef.platform}, not ${input.platform}`);
    }
    const resolved = await new SearchConditionSetService().resolve(input.searchConditionSetRef);
    return {
      source: 'direct',
      applicationFilterInput: resolved.applicationFilterInput,
      conditions: resolved.conditions,
      conditionSetRef: resolved.reference,
      resolution: {
        selectedFieldsFingerprint: resolved.catalogEvidence.selectedFieldsFingerprint,
      },
    };
  }

  if (input.applicationFilterInputFilePath) {
    const applicationFilterInput = await loadApplicationFilterInputFile(input.applicationFilterInputFilePath);
    return {
      source: input.searchSource,
      applicationFilterInput,
      conditions: await buildApplicationFilterConditions(input.platform, applicationFilterInput, {}),
    };
  }

  if (!input.searchSourceExplicit && existingJobRecord?.searchSettings) {
    if (existingJobRecord.searchSettings.conditionSetRef) {
      const reference = existingJobRecord.searchSettings.conditionSetRef;
      if (reference.platform !== input.platform) {
        throw new Error(`Stored search condition set ${reference.conditionSetId} belongs to ${reference.platform}, not ${input.platform}`);
      }
      const resolved = await new SearchConditionSetService().resolve(reference);
      return {
        source: 'direct',
        applicationFilterInput: resolved.applicationFilterInput,
        conditions: resolved.conditions,
        conditionSetRef: resolved.reference,
        resolution: {
          selectedFieldsFingerprint: resolved.catalogEvidence.selectedFieldsFingerprint,
        },
      };
    }
    return existingJobRecord.searchSettings;
  }

  return {
    source: input.searchSource,
    conditions: [],
  };
}

interface ResolvedResumeCaptureContext {
  jobKey: string;
  existingJobRecord?: JobRecord;
  searchSettings: NonNullable<JobRecord['searchSettings']>;
  /** Only this value is sent to a platform search action. */
  pageKeyword: string;
  bossJobId?: string;
  searchExecution?: Omit<NonNullable<RunResult['searchExecution']>, 'includeViewedCandidates'>;
}

/**
 * Resolve persistence identity before browser work. Boss has a stable position
 * identity and an independent page query; all other platforms retain their
 * existing keyword-as-query behavior.
 */
async function resolveResumeCaptureContext(
  input: SinglePlatformCliInput,
  store: JobStore,
): Promise<ResolvedResumeCaptureContext> {
  if (input.platform !== 'boss') {
    const jobKey = buildJobKey(input.searchKeyword, '');
    const existingJobRecord = await store.readJobRecordIfExists(input.platform, jobKey);
    return {
      jobKey,
      ...(existingJobRecord ? { existingJobRecord } : {}),
      searchSettings: await resolveResumeCaptureSearchSettings(input, existingJobRecord),
      pageKeyword: input.searchKeyword,
    };
  }

  if (input.bossCaptureTaskSnapshot) {
    const snapshot = input.bossCaptureTaskSnapshot;
    if (snapshot.jobIdentity.bossJobId
      && input.bossJobId
      && snapshot.jobIdentity.bossJobId !== input.bossJobId) {
      throw new Error(`Boss capture task snapshot belongs to Boss position ${snapshot.jobIdentity.bossJobId}, not ${input.bossJobId}.`);
    }
    if (!input.bossJobId
      && snapshot.jobIdentity.expectedJobName.normalize('NFKC').trim() !== input.searchKeyword.normalize('NFKC').trim()) {
      throw new Error(`Boss capture task snapshot expects job "${snapshot.jobIdentity.expectedJobName}", not "${input.searchKeyword}".`);
    }
    const existingJobRecord = await store.readJobRecordIfExists('boss', snapshot.sourceJobKey);
    if (snapshot.sourceJobRevision !== undefined
      && (!existingJobRecord || (existingJobRecord.revision ?? 1) !== snapshot.sourceJobRevision)) {
      throw new Error(
        `Boss capture task snapshot revision conflict for ${snapshot.sourceJobKey}: expected ${snapshot.sourceJobRevision}, found ${existingJobRecord?.revision ?? 'missing'}. Refresh and confirm the task again.`,
      );
    }
    return {
      jobKey: snapshot.sourceJobKey,
      ...(existingJobRecord ? { existingJobRecord } : {}),
      searchSettings: {
        source: snapshot.searchPlan.source,
        pageKeyword: snapshot.searchPlan.pageKeyword,
        ...(snapshot.searchPlan.applicationFilterInput
          ? { applicationFilterInput: snapshot.searchPlan.applicationFilterInput }
          : {}),
        conditions: snapshot.searchPlan.conditions,
        ...(snapshot.searchPlan.conditionSetRef
          ? { conditionSetRef: snapshot.searchPlan.conditionSetRef }
          : {}),
        ...(snapshot.searchPlan.selectedFieldsFingerprint
          ? { resolution: { selectedFieldsFingerprint: snapshot.searchPlan.selectedFieldsFingerprint } }
          : {}),
        ...(snapshot.searchPlan.savedSearch ? { savedSearch: snapshot.searchPlan.savedSearch } : {}),
        ...(snapshot.searchPlan.sortPolicy ? { sortPolicy: snapshot.searchPlan.sortPolicy } : {}),
      },
      pageKeyword: snapshot.searchPlan.pageKeyword,
      ...(snapshot.jobIdentity.bossJobId ? { bossJobId: snapshot.jobIdentity.bossJobId } : {}),
      searchExecution: {
        source: snapshot.searchPlan.source,
        pageKeyword: snapshot.searchPlan.pageKeyword,
        keywordSource: snapshot.searchPlan.keywordSource as NonNullable<RunResult['searchExecution']>['keywordSource'],
        ...(snapshot.searchPlan.conditionSetRef ? { conditionSetRef: snapshot.searchPlan.conditionSetRef } : {}),
        ...(snapshot.searchPlan.selectedFieldsFingerprint
          ? { selectedFieldsFingerprint: snapshot.searchPlan.selectedFieldsFingerprint }
          : {}),
        ...(snapshot.searchPlan.savedSearch ? { savedSearch: snapshot.searchPlan.savedSearch } : {}),
        ...(snapshot.searchPlan.sortPolicy ? { sortPolicy: snapshot.searchPlan.sortPolicy } : {}),
      },
    };
  }

  const explicitSearchSettings = input.applicationFilterInputFilePath
    ? await resolveResumeCaptureSearchSettings(input)
    : undefined;
  const plan = await resolveBossCapturePlan({
    jobName: input.searchKeyword,
    ...(input.bossJobId ? { bossJobId: input.bossJobId } : {}),
    ...(input.bossSearchKeyword ? { bossSearchKeyword: input.bossSearchKeyword } : {}),
    ...(input.bossSavedSearchReference ? { savedSearchReference: input.bossSavedSearchReference } : {}),
    searchSource: input.searchSource,
    searchSourceExplicit: input.searchSourceExplicit,
    ...(input.searchConditionSetRef ? { searchConditionSetRef: input.searchConditionSetRef } : {}),
    ...(explicitSearchSettings ? { explicitSearchSettings } : {}),
  }, { store });
  const searchSettings: NonNullable<JobRecord['searchSettings']> = {
    source: plan.search.source,
    pageKeyword: plan.search.pageKeyword,
    ...(plan.search.applicationFilterInput ? { applicationFilterInput: plan.search.applicationFilterInput } : {}),
    conditions: plan.search.conditions,
    ...(plan.search.conditionSetRef ? { conditionSetRef: plan.search.conditionSetRef } : {}),
    ...(plan.search.selectedFieldsFingerprint ? {
      resolution: { selectedFieldsFingerprint: plan.search.selectedFieldsFingerprint },
    } : {}),
    ...(plan.search.savedSearch ? { savedSearch: plan.search.savedSearch } : {}),
    ...(plan.search.sortPolicy ? { sortPolicy: plan.search.sortPolicy } : {}),
  };

  return {
    jobKey: plan.jobKey,
    ...(plan.jobRecordWithResolvedSearchSettings ?? plan.jobRecord
      ? { existingJobRecord: plan.jobRecordWithResolvedSearchSettings ?? plan.jobRecord }
      : {}),
    searchSettings,
    pageKeyword: plan.search.pageKeyword,
    ...(plan.bossJobId ? { bossJobId: plan.bossJobId } : {}),
    searchExecution: {
      source: plan.search.source,
      pageKeyword: plan.search.pageKeyword,
      keywordSource: plan.search.keywordSource,
      ...(plan.search.conditionSetRef ? { conditionSetRef: plan.search.conditionSetRef } : {}),
      ...(plan.search.selectedFieldsFingerprint ? {
        selectedFieldsFingerprint: plan.search.selectedFieldsFingerprint,
      } : {}),
      ...(plan.search.savedSearch ? { savedSearch: plan.search.savedSearch } : {}),
      ...(plan.search.sortPolicy ? { sortPolicy: plan.search.sortPolicy } : {}),
    },
  };
}

function resolveBossForwardingSettings(
  input: SinglePlatformCliInput,
  existingJobRecord?: JobRecord,
): BossForwardingSettings | undefined {
  if (input.platform !== 'boss') return undefined;
  return input.bossCaptureSettingsSnapshot
    ? input.bossCaptureSettingsSnapshot.primaryForwarding
    : resolveBossCaptureForwardingSettings(input, existingJobRecord);
}

/**
 * Resolves the Boss-only policy from the saved canonical value plus explicit
 * capture input. A disabled invocation retains previously saved conditions and
 * secondary targets so operators can safely turn the workflow back on later.
 */
async function resolveBossScreeningSettings(
  input: SinglePlatformCliInput,
  existingJobRecord?: JobRecord,
): Promise<BossScreeningSettings | undefined> {
  if (input.platform !== 'boss') return undefined;
  return input.bossCaptureSettingsSnapshot
    ? input.bossCaptureSettingsSnapshot.screening
    : resolveBossCaptureScreeningSettings(input, existingJobRecord);
}

/**
 * Resolves the platform-neutral post-score routing policy. Boss intentionally
 * keeps its legacy screening/forwarding contract; generic flags are rejected
 * for a standalone Boss stage instead of being silently ignored.
 */
async function resolvePostScoreRoutingSettings(
  input: SinglePlatformCliInput,
  existingJobRecord?: JobRecord,
): Promise<PostScoreRoutingSettings | undefined> {
  const hasExplicitInput = input.resultRoutingEnabled !== undefined
    || input.resultRoutingPolicyFile !== undefined
    || input.secondaryEmail !== undefined
    || input.secondaryCc !== undefined;
  if (input.platform === 'boss') {
    if (hasExplicitInput) {
      throw new Error('Generic result-routing flags cannot be used for platform=boss; use Boss screening flags so native forwarding targets remain explicit.');
    }
    return undefined;
  }
  const stored = existingJobRecord?.postScoreRouting;
  if (!stored && !hasExplicitInput) return undefined;
  const policy = input.resultRoutingPolicyFile
    ? await loadPostScoreRoutingPolicyFile(input.resultRoutingPolicyFile)
    : undefined;
  const secondaryRecipient = input.secondaryEmail ?? stored?.secondaryDelivery?.recipientEmail;
  const secondaryCc = input.secondaryCc === undefined
    ? stored?.secondaryDelivery?.ccEmails
    : input.secondaryCc;
  if (input.secondaryCc !== undefined && !secondaryRecipient) {
    throw new Error('Result-routing secondary CC requires an existing or explicit --secondary-email.');
  }
  return normalizePostScoreRoutingSettings({
    enabled: input.resultRoutingEnabled ?? stored?.enabled ?? false,
    policyVersion: policy?.version ?? stored?.policyVersion ?? 2,
    decisionMode: policy?.decisionMode ?? stored?.decisionMode ?? 'reject-on-any-missing',
    requirements: policy?.requirements ?? stored?.requirements ?? [],
    ...(secondaryRecipient ? {
      secondaryDelivery: {
        recipientEmail: secondaryRecipient,
        ...(secondaryCc === undefined ? {} : { ccEmails: secondaryCc }),
      },
    } : {}),
  });
}

function assertBossScreeningPreflight(
  platform: SupportedPlatform,
  forwarding: BossForwardingSettings | undefined,
  delivery: ReportDeliveryOptions,
  screening: BossScreeningSettings | undefined,
): void {
  if (!screening?.enabled) return;
  assertBossScreeningJobRecordReady({
    platform,
    bossForwarding: forwarding,
    recipientEmail: delivery.recipientEmail,
    bossScreening: screening,
  });
}

function assertPostScoreRoutingPreflight(
  platform: SupportedPlatform,
  delivery: ReportDeliveryOptions,
  routing: PostScoreRoutingSettings | undefined,
): void {
  if (!routing?.enabled) return;
  if (platform === 'boss') {
    throw new Error('Post-score routing settings must not be attached to the Boss stage; use Boss screening.');
  }
  if (!delivery.recipientEmail?.trim()) {
    throw new Error(`Enabled post-score routing for ${platform} requires a primary report recipient.`);
  }
  if (!routing.secondaryDelivery?.recipientEmail.trim()) {
    throw new Error(`Enabled post-score routing for ${platform} requires a secondary report recipient.`);
  }
}

async function preflightCaptureRun(
  inputs: readonly RunnableJobInput[],
  platforms: readonly SupportedPlatform[],
): Promise<void> {
  const store = new JobStore();
  const checks = inputs.flatMap((input) => platforms.map(async (platform) => {
    try {
      const platformInput = buildSinglePlatformInput(input, platform);
      const context = await resolveResumeCaptureContext(platformInput, store);

      if (!context.existingJobRecord && !platformInput.jobDescriptionText && !platformInput.jobDescriptionFilePath) {
        throw new Error('Missing required argument --jd or --jd-file');
      }

      if (!context.existingJobRecord && platformInput.jobDescriptionFilePath) {
        await readFile(platformInput.jobDescriptionFilePath, 'utf8');
      }
      const forwarding = resolveBossForwardingSettings(platformInput, context.existingJobRecord);
      const screening = await resolveBossScreeningSettings(platformInput, context.existingJobRecord);
      const postScoreRouting = await resolvePostScoreRoutingSettings(platformInput, context.existingJobRecord);
      const storedDelivery: ReportDeliveryOptions = context.existingJobRecord
        ? {
          recipientEmail: context.existingJobRecord.recipientEmail,
          ccEmails: context.existingJobRecord.ccEmails,
        }
        : {};
      assertBossScreeningPreflight(platform, forwarding, resolveReportDelivery(storedDelivery, platformInput), screening);
      assertPostScoreRoutingPreflight(platform, resolveReportDelivery(storedDelivery, platformInput), postScoreRouting);
      return undefined;
    } catch (error) {
      return { keyword: input.searchKeyword, platform, error };
    }
  }));
  const failures = (await Promise.all(checks)).filter((failure): failure is {
    keyword: string;
    platform: SupportedPlatform;
    error: unknown;
  } => failure !== undefined);

  if (failures.length > 0) {
    const details = failures.map(({ keyword, platform, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `- ${keyword} / ${platform}: ${message}`;
    });
    throw new Error(`Capture preflight failed before opening a browser:\n${details.join('\n')}`);
  }
}

function warnBossCaptureOptIn(): void {
  console.warn(
    'Boss/直猎邦 is enabled as the fourth capture stage. It may open resume details and reuse saved Boss forwarding settings; no talent matching, greeting, chat, or job-sync actions will run.',
  );
}

async function runSinglePlatform(input: SinglePlatformCliInput, options: { printSummary: boolean } = { printSummary: true }): Promise<MainRunSummary> {
  const platformAdapter = resolvePlatformAdapter(input.platform);
  const store = new JobStore();
  const captureContext = await resolveResumeCaptureContext(input, store);
  const { jobKey, searchSettings, pageKeyword } = captureContext;
  let existingJobRecord = captureContext.existingJobRecord;
  const fetchedAt = new Date().toISOString();
  if (input.bossCaptureSettingsSnapshot?.sourceJobKey
    && input.bossCaptureSettingsSnapshot.sourceJobKey !== jobKey) {
    throw new Error(`Boss capture settings snapshot belongs to job ${input.bossCaptureSettingsSnapshot.sourceJobKey}, not ${jobKey}`);
  }
  if (input.bossCaptureTaskSnapshot?.canonicalPatch && existingJobRecord) {
    const expectedRevision = input.bossCaptureTaskSnapshot.sourceJobRevision;
    if (expectedRevision === undefined) {
      throw new Error(`Boss capture task snapshot for existing job ${jobKey} is missing sourceJobRevision; refusing configuration write-back.`);
    }
    existingJobRecord = await store.applyJobConfigPatch(
      'boss',
      jobKey,
      expectedRevision,
      input.bossCaptureTaskSnapshot.canonicalPatch,
    );
  }
  const bossForwarding = resolveBossForwardingSettings(input, existingJobRecord);
  const bossScreening = await resolveBossScreeningSettings(input, existingJobRecord);
  const postScoreRouting = await resolvePostScoreRoutingSettings(input, existingJobRecord);

  if (!existingJobRecord && !input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error('Missing required argument --jd or --jd-file');
  }

  const jobDescriptionText = existingJobRecord
    ? existingJobRecord.rawText
    : input.jobDescriptionText ?? await readFile(input.jobDescriptionFilePath!, 'utf8');
  const normalizedJob = existingJobRecord
    ? existingJobRecord.normalizedJob
    : await parseJobDescriptionRef.fn(jobDescriptionText);
  const effectiveJobRecord: JobRecord = existingJobRecord
    ? {
      ...existingJobRecord,
      platform: existingJobRecord.platform,
      searchKeyword: input.platform === 'boss' ? existingJobRecord.searchKeyword : input.searchKeyword,
      recipientEmail: input.bossCaptureSettingsSnapshot
        ? existingJobRecord.recipientEmail
        : input.recipientEmail ?? existingJobRecord.recipientEmail,
      ccEmails: input.bossCaptureSettingsSnapshot
        ? existingJobRecord.ccEmails
        : input.ccEmails === undefined ? existingJobRecord.ccEmails : input.ccEmails,
      searchSettings,
      bossForwarding: input.bossCaptureSettingsSnapshot ? existingJobRecord.bossForwarding : bossForwarding,
      bossScreening: input.bossCaptureSettingsSnapshot ? existingJobRecord.bossScreening : bossScreening,
      postScoreRouting,
    }
    : {
      jobKey,
      platform: input.platform,
      searchKeyword: input.searchKeyword,
      recipientEmail: input.recipientEmail,
      ccEmails: input.ccEmails,
      searchSettings,
      bossForwarding,
      ...(bossScreening ? { bossScreening } : {}),
      ...(postScoreRouting ? { postScoreRouting } : {}),
      rawText: jobDescriptionText,
      normalizedJob,
      createdAt: fetchedAt,
    };
  const storedDelivery: ReportDeliveryOptions = existingJobRecord
    ? {
      recipientEmail: existingJobRecord.recipientEmail,
      ccEmails: existingJobRecord.ccEmails,
    }
    : {};
  const delivery = input.bossCaptureSettingsSnapshot
    ? input.bossCaptureSettingsSnapshot.primaryDelivery
    : resolveReportDelivery(storedDelivery, input);
  const persistedDelivery = input.bossCaptureSettingsSnapshot && existingJobRecord
    ? storedDelivery
    : delivery;

  const jobRecord: JobRecord = {
    ...effectiveJobRecord,
    recipientEmail: persistedDelivery.recipientEmail,
    ccEmails: persistedDelivery.ccEmails,
  };

  assertBossScreeningPreflight(input.platform, bossForwarding, delivery, bossScreening);
  assertPostScoreRoutingPreflight(input.platform, delivery, postScoreRouting);

  // A queued immutable snapshot has already applied its explicit canonical
  // patch with CAS. Do not rewrite the full stale JobRecord and resurrect a
  // cleared address or an older search setting. New jobs still need their
  // initial record persisted normally.
  if (!input.bossCaptureTaskSnapshot || !existingJobRecord) {
    await store.saveJobRecord(input.platform, jobRecord);
  }

  if (!isCrawl4aiAdapterAvailable()) {
    console.warn('Crawl4AI adapter unavailable at startup; continuing with built-in extraction only.');
  }

  const bossSearchLease = input.platform === 'boss'
    ? await acquireBossSearchLease()
    : undefined;
  let session: BrowserSession | undefined;

  try {
    session = await ensureAuthenticatedBrowserSessionRef.fn(platformAdapter.platform);
    const { candidates, newCandidates, capturedCandidateIds, runResult, resultPath } = await runResumeCaptureFlow(
      input.platform,
      jobKey,
      normalizedJob,
      pageKeyword,
      store,
      session,
      fetchedAt,
      platformAdapter,
      {
        includeViewedCandidates: input.includeViewedCandidates,
        liepinForwardContact: input.liepinForwardContact,
        bossForwardMode: bossForwarding?.mode,
        bossForwardRecipient: bossForwarding?.recipient,
        bossForwardCc: bossForwarding?.ccEmails,
        bossScreening,
        postScoreRouting,
        searchSource: searchSettings.source,
        searchConditions: searchSettings.conditions,
        ...(searchSettings.savedSearch ? { savedSearch: searchSettings.savedSearch } : {}),
        ...(searchSettings.sortPolicy ? { sortPolicy: searchSettings.sortPolicy } : {}),
        reportDelivery: delivery,
        secondaryReportDelivery: bossScreening?.secondaryDelivery ?? postScoreRouting?.secondaryDelivery,
        searchExecution: captureContext.searchExecution,
      },
    );

    let exportSummary: ExportJobResultsSummary | undefined;
    let exportError: string | undefined;
    let emailSummary: SendJobReportSummary | undefined;
    let routedReportSummary: SendBossRoutedReportsSummary | undefined;
    let genericRoutedReportSummary: SendPostScoreRoutedReportsSummary | undefined;
    let routedMainRunEmailSummary: ReturnType<typeof buildBossRoutedMainRunEmailSummary> | undefined;
    let emailError: string | undefined;

    const exportPromise = exportJobResultsRef.fn(input.platform, jobKey);
    const emailPromise: Promise<SendJobReportSummary | SendBossRoutedReportsSummary | SendPostScoreRoutedReportsSummary> | undefined = runResult.bossRouting?.enabled
      ? sendBossRoutedReportsRef.fn(jobKey)
      : runResult.postScoreRouting?.enabled
        ? sendPostScoreRoutedReports(input.platform, jobKey)
      : delivery.recipientEmail
        ? sendJobReportRef.fn(input.platform, jobKey, delivery)
        : undefined;

    const [exportResult, emailResult] = await Promise.allSettled([
      exportPromise,
      emailPromise,
    ]);

    if (exportResult.status === 'fulfilled') {
      exportSummary = exportResult.value;
    } else {
      exportError = exportResult.reason instanceof Error ? exportResult.reason.message : String(exportResult.reason);
      console.error(exportError);
    }

    if (emailResult?.status === 'fulfilled' && emailResult.value) {
      if ('reportDeliveries' in emailResult.value) {
        if (runResult.bossRouting?.enabled) {
          routedReportSummary = emailResult.value;
          routedMainRunEmailSummary = buildBossRoutedMainRunEmailSummary(routedReportSummary.reportDeliveries);
        } else {
          genericRoutedReportSummary = emailResult.value;
          routedMainRunEmailSummary = buildBossRoutedMainRunEmailSummary(genericRoutedReportSummary.reportDeliveries);
        }
      } else {
        emailSummary = emailResult.value;
      }
    } else if (emailResult?.status === 'rejected') {
      emailError = emailResult.reason instanceof Error ? emailResult.reason.message : String(emailResult.reason);
      console.error(emailError);
    }

    const summary: MainRunSummary = {
      jobKey,
      totalCandidates: candidates.length,
      captureAttempts: runResult.captureAttemptCount ?? 0,
      capturedCandidates: capturedCandidateIds.length,
      newCandidates: capturedCandidateIds.length,
      scoredCandidates: runResult.scoredCandidates.length,
      failedCandidates: runResult.failedCandidates.length,
      resultPath,
      exportPath: exportSummary?.exportPath,
      exportError,
      emailAttempted: runResult.bossRouting?.enabled || runResult.postScoreRouting?.enabled
        ? routedMainRunEmailSummary?.emailAttempted ?? false
        : Boolean(delivery.recipientEmail),
      emailDelivered: runResult.bossRouting?.enabled || runResult.postScoreRouting?.enabled
        ? routedMainRunEmailSummary?.emailDelivered ?? false
        : Boolean(emailSummary),
      emailRecipient: routedMainRunEmailSummary?.emailRecipient ?? emailSummary?.recipient,
      emailSubject: routedMainRunEmailSummary?.emailSubject ?? emailSummary?.subject,
      emailError: emailError ?? routedMainRunEmailSummary?.emailError ?? emailSummary?.error,
      ...(runResult.bossRouting ? { bossRouting: runResult.bossRouting } : {}),
      ...(runResult.postScoreRouting ? { postScoreRouting: runResult.postScoreRouting } : {}),
      ...(runResult.bossSeenViewSync ? { bossSeenViewSync: runResult.bossSeenViewSync } : {}),
      ...(routedReportSummary ? { reportDeliveries: routedReportSummary.reportDeliveries } : {}),
      ...(genericRoutedReportSummary ? { reportDeliveries: genericRoutedReportSummary.reportDeliveries } : {}),
      sampleCandidateIds: capturedCandidateIds.slice(0, 10),
      ...(captureContext.searchExecution ? {
        searchExecution: runResult.searchExecution,
        ...(captureContext.bossJobId ? { bossJobId: captureContext.bossJobId } : {}),
      } : {}),
    };

    if (options.printSummary) {
      console.log(JSON.stringify(summary, null, 2));
    }

    return summary;
  } finally {
    try {
      if (session) {
        await closeBrowserSessionRef.fn(session);
      }
    } finally {
      await bossSearchLease?.release();
    }
  }
}

async function runBatchJobs(input: BatchCliInput): Promise<BatchJobRunSummary[]> {
  const jobs = await loadBatchJobInputs(input);
  const platforms = listSelectedCapturePlatforms(input.platform, input.includeBoss);
  await preflightCaptureRun(jobs, platforms);
  if (input.includeBoss) {
    warnBossCaptureOptIn();
  }
  const summaries: BatchJobRunSummary[] = [];

  for (const job of jobs) {
    for (const platform of platforms) {
      summaries.push({
        keyword: job.searchKeyword,
        platform,
        summary: await runSinglePlatform(buildSinglePlatformInput(job, platform), { printSummary: false }),
      });
    }
  }

  console.log(JSON.stringify(summaries, null, 2));
  return summaries;
}

async function runSearchSubscription(input: SearchSubscriptionCliInput): Promise<SearchSubscriptionSummary | SearchSubscriptionSummary[]> {
  const summaries: SearchSubscriptionSummary[] = [];
  const conditionSetService = input.searchConditionSetRefs ? new SearchConditionSetService() : undefined;

  for (const platform of listSelectedSearchSubscriptionPlatforms(input.platform, input.includeBoss)) {
    let session: BrowserSession | undefined;
    let stageSummary: SearchSubscriptionSummary | undefined;
    let failure: unknown;
    try {
      const adapter = resolvePlatformAdapter(platform);
      const conditionSet = input.searchConditionSetRefs?.[platform]
        ? await conditionSetService!.resolve(input.searchConditionSetRefs[platform]!)
        : undefined;
      const plan = await loadSearchConditionPlanFile(input.filePath, {
        platform,
        keywordOverride: input.keyword ?? conditionSet?.revision.defaultKeyword,
        savedSearchNameOverride: input.savedSearchName,
      });
      if (conditionSet && plan.conditions.some((condition) => condition.kind === 'applicationFilter')) {
        throw new Error(`--search-subscription-file cannot include applicationFilter conditions when --search-condition-set is selected for ${platform}`);
      }
      const resolvedPlan = conditionSet
        ? {
          ...plan,
          conditions: [...plan.conditions, ...conditionSet.conditions],
        }
        : plan;
      session = await ensureAuthenticatedBrowserSessionRef.fn(adapter.platform);
      stageSummary = await runSearchSubscriptionWorkflowRef.fn(adapter, session.page, resolvedPlan, {
        save: input.save,
        savedSearchName: input.savedSearchName,
        ...(platform === 'boss' ? { sortPolicy: 'match-priority' as const } : {}),
      });
    } catch (error) {
      failure = error;
    } finally {
      if (session) {
        try {
          await closeBrowserSessionRef.fn(session);
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (stageSummary) summaries.push(stageSummary);
    if (failure !== undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      const summary = {
        mode: 'search-subscription' as const,
        status: 'failed' as const,
        completedPlatforms: summaries.map((item) => item.platform),
        stoppedPlatform: platform,
        results: [...summaries],
        error: message,
      };
      console.error(JSON.stringify(summary, null, 2));
      throw new SearchSubscriptionRunError(summary, failure);
    }
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Verify and bind a complete native Boss subscription without entering the
 * ordinary candidate-capture chain.  The native action performs the bounded
 * card selection/hydration/search verification; only after that succeeds do
 * we persist the reference with a revision-checked JobStore patch.
 */
async function runBossSavedSearchBinding(
  input: BossSavedSearchBindingCliInput,
): Promise<BossSavedSearchBindingSummary> {
  const jobKey = input.bossJobId
    ? buildBossSyncedJobKey(input.searchKeyword, input.bossJobId)
    : buildJobKey(input.searchKeyword, '');
  const store = new JobStore();
  const existing = await store.readJobRecordIfExists('boss', jobKey);
  if (!existing) {
    throw new Error(`Boss saved-search binding requires an existing job record for ${jobKey}`);
  }
  if (existing.platform !== 'boss') {
    throw new Error(`Boss saved-search binding found ${existing.platform}/${jobKey}, not a Boss job record`);
  }
  if (existing.searchKeyword !== input.searchKeyword) {
    throw new Error(`Boss saved-search binding job name ${input.searchKeyword} does not match persisted job ${existing.searchKeyword}`);
  }
  if (input.savedSearch.conditionIdentity.jobScope !== existing.searchKeyword) {
    throw new Error(`Boss saved-search binding reference job scope ${input.savedSearch.conditionIdentity.jobScope} does not match ${existing.searchKeyword}`);
  }

  const adapter = resolvePlatformAdapter('boss');
  if (!adapter.openSavedSearch) {
    throw new Error('Boss saved-search binding is unavailable because the native saved-search action is not registered');
  }
  const estimatedTimeoutMs = adapter.estimateSearchTimeoutMs?.({
    source: 'saved',
    conditions: [],
    includeViewedCandidates: false,
  });
  const deadline = Date.now() + Math.max(
    config.playwright.searchPageTimeoutMs,
    typeof estimatedTimeoutMs === 'number' && Number.isFinite(estimatedTimeoutMs)
      ? Math.max(1, estimatedTimeoutMs)
      : 0,
  );
  const lease = await acquireBossSearchLease();
  let session: BrowserSession | undefined;
  try {
    session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
    await adapter.openSavedSearch(session.page, input.savedSearch, {
      deadline,
      includeViewedCandidates: false,
      sortPolicy: 'match-priority',
    });
    const previousRevision = existing.revision ?? 1;
    const updated = await store.applyJobConfigPatch('boss', jobKey, previousRevision, {
      searchSource: 'saved',
      pageKeyword: input.savedSearch.expectedKeyword,
      conditions: [],
      applicationFilterInput: null,
      conditionSetRef: null,
      selectedFieldsFingerprint: null,
      savedSearch: input.savedSearch,
    });
    const summary: BossSavedSearchBindingSummary = {
      mode: 'boss-saved-search-binding',
      platform: 'boss',
      jobKey,
      savedSearch: input.savedSearch,
      previousRevision,
      revision: updated.revision ?? previousRevision + 1,
      verifiedAt: new Date().toISOString(),
      candidateSideEffects: false,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    try {
      if (session) {
        await closeBrowserSessionRef.fn(session);
      }
    } finally {
      await lease.release();
    }
  }
}

async function runTalentMapping(input: TalentMappingCliInput): Promise<TalentMappingRunSummary> {
  const plan = await loadTalentMappingPlanFileRef.fn(input.filePath, {
    platformSelection: input.platform,
  });
  const summary = await runTalentMappingWorkflowRef.fn({
    plan,
    planFilePath: input.filePath,
    platformSelection: input.platform,
    stage: input.stage,
    confirmedDetailOpen: input.confirmedDetailOpen,
    sourceScanRunId: input.sourceScanRunId,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function resolveJdQuestionContext(
  platform: SupportedPlatform,
  input: JdQuestionCliInput,
  store: JobStore,
): Promise<{ jobKey?: string; rawText: string; normalizedJob?: NormalizedJob; stored: boolean }> {
  const keyword = input.keyword?.trim();
  const jobKey = keyword ? buildJobKey(keyword, '') : undefined;
  const existingJobRecord = jobKey ? await store.readJobRecordIfExists(platform, jobKey) : undefined;

  if (existingJobRecord) {
    return {
      jobKey,
      rawText: existingJobRecord.rawText,
      normalizedJob: existingJobRecord.normalizedJob,
      stored: true,
    };
  }

  if (!input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error(`Missing stored JD for ${platform}${jobKey ? ` job key ${jobKey}` : ''}; provide --jd or --jd-file`);
  }

  const rawText = input.jobDescriptionText ?? await readFile(input.jobDescriptionFilePath!, 'utf8');

  return {
    jobKey,
    rawText,
    stored: false,
  };
}

async function runJdQuestion(input: JdQuestionCliInput): Promise<JdQuestionRunSummary | JdQuestionRunSummary[]> {
  const store = new JobStore();
  const summaries: JdQuestionRunSummary[] = [];

  for (const platform of listSelectedCorePlatforms(input.platform)) {
    const context = await resolveJdQuestionContext(platform, input, store);
    const answer = context.stored && context.jobKey
      ? await answerQuestionWithRagRef.fn({
        platform,
        jobKey: context.jobKey,
        question: input.question,
      }).then((ragAnswer) => ({
        answer: ragAnswer.answer,
        sources: toJdRagSources(ragAnswer.sources),
        answered: ragAnswer.answered,
        confidence: ragAnswer.confidence,
        noAnswerReason: ragAnswer.noAnswerReason,
      }))
      : await answerCandidateQuestionFromJdRef.fn({
        rawJdText: context.rawText,
        normalizedJob: context.normalizedJob,
        question: input.question,
      });

    summaries.push({
      platform,
      jobKey: context.jobKey,
      question: input.question,
      answer: answer.answer,
      sources: answer.sources,
      answered: answer.answered,
      confidence: answer.confidence,
      noAnswerReason: answer.noAnswerReason,
    });
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<MainResult> {
  const input = parseArgs(argv);

  if (input.mode === 'talent-mapping') {
    return runTalentMapping(input);
  }

  if (input.mode === 'boss-talent-search') {
    return runBossTalentSearchMode(input);
  }

  if (input.mode === 'boss-greet') {
    return runBossGreetMode(input);
  }

  if (input.mode === 'boss-chat-operation') {
    return runBossChatOperationMode(input);
  }

  if (input.mode === 'boss-job-sync') {
    return runBossJobSyncMode(input);
  }

  if (input.mode === 'boss-auto-chat') {
    return runBossAutoChat(input);
  }

  if (input.mode === 'jd-question') {
    return runJdQuestion(input);
  }

  if (input.mode === 'search-subscription') {
    return runSearchSubscription(input);
  }

  if (input.mode === 'boss-saved-search-binding') {
    return runBossSavedSearchBinding(input);
  }

  if (input.mode === 'batch') {
    return runBatchJobs(input);
  }

  if (input.platform === 'all') {
    const summaries: AllPlatformsRunSummary[] = [];
    const platforms = listSelectedCapturePlatforms(input.platform, input.includeBoss);
    await preflightCaptureRun([input], platforms);
    if (input.includeBoss) {
      warnBossCaptureOptIn();
    }

    for (const platform of platforms) {
      summaries.push({
        platform,
        summary: await runSinglePlatform(buildSinglePlatformInput(input, platform), { printSummary: false }),
      });
    }

    console.log(JSON.stringify(summaries, null, 2));
    return summaries;
  }

  return runSinglePlatform(buildSinglePlatformInput(input, input.platform));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
