import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveBossCapturePlan,
  type BossCapturePlanOptions,
  type ResolvedBossCapturePlan,
  type ResolveBossCapturePlanInput,
} from '../platforms/boss/capture-plan.js';
export { hashBossCaptureTaskSnapshot } from '../platforms/boss/capture-snapshot.js';
import { hashBossCaptureTaskSnapshot } from '../platforms/boss/capture-snapshot.js';
import type { SearchConditionSetService } from '../search/search-condition-sets.js';
import { buildApplicationFilterConditions, loadApplicationFilterInputFile } from '../search/search-subscription.js';
import { createBossCaptureSettingsSnapshot } from '../scoring/boss-screening.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossCaptureCanonicalPatch,
  BossCaptureTaskSnapshot,
  BossCaptureSettingsSnapshot,
} from '../types/job.js';
import {
  normalizeBatchTask,
  normalizeResumeCaptureTask,
  type NormalizedTask,
} from './task-normalizers.js';
import type { BatchTaskInput, ResumeCaptureTaskInput } from './types.js';

export type BossCapturePlanResolver = (
  input: ResolveBossCapturePlanInput,
  options?: BossCapturePlanOptions,
) => Promise<ResolvedBossCapturePlan>;

export interface BossCaptureSnapshotOptions {
  resolveBossCapturePlan?: BossCapturePlanResolver;
  store?: BossCapturePlanOptions['store'];
  /** Data root used when the server does not inject a plan store (tests/API isolation). */
  dataDir?: string;
  searchConditionSets: Pick<SearchConditionSetService, 'resolve'>;
}

