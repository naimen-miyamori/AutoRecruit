import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey, parseJobDescription } from './parsers/jd-parser.js';
import { config } from './config.js';
import { JobStore } from './storage/job-store.js';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from './browser/session.js';
import { handoffPlatformWorkPage, preflightPlatformRuntimeManifests } from './browser/platform-runtime.js';
import { runBrowserCliMain } from './browser/cli-lifecycle.js';
import { isCrawl4aiAdapterAvailable } from './extraction/crawl4ai-extractor.js';
import { getPlatformAdapter, listCapturePlatforms, listSearchSubscriptionPlatforms, listSupportedPlatforms, parsePlatformArg } from './platforms/registry.js';
import { acquireBossSearchLease } from './platforms/boss/search-lease.js';
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
import type {
  PlatformAdapter,
  SupportedPlatform,
} from './platforms/types.js';
import { answerCandidateQuestionFromJd, toJdRagSources } from './rag/jd-question-answering.js';
import { answerQuestionWithRag } from './rag/service.js';
import { runSearchSubscriptionWorkflow } from './search/search-subscription.js';
import {
  type SearchConditionSetReference,
} from './search/search-condition-sets.js';
import { normalizeBossCaptureSettingsSnapshot } from './scoring/boss-screening.js';
import { evaluatePropertyElectricianHardRequirements } from './scoring/boss-chat-hard-requirements.js';
import { sendBossChatSummary } from './reporting/boss-chat-summary.js';
import { exportJobResults } from './scripts/export-job-results.js';
import {
  sendBossRoutedReports,
  sendPostScoreRoutedReports,
  sendJobReport,
} from './scripts/send-job-report-email.js';
import { loadTalentMappingPlanFile } from './talent-mapping/plan.js';
import { runTalentMappingWorkflow } from './talent-mapping/workflow.js';
import {
  deriveCliSearchModeId,
  getOperationModeDefinition,
  isCliSearchModeId,
  type CliSearchModeId,
} from './operation-modes.js';
import {
  parseEmailList,
  SavedSearchReference,
  SearchSubscriptionSummary,
} from './types/job.js';
import {
  isTalentMappingCorePlatform,
  type TalentMappingRunSummary,
  type TalentMappingStage,
} from './types/talent-mapping.js';
import type {
  BossChatOperationInput,
  BossChatOperationResult,
  BossGreetInput,
  BossGreetResult,
  BossJobSyncRun,
  BossTalentSearchInput,
  BossTalentSearchResult,
} from './types/boss.js';
import type {
  BatchCliInput,
  BatchRunnableJobInput,
  CliInput,
  CliPlatformSelection,
  SearchSubscriptionCliInput,
  SingleJobCliInput,
} from './mode-runners/types.js';
import { parseBossForwardMode, parseSearchSource } from './mode-runners/input-parsers.js';
import { loadBatchJobInputs } from './mode-runners/batch-input.js';
import { runJdQuestionMode, type JdQuestionRunSummary } from './mode-runners/jd-question-runner.js';
import { runTalentMappingMode } from './mode-runners/talent-mapping-runner.js';
import {
  runBossChatOperationMode,
  runBossGreetMode,
  runBossJobSyncMode,
  runBossTalentSearchMode,
  type BossStandaloneRunnerDependencies,
} from './mode-runners/boss-mode-runner.js';
import { runSearchSubscriptionMode } from './mode-runners/search-subscription-runner.js';
import {
  runBossSavedSearchBindingMode,
  type BossSavedSearchBindingSummary,
} from './mode-runners/boss-saved-search-binding-runner.js';
export type { BossSavedSearchBindingSummary } from './mode-runners/boss-saved-search-binding-runner.js';
import {
  type AllPlatformsRunSummary,
  type BatchJobRunSummary,
  type MainRunSummary,
} from './mode-runners/run-summary.js';
import {
  runAllPlatformsCaptureMode,
  runBatchCaptureMode,
  type CaptureDispatchRunnerDependencies,
} from './mode-runners/capture-dispatch-runner.js';
import { runBossAutoChatMode, type BossAutoChatRunSummary } from './mode-runners/boss-auto-chat-runner.js';
import { createCaptureEngine } from './capture-engine.js';
export const {
  executeBossRejectionEmailDeliveryRef,
  formatResumeSnapshot,
  extractCandidateListRef,
  extractCandidateListWithAdapterRef,
  extractionBoundary,
  extractResumeFromPageRef,
  forwardBossResumeRef,
  openDirectSearchRef,
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
} = createCaptureEngine();
import {
  preflightCaptureRun,
  runSinglePlatformCapture,
  type CaptureRunnerDependencies,
} from './mode-runners/capture-runner.js';
import {
  assertBossScreeningPreflight,
  assertPostScoreRoutingPreflight,
  buildSinglePlatformInput,
  resolveBossForwardingSettings,
  resolveBossScreeningSettings,
  resolvePostScoreRoutingSettings,
  resolveResumeCaptureContext,
} from './mode-runners/capture-config.js';
export type { BossAutoChatRunSummary } from './mode-runners/boss-auto-chat-runner.js';
export {
  buildBossRoutedMainRunEmailSummary,
  type AllPlatformsRunSummary,
  type BatchJobRunSummary,
  type MainRunSummary,
} from './mode-runners/run-summary.js';
export type { JdQuestionRunSummary } from './mode-runners/jd-question-runner.js';

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

