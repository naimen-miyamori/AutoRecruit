import { listCapturePlatforms } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import { JobStore } from '../storage/job-store.js';
import {
  buildCaptureExecutionEnvelope,
  buildCaptureExecutionPlan,
  buildPlatformCaptureTargetRequest,
  resolvePlatformCaptureTarget,
  type CaptureExecutionEnvelope,
} from '../mode-runners/capture-targets.js';
import { buildSinglePlatformInput, resolveResumeCaptureContext } from '../mode-runners/capture-config.js';
import { loadBatchJobInputs } from '../mode-runners/batch-input.js';
import type { BatchCliInput, RunnableJobInput, SingleJobCliInput } from '../mode-runners/types.js';
import type { BatchTaskInput, ResumeCaptureTaskInput } from './types.js';

function selectedPlatforms(
  platform: ResumeCaptureTaskInput['platform'],
  includeBoss: boolean,
): SupportedPlatform[] {
  return platform === 'all' ? listCapturePlatforms(includeBoss) : [platform];
}

function toRunnableInput(input: ResumeCaptureTaskInput): SingleJobCliInput {
  return {
    mode: 'single',
    platform: input.platform,
    searchKeyword: input.keyword,
    ...(input.bossJobId ? { bossJobId: input.bossJobId } : {}),
    ...(input.bossSearchKeyword ? { bossSearchKeyword: input.bossSearchKeyword } : {}),
    ...(input.bossSavedSearchReference ? { bossSavedSearchReference: input.bossSavedSearchReference } : {}),
    ...(input.bossSearchConditionSetRef ? { bossSearchConditionSetRef: input.bossSearchConditionSetRef } : {}),
    ...(input.jd ? { jobDescriptionText: input.jd } : {}),
    ...(input.jdFile ? { jobDescriptionFilePath: input.jdFile } : {}),
    includeViewedCandidates: input.includeViewed ?? false,
    includeBoss: input.includeBoss ?? false,
    recipientEmail: input.email,
    ccEmails: input.cc,
    liepinForwardContact: input.liepinForwardContact,
    bossForwardMode: input.bossForwardMode,
    bossForwardRecipient: input.bossForwardRecipient,
    bossForwardCc: input.bossForwardCc,
    bossScreeningEnabled: input.bossScreeningEnabled,
    bossScreeningPolicyFile: input.bossScreeningPolicyFile,
    bossSecondaryEmail: input.bossSecondaryEmail,
    bossSecondaryCc: input.bossSecondaryCc,
    resultRoutingEnabled: input.resultRoutingEnabled,
    resultRoutingPolicyFile: input.resultRoutingPolicyFile,
    secondaryEmail: input.secondaryEmail,
    secondaryCc: input.secondaryCc,
    bossCaptureSettingsSnapshot: input.bossCaptureSettingsSnapshot,
    bossCaptureTaskSnapshot: input.bossCaptureTaskSnapshot,
    searchSource: input.searchSource ?? 'saved',
    searchSourceExplicit: input.searchSource !== undefined,
    applicationFilterInputFilePath: input.applicationFilterInputFile,
    searchConditionSetRefs: input.searchConditionSetRefs,
  };
}

function toBatchCliInput(input: BatchTaskInput): BatchCliInput {
  return {
    mode: 'batch',
    platform: input.platform,
    jobsFilePath: input.jobsFile,
    includeViewedCandidates: input.includeViewed ?? false,
    includeBoss: input.includeBoss ?? false,
    recipientEmail: input.email,
    ccEmails: input.cc,
    liepinForwardContact: input.liepinForwardContact,
    bossForwardMode: input.bossForwardMode,
    bossForwardRecipient: input.bossForwardRecipient,
    bossForwardCc: input.bossForwardCc,
    bossScreeningEnabled: input.bossScreeningEnabled,
    bossScreeningPolicyFile: input.bossScreeningPolicyFile,
    bossSecondaryEmail: input.bossSecondaryEmail,
    bossSecondaryCc: input.bossSecondaryCc,
    resultRoutingEnabled: input.resultRoutingEnabled,
    resultRoutingPolicyFile: input.resultRoutingPolicyFile,
    secondaryEmail: input.secondaryEmail,
    secondaryCc: input.secondaryCc,
    searchSource: input.searchSource ?? 'saved',
    searchSourceExplicit: input.searchSource !== undefined,
    applicationFilterInputFilePath: input.applicationFilterInputFile,
    searchConditionSetRefs: input.searchConditionSetRefs,
  };
}

async function resolvePlans(input: {
  jobs: readonly RunnableJobInput[];
  platforms: readonly SupportedPlatform[];
  dataDir: string;
  searchConditionSets: Pick<SearchConditionSetService, 'resolve'>;
}) {
  const store = new JobStore(input.dataDir);
  const plans = [];
  for (const job of input.jobs) {
    const targets = [];
    for (const platform of input.platforms) {
      const platformInput = buildSinglePlatformInput(job, platform);
      const context = await resolveResumeCaptureContext(platformInput, store, {
        searchConditionSets: input.searchConditionSets,
      });
      targets.push(resolvePlatformCaptureTarget({
        request: buildPlatformCaptureTargetRequest(job, platformInput),
        platformInput,
        context,
      }));
    }
    plans.push(buildCaptureExecutionPlan({
      displayLabel: job.searchKeyword,
      platformOrder: input.platforms,
      targets,
    }));
  }
  return plans;
}

export async function buildServerCaptureExecutionEnvelope(
  kind: 'resume-capture' | 'batch',
  taskInput: ResumeCaptureTaskInput | BatchTaskInput,
  options: {
    dataDir: string;
    searchConditionSets: Pick<SearchConditionSetService, 'resolve'>;
  },
): Promise<CaptureExecutionEnvelope> {
  if (kind === 'resume-capture') {
    const input = toRunnableInput(taskInput as ResumeCaptureTaskInput);
    const platforms = selectedPlatforms(input.platform, input.includeBoss);
    return buildCaptureExecutionEnvelope(await resolvePlans({
      jobs: [input], platforms, ...options,
    }));
  }

  const input = toBatchCliInput(taskInput as BatchTaskInput);
  const platforms = selectedPlatforms(input.platform, input.includeBoss);
  const jobs = await loadBatchJobInputs(input, {
    listSelectedPlatforms: selectedPlatforms,
  });
  return buildCaptureExecutionEnvelope(await resolvePlans({ jobs, platforms, ...options }));
}
