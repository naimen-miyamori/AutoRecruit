import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { normalizeBossCaptureSettingsSnapshot } from '../scoring/boss-screening.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';
import { normalizeBossCaptureTaskSnapshot, normalizeBossSavedSearchReference } from '../server/task-normalizers.js';
import { parseEmailList } from '../types/job.js';
import { parseBossForwardMode, parseSearchSource } from './input-parsers.js';
import type { BatchCliInput, BatchRunnableJobInput } from './types.js';

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
  selectedPlatforms: readonly SupportedPlatform[],
): Partial<Record<SupportedPlatform, SearchConditionSetReference>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: searchConditionSets must be an object`);
  }

  const allowedPlatforms = new Set(selectedPlatforms);
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

function parseBatchJobItem(
  value: unknown,
  itemIndex: number,
  input: BatchCliInput,
  selectedPlatforms: readonly SupportedPlatform[],
): BatchRunnableJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: item must be an object`);
  }

  const item = value as Record<string, unknown>;
  const legacyBossSecondaryForwardFields = [
    'bossSecondaryForwardMode',
    'bossSecondaryForwardRecipient',
    'bossSecondaryForwardCc',
  ].filter((field) => field in item);
  if (legacyBossSecondaryForwardFields.length > 0) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${legacyBossSecondaryForwardFields.join(', ')} are no longer supported; use bossSecondaryEmail/bossSecondaryCc for rejected resume emails`);
  }
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
  const itemSearchConditionSetRefs = parseBatchSearchConditionSetReferences(item.searchConditionSets, itemIndex, selectedPlatforms);
  const itemCcEmails = parseBatchCcEmails(item.cc, itemIndex);
  const itemBossForwardModeValue = parseOptionalString(item.bossForwardMode, 'bossForwardMode', itemIndex);
  const itemBossForwardMode = itemBossForwardModeValue === undefined
    ? undefined
    : parseBossForwardMode(itemBossForwardModeValue.trim(), `jobs-file item ${itemIndex}.bossForwardMode`);
  const itemBossForwardRecipient = parseOptionalString(item.bossForwardRecipient, 'bossForwardRecipient', itemIndex)?.trim();
  const itemBossForwardCc = parseBatchEmailList(item.bossForwardCc, 'bossForwardCc', itemIndex);
  const itemBossScreeningEnabled = parseBatchOptionalBoolean(item.bossScreeningEnabled, 'bossScreeningEnabled', itemIndex);
  const itemBossScreeningPolicyFile = parseOptionalString(item.bossScreeningPolicyFile, 'bossScreeningPolicyFile', itemIndex);
  const itemBossSecondaryEmail = parseOptionalString(item.bossSecondaryEmail, 'bossSecondaryEmail', itemIndex)?.trim();
  const itemBossSecondaryCc = parseBatchEmailList(item.bossSecondaryCc, 'bossSecondaryCc', itemIndex);
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
  const effectiveBossSecondaryEmail = itemBossSecondaryEmail ?? input.bossSecondaryEmail;
  const effectiveBossSecondaryCc = item.bossSecondaryCc === undefined ? input.bossSecondaryCc : itemBossSecondaryCc;
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
    && !selectedPlatforms.includes('boss')) {
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
    || item.bossSecondaryEmail !== undefined
    || item.bossSecondaryCc !== undefined
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
  if (hasItemBossForwardingInput && !selectedPlatforms.includes('boss')) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: Boss forwarding fields require a selected Boss capture stage`);
  }
  if (hasItemBossScreeningInput && !selectedPlatforms.includes('boss')) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: Boss screening fields require a selected Boss capture stage`);
  }
  if (hasItemResultRoutingInput && selectedPlatforms.length === 0) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: result routing requires a selected capture stage`);
  }
  if ((itemBossForwardMode === undefined) !== (itemBossForwardRecipient === undefined)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: bossForwardMode and bossForwardRecipient must be provided together`);
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
    bossSecondaryEmail: effectiveBossSecondaryEmail,
    bossSecondaryCc: effectiveBossSecondaryCc,
    resultRoutingEnabled: effectiveResultRoutingEnabled,
    resultRoutingPolicyFile: effectiveResultRoutingPolicyFile,
    secondaryEmail: effectiveSecondaryEmail,
    secondaryCc: effectiveSecondaryCc,
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

export interface BatchInputDependencies {
  listSelectedPlatforms: (platform: BatchCliInput['platform'], includeBoss: boolean) => SupportedPlatform[];
}

export async function loadBatchJobInputs(
  input: BatchCliInput,
  dependencies: BatchInputDependencies,
): Promise<BatchRunnableJobInput[]> {
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

  const selectedPlatforms = dependencies.listSelectedPlatforms(input.platform, input.includeBoss);
  return payload.map((item, index) => parseBatchJobItem(item, index, input, selectedPlatforms));
}
