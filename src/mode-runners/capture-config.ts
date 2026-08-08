import { buildJobKey } from '../parsers/jd-parser.js';
import { resolveBossCapturePlan } from '../platforms/boss/capture-plan.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { assertDeliverableEmailAddress, assertEmailAddressSyntax, assertSmtpConfigurationReady, sendJobReportEmail } from '../reporting/mailer.js';
import {
  assertBossScreeningJobRecordReady,
  loadPostScoreRoutingPolicyFile,
  normalizePostScoreRoutingSettings,
  resolveBossCaptureForwardingSettings,
  resolveBossCaptureScreeningSettings,
} from '../scoring/boss-screening.js';
import { buildApplicationFilterConditions, loadApplicationFilterInputFile } from '../search/search-subscription.js';
import { SearchConditionSetService } from '../search/search-condition-sets.js';
import { sendJobReportEmailRef } from '../scripts/send-job-report-email.js';
import type { JobStore } from '../storage/job-store.js';
import type {
  BossForwardingSettings,
  BossScreeningSettings,
  JobRecord,
  PostScoreRoutingSettings,
  ReportDeliveryOptions,
  RunResult,
} from '../types/job.js';
import type { ResolvedResumeCaptureContext } from './capture-runner.js';
import type { RunnableJobInput, SinglePlatformCliInput } from './types.js';

export function buildSinglePlatformInput(input: RunnableJobInput, platform: SupportedPlatform): SinglePlatformCliInput {
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

/**
 * Resolve persistence identity before browser work. Boss has a stable position
 * identity and an independent page query; all other platforms retain their
 * existing keyword-as-query behavior.
 */
export async function resolveResumeCaptureContext(
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

export function resolveBossForwardingSettings(
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
export async function resolveBossScreeningSettings(
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
export async function resolvePostScoreRoutingSettings(
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

export function assertBossScreeningPreflight(
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
  const rejectionDelivery = screening.secondaryDelivery!;
  try {
    assertEmailAddressSyntax(rejectionDelivery.recipientEmail, 'Boss rejection email recipient');
    for (const [index, ccEmail] of (rejectionDelivery.ccEmails ?? []).entries()) {
      assertEmailAddressSyntax(ccEmail, `Boss rejection email cc[${index}]`);
    }
    if (sendJobReportEmailRef.fn === sendJobReportEmail) {
      assertDeliverableEmailAddress(rejectionDelivery.recipientEmail, 'Boss rejection email recipient');
      for (const [index, ccEmail] of (rejectionDelivery.ccEmails ?? []).entries()) {
        assertDeliverableEmailAddress(ccEmail, `Boss rejection email cc[${index}]`);
      }
      assertSmtpConfigurationReady();
    }
  } catch (error) {
    const message = error instanceof Error && error.message === 'SMTP configuration is incomplete'
      ? 'Boss rejection email SMTP configuration is incomplete.'
      : 'Boss rejection email recipient or CC is not deliverable.';
    throw new Error(message);
  }
}

export function assertPostScoreRoutingPreflight(
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
