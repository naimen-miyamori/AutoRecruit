import { buildJobKey } from '../../parsers/jd-parser.js';
import {
  SearchConditionSetService,
  type SearchConditionSetReference,
} from '../../search/search-condition-sets.js';
import { JobStore } from '../../storage/job-store.js';
import type { JobRecord, JobSearchSource, SearchCondition } from '../../types/job.js';

/** Identifies why the exact query text was selected for a Boss search page. */
export type BossCaptureKeywordSource =
  | 'run-override'
  | 'stored-setting'
  | 'condition-set-default'
  | 'legacy-job-keyword';

export interface BossCaptureSearchPlan {
  source: JobSearchSource;
  pageKeyword: string;
  keywordSource: BossCaptureKeywordSource;
  applicationFilterInput?: Record<string, unknown>;
  conditions: SearchCondition[];
  conditionSetRef?: SearchConditionSetReference;
  selectedFieldsFingerprint?: string;
}

/**
 * Browser-independent capture input. jobName is the expected Boss position
 * name; it is never silently replaced by the page search keyword.
 */
export interface ResolveBossCapturePlanInput {
  jobName: string;
  bossJobId?: string;
  /** Explicit per-run query text for the Boss talent search page. */
  bossSearchKeyword?: string;
  searchSource?: JobSearchSource;
  /** True only when this run explicitly replaces a saved search source. */
  searchSourceExplicit?: boolean;
  /** Explicit per-run condition set; it replaces a saved condition set. */
  searchConditionSetRef?: SearchConditionSetReference;
  /** Explicit non-condition-set direct search settings, resolved by the caller. */
  explicitSearchSettings?: NonNullable<JobRecord['searchSettings']>;
}

export interface ResolvedBossCapturePlan {
  platform: 'boss';
  /** The stable Boss key for stored/synchronised positions, or a legacy new-job key. */
  jobKey: string;
  bossJobId?: string;
  expectedJobName: string;
  /** Undefined only for a genuinely new legacy job (which must still provide JD elsewhere). */
  jobRecord?: JobRecord;
  search: BossCaptureSearchPlan;
  /**
   * An equivalent, schema-complete record that the orchestration layer may
   * persist after this resolver succeeds. The resolver itself never writes.
   */
  jobRecordWithResolvedSearchSettings?: JobRecord;
}

export interface BossCapturePlanStore {
  findBossJobRecordByPositionId(bossJobId: string): Promise<JobRecord | undefined>;
  findBossJobRecordsByName(jobName: string): Promise<JobRecord[]>;
}

export interface BossCapturePlanOptions {
  store?: BossCapturePlanStore;
  searchConditionSets?: Pick<SearchConditionSetService, 'resolve'>;
}

function normalizeNonEmptyText(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be non-empty.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  return value?.normalize('NFKC').replace(/\s+/gu, ' ').trim() || undefined;
}

function normalizedNameKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}

function storedJobMatchesName(record: JobRecord, expectedJobName: string): boolean {
  const expected = normalizedNameKey(expectedJobName);
  return [record.searchKeyword, record.normalizedJob.title]
    .some((value) => normalizedNameKey(value) === expected);
}

function cloneSearchSettings(settings: NonNullable<JobRecord['searchSettings']>): NonNullable<JobRecord['searchSettings']> {
  return {
    ...settings,
    ...(settings.applicationFilterInput
      ? { applicationFilterInput: JSON.parse(JSON.stringify(settings.applicationFilterInput)) as Record<string, unknown> }
      : {}),
    conditions: [...settings.conditions],
    ...(settings.conditionSetRef ? { conditionSetRef: { ...settings.conditionSetRef } } : {}),
    ...(settings.resolution ? { resolution: { ...settings.resolution } } : {}),
  };
}

async function resolveStoredBossJob(
  input: ResolveBossCapturePlanInput,
  store: BossCapturePlanStore,
): Promise<{ jobRecord?: JobRecord; bossJobId?: string; jobKey: string }> {
  const bossJobId = normalizeNonEmptyText(input.bossJobId, 'bossJobId');
  if (bossJobId) {
    const record = await store.findBossJobRecordByPositionId(bossJobId);
    if (!record) {
      throw new Error(`Missing stored Boss JD for job ${input.jobName} (Boss ID ${bossJobId}). Synchronize positions first.`);
    }
    if (!storedJobMatchesName(record, input.jobName)) {
      throw new Error(`Boss ID ${bossJobId} belongs to stored job ${record.searchKeyword}, not expected job ${input.jobName}.`);
    }
    if (record.bossPosition?.bossJobId !== bossJobId) {
      throw new Error(`Stored Boss job ${record.jobKey} does not retain expected Boss ID ${bossJobId}.`);
    }
    return { jobRecord: record, bossJobId, jobKey: record.jobKey };
  }

  const matches = await store.findBossJobRecordsByName(input.jobName);
  if (matches.length > 1) {
    throw new Error(`Ambiguous stored Boss JD for job ${input.jobName}; provide --boss-job-id.`);
  }
  if (matches.length === 1) {
    const record = matches[0]!;
    return {
      jobRecord: record,
      ...(record.bossPosition?.bossJobId ? { bossJobId: record.bossPosition.bossJobId } : {}),
      jobKey: record.jobKey,
    };
  }

  return { jobKey: buildJobKey(input.jobName, '') };
}