function selectsBossStage(input: ResumeCaptureTaskInput): boolean {
  return input.platform === 'boss' || (input.platform === 'all' && input.includeBoss === true);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalPatchFromInput(
  input: ResumeCaptureTaskInput,
  plan: ResolvedBossCapturePlan,
  settings: BossCaptureSettingsSnapshot,
): BossCaptureCanonicalPatch | undefined {
  const patch: BossCaptureCanonicalPatch = {};
  if (input.email !== undefined) patch.recipientEmail = input.email;
  if (input.cc !== undefined) patch.ccEmails = [...input.cc];

  const hasForwardingInput = input.bossForwardMode !== undefined
    || input.bossForwardRecipient !== undefined
    || input.bossForwardCc !== undefined;
  if (hasForwardingInput) {
    patch.bossForwarding = settings.primaryForwarding ? clone(settings.primaryForwarding) : null;
  }

  const hasScreeningInput = input.bossScreeningEnabled !== undefined
    || input.bossScreeningPolicyFile !== undefined
    || input.bossSecondaryEmail !== undefined
    || input.bossSecondaryCc !== undefined;
  if (hasScreeningInput) {
    patch.bossScreening = settings.screening ? clone(settings.screening) : null;
  }

  if (input.searchSource !== undefined) patch.searchSource = plan.search.source;
  if (input.bossSearchKeyword !== undefined) patch.pageKeyword = plan.search.pageKeyword;
  const replacesSearchWithDirect = plan.search.source === 'direct' && (
    input.searchSource !== undefined
    || input.applicationFilterInputFile !== undefined
    || input.bossSearchConditionSetRef !== undefined
    || input.searchConditionSetRefs?.boss !== undefined
  );
  if (replacesSearchWithDirect) {
    patch.savedSearch = null;
  } else if (input.bossSavedSearchReference !== undefined) {
    patch.savedSearch = plan.search.savedSearch ? clone(plan.search.savedSearch) : null;
  }
  if (input.applicationFilterInputFile !== undefined) {
    patch.applicationFilterInput = plan.search.applicationFilterInput
      ? clone(plan.search.applicationFilterInput)
      : null;
    patch.conditions = clone(plan.search.conditions);
    patch.conditionSetRef = plan.search.conditionSetRef ? clone(plan.search.conditionSetRef) : null;
    patch.selectedFieldsFingerprint = plan.search.selectedFieldsFingerprint ?? null;
  }
  if (input.bossSearchConditionSetRef !== undefined || input.searchConditionSetRefs?.boss !== undefined) {
    patch.conditionSetRef = plan.search.conditionSetRef ? clone(plan.search.conditionSetRef) : null;
    patch.conditions = clone(plan.search.conditions);
    patch.applicationFilterInput = plan.search.applicationFilterInput
      ? clone(plan.search.applicationFilterInput)
      : null;
    patch.selectedFieldsFingerprint = plan.search.selectedFieldsFingerprint ?? null;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function makeBossCaptureTaskSnapshot(input: {
  normalizedInput: ResumeCaptureTaskInput;
  plan: ResolvedBossCapturePlan;
  settings: BossCaptureSettingsSnapshot;
  sourceJobsFile?: string;
  sourceItemIndex?: number;
}): BossCaptureTaskSnapshot {
  const { normalizedInput, plan, settings } = input;
  const canonicalPatch = canonicalPatchFromInput(normalizedInput, plan, settings);
  const unsigned: Omit<BossCaptureTaskSnapshot, 'snapshotHash'> = {
    version: 4,
    resolvedAt: settings.resolvedAt,
    sourceJobKey: plan.jobKey,
    ...(plan.jobRecord?.revision !== undefined ? { sourceJobRevision: plan.jobRecord.revision } : {}),
    ...(input.sourceJobsFile ? { sourceJobsFile: path.resolve(input.sourceJobsFile) } : {}),
    ...(input.sourceItemIndex !== undefined ? { sourceItemIndex: input.sourceItemIndex } : {}),
    jobIdentity: {
      ...(plan.bossJobId ? { bossJobId: plan.bossJobId } : {}),
      expectedJobName: plan.expectedJobName,
    },
    searchPlan: {
      source: plan.search.source,
      pageKeyword: plan.search.pageKeyword,
      keywordSource: plan.search.keywordSource,
      ...(plan.search.conditionSetRef ? { conditionSetRef: clone(plan.search.conditionSetRef) } : {}),
      ...(plan.search.selectedFieldsFingerprint
        ? { selectedFieldsFingerprint: plan.search.selectedFieldsFingerprint }
        : {}),
      ...(plan.search.savedSearch ? { savedSearch: clone(plan.search.savedSearch) } : {}),
      ...(plan.search.sortPolicy ? { sortPolicy: plan.search.sortPolicy } : {}),
      ...(plan.search.applicationFilterInput
        ? { applicationFilterInput: clone(plan.search.applicationFilterInput) }
        : {}),
      conditions: clone(plan.search.conditions),
    },
    deliveryAndScreening: {
      ...(settings.primaryForwarding ? { primaryForwarding: clone(settings.primaryForwarding) } : {}),
      primaryDelivery: clone(settings.primaryDelivery),
      ...(settings.screening ? { screening: clone(settings.screening) } : {}),
    },
    ...(canonicalPatch ? { canonicalPatch } : {}),
  };
  return {
    ...unsigned,
    snapshotHash: hashBossCaptureTaskSnapshot(unsigned),
  };
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
  const resolver = options.resolveBossCapturePlan ?? resolveBossCapturePlan;
  const planStore = options.store ?? new JobStore(options.dataDir);
  const applicationFilterInput = normalized.input.applicationFilterInputFile
    ? await loadApplicationFilterInputFile(normalized.input.applicationFilterInputFile)
    : undefined;
  const explicitSearchSettings = applicationFilterInput
    ? {
      source: normalized.input.searchSource ?? 'direct' as const,
      applicationFilterInput,
      conditions: await buildApplicationFilterConditions('boss', applicationFilterInput, {}),
    }
    : undefined;
  const plan = await resolver({
    jobName: normalized.input.keyword,
    ...(normalized.input.bossJobId ? { bossJobId: normalized.input.bossJobId } : {}),
    ...(normalized.input.bossSearchKeyword ? { bossSearchKeyword: normalized.input.bossSearchKeyword } : {}),
    ...(normalized.input.bossSavedSearchReference ? { savedSearchReference: clone(normalized.input.bossSavedSearchReference) } : {}),
    ...(normalized.input.searchSource ? { searchSource: normalized.input.searchSource } : {}),
    searchSourceExplicit: normalized.input.searchSource !== undefined,
    ...(explicitBossConditionSetRef ? { searchConditionSetRef: explicitBossConditionSetRef } : {}),
    ...(explicitSearchSettings ? { explicitSearchSettings } : {}),
  }, {
    store: planStore,
    searchConditionSets: options.searchConditionSets,
  });

  const needsBossPageKeywordSnapshot = normalized.input.bossSearchKeyword !== undefined
    || plan.search.pageKeyword !== normalized.input.keyword;
  const bossCaptureSettingsSnapshot = await createBossCaptureSettingsSnapshot({
    overrides: {
      recipientEmail: normalized.input.email,
      ccEmails: normalized.input.cc,
      bossForwardMode: normalized.input.bossForwardMode,
      bossForwardRecipient: normalized.input.bossForwardRecipient,
      bossForwardCc: normalized.input.bossForwardCc,
      bossScreeningEnabled: normalized.input.bossScreeningEnabled,
      bossScreeningPolicyFile: normalized.input.bossScreeningPolicyFile,
      bossSecondaryEmail: normalized.input.bossSecondaryEmail,
      bossSecondaryCc: normalized.input.bossSecondaryCc,
    },
    ...(plan.jobRecord ? { existingJobRecord: plan.jobRecord } : {}),
    sourceJobKey: plan.jobKey,
  });
  const bossCaptureTaskSnapshot = makeBossCaptureTaskSnapshot({
    normalizedInput: normalized.input,
    plan,
    settings: bossCaptureSettingsSnapshot,
  });
  const input: ResumeCaptureTaskInput = {
    ...normalized.input,
    ...(plan.bossJobId ? { bossJobId: plan.bossJobId } : {}),
    ...(needsBossPageKeywordSnapshot ? { bossSearchKeyword: plan.search.pageKeyword } : {}),
    ...(plan.search.savedSearch ? { bossSavedSearchReference: clone(plan.search.savedSearch) } : {}),
    // An explicit client condition set already has an immutable public
    // representation. Only saved/reused settings require this private
    // Boss-only snapshot field.
    ...(!explicitBossConditionSetRef && plan.search.conditionSetRef
      ? { bossSearchConditionSetRef: plan.search.conditionSetRef }
      : {}),
    bossCaptureSettingsSnapshot,
    bossCaptureTaskSnapshot,
  };
  const snapshot = normalizeResumeCaptureTask(input, {
    allowBossSearchConditionSetRef: true,
    allowBossSavedSearchReference: true,
    allowBossCaptureSettingsSnapshot: true,
    allowBossCaptureTaskSnapshot: true,
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
    bossCaptureTaskSnapshotHash: bossCaptureTaskSnapshot.snapshotHash,
    bossCaptureTaskSnapshotVersion: bossCaptureTaskSnapshot.version,
    ...(bossCaptureTaskSnapshot.sourceJobRevision !== undefined
      ? { bossCaptureTaskSnapshotSourceJobRevision: bossCaptureTaskSnapshot.sourceJobRevision }
      : {}),
  };
  return snapshot;
}

function itemValue(item: Record<string, unknown>, field: string, fallback: unknown): unknown {
  return item[field] === undefined ? fallback : item[field];
}

function resolvedItemPolicyPath(
  item: Record<string, unknown>,
  jobsFilePath: string,
  fallback: string | undefined,
): unknown {
  const value = item.bossScreeningPolicyFile;
  if (value === undefined) {
    return fallback === undefined
      ? undefined
      : path.resolve(path.dirname(path.resolve(jobsFilePath)), fallback);
  }
  return typeof value === 'string' && value.trim()
    ? path.resolve(path.dirname(path.resolve(jobsFilePath)), value)
    : value;
}

function resolvedItemResultRoutingPolicyPath(
  item: Record<string, unknown>,
  jobsFilePath: string,
  fallback: string | undefined,
): unknown {
  const value = item.resultRoutingPolicyFile;
  if (value === undefined) {
    return fallback === undefined ? undefined : path.resolve(fallback);
  }
  if (typeof value !== 'string' || !value.trim()) return value;
  return path.resolve(path.dirname(jobsFilePath), value);
}

function resolvedItemInputPath(
  item: Record<string, unknown>,
  jobsFilePath: string,
  fallback: string | undefined,
): string | undefined {
  const value = item.applicationFilterInputFile;
  if (value === undefined) {
    return fallback === undefined
      ? undefined
      : path.resolve(path.dirname(path.resolve(jobsFilePath)), fallback);
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return path.resolve(path.dirname(path.resolve(jobsFilePath)), value);
}

function itemBossConditionSetRef(item: Record<string, unknown>): unknown {
  const refs = item.searchConditionSets;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return undefined;
  const value = (refs as Record<string, unknown>).boss;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return {
    ...(value as Record<string, unknown>),
    platform: 'boss',
  };
}

/**
 * Materializes an immutable jobs-file copy whose Boss items contain the exact
 * confirmed delivery and screening snapshot. Core-platform job fields remain
 * byte-for-byte equivalent JSON values and continue using normal batch rules.
 */
export async function snapshotBossBatchCaptureSettings(
  normalized: NormalizedTask<BatchTaskInput>,
  options: BossCaptureSnapshotOptions & { dataDir: string },
): Promise<NormalizedTask<BatchTaskInput>> {
  if (!(normalized.input.platform === 'boss'
    || (normalized.input.platform === 'all' && normalized.input.includeBoss === true))) {
    return normalized;
  }

  const jobsFilePath = path.resolve(normalized.input.jobsFile);
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(jobsFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in jobs file ${normalized.input.jobsFile}: ${error.message}`);
    }
    throw error;
  }
  if (!Array.isArray(payload)) {
    throw new Error(`Batch jobs file ${normalized.input.jobsFile} must contain a JSON array`);
  }

  const resolver = options.resolveBossCapturePlan ?? resolveBossCapturePlan;
  const planStore = options.store ?? new JobStore(options.dataDir);
  const snapshottedItems = await Promise.all(payload.map(async (value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid jobs-file item at index ${index}: item must be an object`);
    }
    const item = value as Record<string, unknown>;
    if (item.bossCaptureSettingsSnapshot !== undefined || item.bossCaptureTaskSnapshot !== undefined) {
      throw new Error(`Invalid jobs-file item at index ${index}: Boss capture snapshots are reserved for server-created snapshots`);
    }
    const synthetic = normalizeResumeCaptureTask({
      platform: 'boss',
      keyword: item.keyword,
      bossJobId: item.bossJobId,
      bossSearchKeyword: item.bossSearchKeyword,
      bossSavedSearchReference: item.bossSavedSearchReference,
      searchSource: itemValue(item, 'searchSource', normalized.input.searchSource),
      applicationFilterInputFile: resolvedItemInputPath(
        item,
        jobsFilePath,
        normalized.input.applicationFilterInputFile,
      ),
      searchConditionSetRefs: (() => {
        const bossReference = itemBossConditionSetRef(item) ?? normalized.input.searchConditionSetRefs?.boss;
        return bossReference ? { boss: bossReference } : undefined;
      })(),
      email: itemValue(item, 'email', normalized.input.email),
      cc: itemValue(item, 'cc', normalized.input.cc),
      bossForwardMode: itemValue(item, 'bossForwardMode', normalized.input.bossForwardMode),
      bossForwardRecipient: itemValue(item, 'bossForwardRecipient', normalized.input.bossForwardRecipient),
      bossForwardCc: itemValue(item, 'bossForwardCc', normalized.input.bossForwardCc),
      bossScreeningEnabled: itemValue(item, 'bossScreeningEnabled', normalized.input.bossScreeningEnabled),
      bossScreeningPolicyFile: resolvedItemPolicyPath(item, jobsFilePath, normalized.input.bossScreeningPolicyFile),
      bossSecondaryEmail: itemValue(item, 'bossSecondaryEmail', normalized.input.bossSecondaryEmail),
      bossSecondaryCc: itemValue(item, 'bossSecondaryCc', normalized.input.bossSecondaryCc),
    });
    const explicitBossConditionSetRef = synthetic.input.searchConditionSetRefs?.boss;
    const itemApplicationFilterInput = synthetic.input.applicationFilterInputFile
      ? await loadApplicationFilterInputFile(synthetic.input.applicationFilterInputFile)
      : undefined;
    const explicitSearchSettings = itemApplicationFilterInput
      ? {
        source: synthetic.input.searchSource ?? 'direct' as const,
        applicationFilterInput: itemApplicationFilterInput,
        conditions: await buildApplicationFilterConditions('boss', itemApplicationFilterInput, {}),
      }
      : undefined;
    const plan = await resolver({
      jobName: synthetic.input.keyword,
      ...(synthetic.input.bossJobId ? { bossJobId: synthetic.input.bossJobId } : {}),
      ...(synthetic.input.bossSearchKeyword ? { bossSearchKeyword: synthetic.input.bossSearchKeyword } : {}),
      ...(synthetic.input.bossSavedSearchReference
        ? { savedSearchReference: clone(synthetic.input.bossSavedSearchReference) }
        : {}),
      ...(synthetic.input.searchSource ? { searchSource: synthetic.input.searchSource } : {}),
      searchSourceExplicit: item.searchSource !== undefined || normalized.input.searchSource !== undefined,
      ...(explicitBossConditionSetRef ? { searchConditionSetRef: explicitBossConditionSetRef } : {}),
      ...(explicitSearchSettings ? { explicitSearchSettings } : {}),
    }, {
      store: planStore,
      searchConditionSets: options.searchConditionSets,
    });
    const snapshot = await createBossCaptureSettingsSnapshot({
      overrides: {
        recipientEmail: synthetic.input.email,
        ccEmails: synthetic.input.cc,
        bossForwardMode: synthetic.input.bossForwardMode,
        bossForwardRecipient: synthetic.input.bossForwardRecipient,
        bossForwardCc: synthetic.input.bossForwardCc,
        bossScreeningEnabled: synthetic.input.bossScreeningEnabled,
        bossScreeningPolicyFile: synthetic.input.bossScreeningPolicyFile,
        bossSecondaryEmail: synthetic.input.bossSecondaryEmail,
        bossSecondaryCc: synthetic.input.bossSecondaryCc,
      },
      ...(plan.jobRecord ? { existingJobRecord: plan.jobRecord } : {}),
      sourceJobKey: plan.jobKey,
    });
    const taskSnapshot = makeBossCaptureTaskSnapshot({
      normalizedInput: synthetic.input,
      plan,
      settings: snapshot,
      sourceJobsFile: jobsFilePath,
      sourceItemIndex: index,
    });
    return {
      ...item,
      ...(synthetic.input.applicationFilterInputFile
        ? { applicationFilterInputFile: synthetic.input.applicationFilterInputFile }
        : {}),
      ...(synthetic.input.bossScreeningPolicyFile
        ? { bossScreeningPolicyFile: path.resolve(synthetic.input.bossScreeningPolicyFile) }
        : {}),
      ...(item.resultRoutingPolicyFile !== undefined || normalized.input.resultRoutingPolicyFile !== undefined
        ? { resultRoutingPolicyFile: resolvedItemResultRoutingPolicyPath(item, jobsFilePath, normalized.input.resultRoutingPolicyFile) }
        : {}),
      bossCaptureSettingsSnapshot: snapshot,
      bossCaptureTaskSnapshot: taskSnapshot,
    };
  }));

  const content = `${JSON.stringify(snapshottedItems, null, 2)}\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  const snapshotDir = path.join(options.dataDir, 'server', 'task-snapshots');
  await mkdir(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, `boss-batch-${digest}.json`);
  await writeFile(snapshotPath, content, 'utf8');
  const result = normalizeBatchTask({ ...normalized.input, jobsFile: snapshotPath });
  result.inputSummary = {
    ...result.inputSummary,
    sourceJobsFile: normalized.input.jobsFile,
    bossCaptureSettingsSnapshotCount: snapshottedItems.length,
    jobsSnapshotHash: digest,
  };
  return result;
}