export interface MainOptions {
  reportSearchMode?: (message: string) => void;
}

export const parseJobDescriptionRef = { fn: parseJobDescription };
export const exportJobResultsRef = { fn: exportJobResults };
export const sendJobReportRef = { fn: sendJobReport };
export const sendBossRoutedReportsRef = { fn: sendBossRoutedReports };
export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const preflightPlatformRuntimeManifestsRef = { fn: preflightPlatformRuntimeManifests };
export const runSearchSubscriptionWorkflowRef = { fn: runSearchSubscriptionWorkflow };
export const loadTalentMappingPlanFileRef = { fn: loadTalentMappingPlanFile };
export const runTalentMappingWorkflowRef = { fn: runTalentMappingWorkflow };
export const answerCandidateQuestionFromJdRef = { fn: answerCandidateQuestionFromJd };
export const answerQuestionWithRagRef = { fn: answerQuestionWithRag };
export const openBossChatPageRef = { fn: openBossChatPage };
export const collectBossUnreadConversationsRef = { fn: collectBossUnreadConversations };
export const openBossUnreadConversationRef = { fn: openBossUnreadConversation };
export const openAndParseBossChatResumeRef = { fn: openAndParseBossChatResume };
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
  throw new Error('--boss-screening-enabled, --boss-screening-policy-file, --boss-secondary-email, and --boss-secondary-cc require --platform boss or --platform all --include-boss true');
}

