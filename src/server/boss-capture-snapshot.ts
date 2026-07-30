import {
  resolveBossCapturePlan,
  type BossCapturePlanOptions,
  type ResolvedBossCapturePlan,
  type ResolveBossCapturePlanInput,
} from '../platforms/boss/capture-plan.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import {
  normalizeResumeCaptureTask,
  type NormalizedTask,
} from './task-normalizers.js';
import type { ResumeCaptureTaskInput } from './types.js';

export type BossCapturePlanResolver = (
  input: ResolveBossCapturePlanInput,
  options?: BossCapturePlanOptions,
) => Promise<ResolvedBossCapturePlan>;

export interface BossCaptureSnapshotOptions {
  resolveBossCapturePlan?: BossCapturePlanResolver;
  store?: BossCapturePlanOptions['store'];
  searchConditionSets: Pick<SearchConditionSetService, 'resolve'>;
}

function selectsBossStage(input: ResumeCaptureTaskInput): boolean {
  return input.platform === 'boss' || (input.platform === 'all' && input.includeBoss === true);
}

/**
 * Resolve a reusable Boss job setting at the queue boundary and convert its
 * immutable condition-set revision into a Boss-only CLI channel. This leaves
 * global searchSource/searchConditionSetRefs untouched, so all+includeBoss
 * retains the independently resolved settings of the three core platforms.
 */
export async function snapshotBossCaptureSettings(
  normalized: NormalizedTask<ResumeCaptureTaskInput>,
  options: BossCaptureSnapshotOptions,
): Promise<NormalizedTask<ResumeCaptureTaskInput>> {
  if (!selectsBossStage(normalized.input)) {
    return normalized;
  }

  const explicitBossConditionSetRef = normalized.input.searchConditionSetRefs?.boss;
  // This public direct-search ref is already an immutable revision and must
  // retain the existing global direct-search argv behavior. Server snapshotting
  // is only necessary when it came from the stored Boss setting.
  if (explicitBossConditionSetRef) {
    return normalized;
  }

  const resolver = options.resolveBossCapturePlan ?? resolveBossCapturePlan;
  const plan = await resolver({
    jobName: normalized.input.keyword,
    ...(normalized.input.bossJobId ? { bossJobId: normalized.input.bossJobId } : {}),
    ...(normalized.input.bossSearchKeyword ? { bossSearchKeyword: normalized.input.bossSearchKeyword } : {}),
    ...(normalized.input.searchSource ? { searchSource: normalized.input.searchSource } : {}),
    searchSourceExplicit: normalized.input.searchSource !== undefined,
    ...(explicitBossConditionSetRef ? { searchConditionSetRef: explicitBossConditionSetRef } : {}),
  }, {
    ...(options.store ? { store: options.store } : {}),
    searchConditionSets: options.searchConditionSets,
  });

  const needsBossPageKeywordSnapshot = normalized.input.bossSearchKeyword !== undefined
    || plan.search.pageKeyword !== normalized.input.keyword;
  const input: ResumeCaptureTaskInput = {
    ...normalized.input,
    ...(plan.bossJobId ? { bossJobId: plan.bossJobId } : {}),
    ...(needsBossPageKeywordSnapshot ? { bossSearchKeyword: plan.search.pageKeyword } : {}),
    // An explicit client condition set already has an immutable public
    // representation. Only saved/reused settings require this private
    // Boss-only snapshot field.
    ...(!explicitBossConditionSetRef && plan.search.conditionSetRef
      ? { bossSearchConditionSetRef: plan.search.conditionSetRef }
      : {}),
  };
  const snapshot = normalizeResumeCaptureTask(input, {
    allowBossSearchConditionSetRef: true,
  });
  snapshot.inputSummary = {
    ...snapshot.inputSummary,
    bossJobKey: plan.jobKey,
    bossSearchSource: plan.search.source,
    bossKeywordSource: plan.search.keywordSource,
    ...(plan.search.conditionSetRef ? { bossConditionSetRef: plan.search.conditionSetRef } : {}),
    ...(plan.search.selectedFieldsFingerprint
      ? { bossSelectedFieldsFingerprint: plan.search.selectedFieldsFingerprint }
      : {}),
  };
  return snapshot;
}
