import type { BrowserSession } from '../browser/session.js';
import type { JobStore } from '../storage/job-store.js';
import type {
  CoreSavedSearchVerificationRequest,
  PlatformAdapter,
  SupportedPlatform,
} from '../platforms/types.js';
import type { ExportJobResultsSummary } from '../scripts/export-job-results.js';
import type {
  SendBossRoutedReportsSummary,
  SendJobReportSummary,
  SendPostScoreRoutedReportsSummary,
} from '../scripts/send-job-report-email.js';
import type {
  BossForwardingSettings,
  BossScreeningSettings,
  CandidateListItem,
  JobRecord,
  NormalizedJob,
  PostScoreRoutingSettings,
  PlatformSavedSearchOpenEvidence,
  ReportDeliveryOptions,
  RunResult,
} from '../types/job.js';
import { resolveReportDelivery } from '../types/job.js';
import type { RunnableJobInput, SinglePlatformCliInput } from './types.js';
import {
  buildBossRoutedMainRunEmailSummary,
  type MainRunSummary,
} from './run-summary.js';
import { preflightPlatformRuntimeManifests } from '../browser/platform-runtime.js';
import {
  buildCaptureExecutionPlan,
  buildPlatformCaptureTargetRequest,
  resolvePlatformCaptureTarget,
  type ResolvedPlatformCaptureTarget,
  type CaptureExecutionPlan,
} from './capture-targets.js';

export interface ResolvedResumeCaptureContext {
  jobKey: string;
  existingJobRecord?: JobRecord;
  searchSettings: NonNullable<JobRecord['searchSettings']>;
  pageKeyword: string;
  prospectiveCoreSavedSearchRequest?: CoreSavedSearchVerificationRequest;
  bossJobId?: string;
  searchExecution?: Omit<NonNullable<RunResult['searchExecution']>, 'includeViewedCandidates'>;
}

interface CaptureFlowResult {
  candidates: CandidateListItem[];
  newCandidates: CandidateListItem[];
  capturedCandidateIds: string[];
  runResult: RunResult;
  resultPath: string;
}

interface ReleaseHandle {
  release(): Promise<void>;
}

export interface CaptureRunnerDependencies {
  createStore: () => JobStore;
  resolvePlatformAdapter: (platform: SupportedPlatform) => PlatformAdapter;
  resolveContext: (input: SinglePlatformCliInput, store: JobStore) => Promise<ResolvedResumeCaptureContext>;
  resolveForwarding: (input: SinglePlatformCliInput, record?: JobRecord) => BossForwardingSettings | undefined;
  resolveScreening: (input: SinglePlatformCliInput, record?: JobRecord) => Promise<BossScreeningSettings | undefined>;
  resolveRouting: (input: SinglePlatformCliInput, record?: JobRecord) => Promise<PostScoreRoutingSettings | undefined>;
  assertScreeningPreflight: (
    platform: SupportedPlatform,
    forwarding: BossForwardingSettings | undefined,
    delivery: ReportDeliveryOptions,
    screening: BossScreeningSettings | undefined,
  ) => void;
  assertRoutingPreflight: (
    platform: SupportedPlatform,
    delivery: ReportDeliveryOptions,
    routing: PostScoreRoutingSettings | undefined,
  ) => void;
  readTextFile: (filePath: string) => Promise<string>;
  parseJobDescription: (text: string) => Promise<NormalizedJob>;
  isExtractionAdapterAvailable: () => boolean;
  acquireBossSearchLease: () => Promise<ReleaseHandle>;
  openSession: (platform: SupportedPlatform) => Promise<BrowserSession>;
  closeSession: (session: BrowserSession) => Promise<void>;
  runCaptureFlow: (
    platform: SupportedPlatform,
    jobKey: string,
    job: NormalizedJob,
    pageKeyword: string,
    store: JobStore,
    session: BrowserSession,
    fetchedAt: string,
    adapter: PlatformAdapter,
    options: {
      includeViewedCandidates?: boolean;
      liepinForwardContact?: string;
      bossForwardMode?: SinglePlatformCliInput['bossForwardMode'];
      bossForwardRecipient?: string;
      bossForwardCc?: string[];
      bossScreening?: BossScreeningSettings;
      postScoreRouting?: PostScoreRoutingSettings;
      searchSource?: SinglePlatformCliInput['searchSource'];
      searchConditions?: NonNullable<JobRecord['searchSettings']>['conditions'];
      savedSearch?: NonNullable<JobRecord['searchSettings']>['savedSearch'];
      coreSavedSearchTarget?: NonNullable<JobRecord['searchSettings']>['coreSavedSearchTarget'];
      coreSavedSearchVerificationRequest?: CoreSavedSearchVerificationRequest;
      sortPolicy?: NonNullable<JobRecord['searchSettings']>['sortPolicy'];
      reportDelivery?: ReportDeliveryOptions;
      secondaryReportDelivery?: ReportDeliveryOptions;
      searchExecution?: ResolvedResumeCaptureContext['searchExecution'];
      onSavedSearchOpenEvidence?: (
        evidence: PlatformSavedSearchOpenEvidence,
        target?: NonNullable<JobRecord['searchSettings']>['coreSavedSearchTarget'],
      ) => Promise<void>;
      releaseBrowserPhase?: () => Promise<void>;
    },
  ) => Promise<CaptureFlowResult>;
  exportResults: (platform: SupportedPlatform, jobKey: string) => Promise<ExportJobResultsSummary>;
  sendJobReport: (platform: SupportedPlatform, jobKey: string, delivery: ReportDeliveryOptions) => Promise<SendJobReportSummary>;
  sendBossRoutedReports: (jobKey: string) => Promise<SendBossRoutedReportsSummary>;
  sendPostScoreRoutedReports: (platform: SupportedPlatform, jobKey: string) => Promise<SendPostScoreRoutedReportsSummary>;
  report: (summary: MainRunSummary) => void;
  warn: (message: string) => void;
  reportError: (message: string) => void;
  now: () => string;
}

