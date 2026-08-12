import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { BossForwardMode, SupportedPlatform } from '../platforms/types.js';
import { isTalentMappingCorePlatform } from '../types/talent-mapping.js';
import { loadTalentMappingPlanFile } from '../talent-mapping/plan.js';
import { assertSafeSearchConditionSetId } from '../search/search-condition-set-store.js';
import { normalizeBossCaptureSettingsSnapshot } from '../scoring/boss-screening.js';
import { deriveCliSearchModeId, getOperationModeDefinition, resolveOperationModeEffects } from '../operation-modes.js';
import { assertRecurringScheduleTaskKind } from './schedule-template-validation.js';
import {
  fingerprintSavedSearchConditionIdentity,
  normalizeBossSavedSearchIdentity,
} from '../platforms/boss/saved-search-identity.js';
import type { BossCaptureTaskSnapshot, SavedSearchConditionIdentity, SavedSearchReference } from '../types/job.js';
import type {
  BatchTaskInput,
  BossAutoChatTaskInput,
  BossChatOperationTaskInput,
  BossGreetTaskInput,
  BossJobSyncTaskInput,
  BossTalentSearchTaskInput,
  ConsolePlatformSelection,
  LoginRefreshTaskInput,
  RagAnswerInput,
  RagOpsAction,
  RagOpsTaskInput,
  ResumeCaptureTaskInput,
  SchedulableTaskKind,
  SearchSource,
  SearchConditionSetReference,
  SearchConditionSetReferenceMap,
  SearchSubscriptionTaskInput,
  TalentMappingClassificationTaskInput,
  TalentMappingTaskInput,
  TaskInput,
} from './types.js';
import type { BossChatOperation, BossTalentSource } from '../types/boss.js';
import { assertBossCaptureTaskSnapshotHash } from '../platforms/boss/capture-snapshot.js';
import type { AskRagQuestionOptions, IngestConversationOptions } from '../rag/service.js';
import type { RagConversationTurn, RagSpeaker } from '../rag/types.js';

export type JsonObject = Record<string, unknown>;

export type NormalizedTask<TInput> = {
  input: TInput;
  argv: string[];
  inputSummary: Record<string, unknown>;
};

/**
 * The public HTTP/assistant shape intentionally cannot provide a resolved
 * Boss condition-set snapshot. Only the server preflight may opt in after it
 * has resolved an exact stored revision.
 */
export interface NormalizeResumeCaptureTaskOptions {
  allowBossSearchConditionSetRef?: boolean;
  allowBossSavedSearchReference?: boolean;
  allowBossCaptureSettingsSnapshot?: boolean;
  allowBossCaptureTaskSnapshot?: boolean;
}

export type NormalizedSchedulableTask = NormalizedTask<TaskInput> & {
  kind: SchedulableTaskKind;
};

export type NormalizedRagAnswerRequest =
  | {
    mode: 'stored';
    options: AskRagQuestionOptions;
  }
  | {
    mode: 'temporary-jd';
    platform: SupportedPlatform;
    jobKey?: string;
    question: string;
    jd?: string;
    jdFile?: string;
  };

export function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value as JsonObject;
}

/**
 * Validate the shape of the private v4 Boss task snapshot.  Public callers
 * cannot opt into this field; keeping the structural check here still makes
 * persisted queue files fail closed instead of producing a partially pinned
 * execution plan.
 */
export function normalizeBossCaptureTaskSnapshot(value: unknown): BossCaptureTaskSnapshot {
  const item = normalizeJsonObject(value, 'bossCaptureTaskSnapshot');
  if (item.version !== 4) {
    throw new Error('bossCaptureTaskSnapshot.version must be 4');
  }
  const resolvedAt = getRequiredString(item, 'resolvedAt');
  const sourceJobKey = getRequiredString(item, 'sourceJobKey');
  const snapshotHash = getRequiredString(item, 'snapshotHash');
  if (!/^[a-f0-9]{64}$/u.test(snapshotHash)) {
    throw new Error('bossCaptureTaskSnapshot.snapshotHash must be a SHA-256 hex digest');
  }
  if (item.sourceJobRevision !== undefined
    && (typeof item.sourceJobRevision !== 'number'
      || !Number.isSafeInteger(item.sourceJobRevision)
      || item.sourceJobRevision <= 0)) {
    throw new Error('bossCaptureTaskSnapshot.sourceJobRevision must be a positive integer');
  }
  if (item.sourceItemIndex !== undefined
    && (typeof item.sourceItemIndex !== 'number'
      || !Number.isSafeInteger(item.sourceItemIndex)
      || item.sourceItemIndex < 0)) {
    throw new Error('bossCaptureTaskSnapshot.sourceItemIndex must be a non-negative integer');
  }
  const identity = normalizeJsonObject(item.jobIdentity, 'bossCaptureTaskSnapshot.jobIdentity');
  const expectedJobName = getRequiredString(identity, 'expectedJobName');
  const searchPlan = normalizeJsonObject(item.searchPlan, 'bossCaptureTaskSnapshot.searchPlan');
  const source = searchPlan.source;
  if (source !== 'saved' && source !== 'direct') {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.source must be saved or direct');
  }
  const pageKeyword = getRequiredString(searchPlan, 'pageKeyword');
  const keywordSource = getRequiredString(searchPlan, 'keywordSource');
  if (!Array.isArray(searchPlan.conditions)) {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.conditions must be an array');
  }
  const savedSearch = searchPlan.savedSearch === undefined
    ? undefined
    : normalizeBossSavedSearchReference(searchPlan.savedSearch, 'bossCaptureTaskSnapshot.searchPlan.savedSearch');
  if (source === 'saved' && !savedSearch) {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.savedSearch is required for a saved Boss search');
  }
  if (savedSearch && savedSearch.expectedKeyword !== pageKeyword) {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.savedSearch.expectedKeyword must match pageKeyword');
  }
  if (savedSearch && savedSearch.conditionIdentity.jobScope !== expectedJobName) {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.savedSearch.jobScope must match expectedJobName');
  }
  if (searchPlan.sortPolicy !== undefined
    && searchPlan.sortPolicy !== 'platform-default'
    && searchPlan.sortPolicy !== 'match-priority') {
    throw new Error('bossCaptureTaskSnapshot.searchPlan.sortPolicy is invalid');
  }
  const delivery = normalizeJsonObject(item.deliveryAndScreening, 'bossCaptureTaskSnapshot.deliveryAndScreening');
  const primaryDelivery = normalizeJsonObject(delivery.primaryDelivery, 'bossCaptureTaskSnapshot.deliveryAndScreening.primaryDelivery');
  if (!Array.isArray(primaryDelivery.ccEmails)
    || !primaryDelivery.ccEmails.every((email) => typeof email === 'string')) {
    throw new Error('bossCaptureTaskSnapshot primaryDelivery.ccEmails must be a string array');
  }
  // The queue stores JSON values.  A deep clone prevents callers from
  // mutating an in-memory task snapshot after it has been normalized.
  const cloned = JSON.parse(JSON.stringify(item)) as BossCaptureTaskSnapshot;
  cloned.resolvedAt = resolvedAt;
  cloned.sourceJobKey = sourceJobKey;
  cloned.jobIdentity.expectedJobName = expectedJobName;
  cloned.searchPlan.source = source;
  cloned.searchPlan.pageKeyword = pageKeyword;
  cloned.searchPlan.keywordSource = keywordSource;
  return assertBossCaptureTaskSnapshotHash(cloned);
}

