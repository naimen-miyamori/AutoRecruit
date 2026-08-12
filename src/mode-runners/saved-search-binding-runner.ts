import { isDeepStrictEqual } from 'node:util';

import type { CoreSavedSearchPlatform } from '../search/saved-search-target.js';
import {
  buildCoreSavedSearchTarget,
  buildZhilianNativeSavedSearchTarget,
  isZhilianNativeSavedSearchOpenEvidence,
} from '../search/saved-search-target.js';
import { JobConfigConflictError, JobStore } from '../storage/job-store.js';
import type { JobRecord } from '../types/job.js';
import { SavedSearchEvidenceStore } from '../search/saved-search-evidence-store.js';

export interface BindCoreSavedSearchTargetInput {
  platform: CoreSavedSearchPlatform;
  jobKey: string;
  expectedRevision: number;
  name: string;
  expectedKeyword: string;
  evidenceHash: string;
  confirmed: boolean;
}

export async function bindCoreSavedSearchTarget(
  input: BindCoreSavedSearchTargetInput,
  dependencies: { store?: JobStore; evidenceStore?: SavedSearchEvidenceStore } = {},
): Promise<JobRecord> {
  if (input.confirmed !== true) throw new Error('Core saved-search binding requires confirmed=true.');
  const evidence = await (dependencies.evidenceStore ?? new SavedSearchEvidenceStore()).read(input.evidenceHash);
  if (evidence.platform !== input.platform) {
    throw new Error(`Saved-search evidence belongs to ${evidence.platform}, not ${input.platform}.`);
  }
  if (evidence.boundJobKey !== input.jobKey) {
    throw new Error(`Saved-search evidence belongs to job ${evidence.boundJobKey}, not ${input.jobKey}.`);
  }
  if (evidence.postcondition !== 'opened-and-verified') {
    throw new Error('Saved-search evidence does not prove an opened target.');
  }

  const store = dependencies.store ?? new JobStore();
  const current = await store.readJobRecord(input.platform, input.jobKey);
  const currentRevision = current.revision ?? 1;
  if (currentRevision !== input.expectedRevision) {
    throw new JobConfigConflictError(input.platform, input.jobKey, input.expectedRevision, currentRevision);
  }
  if (!current.jobIdentity) {
    throw new Error(`Core saved-search binding requires a persisted strict jobIdentity for ${input.platform}/${input.jobKey}.`);
  }
  if (current.searchSettings?.source !== 'saved') {
    throw new Error(`Core saved-search binding requires ${input.platform}/${input.jobKey} to have search source saved.`);
  }

  const currentTarget = current.searchSettings.coreSavedSearchTarget;
  const normalizedName = input.name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const normalizedKeyword = input.expectedKeyword.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const semanticTarget = isZhilianNativeSavedSearchOpenEvidence(evidence)
    ? (() => {
      if (input.platform !== 'zhilian') {
        throw new Error(`Native-condition evidence belongs to Zhilian, not ${input.platform}.`);
      }
      return buildZhilianNativeSavedSearchTarget({
        boundJobKey: input.jobKey,
        bindingRevision: 1,
        name: normalizedName,
        nativeConditionId: evidence.observedNativeConditionId,
        expectedKeyword: normalizedKeyword,
        conditionFingerprint: evidence.observedConditionFingerprint,
      });
    })()
    : (() => {
      if (input.platform === 'zhilian') {
        throw new Error('Zhilian binding requires native-condition evidence; exact-name evidence is migration-ineligible.');
      }
      return buildCoreSavedSearchTarget({
        platform: input.platform,
        boundJobKey: input.jobKey,
        bindingRevision: 1,
        name: normalizedName,
        expectedKeyword: normalizedKeyword,
      });
    })();
  const sameSemanticTarget = currentTarget?.targetFingerprint === semanticTarget.targetFingerprint;
  const bindingRevision = sameSemanticTarget
    ? currentTarget!.bindingRevision
    : (currentTarget?.bindingRevision ?? 0) + 1;
  const target = semanticTarget.targetKind === 'zhilian-native-condition'
    ? buildZhilianNativeSavedSearchTarget({ ...semanticTarget, bindingRevision })
    : buildCoreSavedSearchTarget({ ...semanticTarget, bindingRevision });
  const evidenceMatches = evidence.targetFingerprint === target.targetFingerprint
    && evidence.observedKeyword === target.expectedKeyword
    && (isZhilianNativeSavedSearchOpenEvidence(evidence)
      ? target.targetKind === 'zhilian-native-condition'
        && evidence.observedNativeConditionId === target.nativeConditionId
        && evidence.observedConditionFingerprint === target.conditionFingerprint
      : target.targetKind === 'core-exact-name-keyword'
        && evidence.observedName === target.name);
  if (!evidenceMatches) {
    throw new Error('Saved-search evidence does not match the requested target identity and keyword.');
  }
  if (isDeepStrictEqual(currentTarget, target)) return current;

  return store.applyJobConfigPatch(input.platform, input.jobKey, input.expectedRevision, {
    searchSource: 'saved',
    pageKeyword: target.expectedKeyword,
    coreSavedSearchTarget: target,
  });
}