export async function preflightCaptureRun(
  inputs: readonly RunnableJobInput[],
  platforms: readonly SupportedPlatform[],
  dependencies: Pick<CaptureRunnerDependencies,
    | 'createStore'
    | 'resolveContext'
    | 'resolveForwarding'
    | 'resolveScreening'
    | 'resolveRouting'
    | 'assertScreeningPreflight'
    | 'assertRoutingPreflight'
    | 'readTextFile'> & {
      buildSinglePlatformInput: (input: RunnableJobInput, platform: SupportedPlatform) => SinglePlatformCliInput;
      preflightRuntimes?: (platforms: readonly SupportedPlatform[]) => Promise<void>;
    },
): Promise<CaptureExecutionPlan[]> {
  const store = dependencies.createStore();
  const checks = inputs.flatMap((input, inputIndex) => platforms.map(async (platform) => {
    try {
      const platformInput = dependencies.buildSinglePlatformInput(input, platform);
      const context = await dependencies.resolveContext(platformInput, store);

      if (!context.existingJobRecord && !platformInput.jobDescriptionText && !platformInput.jobDescriptionFilePath) {
        throw new Error('Missing required argument --jd or --jd-file');
      }
      if (!context.existingJobRecord && platformInput.jobDescriptionFilePath) {
        await dependencies.readTextFile(platformInput.jobDescriptionFilePath);
      }
      const forwarding = dependencies.resolveForwarding(platformInput, context.existingJobRecord);
      const screening = await dependencies.resolveScreening(platformInput, context.existingJobRecord);
      const routing = await dependencies.resolveRouting(platformInput, context.existingJobRecord);
      const storedDelivery: ReportDeliveryOptions = context.existingJobRecord
        ? {
          recipientEmail: context.existingJobRecord.recipientEmail,
          ccEmails: context.existingJobRecord.ccEmails,
        }
        : {};
      const delivery = resolveReportDelivery(storedDelivery, platformInput);
      dependencies.assertScreeningPreflight(platform, forwarding, delivery, screening);
      dependencies.assertRoutingPreflight(platform, delivery, routing);
      const target = platform !== 'boss' || platformInput.bossCaptureTaskSnapshot
        ? resolvePlatformCaptureTarget({
          request: buildPlatformCaptureTargetRequest(input, platformInput),
          platformInput,
          context,
        })
        : undefined;
      return { inputIndex, platform, target };
    } catch (error) {
      return { inputIndex, keyword: input.searchKeyword, platform, error };
    }
  }));
  const checkResults = await Promise.all(checks);
  const failures = checkResults.filter((failure): failure is {
    inputIndex: number;
    keyword: string;
    platform: SupportedPlatform;
    error: unknown;
  } => 'error' in failure);

  if (failures.length > 0) {
    const details = failures.map(({ keyword, platform, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `- ${keyword} / ${platform}: ${message}`;
    });
    throw new Error(`Capture preflight failed before opening a browser:\n${details.join('\n')}`);
  }

  const plans: CaptureExecutionPlan[] = [];
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const targets = checkResults
      .filter((result): result is { inputIndex: number; platform: SupportedPlatform; target: ResolvedPlatformCaptureTarget } =>
        !('error' in result) && result.inputIndex === inputIndex && result.target !== undefined)
      .map((result) => result.target);
    if (targets.length === platforms.length) {
      plans.push(buildCaptureExecutionPlan({
        displayLabel: inputs[inputIndex]!.searchKeyword,
        platformOrder: platforms,
        targets,
      }));
    }
  }
  await (dependencies.preflightRuntimes ?? preflightPlatformRuntimeManifests)(platforms);
  return plans;
}