export function getOptionalString(item: JsonObject, fieldName: string): string | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string when provided`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getRequiredString(item: JsonObject, fieldName: string): string {
  const value = getOptionalString(item, fieldName);
  if (!value) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function normalizeSavedSearchRecord(
  value: unknown,
  fieldName: string,
  kind: 'string' | 'boolean' | 'string-array',
): Record<string, string> | Record<string, boolean> | Record<string, string[]> {
  const record = normalizeJsonObject(value, fieldName);
  const result: Record<string, string> | Record<string, boolean> | Record<string, string[]> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalizedKey = key.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!normalizedKey) {
      throw new Error(`${fieldName} contains an empty key`);
    }
    if (kind === 'string') {
      if (typeof child !== 'string' || !child.trim()) {
        throw new Error(`${fieldName}.${key} must be a non-empty string`);
      }
      (result as Record<string, string>)[normalizedKey] = child.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    } else if (kind === 'boolean') {
      if (typeof child !== 'boolean') {
        throw new Error(`${fieldName}.${key} must be a boolean`);
      }
      (result as Record<string, boolean>)[normalizedKey] = child;
    } else {
      if (!Array.isArray(child) || !child.every((entry) => typeof entry === 'string' && entry.trim())) {
        throw new Error(`${fieldName}.${key} must be an array of non-empty strings`);
      }
      (result as Record<string, string[]>)[normalizedKey] = [...new Set(
        child.map((entry) => entry.normalize('NFKC').replace(/\s+/gu, ' ').trim()),
      )];
    }
  }
  return result;
}

/** Validate and normalize the complete identity required for a Boss saved search. */
export function normalizeBossSavedSearchReference(
  value: unknown,
  label = 'bossSavedSearchReference',
): SavedSearchReference {
  const item = normalizeJsonObject(value, label);
  if (item.version !== 1 || item.platform !== 'boss') {
    throw new Error(`${label} must be a version 1 Boss saved-search reference`);
  }
  const name = getRequiredString(item, 'name').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const nativeId = getOptionalString(item, 'nativeId');
  const expectedKeyword = getRequiredString(item, 'expectedKeyword').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const rawIdentity = normalizeJsonObject(item.conditionIdentity, `${label}.conditionIdentity`);
  const jobScope = getRequiredString(rawIdentity, 'jobScope').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const city = rawIdentity.city === undefined
    ? undefined
    : getRequiredString(rawIdentity, 'city').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const cityOptions = rawIdentity.cityOptions === undefined
    ? undefined
    : (() => {
      const values = rawIdentity.cityOptions;
      if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'string' && entry.trim())) {
        throw new Error(`${label}.conditionIdentity.cityOptions must be an array of non-empty strings`);
      }
      return [...new Set(values.map((entry) => entry.normalize('NFKC').replace(/\s+/gu, ' ').trim()))].sort();
    })();
  const company = rawIdentity.company === undefined
    ? undefined
    : getRequiredString(rawIdentity, 'company').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const identity: SavedSearchConditionIdentity = {
    jobScope,
    ...(city ? { city } : {}),
    ...(cityOptions ? { cityOptions } : {}),
    ...(company ? { company } : {}),
    inline: normalizeSavedSearchRecord(
      rawIdentity.inline,
      `${label}.conditionIdentity.inline`,
      'string-array',
    ) as Record<string, string[]>,
    more: normalizeSavedSearchRecord(
      rawIdentity.more,
      `${label}.conditionIdentity.more`,
      'string',
    ) as Record<string, string>,
    toggles: normalizeSavedSearchRecord(
      rawIdentity.toggles,
      `${label}.conditionIdentity.toggles`,
      'boolean',
    ) as Record<string, boolean>,
  };
  const conditionFingerprint = getRequiredString(item, 'conditionFingerprint');
  if (!/^[a-f0-9]{64}$/u.test(conditionFingerprint)) {
    throw new Error(`${label}.conditionFingerprint must be a SHA-256 hex digest`);
  }
  const normalizedIdentity = normalizeBossSavedSearchIdentity(identity);
  if (fingerprintSavedSearchConditionIdentity(normalizedIdentity) !== conditionFingerprint) {
    throw new Error(`${label}.conditionFingerprint does not match conditionIdentity`);
  }
  const selectedFieldsFingerprint = getOptionalString(item, 'selectedFieldsFingerprint');
  return {
    version: 1,
    platform: 'boss',
    name,
    ...(nativeId ? { nativeId } : {}),
    expectedKeyword,
    conditionIdentity: normalizedIdentity,
    conditionFingerprint,
    ...(selectedFieldsFingerprint ? { selectedFieldsFingerprint } : {}),
  };
}

export function getOptionalBoolean(item: JsonObject, fieldName: string): boolean | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

export function getOptionalPositiveInteger(item: JsonObject, fieldName: string): number | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value;
}

export function getOptionalNumberInRange(
  item: JsonObject,
  fieldName: string,
  min: number,
  max: number,
): number | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be a number from ${min} to ${max}`);
  }

  return value;
}