function parseArgsInternal(argv: readonly string[]): CliInput {
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

  const legacyBossSecondaryForwardFlags = [
    'boss-secondary-forward-mode',
    'boss-secondary-forward-recipient',
    'boss-secondary-forward-cc',
  ].filter((flag) => flagPresence.has(flag));
  if (legacyBossSecondaryForwardFlags.length > 0) {
    throw new Error(`${legacyBossSecondaryForwardFlags.map((flag) => `--${flag}`).join(', ')} are no longer supported; rejected Boss resumes are emailed to --boss-secondary-email instead.`);
  }

  const searchKeyword = values.get('keyword');
  const platform = parsePlatformSelection(values.get('platform'));
  const requestedModeId = values.get('mode-id')?.trim();
  if (flagPresence.has('mode-id') && !isCliSearchModeId(requestedModeId)) {
    throw new Error(`operation-mode-unknown: --mode-id must be one of: ${['capture.reuse-job-settings', 'capture.subscription-search', 'capture.direct-search', 'batch.capture', 'subscription.manage'].join(', ')}`);
  }
  const modeId = requestedModeId ? requestedModeId as CliSearchModeId : undefined;
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
    || flagPresence.has('boss-secondary-email')
    || flagPresence.has('boss-secondary-cc')
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

  if (flagPresence.has('boss-secondary-email') && !bossSecondaryEmail) {
    throw new Error('--boss-secondary-email must be a non-empty email address');
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
      modeId,
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
      modeId,
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
    modeId,
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

type CliSearchOperationInput = SingleJobCliInput | BatchCliInput | SearchSubscriptionCliInput;

function isCliSearchOperationInput(input: CliInput): input is CliSearchOperationInput {
  return input.mode === 'single' || input.mode === 'batch' || input.mode === 'search-subscription';
}

function parseArgs(argv: readonly string[]): CliInput {
  const input = parseArgsInternal(argv);
  if (argv.includes('--mode-id') && !isCliSearchOperationInput(input)) {
    throw new Error('--mode-id is only valid for resume capture, batch capture, or subscription management');
  }
  return input;
}

function announceCliSearchMode(
  input: CliSearchOperationInput,
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): CliSearchModeId {
  const resolvedModeId = deriveCliSearchModeId({
    mode: input.mode,
    searchSource: input.mode === 'search-subscription' ? undefined : input.searchSource,
    searchSourceExplicit: input.mode === 'single' || input.mode === 'batch'
      ? input.searchSourceExplicit
      : undefined,
  });
  if (input.modeId && input.modeId !== resolvedModeId) {
    const requestedDefinition = getOperationModeDefinition(input.modeId);
    const resolvedDefinition = getOperationModeDefinition(resolvedModeId);
    throw new Error(`operation-mode-conflict: 预期“${requestedDefinition.label}”（${input.modeId}），但参数解析为“${resolvedDefinition.label}”（${resolvedModeId}）。请修改 --mode-id 或匹配的搜索参数，使二者一致后再重试。`);
  }

  const definition = getOperationModeDefinition(resolvedModeId);
  if (input.modeId) {
    report(`执行模式：${definition.label}（${resolvedModeId}）\n作用：${definition.effectSummary}`);
  } else {
    report(`兼容入口：未提供 --mode-id，已解析为“${definition.label}”（${resolvedModeId}）。为避免“订阅搜索”和“订阅管理”混淆，建议使用 npm run search:run -- --mode-id ${resolvedModeId} ...\n作用：${definition.effectSummary}`);
  }
  return resolvedModeId;
}

function warnBossCaptureOptIn(): void {
  console.warn(
    'Boss/直猎邦 is enabled as the fourth capture stage. It may open resume details and reuse saved Boss forwarding settings; no talent matching, greeting, chat, or job-sync actions will run.',
  );
}

function createCaptureRunnerDependencies(): CaptureRunnerDependencies {
  return {
    createStore: () => new JobStore(),
    resolvePlatformAdapter,
    resolveContext: resolveResumeCaptureContext,
    resolveForwarding: resolveBossForwardingSettings,
    resolveScreening: resolveBossScreeningSettings,
    resolveRouting: resolvePostScoreRoutingSettings,
    assertScreeningPreflight: assertBossScreeningPreflight,
    assertRoutingPreflight: assertPostScoreRoutingPreflight,
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    parseJobDescription: (text) => parseJobDescriptionRef.fn(text),
    isExtractionAdapterAvailable: isCrawl4aiAdapterAvailable,
    acquireBossSearchLease,
    openSession: (platform) => ensureAuthenticatedBrowserSessionRef.fn(platform),
    closeSession: (session) => closeBrowserSessionRef.fn(session),
    runCaptureFlow: runResumeCaptureFlow,
    exportResults: (platform, jobKey) => exportJobResultsRef.fn(platform, jobKey),
    sendJobReport: (platform, jobKey, delivery) => sendJobReportRef.fn(platform, jobKey, delivery),
    sendBossRoutedReports: (jobKey) => sendBossRoutedReportsRef.fn(jobKey),
    sendPostScoreRoutedReports,
    report: (summary) => console.log(JSON.stringify(summary, null, 2)),
    warn: (message) => console.warn(message),
    reportError: (message) => console.error(message),
    now: () => new Date().toISOString(),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2), options: MainOptions = {}): Promise<MainResult> {
  const input = parseArgs(argv);
  const captureRunnerDependencies = createCaptureRunnerDependencies();
  const bossStandaloneDependencies: BossStandaloneRunnerDependencies = {
    openSession: () => ensureAuthenticatedBrowserSessionRef.fn('boss'),
    closeSession: (session) => closeBrowserSessionRef.fn(session),
    runTalentSearch: (session, modeInput) => runBossTalentSearchRef.fn(session.page, modeInput),
    runGreet: (session, modeInput) => greetBossTalentCandidateRef.fn(session.page, modeInput),
    runChatOperation: (session, modeInput) => executeBossChatOperationRef.fn(session.page, modeInput),
    runJobSync: (session, modeInput) => syncBossPositionsRef.fn(session.page, modeInput),
    report: (result) => console.log(JSON.stringify(result, null, 2)),
  };
  const captureDispatchDependencies: CaptureDispatchRunnerDependencies = {
    loadBatchJobs: (batchInput) => loadBatchJobInputs(batchInput, {
      listSelectedPlatforms: listSelectedCapturePlatforms,
    }),
    listPlatforms: listSelectedCapturePlatforms,
    preflight: (jobs, platforms) => preflightCaptureRun(jobs, platforms, {
      ...captureRunnerDependencies,
      buildSinglePlatformInput,
      preflightRuntimes: preflightPlatformRuntimeManifestsRef.fn,
    }),
    warnBossOptIn: warnBossCaptureOptIn,
    buildSinglePlatformInput,
    runSinglePlatform: (platformInput, runOptions) => runSinglePlatformCapture(
      platformInput,
      captureRunnerDependencies,
      runOptions,
    ),
    report: (result) => console.log(JSON.stringify(result, null, 2)),
  };

  if (isCliSearchOperationInput(input)) {
    announceCliSearchMode(input, options.reportSearchMode);
  }

  if (input.mode === 'talent-mapping') {
    return runTalentMappingMode(input, {
      loadPlan: (filePath, overrides) => loadTalentMappingPlanFileRef.fn(filePath, overrides),
      runWorkflow: (workflowInput) => runTalentMappingWorkflowRef.fn(workflowInput),
      report: (summary) => console.log(JSON.stringify(summary, null, 2)),
    });
  }

  if (input.mode === 'boss-talent-search') {
    return runBossTalentSearchMode(input, bossStandaloneDependencies);
  }

  if (input.mode === 'boss-greet') {
    return runBossGreetMode(input, bossStandaloneDependencies);
  }

  if (input.mode === 'boss-chat-operation') {
    return runBossChatOperationMode(input, bossStandaloneDependencies);
  }

  if (input.mode === 'boss-job-sync') {
    return runBossJobSyncMode(input, bossStandaloneDependencies);
  }

  if (input.mode === 'boss-auto-chat') {
    return runBossAutoChatMode(input, {
      createStore: () => new JobStore(),
      now: () => new Date(),
      buildJobKey,
      scoringModel: config.scoring.model,
      openSession: () => ensureAuthenticatedBrowserSessionRef.fn('boss'),
      closeSession: (session) => closeBrowserSessionRef.fn(session),
      syncPositions: (page, modeInput) => syncBossPositionsRef.fn(page, modeInput),
      openChatPage: (page) => openBossChatPageRef.fn(page),
      collectUnreadConversations: (page, retryItems) => collectBossUnreadConversationsRef.fn(page, retryItems),
      openUnreadConversation: (page, conversation) => openBossUnreadConversationRef.fn(page, conversation),
      openAndParseResume: (page, opened) => openAndParseBossChatResumeRef.fn(page, opened),
      closeResume: (page) => closeBossChatResumeRef.fn(page),
      contactQualified: (page) => contactBossQualifiedCandidateRef.fn(page),
      contactShanghaiOrigin: (page) => contactBossShanghaiOriginCandidateRef.fn(page),
      contactUnqualified: (page) => contactBossUnqualifiedCandidateRef.fn(page),
      forwardResume: (...args) => forwardBossResumeRef.fn(...args),
      evaluateHardRequirements: (resume) => evaluateBossChatHardRequirementsRef.fn(resume),
      scoreResume: (job, resume) => scoreResumeAgainstJobRef.fn(job, resume),
      sendSummary: (run, delivery) => sendBossChatSummaryRef.fn(run, delivery),
      formatResumeSnapshot,
      report: (summary) => console.log(JSON.stringify(summary, null, 2)),
    });
  }

  if (input.mode === 'jd-question') {
    return runJdQuestionMode(input, {
      createStore: () => new JobStore(),
      listPlatforms: listSelectedCorePlatforms,
      buildJobKey,
      readTextFile: (filePath) => readFile(filePath, 'utf8'),
      answerStored: async (questionInput) => answerQuestionWithRagRef.fn(questionInput).then((ragAnswer) => ({
        answer: ragAnswer.answer,
        sources: toJdRagSources(ragAnswer.sources),
        answered: ragAnswer.answered,
        confidence: ragAnswer.confidence,
        noAnswerReason: ragAnswer.noAnswerReason,
      })),
      answerTemporary: (questionInput) => answerCandidateQuestionFromJdRef.fn(questionInput),
      report: (result) => console.log(JSON.stringify(result, null, 2)),
    });
  }

  if (input.mode === 'search-subscription') {
    return runSearchSubscriptionMode(input, {
      listPlatforms: listSelectedSearchSubscriptionPlatforms,
      resolveAdapter: resolvePlatformAdapter,
      openSession: (platform) => ensureAuthenticatedBrowserSessionRef.fn(platform),
      closeSession: (session) => closeBrowserSessionRef.fn(session),
      handoffWorkPage: handoffPlatformWorkPage,
      preflightRuntimes: preflightPlatformRuntimeManifests,
      runWorkflow: (adapter, page, plan, workflowOptions) => runSearchSubscriptionWorkflowRef.fn(adapter, page, plan, workflowOptions),
      report: (result) => console.log(JSON.stringify(result, null, 2)),
      reportFailure: (summary) => console.error(JSON.stringify(summary, null, 2)),
    });
  }

  if (input.mode === 'boss-saved-search-binding') {
    return runBossSavedSearchBindingMode(input, {
      createStore: () => new JobStore(),
      buildJobKey,
      buildSyncedJobKey: buildBossSyncedJobKey,
      resolveAdapter: () => resolvePlatformAdapter('boss'),
      searchPageTimeoutMs: config.playwright.searchPageTimeoutMs,
      acquireSearchLease: acquireBossSearchLease,
      openSession: () => ensureAuthenticatedBrowserSessionRef.fn('boss'),
      closeSession: (session) => closeBrowserSessionRef.fn(session),
      now: () => new Date(),
      report: (summary) => console.log(JSON.stringify(summary, null, 2)),
    });
  }

  if (input.mode === 'batch') {
    return runBatchCaptureMode(input, captureDispatchDependencies);
  }

  if (input.platform === 'all') {
    return runAllPlatformsCaptureMode(input, captureDispatchDependencies);
  }

  return runSinglePlatformCapture(
    buildSinglePlatformInput(input, input.platform),
    captureRunnerDependencies,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runBrowserCliMain(() => main());
}