export async function runSinglePlatformCapture(
  input: SinglePlatformCliInput,
  dependencies: CaptureRunnerDependencies,
  options: { printSummary: boolean } = { printSummary: true },
): Promise<MainRunSummary> {
  const platformAdapter = dependencies.resolvePlatformAdapter(input.platform);
  const store = dependencies.createStore();
  const captureContext = await dependencies.resolveContext(input, store);
  const { jobKey, searchSettings, pageKeyword } = captureContext;
  let existingJobRecord = captureContext.existingJobRecord;
  const fetchedAt = dependencies.now();
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
  const bossForwarding = dependencies.resolveForwarding(input, existingJobRecord);
  const bossScreening = await dependencies.resolveScreening(input, existingJobRecord);
  const postScoreRouting = await dependencies.resolveRouting(input, existingJobRecord);

  if (!existingJobRecord && !input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error('Missing required argument --jd or --jd-file');
  }

  const jobDescriptionText = existingJobRecord
    ? existingJobRecord.rawText
    : input.jobDescriptionText ?? await dependencies.readTextFile(input.jobDescriptionFilePath!);
  const normalizedJob = existingJobRecord
    ? existingJobRecord.normalizedJob
    : await dependencies.parseJobDescription(jobDescriptionText);
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
      ...(input.platform === 'boss' ? {} : {
        jobIdentity: {
          version: 1 as const,
          expectedJobName: input.searchKeyword.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
          nameAuthority: 'user-confirmed' as const,
        },
      }),
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

  let jobRecord: JobRecord = {
    ...effectiveJobRecord,
    recipientEmail: persistedDelivery.recipientEmail,
    ccEmails: persistedDelivery.ccEmails,
  };

  dependencies.assertScreeningPreflight(input.platform, bossForwarding, delivery, bossScreening);
  dependencies.assertRoutingPreflight(input.platform, delivery, postScoreRouting);

  if (!input.bossCaptureTaskSnapshot || !existingJobRecord) {
    const recordToPersist = !existingJobRecord
      && input.platform !== 'boss'
      && jobRecord.searchSettings?.coreSavedSearchTarget
      ? {
        ...jobRecord,
        searchSettings: {
          ...jobRecord.searchSettings,
          coreSavedSearchTarget: undefined,
        },
      }
      : jobRecord;
    await store.saveJobRecord(input.platform, recordToPersist, !existingJobRecord && input.platform !== 'boss'
      ? { identityWriteAuthority: 'new-capture' }
      : {});
    jobRecord = recordToPersist;
  }

  if (!dependencies.isExtractionAdapterAvailable()) {
    dependencies.warn('Crawl4AI adapter unavailable at startup; continuing with built-in extraction only.');
  }

  let bossSearchLease: ReleaseHandle | undefined;
  let session: BrowserSession | undefined;
  const releaseBrowserPhase = async (): Promise<void> => {
    try {
      if (bossSearchLease) {
        const ownedLease = bossSearchLease;
        bossSearchLease = undefined;
        await ownedLease.release();
      }
    } finally {
      if (session) {
        const ownedSession = session;
        session = undefined;
        await dependencies.closeSession(ownedSession);
      }
    }
  };

  try {
    session = await dependencies.openSession(platformAdapter.platform);
    if (input.platform === 'boss') bossSearchLease = await dependencies.acquireBossSearchLease();
    const { candidates, capturedCandidateIds, runResult, resultPath } = await dependencies.runCaptureFlow(
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
        ...(searchSettings.coreSavedSearchTarget
          ? { coreSavedSearchTarget: searchSettings.coreSavedSearchTarget }
          : {}),
        ...(captureContext.prospectiveCoreSavedSearchRequest
          ? { coreSavedSearchVerificationRequest: captureContext.prospectiveCoreSavedSearchRequest }
          : {}),
        ...(searchSettings.sortPolicy ? { sortPolicy: searchSettings.sortPolicy } : {}),
        reportDelivery: delivery,
        secondaryReportDelivery: bossScreening?.secondaryDelivery ?? postScoreRouting?.secondaryDelivery,
        searchExecution: captureContext.searchExecution,
        ...(!existingJobRecord
          && (searchSettings.coreSavedSearchTarget || captureContext.prospectiveCoreSavedSearchRequest) ? {
          onSavedSearchOpenEvidence: async (
            evidence: PlatformSavedSearchOpenEvidence,
            discoveredTarget?: NonNullable<JobRecord['searchSettings']>['coreSavedSearchTarget'],
          ) => {
            const target = searchSettings.coreSavedSearchTarget ?? discoveredTarget;
            if (!target) {
              throw new Error('Prospective saved-search verification did not return an executable target.');
            }
            if (evidence.targetFingerprint !== target.targetFingerprint) {
              throw new Error('Prospective saved-search evidence fingerprint does not match the planned target.');
            }
            jobRecord = await store.applyJobConfigPatch(
              input.platform,
              jobKey,
              jobRecord.revision ?? 1,
              { coreSavedSearchTarget: target },
            );
          },
        } : {}),
        releaseBrowserPhase,
      },
    );

    let exportSummary: ExportJobResultsSummary | undefined;
    let exportError: string | undefined;
    let emailSummary: SendJobReportSummary | undefined;
    let routedReportSummary: SendBossRoutedReportsSummary | undefined;
    let genericRoutedReportSummary: SendPostScoreRoutedReportsSummary | undefined;
    let routedMainRunEmailSummary: ReturnType<typeof buildBossRoutedMainRunEmailSummary> | undefined;
    let emailError: string | undefined;

    const emailPromise: Promise<SendJobReportSummary | SendBossRoutedReportsSummary | SendPostScoreRoutedReportsSummary> | undefined = runResult.bossRouting?.enabled
      ? dependencies.sendBossRoutedReports(jobKey)
      : runResult.postScoreRouting?.enabled
        ? dependencies.sendPostScoreRoutedReports(input.platform, jobKey)
        : delivery.recipientEmail
          ? dependencies.sendJobReport(input.platform, jobKey, delivery)
          : undefined;

    const [exportResult, emailResult] = await Promise.allSettled([
      dependencies.exportResults(input.platform, jobKey),
      emailPromise,
    ]);

    if (exportResult.status === 'fulfilled') {
      exportSummary = exportResult.value;
    } else {
      exportError = exportResult.reason instanceof Error ? exportResult.reason.message : String(exportResult.reason);
      dependencies.reportError(exportError);
    }

    if (emailResult?.status === 'fulfilled' && emailResult.value) {
      if ('reportDeliveries' in emailResult.value) {
        if (runResult.bossRouting?.enabled) {
          routedReportSummary = emailResult.value;
          routedMainRunEmailSummary = buildBossRoutedMainRunEmailSummary(
            routedReportSummary.reportDeliveries,
            runResult.bossRouting,
          );
        } else {
          genericRoutedReportSummary = emailResult.value;
          routedMainRunEmailSummary = buildBossRoutedMainRunEmailSummary(genericRoutedReportSummary.reportDeliveries);
        }
      } else {
        emailSummary = emailResult.value;
      }
    } else if (emailResult?.status === 'rejected') {
      emailError = emailResult.reason instanceof Error ? emailResult.reason.message : String(emailResult.reason);
      dependencies.reportError(emailError);
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
      ...(routedReportSummary?.rejectionEmails ? { rejectionEmails: routedReportSummary.rejectionEmails } : {}),
      ...(genericRoutedReportSummary ? { reportDeliveries: genericRoutedReportSummary.reportDeliveries } : {}),
      sampleCandidateIds: capturedCandidateIds.slice(0, 10),
      ...(captureContext.searchExecution ? {
        searchExecution: runResult.searchExecution,
        ...(captureContext.bossJobId ? { bossJobId: captureContext.bossJobId } : {}),
      } : {}),
    };

    if (options.printSummary) dependencies.report(summary);
    return summary;
  } finally {
    await releaseBrowserPhase();
  }
}