export function getOptionalMetadata(item: JsonObject, fieldName: string): Record<string, unknown> | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object when provided`);
  }

  return value as Record<string, unknown>;
}

export function normalizePlatformSelection(value: unknown): ConsolePlatformSelection {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('platform is required');
  }

  const trimmed = value.trim();
  return trimmed === 'all' ? 'all' : parsePlatformArg(trimmed);
}

export function normalizePlatform(value: unknown): SupportedPlatform {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('platform is required');
  }

  return parsePlatformArg(value.trim());
}

function normalizeTalentMappingPlatformSelection(value: unknown): TalentMappingTaskInput['platform'] {
  const selection = normalizePlatformSelection(value);
  if (selection !== 'all' && !isTalentMappingCorePlatform(selection)) {
    throw new Error('Talent Mapping supports only 51job, liepin, zhilian, or all; Boss is outside the Talent Mapping product boundary');
  }
  return selection;
}

export function normalizeSearchSource(value: unknown): SearchSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'saved' || value === 'direct') {
    return value;
  }

  throw new Error('searchSource must be saved or direct');
}

function normalizeBossForwardMode(value: unknown): BossForwardMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'colleague' || value === 'email') {
    return value;
  }

  throw new Error('bossForwardMode must be colleague or email');
}

function normalizeBossForwarding(
  item: JsonObject,
  platform: ConsolePlatformSelection,
  includeBoss = false,
): { bossForwardMode?: BossForwardMode; bossForwardRecipient?: string; bossForwardCc?: string[] } {
  const bossForwardMode = normalizeBossForwardMode(getOptionalString(item, 'bossForwardMode'));
  const bossForwardRecipient = getOptionalString(item, 'bossForwardRecipient');
  const bossForwardCc = normalizeForwardCc(item.bossForwardCc, 'bossForwardCc');
  if (Boolean(bossForwardMode) !== Boolean(bossForwardRecipient)) {
    throw new Error('bossForwardMode and bossForwardRecipient must be provided together');
  }

  if (bossForwardMode && platform !== 'boss' && !(platform === 'all' && includeBoss)) {
    throw new Error('Boss forwarding can only be used with platform boss or platform all with includeBoss=true');
  }
  if (bossForwardCc?.length && bossForwardMode === 'colleague') {
    throw new Error('bossForwardCc requires bossForwardMode email');
  }
  if (bossForwardCc !== undefined && platform !== 'boss' && !(platform === 'all' && includeBoss)) {
    throw new Error('Boss forwarding can only be used with platform boss or platform all with includeBoss=true');
  }

  return { bossForwardMode, bossForwardRecipient, bossForwardCc };
}

interface BossScreeningTaskFields {
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
}

interface PostScoreRoutingTaskFields {
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
}

function normalizePostScoreRouting(
  item: JsonObject,
  platform: ConsolePlatformSelection,
): PostScoreRoutingTaskFields {
  const resultRoutingEnabled = getOptionalBoolean(item, 'resultRoutingEnabled');
  const resultRoutingPolicyFile = getOptionalString(item, 'resultRoutingPolicyFile');
  const secondaryEmail = getOptionalString(item, 'secondaryEmail');
  const secondaryCc = normalizeCc(item.secondaryCc);
  const hasInput = resultRoutingEnabled !== undefined
    || resultRoutingPolicyFile !== undefined
    || secondaryEmail !== undefined
    || secondaryCc !== undefined;
  if (hasInput && platform === 'boss') {
    throw new Error('Generic result routing cannot be used with platform boss; use Boss screening so native forwarding remains explicit');
  }
  return {
    resultRoutingEnabled,
    resultRoutingPolicyFile: resultRoutingPolicyFile ? path.resolve(resultRoutingPolicyFile) : undefined,
    secondaryEmail,
    secondaryCc,
  };
}

/**
 * Keep the Boss post-score routing settings on the normal capture boundary.
 * The normalizer intentionally validates only transport shape and platform
 * isolation: saved-policy reuse and enabled-policy completeness are resolved
 * by the Boss capture preflight before browser activity.
 */
function normalizeBossScreening(
  item: JsonObject,
  platform: ConsolePlatformSelection,
  includeBoss = false,
): BossScreeningTaskFields {
  const legacyForwardFields = [
    'bossSecondaryForwardMode',
    'bossSecondaryForwardRecipient',
    'bossSecondaryForwardCc',
  ].filter((field) => field in item);
  if (legacyForwardFields.length > 0) {
    throw new Error(`${legacyForwardFields.join(', ')} are no longer supported; use bossSecondaryEmail/bossSecondaryCc for rejected resume emails`);
  }
  const bossScreeningEnabled = getOptionalBoolean(item, 'bossScreeningEnabled');
  const bossScreeningPolicyFile = getOptionalString(item, 'bossScreeningPolicyFile');
  const bossSecondaryEmail = getOptionalString(item, 'bossSecondaryEmail');
  const bossSecondaryCc = normalizeCc(item.bossSecondaryCc);
  const hasScreeningInput = bossScreeningEnabled !== undefined
    || bossScreeningPolicyFile !== undefined
    || bossSecondaryEmail !== undefined
    || bossSecondaryCc !== undefined;

  if (hasScreeningInput && platform !== 'boss' && !(platform === 'all' && includeBoss)) {
    throw new Error('Boss screening can only be used with platform boss or platform all with includeBoss=true');
  }
  return {
    bossScreeningEnabled,
    bossScreeningPolicyFile,
    bossSecondaryEmail,
    bossSecondaryCc,
  };
}

function normalizeCaptureIncludeBoss(item: JsonObject, platform: ConsolePlatformSelection): boolean | undefined {
  const includeBoss = getOptionalBoolean(item, 'includeBoss');
  if (includeBoss !== undefined && platform !== 'all') {
    throw new Error('includeBoss can only be used with platform all');
  }
  return includeBoss;
}

const corePlatformOrder: SupportedPlatform[] = ['51job', 'liepin', 'zhilian'];
const capturePlatformOrder: SupportedPlatform[] = [...corePlatformOrder, 'boss'];
const searchSubscriptionPlatformOrder: SupportedPlatform[] = [...corePlatformOrder, 'boss'];

function selectedPlatforms(
  platform: ConsolePlatformSelection,
  includeBoss = false,
  purpose: 'capture' | 'search-subscription' = 'capture',
): SupportedPlatform[] {
  if (platform !== 'all') {
    return [platform];
  }

  return includeBoss
    ? purpose === 'search-subscription' ? searchSubscriptionPlatformOrder : capturePlatformOrder
    : corePlatformOrder;
}

function normalizeSearchConditionSetRefs(
  item: JsonObject,
  platform: ConsolePlatformSelection,
  includeBoss = false,
  purpose: 'capture' | 'search-subscription' = 'capture',
): SearchConditionSetReferenceMap | undefined {
  const raw = item.searchConditionSetRefs;
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('searchConditionSetRefs must be an object keyed by platform');
  }

  const allowedPlatforms = new Set(selectedPlatforms(platform, includeBoss, purpose));
  const refs: SearchConditionSetReferenceMap = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('searchConditionSetRefs must contain at least one platform reference');
  }

  for (const [platformKey, rawReference] of entries) {
    const referencePlatform = normalizePlatform(platformKey);
    if (!allowedPlatforms.has(referencePlatform)) {
      throw new Error(
        platform === 'all'
          ? `searchConditionSetRefs.${platformKey} is not selected by this task`
          : `searchConditionSetRefs can only contain ${platform}`,
      );
    }

    const reference = normalizeJsonObject(rawReference, `searchConditionSetRefs.${platformKey}`);
    const conditionSetId = getRequiredString(reference, 'conditionSetId');
    assertSafeSearchConditionSetId(conditionSetId);
    const declaredPlatform = normalizePlatform(reference.platform);
    const revision = getOptionalPositiveInteger(reference, 'revision');
    if (!revision) {
      throw new Error(`searchConditionSetRefs.${platformKey}.revision is required`);
    }
    if (declaredPlatform !== referencePlatform) {
      throw new Error(`searchConditionSetRefs.${platformKey}.platform must match its platform key`);
    }

    refs[referencePlatform] = { conditionSetId, platform: declaredPlatform, revision };
  }

  return refs;
}

function normalizeBossSearchConditionSetRef(
  item: JsonObject,
  options: NormalizeResumeCaptureTaskOptions,
): SearchConditionSetReference | undefined {
  const raw = item.bossSearchConditionSetRef;
  if (raw === undefined) {
    return undefined;
  }
  if (!options.allowBossSearchConditionSetRef) {
    throw new Error('bossSearchConditionSetRef is reserved for server-resolved Boss capture snapshots');
  }

  const reference = normalizeJsonObject(raw, 'bossSearchConditionSetRef');
  const conditionSetId = getRequiredString(reference, 'conditionSetId');
  assertSafeSearchConditionSetId(conditionSetId);
  const platform = normalizePlatform(reference.platform);
  const revision = getOptionalPositiveInteger(reference, 'revision');
  if (!revision) {
    throw new Error('bossSearchConditionSetRef.revision is required');
  }
  if (platform !== 'boss') {
    throw new Error('bossSearchConditionSetRef.platform must be boss');
  }
  return { conditionSetId, platform, revision };
}

function serializeSearchConditionSetRefs(
  platform: ConsolePlatformSelection,
  refs: SearchConditionSetReferenceMap | undefined,
): string | undefined {
  if (!refs) {
    return undefined;
  }

  const ordered = capturePlatformOrder
    .map((item) => refs[item])
    .filter((reference): reference is SearchConditionSetReference => Boolean(reference));
  if (ordered.length === 0) {
    return undefined;
  }

  if (platform !== 'all') {
    const reference = refs[platform];
    return reference ? `${reference.conditionSetId}@${reference.revision}` : undefined;
  }

  return ordered.map((reference) => (
    `${reference.platform}=${reference.conditionSetId}@${reference.revision}`
  )).join(',');
}

function summarizeSearchConditionSetRefs(
  refs: SearchConditionSetReferenceMap | undefined,
): Array<SearchConditionSetReference> | undefined {
  if (!refs) {
    return undefined;
  }

  return capturePlatformOrder
    .map((platform) => refs[platform])
    .filter((reference): reference is SearchConditionSetReference => Boolean(reference));
}

function validateDirectConditionInput(
  searchSource: SearchSource | undefined,
  applicationFilterInputFile: string | undefined,
  searchConditionSetRefs: SearchConditionSetReferenceMap | undefined,
): void {
  if (applicationFilterInputFile && searchConditionSetRefs) {
    throw new Error('applicationFilterInputFile and searchConditionSetRefs are mutually exclusive');
  }
  if ((applicationFilterInputFile || searchConditionSetRefs) && searchSource !== 'direct') {
    throw new Error('applicationFilterInputFile or searchConditionSetRefs requires searchSource direct');
  }
}

function normalizeCc(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? [...new Set(items)] : undefined;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const items = value.map((item) => item.trim()).filter(Boolean);
    return [...new Set(items)];
  }

  throw new Error('cc must be a string or string array');
}

function normalizeForwardCc(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  }
  throw new Error(`${fieldName} must be a string or string array`);
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function pushOptional(argv: string[], flagName: string, value: string | undefined): void {
  if (value !== undefined) {
    argv.push(flagName, value);
  }
}

function pushOptionalBoolean(argv: string[], flagName: string, value: boolean | undefined): void {
  if (value !== undefined) {
    argv.push(flagName, String(value));
  }
}

function assertAbsent(item: JsonObject, fieldNames: string[], context: string): void {
  const present = fieldNames.filter((fieldName) => item[fieldName] !== undefined);
  if (present.length > 0) {
    throw new Error(`${context} cannot include ${present.join(', ')}`);
  }
}

function assertOnlyFields(item: JsonObject, fieldNames: readonly string[], context: string): void {
  const allowed = new Set(fieldNames);
  const unsupported = Object.keys(item).filter((fieldName) => !allowed.has(fieldName));
  if (unsupported.length > 0) {
    throw new Error(`${context} cannot include ${unsupported.join(', ')}`);
  }
}

function summarizeText(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function normalizeResumeCaptureTask(
  payload: unknown,
  options: NormalizeResumeCaptureTaskOptions = {},
): NormalizedTask<ResumeCaptureTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertOnlyFields(item, [
    'platform',
    'includeBoss',
    'keyword',
    'bossJobId',
    'bossSearchKeyword',
    ...(options.allowBossSearchConditionSetRef ? ['bossSearchConditionSetRef'] : []),
    'bossSavedSearchReference',
    'jd',
    'jdFile',
    'includeViewed',
    'searchSource',
    'applicationFilterInputFile',
    'searchConditionSetRefs',
    'email',
    'cc',
    'liepinForwardContact',
    'bossForwardMode',
    'bossForwardRecipient',
    'bossForwardCc',
    'bossScreeningEnabled',
    'bossScreeningPolicyFile',
    'bossSecondaryForwardMode',
    'bossSecondaryForwardRecipient',
    'bossSecondaryForwardCc',
    'bossSecondaryEmail',
    'bossSecondaryCc',
    'resultRoutingEnabled',
    'resultRoutingPolicyFile',
    'secondaryEmail',
    'secondaryCc',
    ...(options.allowBossCaptureSettingsSnapshot ? ['bossCaptureSettingsSnapshot'] : []),
    ...(options.allowBossCaptureTaskSnapshot ? ['bossCaptureTaskSnapshot'] : []),
  ], 'resume-capture task');
  const platform = normalizePlatformSelection(item.platform);
  const includeBoss = normalizeCaptureIncludeBoss(item, platform);
  const keyword = getRequiredString(item, 'keyword');
  const bossJobId = getOptionalString(item, 'bossJobId');
  const bossSearchKeyword = getOptionalString(item, 'bossSearchKeyword');
  const bossSearchConditionSetRef = normalizeBossSearchConditionSetRef(item, options);
  const bossSavedSearchReference = item.bossSavedSearchReference !== undefined
    ? normalizeBossSavedSearchReference(item.bossSavedSearchReference)
    : undefined;
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');
  const includeViewed = getOptionalBoolean(item, 'includeViewed');
  const searchSource = normalizeSearchSource(item.searchSource);
  const operationModeId = deriveCliSearchModeId({
    mode: 'single',
    searchSource,
    searchSourceExplicit: item.searchSource !== undefined,
  });
  const operationModeDefinition = getOperationModeDefinition(operationModeId);
  const resolvedOperationEffects = resolveOperationModeEffects(operationModeId, {
    searchSource,
    searchSourceExplicit: item.searchSource !== undefined,
  });
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const searchConditionSetRefs = normalizeSearchConditionSetRefs(item, platform, includeBoss === true);
  const email = getOptionalString(item, 'email');
  const cc = normalizeCc(item.cc);
  const liepinForwardContact = getOptionalString(item, 'liepinForwardContact');
  const { bossForwardMode, bossForwardRecipient, bossForwardCc } = normalizeBossForwarding(item, platform, includeBoss === true);
  const bossScreening = normalizeBossScreening(item, platform, includeBoss === true);
  const postScoreRouting = normalizePostScoreRouting(item, platform);
  const bossCaptureSettingsSnapshot = options.allowBossCaptureSettingsSnapshot
    && item.bossCaptureSettingsSnapshot !== undefined
    ? normalizeBossCaptureSettingsSnapshot(item.bossCaptureSettingsSnapshot)
    : undefined;
  const bossCaptureTaskSnapshot = options.allowBossCaptureTaskSnapshot
    && item.bossCaptureTaskSnapshot !== undefined
    ? normalizeBossCaptureTaskSnapshot(item.bossCaptureTaskSnapshot)
    : undefined;
  if (bossCaptureSettingsSnapshot && platform !== 'boss' && !(platform === 'all' && includeBoss === true)) {
    throw new Error('Boss capture settings snapshots require platform boss or platform all with includeBoss=true');
  }
  if (bossCaptureTaskSnapshot && platform !== 'boss' && !(platform === 'all' && includeBoss === true)) {
    throw new Error('Boss capture task snapshots require platform boss or platform all with includeBoss=true');
  }

  if (jd && jdFile) {
    throw new Error('jd and jdFile are mutually exclusive');
  }

  if ((bossJobId || bossSearchKeyword || bossSearchConditionSetRef)
    && platform !== 'boss'
    && !(platform === 'all' && includeBoss === true)) {
    throw new Error('bossJobId, bossSearchKeyword, and Boss search snapshots can only be used with platform boss or platform all with includeBoss=true');
  }
  if (bossSavedSearchReference
    && platform !== 'boss'
    && !(platform === 'all' && includeBoss === true)) {
    throw new Error('Boss saved-search references can only be used with platform boss or platform all with includeBoss=true');
  }
  if (bossSavedSearchReference && searchSource === 'direct') {
    throw new Error('bossSavedSearchReference requires searchSource saved or an omitted searchSource');
  }
  if (bossSavedSearchReference && bossSavedSearchReference.conditionIdentity.jobScope !== keyword) {
    throw new Error('bossSavedSearchReference.conditionIdentity.jobScope must match keyword');
  }
  if (bossSavedSearchReference && bossSearchKeyword
    && bossSavedSearchReference.expectedKeyword !== bossSearchKeyword) {
    throw new Error('bossSavedSearchReference.expectedKeyword must match bossSearchKeyword');
  }

  if (bossSearchConditionSetRef && applicationFilterInputFile) {
    throw new Error('bossSearchConditionSetRef and applicationFilterInputFile are mutually exclusive');
  }
  if (bossSearchConditionSetRef && searchConditionSetRefs?.boss) {
    throw new Error('bossSearchConditionSetRef and searchConditionSetRefs.boss are mutually exclusive');
  }

  validateDirectConditionInput(searchSource, applicationFilterInputFile, searchConditionSetRefs);

  if (liepinForwardContact && platform !== 'liepin' && platform !== 'all') {
    throw new Error('liepinForwardContact can only be used with platform liepin or all');
  }

  const input: ResumeCaptureTaskInput = {
    platform,
    includeBoss,
    keyword,
    bossJobId,
    bossSearchKeyword,
    bossSearchConditionSetRef,
    bossSavedSearchReference,
    jd,
    jdFile,
    includeViewed,
    searchSource,
    applicationFilterInputFile,
    searchConditionSetRefs,
    email,
    cc,
    liepinForwardContact,
    bossForwardMode,
    bossForwardRecipient,
    bossForwardCc,
    ...bossScreening,
    ...postScoreRouting,
    bossCaptureSettingsSnapshot,
    bossCaptureTaskSnapshot,
  };
  const argv = ['--mode-id', operationModeId, '--platform', platform, '--keyword', keyword];
  pushOptionalBoolean(argv, '--include-boss', includeBoss);
  pushOptional(argv, '--boss-job-id', bossJobId);
  pushOptional(argv, '--boss-search-keyword', bossSearchKeyword);
  pushOptional(
    argv,
    '--boss-search-condition-set',
    bossSearchConditionSetRef ? `${bossSearchConditionSetRef.conditionSetId}@${bossSearchConditionSetRef.revision}` : undefined,
  );
  pushOptional(argv, '--jd', jd);
  pushOptional(argv, '--jd-file', jdFile);
  pushOptionalBoolean(argv, '--include-viewed', includeViewed);
  pushOptional(argv, '--search-source', searchSource);
  pushOptional(argv, '--application-filter-input-file', applicationFilterInputFile);
  pushOptional(argv, '--search-condition-set', serializeSearchConditionSetRefs(platform, searchConditionSetRefs));
  pushOptional(argv, '--email', email);
  pushOptional(argv, '--cc', cc?.join(','));
  pushOptional(argv, '--liepin-forward-contact', liepinForwardContact);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);
  pushOptional(argv, '--boss-forward-cc', bossForwardCc?.join(','));
  pushOptionalBoolean(argv, '--boss-screening-enabled', bossScreening.bossScreeningEnabled);
  pushOptional(argv, '--boss-screening-policy-file', bossScreening.bossScreeningPolicyFile);
  pushOptional(argv, '--boss-secondary-email', bossScreening.bossSecondaryEmail);
  pushOptional(argv, '--boss-secondary-cc', bossScreening.bossSecondaryCc?.join(','));
  pushOptionalBoolean(argv, '--result-routing-enabled', postScoreRouting.resultRoutingEnabled);
  pushOptional(argv, '--result-routing-policy-file', postScoreRouting.resultRoutingPolicyFile);
  pushOptional(argv, '--secondary-email', postScoreRouting.secondaryEmail);
  pushOptional(argv, '--secondary-cc', postScoreRouting.secondaryCc?.join(','));
  pushOptional(
    argv,
    '--boss-capture-settings-json',
    bossCaptureSettingsSnapshot ? JSON.stringify(bossCaptureSettingsSnapshot) : undefined,
  );
  pushOptional(
    argv,
    '--boss-capture-task-snapshot-json',
    bossCaptureTaskSnapshot ? JSON.stringify(bossCaptureTaskSnapshot) : undefined,
  );

  return {
    input,
    argv,
    inputSummary: {
      platform,
      includeBoss: includeBoss ?? false,
      keyword,
      bossJobId,
      bossSearchKeyword,
      bossSearchConditionSetRef,
      bossSavedSearchReference: bossSavedSearchReference
        ? {
          name: bossSavedSearchReference.name,
          ...(bossSavedSearchReference.nativeId ? { nativeId: bossSavedSearchReference.nativeId } : {}),
          expectedKeyword: bossSavedSearchReference.expectedKeyword,
          conditionFingerprint: bossSavedSearchReference.conditionFingerprint,
        }
        : undefined,
      hasJd: Boolean(jd),
      jdPreview: summarizeText(jd),
      jdFile,
      includeViewed: includeViewed ?? false,
      modeId: operationModeId,
      modeLabel: operationModeDefinition.label,
      declaredEffects: operationModeDefinition.effectSummary,
      resolvedEffects: resolvedOperationEffects,
      searchSource: searchSource ?? 'stored-or-saved',
      applicationFilterInputFile,
      searchConditionSetRefs: summarizeSearchConditionSetRefs(searchConditionSetRefs),
      email,
      ccCount: cc?.length ?? 0,
      liepinForwardContact,
      bossForwardMode,
      bossForwardRecipient,
      bossForwardCcCount: bossForwardCc?.length ?? 0,
      bossScreeningEnabled: bossScreening.bossScreeningEnabled,
      bossScreeningPolicyFile: bossScreening.bossScreeningPolicyFile,
      bossSecondaryEmail: bossScreening.bossSecondaryEmail,
      bossSecondaryCcCount: bossScreening.bossSecondaryCc?.length ?? 0,
      resultRoutingEnabled: postScoreRouting.resultRoutingEnabled,
      resultRoutingPolicyFile: postScoreRouting.resultRoutingPolicyFile,
      secondaryEmail: postScoreRouting.secondaryEmail,
      secondaryCcCount: postScoreRouting.secondaryCc?.length ?? 0,
      bossCaptureSettingsHash: bossCaptureSettingsSnapshot?.settingsHash,
      bossCaptureSettingsResolvedAt: bossCaptureSettingsSnapshot?.resolvedAt,
      bossCaptureTaskSnapshotHash: bossCaptureTaskSnapshot?.snapshotHash,
      bossCaptureTaskSnapshotResolvedAt: bossCaptureTaskSnapshot?.resolvedAt,
    },
  };
}

export function normalizeBatchTask(payload: unknown): NormalizedTask<BatchTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertOnlyFields(item, [
    'platform',
    'includeBoss',
    'jobsFile',
    'includeViewed',
    'searchSource',
    'applicationFilterInputFile',
    'searchConditionSetRefs',
    'email',
    'cc',
    'liepinForwardContact',
    'bossForwardMode',
    'bossForwardRecipient',
    'bossForwardCc',
    'bossScreeningEnabled',
    'bossScreeningPolicyFile',
    'bossSecondaryForwardMode',
    'bossSecondaryForwardRecipient',
    'bossSecondaryForwardCc',
    'bossSecondaryEmail',
    'bossSecondaryCc',
    'resultRoutingEnabled',
    'resultRoutingPolicyFile',
    'secondaryEmail',
    'secondaryCc',
  ], 'batch task');
  assertAbsent(item, ['keyword', 'bossJobId', 'bossSearchKeyword', 'jd', 'jdFile'], 'batch task');

  const platform = normalizePlatformSelection(item.platform);
  const includeBoss = normalizeCaptureIncludeBoss(item, platform);
  const jobsFile = getRequiredString(item, 'jobsFile');
  const includeViewed = getOptionalBoolean(item, 'includeViewed');
  const searchSource = normalizeSearchSource(item.searchSource);
  const operationModeId = deriveCliSearchModeId({
    mode: 'batch',
    searchSource,
    searchSourceExplicit: item.searchSource !== undefined,
  });
  const operationModeDefinition = getOperationModeDefinition(operationModeId);
  const resolvedOperationEffects = resolveOperationModeEffects(operationModeId, {
    searchSource,
    searchSourceExplicit: item.searchSource !== undefined,
  });
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const searchConditionSetRefs = normalizeSearchConditionSetRefs(item, platform, includeBoss === true);
  const email = getOptionalString(item, 'email');
  const cc = normalizeCc(item.cc);
  const liepinForwardContact = getOptionalString(item, 'liepinForwardContact');
  const { bossForwardMode, bossForwardRecipient, bossForwardCc } = normalizeBossForwarding(item, platform, includeBoss === true);
  const bossScreening = normalizeBossScreening(item, platform, includeBoss === true);
  const postScoreRouting = normalizePostScoreRouting(item, platform);

  validateDirectConditionInput(searchSource, applicationFilterInputFile, searchConditionSetRefs);

  if (liepinForwardContact && platform !== 'liepin' && platform !== 'all') {
    throw new Error('liepinForwardContact can only be used with platform liepin or all');
  }

  const input: BatchTaskInput = {
    platform,
    includeBoss,
    jobsFile,
    includeViewed,
    searchSource,
    applicationFilterInputFile,
    searchConditionSetRefs,
    email,
    cc,
    liepinForwardContact,
    bossForwardMode,
    bossForwardRecipient,
    bossForwardCc,
    ...bossScreening,
    ...postScoreRouting,
  };
  const argv = ['--mode-id', operationModeId, '--platform', platform, '--jobs-file', jobsFile];
  pushOptionalBoolean(argv, '--include-boss', includeBoss);
  pushOptionalBoolean(argv, '--include-viewed', includeViewed);
  pushOptional(argv, '--search-source', searchSource);
  pushOptional(argv, '--application-filter-input-file', applicationFilterInputFile);
  pushOptional(argv, '--search-condition-set', serializeSearchConditionSetRefs(platform, searchConditionSetRefs));
  pushOptional(argv, '--email', email);
  pushOptional(argv, '--cc', cc?.join(','));
  pushOptional(argv, '--liepin-forward-contact', liepinForwardContact);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);
  pushOptional(argv, '--boss-forward-cc', bossForwardCc?.join(','));
  pushOptionalBoolean(argv, '--boss-screening-enabled', bossScreening.bossScreeningEnabled);
  pushOptional(argv, '--boss-screening-policy-file', bossScreening.bossScreeningPolicyFile);
  pushOptional(argv, '--boss-secondary-email', bossScreening.bossSecondaryEmail);
  pushOptional(argv, '--boss-secondary-cc', bossScreening.bossSecondaryCc?.join(','));
  pushOptionalBoolean(argv, '--result-routing-enabled', postScoreRouting.resultRoutingEnabled);
  pushOptional(argv, '--result-routing-policy-file', postScoreRouting.resultRoutingPolicyFile);
  pushOptional(argv, '--secondary-email', postScoreRouting.secondaryEmail);
  pushOptional(argv, '--secondary-cc', postScoreRouting.secondaryCc?.join(','));

  return {
    input,
    argv,
    inputSummary: {
      platform,
      includeBoss: includeBoss ?? false,
      jobsFile,
      includeViewed: includeViewed ?? false,
      modeId: operationModeId,
      modeLabel: operationModeDefinition.label,
      declaredEffects: operationModeDefinition.effectSummary,
      resolvedEffects: resolvedOperationEffects,
      searchSource: searchSource ?? 'stored-or-saved',
      applicationFilterInputFile,
      searchConditionSetRefs: summarizeSearchConditionSetRefs(searchConditionSetRefs),
      email,
      ccCount: cc?.length ?? 0,
      liepinForwardContact,
      bossForwardMode,
      bossForwardRecipient,
      bossForwardCcCount: bossForwardCc?.length ?? 0,
      bossScreeningEnabled: bossScreening.bossScreeningEnabled,
      bossScreeningPolicyFile: bossScreening.bossScreeningPolicyFile,
      bossSecondaryEmail: bossScreening.bossSecondaryEmail,
      bossSecondaryCcCount: bossScreening.bossSecondaryCc?.length ?? 0,
      resultRoutingEnabled: postScoreRouting.resultRoutingEnabled,
      resultRoutingPolicyFile: postScoreRouting.resultRoutingPolicyFile,
      secondaryEmail: postScoreRouting.secondaryEmail,
      secondaryCcCount: postScoreRouting.secondaryCc?.length ?? 0,
    },
  };
}

export async function normalizeTalentMappingTask(payload: unknown): Promise<NormalizedTask<TalentMappingTaskInput>> {
  const item = normalizeJsonObject(payload, 'talent-mapping task');
  assertOnlyFields(item, [
    'platform',
    'talentMappingFile',
    'mappingStage',
    'confirmedDetailOpen',
    'mappingRunId',
  ], 'talent-mapping task');
  const platform = normalizeTalentMappingPlatformSelection(item.platform);
  const talentMappingFile = path.resolve(getRequiredString(item, 'talentMappingFile'));
  const mappingStageValue = getRequiredString(item, 'mappingStage');
  if (mappingStageValue !== 'scan' && mappingStageValue !== 'enrich' && mappingStageValue !== 'all') {
    throw new Error('mappingStage must be scan, enrich, or all');
  }
  const mappingStage = mappingStageValue as TalentMappingTaskInput['mappingStage'];
  const confirmedDetailOpen = getOptionalBoolean(item, 'confirmedDetailOpen');
  const mappingRunId = getOptionalString(item, 'mappingRunId');

  if (mappingStage === 'scan' && item.confirmedDetailOpen !== undefined) {
    throw new Error('confirmedDetailOpen is valid only with mappingStage enrich or all');
  }
  if (mappingRunId && mappingStage !== 'enrich') {
    throw new Error('mappingRunId is valid only with mappingStage enrich');
  }

  const plan = await loadTalentMappingPlanFile(talentMappingFile, { platformSelection: platform });
  if (mappingStage === 'enrich' && plan.enrichment.mode === 'card-only') {
    throw new Error('mappingStage enrich is invalid for a card-only Talent Mapping plan');
  }
  if ((mappingStage === 'enrich' || mappingStage === 'all')
    && plan.enrichment.mode !== 'card-only'
    && confirmedDetailOpen !== true) {
    throw new Error('confirmedDetailOpen=true is required for Talent Mapping detail enrichment');
  }
  const input: TalentMappingTaskInput = {
    platform,
    talentMappingFile,
    mappingStage,
    confirmedDetailOpen,
    mappingRunId,
  };
  const argv = [
    '--platform', platform,
    '--talent-mapping-file', talentMappingFile,
    '--mapping-stage', mappingStage,
  ];
  if (mappingStage !== 'scan') {
    argv.push('--mapping-confirm-detail-open', String(confirmedDetailOpen ?? false));
  }
  pushOptional(argv, '--mapping-run-id', mappingRunId);

  return {
    input,
    argv,
    inputSummary: {
      platform,
      talentMappingFile,
      mappingStage,
      confirmedDetailOpen: confirmedDetailOpen ?? false,
      mappingRunId,
    },
  };
}

export function normalizeTalentMappingClassificationTask(
  payload: unknown,
): NormalizedTask<TalentMappingClassificationTaskInput> {
  const item = normalizeJsonObject(payload, 'talent-mapping-classification task');
  assertOnlyFields(item, ['mappingKey', 'limit'], 'talent-mapping-classification task');
  const mappingKey = getRequiredString(item, 'mappingKey');
  const limit = getOptionalPositiveInteger(item, 'limit');
  if (limit !== undefined && limit > 100) {
    throw new Error('limit must be at most 100');
  }
  return {
    input: { mappingKey, limit },
    argv: [],
    inputSummary: {
      mappingKey,
      limit: limit ?? 25,
      modelInputPolicy: 'company-title-location-only',
    },
  };
}

export function normalizeSearchSubscriptionTask(payload: unknown): NormalizedTask<SearchSubscriptionTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertAbsent(item, ['jd', 'jdFile', 'email', 'cc', 'includeViewed', 'bossJobId', 'bossSearchKeyword', 'liepinForwardContact', 'bossForwardMode', 'bossForwardRecipient', 'searchSource'], 'search-subscription task');

  const platform = normalizePlatformSelection(item.platform);
  const includeBoss = getOptionalBoolean(item, 'includeBoss') ?? false;
  if (includeBoss && platform !== 'all') throw new Error('includeBoss can only be used with platform all');
  const searchSubscriptionFile = getRequiredString(item, 'searchSubscriptionFile');
  const keyword = getOptionalString(item, 'keyword');
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const searchConditionSetRefs = normalizeSearchConditionSetRefs(item, platform, includeBoss, 'search-subscription');
  const saveSearchSubscription = getOptionalBoolean(item, 'saveSearchSubscription');
  const searchSubscriptionName = getOptionalString(item, 'searchSubscriptionName');
  const operationModeId = deriveCliSearchModeId({ mode: 'search-subscription' });
  const operationModeDefinition = getOperationModeDefinition(operationModeId);
  const resolvedOperationEffects = resolveOperationModeEffects(operationModeId, {
    saveSearchSubscription,
  });

  if (applicationFilterInputFile && searchConditionSetRefs) {
    throw new Error('applicationFilterInputFile and searchConditionSetRefs are mutually exclusive');
  }

  const input: SearchSubscriptionTaskInput = {
    platform,
    includeBoss,
    searchSubscriptionFile,
    keyword,
    applicationFilterInputFile,
    searchConditionSetRefs,
    saveSearchSubscription,
    searchSubscriptionName,
  };
  const argv = ['--mode-id', operationModeId, '--platform', platform, '--search-subscription-file', searchSubscriptionFile];
  if (item.includeBoss !== undefined) pushOptionalBoolean(argv, '--include-boss', includeBoss);
  pushOptional(argv, '--keyword', keyword);
  pushOptional(argv, '--search-condition-set', serializeSearchConditionSetRefs(platform, searchConditionSetRefs));
  pushOptionalBoolean(argv, '--save-search-subscription', saveSearchSubscription);
  pushOptional(argv, '--search-subscription-name', searchSubscriptionName);

  return {
    input,
    argv,
    inputSummary: {
      platform,
      modeId: operationModeId,
      modeLabel: operationModeDefinition.label,
      declaredEffects: operationModeDefinition.effectSummary,
      resolvedEffects: resolvedOperationEffects,
      includeBoss,
      searchSubscriptionFile,
      keyword,
      applicationFilterInputFile,
      searchConditionSetRefs: summarizeSearchConditionSetRefs(searchConditionSetRefs),
      saveSearchSubscription: saveSearchSubscription ?? false,
      searchSubscriptionName,
    },
  };
}

export function normalizeBossAutoChatTask(payload: unknown): NormalizedTask<BossAutoChatTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertAbsent(item, [
    'keyword',
    'jd',
    'jdFile',
    'jobsFile',
    'includeViewed',
    'includeBoss',
    'searchSource',
    'applicationFilterInputFile',
    'email',
    'cc',
    'liepinForwardContact',
    'searchSubscriptionFile',
    'saveSearchSubscription',
    'searchSubscriptionName',
  ], 'boss-auto-chat task');

  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') {
    throw new Error('boss-auto-chat task requires platform boss');
  }

  const scoreThreshold = getOptionalNumberInRange(item, 'scoreThreshold', 0, 100);
  const requireAllHardRequirements = getOptionalBoolean(item, 'requireAllHardRequirements');
  const replyToUnqualifiedCandidates = getOptionalBoolean(item, 'replyToUnqualifiedCandidates');
  const syncJobsBeforeReview = getOptionalBoolean(item, 'syncJobsBeforeReview');
  const summaryEmail = getOptionalString(item, 'summaryEmail');
  const summaryCc = normalizeCc(item.summaryCc);
  if (summaryCc && !summaryEmail) {
    throw new Error('boss-auto-chat summaryCc requires summaryEmail');
  }
  const { bossForwardMode, bossForwardRecipient, bossForwardCc } = normalizeBossForwarding(item, platform);

  const input: BossAutoChatTaskInput = {
    platform: 'boss',
    scoreThreshold,
    requireAllHardRequirements,
    replyToUnqualifiedCandidates,
    bossForwardMode,
    bossForwardRecipient,
    bossForwardCc,
    summaryEmail,
    summaryCc,
    syncJobsBeforeReview,
  };
  const argv = ['--platform', 'boss', '--boss-auto-chat', 'true'];
  if (scoreThreshold !== undefined) {
    argv.push('--boss-chat-score-threshold', String(scoreThreshold));
  }
  pushOptionalBoolean(argv, '--boss-chat-require-all', requireAllHardRequirements);
  pushOptionalBoolean(argv, '--boss-chat-reply-unqualified', replyToUnqualifiedCandidates);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);
  pushOptional(argv, '--boss-forward-cc', bossForwardCc?.join(','));
  pushOptional(argv, '--boss-chat-summary-email', summaryEmail);
  pushOptional(argv, '--boss-chat-summary-cc', summaryCc?.join(','));
  pushOptionalBoolean(argv, '--boss-sync-jobs-before-review', syncJobsBeforeReview);

  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss',
      scoreThreshold: scoreThreshold ?? 70,
      requireAllHardRequirements: requireAllHardRequirements ?? false,
      replyToUnqualifiedCandidates: replyToUnqualifiedCandidates ?? false,
      bossForwardMode,
      bossForwardRecipient,
      bossForwardCcCount: bossForwardCc?.length ?? 0,
      summaryEmail,
      summaryCcCount: summaryCc?.length ?? 0,
      syncJobsBeforeReview: syncJobsBeforeReview ?? false,
    },
  };
}

export function normalizeBossTalentSearchTask(payload: unknown): NormalizedTask<BossTalentSearchTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-talent-search task requires platform boss');
  if (item.source !== 'recommend' && item.source !== 'deep-search') {
    throw new Error('source must be recommend or deep-search');
  }
  const source = item.source;
  const bossJobId = getOptionalString(item, 'bossJobId');
  const expectedJobName = getOptionalString(item, 'expectedJobName');
  const coreRequirements = normalizeStringArray(item.coreRequirements, 'coreRequirements');
  const bonusRequirements = normalizeStringArray(item.bonusRequirements, 'bonusRequirements');
  const triggerMatch = getOptionalBoolean(item, 'triggerMatch');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (source === 'recommend' && (coreRequirements || bonusRequirements || triggerMatch)) {
    throw new Error('Boss recommendation does not accept requirements or triggerMatch');
  }
  if (triggerMatch === true && confirmed !== true) {
    throw new Error('Boss immediate match requires confirmed=true');
  }
  const input: BossTalentSearchTaskInput = {
    platform: 'boss',
    source,
    bossJobId,
    expectedJobName,
    coreRequirements,
    bonusRequirements,
    triggerMatch,
    confirmed,
  };
  const argv = ['--platform', 'boss', '--boss-talent-source', source];
  pushOptional(argv, '--boss-job-id', bossJobId);
  pushOptional(argv, '--boss-expected-job-name', expectedJobName);
  pushOptional(argv, '--boss-core-requirements-json', coreRequirements ? JSON.stringify(coreRequirements) : undefined);
  pushOptional(argv, '--boss-bonus-requirements-json', bonusRequirements ? JSON.stringify(bonusRequirements) : undefined);
  pushOptionalBoolean(argv, '--boss-trigger-match', triggerMatch);
  pushOptionalBoolean(argv, '--boss-confirmed', confirmed);
  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss', source, bossJobId, expectedJobName,
      coreRequirementCount: coreRequirements?.length ?? 0,
      bonusRequirementCount: bonusRequirements?.length ?? 0,
      triggerMatch: triggerMatch ?? false,
      confirmed: confirmed ?? false,
    },
  };
}

export function normalizeBossGreetTask(payload: unknown): NormalizedTask<BossGreetTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-greet task requires platform boss');
  const source = item.source as BossTalentSource;
  if (source !== 'recommend' && source !== 'deep-search') {
    throw new Error('boss-greet source must be recommend or deep-search');
  }
  const candidateId = getRequiredString(item, 'candidateId');
  const expectedCandidateName = getRequiredString(item, 'expectedCandidateName');
  const expectedJobName = getRequiredString(item, 'expectedJobName');
  const bossJobId = getOptionalString(item, 'bossJobId');
  const intentId = getOptionalString(item, 'intentId');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (confirmed !== true) throw new Error('boss-greet requires confirmed=true');
  const input: BossGreetTaskInput = {
    platform: 'boss', source, candidateId, expectedCandidateName, expectedJobName,
    bossJobId, intentId, confirmed: true,
  };
  const argv = [
    '--platform', 'boss',
    '--boss-greet-source', source,
    '--boss-greet-candidate-id', candidateId,
    '--boss-expected-candidate-name', expectedCandidateName,
    '--boss-expected-job-name', expectedJobName,
    '--boss-confirmed', 'true',
  ];
  pushOptional(argv, '--boss-job-id', bossJobId);
  pushOptional(argv, '--boss-intent-id', intentId);
  return {
    input,
    argv,
    inputSummary: { platform: 'boss', source, candidateId, expectedCandidateName, expectedJobName, bossJobId, intentId },
  };
}

const bossChatOperations = new Set<BossChatOperation>([
  'list-conversations', 'open-conversation', 'read-conversation', 'read-history', 'preview-resume',
  'send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume',
  'exchange-phone', 'exchange-wechat',
]);
const bossChatMutations = new Set<BossChatOperation>([
  'send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume',
  'exchange-phone', 'exchange-wechat',
]);

export function normalizeBossChatOperationTask(payload: unknown): NormalizedTask<BossChatOperationTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-chat-operation task requires platform boss');
  const action = getRequiredString(item, 'action') as BossChatOperation;
  if (!bossChatOperations.has(action)) throw new Error(`Unsupported Boss chat action: ${action}`);
  const conversationId = getOptionalString(item, 'conversationId');
  const expectedCandidateName = getOptionalString(item, 'expectedCandidateName');
  const expectedJobName = getOptionalString(item, 'expectedJobName');
  const text = getOptionalString(item, 'text');
  const remark = getOptionalString(item, 'remark');
  const intentId = getOptionalString(item, 'intentId');
  const unreadOnly = getOptionalBoolean(item, 'unreadOnly');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (action !== 'list-conversations' && !conversationId) throw new Error(`${action} requires conversationId`);
  if (action === 'send-text' && !text) throw new Error('send-text requires text');
  if (action === 'remark' && !remark) throw new Error('remark requires remark');
  if (bossChatMutations.has(action) && (confirmed !== true || !intentId)) {
    throw new Error(`${action} requires confirmed=true and intentId`);
  }
  const input: BossChatOperationTaskInput = {
    platform: 'boss', action, conversationId, expectedCandidateName, expectedJobName,
    text, remark, intentId, unreadOnly, confirmed,
  };
  const argv = ['--platform', 'boss', '--boss-chat-operation', action];
  pushOptional(argv, '--boss-conversation-id', conversationId);
  pushOptional(argv, '--boss-expected-candidate-name', expectedCandidateName);
  pushOptional(argv, '--boss-expected-job-name', expectedJobName);
  pushOptional(argv, '--boss-chat-text', text);
  pushOptional(argv, '--boss-chat-remark', remark);
  pushOptional(argv, '--boss-intent-id', intentId);
  pushOptionalBoolean(argv, '--boss-unread-only', unreadOnly);
  pushOptionalBoolean(argv, '--boss-confirmed', confirmed);
  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss', action, conversationId, expectedCandidateName, expectedJobName,
      hasText: Boolean(text), hasRemark: Boolean(remark), intentId,
      unreadOnly: unreadOnly ?? false, confirmed: confirmed ?? false,
    },
  };
}

export function normalizeBossJobSyncTask(payload: unknown): NormalizedTask<BossJobSyncTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-job-sync task requires platform boss');
  const bossJobIds = normalizeStringArray(item.bossJobIds, 'bossJobIds');
  const includeClosed = getOptionalBoolean(item, 'includeClosed');
  const input: BossJobSyncTaskInput = { platform: 'boss', bossJobIds, includeClosed };
  const argv = ['--platform', 'boss', '--boss-job-sync', 'true'];
  pushOptional(argv, '--boss-job-ids', bossJobIds?.join(','));
  pushOptionalBoolean(argv, '--boss-include-closed-jobs', includeClosed);
  return {
    input,
    argv,
    inputSummary: { platform: 'boss', bossJobIds, includeClosed: includeClosed ?? true },
  };
}

export async function prepareSearchSubscriptionTask(
  payload: unknown,
  dataDir: string,
): Promise<NormalizedTask<SearchSubscriptionTaskInput>> {
  const normalized = normalizeSearchSubscriptionTask(payload);
  const filterInputFile = normalized.input.applicationFilterInputFile;
  if (!filterInputFile) {
    return normalized;
  }

  const sourceFilePath = path.resolve(normalized.input.searchSubscriptionFile);
  const subscription = JSON.parse(await readFile(sourceFilePath, 'utf8')) as unknown;
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new Error('searchSubscriptionFile must point to a JSON object');
  }

  const runtimeDir = path.join(dataDir, 'runtime', 'search-subscriptions');
  await mkdir(runtimeDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(runtimeDir, `search-subscription-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`);
  const filterPath = path.isAbsolute(filterInputFile)
    ? filterInputFile
    : path.resolve(filterInputFile);
  const wrappedSubscription = {
    ...(subscription as Record<string, unknown>),
    applicationFilterInputFile: path.relative(path.dirname(filePath), filterPath),
  };
  await writeFile(filePath, `${JSON.stringify(wrappedSubscription, null, 2)}\n`, 'utf8');

  normalized.input.searchSubscriptionFile = path.relative(process.cwd(), filePath);
  normalized.inputSummary.searchSubscriptionFile = normalized.input.searchSubscriptionFile;
  normalized.argv = normalized.argv.flatMap((value, index, argv) => (
    value === '--search-subscription-file' ? [value, normalized.input.searchSubscriptionFile] : index > 0 && argv[index - 1] === '--search-subscription-file' ? [] : [value]
  ));
  return normalized;
}

export async function normalizeSchedulableTask(
  kind: SchedulableTaskKind,
  input: Record<string, unknown>,
  dataDir: string,
): Promise<NormalizedSchedulableTask> {
  assertRecurringScheduleTaskKind(kind);
  switch (kind) {
    case 'resume-capture': {
      const normalized = normalizeResumeCaptureTask(input);
      return { kind, ...normalized };
    }
    case 'batch': {
      const normalized = normalizeBatchTask(input);
      return { kind, ...normalized };
    }
    case 'talent-mapping': {
      const normalized = await normalizeTalentMappingTask(input);
      if (normalized.input.mappingStage !== 'scan') {
        throw new Error('Scheduled Talent Mapping requires mappingStage scan');
      }
      const plan = await loadTalentMappingPlanFile(normalized.input.talentMappingFile, {
        platformSelection: normalized.input.platform,
      });
      if (plan.enrichment.mode !== 'card-only') {
        throw new Error('Scheduled Talent Mapping requires a card-only plan');
      }
      return { kind, ...normalized };
    }
    case 'search-subscription': {
      const normalized = await prepareSearchSubscriptionTask(input, dataDir);
      if (normalized.input.saveSearchSubscription === true || normalized.input.searchSubscriptionName !== undefined) {
        throw new Error('Scheduled search-subscription tasks cannot save or rename platform subscriptions');
      }
      return { kind, ...normalized };
    }
    case 'boss-job-sync': {
      const normalized = normalizeBossJobSyncTask(input);
      return { kind, ...normalized };
    }
    default:
      throw new Error(`scheduled-task-kind-unknown: ${String(kind)}`);
  }
}

export function normalizeLoginRefreshTask(payload: unknown): NormalizedTask<LoginRefreshTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  assertAbsent(item, ['keepOpen'], 'login-refresh task');

  return {
    input: { platform },
    argv: [],
    inputSummary: {
      platform,
      action: 'manual-login-refresh',
    },
  };
}

export function normalizeRagOpsAction(value: unknown): RagOpsAction {
  if (
    value === 'doctor'
    || value === 'review'
    || value === 'metrics'
    || value === 'ops'
    || value === 'rebuild'
  ) {
    return value;
  }

  throw new Error('action must be doctor, review, metrics, ops, or rebuild');
}

export function normalizeRagOpsTask(payload: unknown): NormalizedTask<RagOpsTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const action = normalizeRagOpsAction(item.action);
  const platform = item.platform === undefined ? undefined : normalizePlatform(item.platform);
  const jobKey = getOptionalString(item, 'jobKey');
  const keyword = getOptionalString(item, 'keyword');
  const question = getOptionalString(item, 'question');
  const file = getOptionalString(item, 'file');
  const policyFile = getOptionalString(item, 'policyFile');
  const reviewer = getOptionalString(item, 'reviewer');
  const limit = getOptionalPositiveInteger(item, 'limit');
  const includeReviewed = getOptionalBoolean(item, 'includeReviewed');
  const failOnIssue = getOptionalBoolean(item, 'failOnIssue');

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && !platform) {
    throw new Error('platform is required for this RAG operation');
  }

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && !jobKey && !keyword) {
    throw new Error('jobKey or keyword is required for this RAG operation');
  }

  if ((action === 'metrics' || action === 'ops') && !file) {
    throw new Error('file is required for this RAG operation');
  }

  if ((action === 'metrics' || action === 'rebuild') && question) {
    throw new Error(`question is not supported for ${action}`);
  }

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && file) {
    throw new Error(`file is not supported for ${action}`);
  }

  if (action !== 'metrics' && action !== 'ops' && policyFile) {
    throw new Error(`policyFile is not supported for ${action}`);
  }

  const input: RagOpsTaskInput = {
    action,
    platform,
    jobKey,
    keyword,
    question,
    file,
    policyFile,
    reviewer,
    limit,
    includeReviewed,
    failOnIssue,
  };
  const argv = ['rag-ops', action];
  pushOptional(argv, '--platform', platform);
  pushOptional(argv, '--job-key', jobKey);
  pushOptional(argv, '--keyword', keyword);
  pushOptional(argv, '--question', question);
  pushOptional(argv, '--file', file);
  pushOptional(argv, '--policy', policyFile);
  pushOptional(argv, '--reviewer', reviewer);
  if (limit !== undefined) {
    argv.push('--limit', String(limit));
  }
  pushOptionalBoolean(argv, '--include-reviewed', includeReviewed);
  pushOptionalBoolean(argv, '--fail-on-issue', failOnIssue);

  return {
    input,
    argv,
    inputSummary: {
      action,
      platform,
      jobKey,
      keyword,
      question,
      file,
      policyFile,
      reviewer,
      limit,
      includeReviewed: includeReviewed ?? false,
      failOnIssue: failOnIssue ?? false,
    },
  };
}

function normalizeRagJobKey(item: JsonObject): string {
  const jobKey = getOptionalString(item, 'jobKey');
  if (jobKey) {
    return jobKey;
  }

  const keyword = getOptionalString(item, 'keyword');
  if (keyword) {
    return buildJobKey(keyword, '');
  }

  throw new Error('jobKey or keyword is required');
}

function normalizeRole(value: unknown, fieldPath: string): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`${fieldPath}.role must be candidate, recruiter, or system`);
}

function normalizeConversationTurn(value: unknown, index: number): RagConversationTurn {
  const item = normalizeJsonObject(value, `turns[${index}]`);
  return {
    id: getOptionalString(item, 'id'),
    role: normalizeRole(item.role, `turns[${index}]`),
    content: getRequiredString(item, 'content'),
    verified: item.verified === true,
    createdAt: getOptionalString(item, 'createdAt'),
    metadata: getOptionalMetadata(item, 'metadata'),
  };
}

function normalizeConversationTurns(value: unknown): RagConversationTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('turns must be a non-empty array');
  }

  return value.map((turn, index) => normalizeConversationTurn(turn, index));
}

export function normalizeRagAnswerRequest(payload: unknown): NormalizedRagAnswerRequest {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  const question = getRequiredString(item, 'question');
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');
  const keyword = getOptionalString(item, 'keyword');
  const jobKey = getOptionalString(item, 'jobKey') ?? (keyword ? buildJobKey(keyword, '') : undefined);

  if (jd || jdFile) {
    if (jd && jdFile) {
      throw new Error('jd and jdFile are mutually exclusive');
    }

    return {
      mode: 'temporary-jd',
      platform,
      jobKey,
      question,
      jd,
      jdFile,
    };
  }

  return {
    mode: 'stored',
    options: {
      platform,
      jobKey: normalizeRagJobKey(item),
      question,
      topK: getOptionalPositiveInteger(item, 'topK'),
      autoIndex: getOptionalBoolean(item, 'autoIndex'),
      logAnswer: getOptionalBoolean(item, 'logAnswer'),
      answerLogMetadata: getOptionalMetadata(item, 'metadata'),
    },
  };
}

export function normalizeRagAnswerInput(payload: unknown): RagAnswerInput {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  const question = getRequiredString(item, 'question');
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');

  if (jd && jdFile) {
    throw new Error('jd and jdFile are mutually exclusive');
  }

  return {
    platform,
    jobKey: getOptionalString(item, 'jobKey'),
    keyword: getOptionalString(item, 'keyword'),
    jd,
    jdFile,
    question,
    topK: getOptionalPositiveInteger(item, 'topK'),
    autoIndex: getOptionalBoolean(item, 'autoIndex'),
    logAnswer: getOptionalBoolean(item, 'logAnswer'),
    metadata: getOptionalMetadata(item, 'metadata'),
  };
}

export function normalizeApplicationFilterInputRequest(payload: unknown): {
  platform: SupportedPlatform;
  applicationFilterInput: Record<string, unknown>;
  label?: string;
} {
  const item = normalizeJsonObject(payload, 'request body');
  const applicationFilterInput = item.applicationFilterInput;
  if (!applicationFilterInput || typeof applicationFilterInput !== 'object' || Array.isArray(applicationFilterInput)) {
    throw new Error('applicationFilterInput must be a JSON object');
  }

  return {
    platform: normalizePlatform(item.platform),
    applicationFilterInput: applicationFilterInput as Record<string, unknown>,
    label: getOptionalString(item, 'label'),
  };
}

export function normalizeConversationRequest(payload: unknown): IngestConversationOptions {
  const item = normalizeJsonObject(payload, 'request body');
  return {
    platform: normalizePlatform(item.platform),
    jobKey: normalizeRagJobKey(item),
    conversationId: getRequiredString(item, 'conversationId'),
    turns: normalizeConversationTurns(item.turns),
  };
}