function pageKeywordFrom(
  explicitPageKeyword: string | undefined,
  storedPageKeyword: string | undefined,
  conditionSetDefaultKeyword: string | undefined,
  legacyJobKeyword: string,
): Pick<BossCaptureSearchPlan, 'pageKeyword' | 'keywordSource'> {
  if (explicitPageKeyword) {
    return { pageKeyword: explicitPageKeyword, keywordSource: 'run-override' };
  }
  if (storedPageKeyword) {
    return { pageKeyword: storedPageKeyword, keywordSource: 'stored-setting' };
  }
  if (conditionSetDefaultKeyword) {
    return { pageKeyword: conditionSetDefaultKeyword, keywordSource: 'condition-set-default' };
  }
  const fallback = normalizeNonEmptyText(legacyJobKeyword, 'Boss page keyword');
  if (!fallback) {
    throw new Error('Boss page keyword must be non-empty.');
  }
  return { pageKeyword: fallback, keywordSource: 'legacy-job-keyword' };
}

/**
 * Resolves stable Boss job identity and effective saved/direct search settings
 * without creating a browser session or mutating persisted records.
 */
export async function resolveBossCapturePlan(
  input: ResolveBossCapturePlanInput,
  options: BossCapturePlanOptions = {},
): Promise<ResolvedBossCapturePlan> {
  const expectedJobName = normalizeNonEmptyText(input.jobName, 'jobName');
  if (!expectedJobName) {
    throw new Error('jobName must be non-empty.');
  }
  if (input.searchConditionSetRef && input.explicitSearchSettings?.applicationFilterInput) {
    throw new Error('A Boss condition set cannot be combined with explicit application filter input.');
  }
  if (input.searchConditionSetRef && input.searchConditionSetRef.platform !== 'boss') {
    throw new Error(`Search condition set ${input.searchConditionSetRef.conditionSetId} belongs to ${input.searchConditionSetRef.platform}, not boss.`);
  }

  const store = options.store ?? new JobStore();
  const target = await resolveStoredBossJob({ ...input, jobName: expectedJobName }, store);
  const explicitPageKeyword = normalizeNonEmptyText(input.bossSearchKeyword, 'bossSearchKeyword');
  const reuseStoredSettings = !input.searchSourceExplicit
    && !input.searchConditionSetRef
    && !input.explicitSearchSettings;
  const baseSettings = reuseStoredSettings && target.jobRecord?.searchSettings
    ? cloneSearchSettings(target.jobRecord.searchSettings)
    : cloneSearchSettings(input.explicitSearchSettings ?? {
      source: input.searchConditionSetRef ? 'direct' : input.searchSource ?? 'saved',
      conditions: [],
    });
  const conditionSetRef = input.searchConditionSetRef ?? (
    reuseStoredSettings ? baseSettings.conditionSetRef : undefined
  );
  const searchConditionSets = options.searchConditionSets ?? new SearchConditionSetService();

  let settings = baseSettings;
  let conditionSetDefaultKeyword: string | undefined;
  if (conditionSetRef) {
    if (conditionSetRef.platform !== 'boss') {
      throw new Error(`Stored search condition set ${conditionSetRef.conditionSetId} belongs to ${conditionSetRef.platform}, not boss.`);
    }
    const resolved = await searchConditionSets.resolve(conditionSetRef);
    conditionSetDefaultKeyword = normalizeOptionalText(resolved.revision.defaultKeyword);
    settings = {
      source: 'direct',
      applicationFilterInput: resolved.applicationFilterInput,
      conditions: resolved.conditions,
      conditionSetRef: resolved.reference,
      resolution: {
        selectedFieldsFingerprint: resolved.catalogEvidence.selectedFieldsFingerprint,
      },
    };
  }

  // A source override changes the search entry, not the stored page query.
  // Only an explicitly selected condition-set revision gets a fresh keyword
  // precedence and must not inherit another revision's saved query text.
  const storedPageKeyword = !input.searchConditionSetRef
    ? normalizeOptionalText(target.jobRecord?.searchSettings?.pageKeyword)
    : undefined;
  const keyword = pageKeywordFrom(
    explicitPageKeyword,
    storedPageKeyword,
    conditionSetDefaultKeyword,
    target.jobRecord?.searchKeyword ?? expectedJobName,
  );
  const search: BossCaptureSearchPlan = {
    source: settings.source,
    ...keyword,
    ...(settings.applicationFilterInput ? { applicationFilterInput: settings.applicationFilterInput } : {}),
    conditions: settings.conditions,
    ...(settings.conditionSetRef ? { conditionSetRef: settings.conditionSetRef } : {}),
    ...(settings.resolution ? { selectedFieldsFingerprint: settings.resolution.selectedFieldsFingerprint } : {}),
  };
  const shouldBackfillPageKeyword = Boolean(
    target.jobRecord
      && reuseStoredSettings
      && target.jobRecord.searchSettings?.conditionSetRef
      && !target.jobRecord.searchSettings.pageKeyword
      && keyword.keywordSource === 'condition-set-default'
  );
  const jobRecordWithResolvedSearchSettings = target.jobRecord && shouldBackfillPageKeyword
    ? {
      ...target.jobRecord,
      searchSettings: {
        ...settings,
        pageKeyword: keyword.pageKeyword,
      },
    }
    : undefined;

  return {
    platform: 'boss',
    jobKey: target.jobKey,
    ...(target.bossJobId ? { bossJobId: target.bossJobId } : {}),
    expectedJobName,
    ...(target.jobRecord ? { jobRecord: target.jobRecord } : {}),
    search,
    ...(jobRecordWithResolvedSearchSettings ? { jobRecordWithResolvedSearchSettings } : {}),
  };
}
