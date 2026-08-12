import type { BrowserSession } from '../browser/session.js';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { handoffPlatformWorkPage, preflightPlatformRuntimeManifests } from '../browser/platform-runtime.js';
import { config } from '../config.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { PlatformAdapter } from '../platforms/types.js';
import { SavedSearchEvidenceStore } from '../search/saved-search-evidence-store.js';
import {
  assertCoreSavedSearchTarget,
  assertPlatformSavedSearchOpenEvidence,
  buildCoreSavedSearchTarget,
  isZhilianNativeSavedSearchOpenEvidence,
  type CoreSavedSearchPlatform,
} from '../search/saved-search-target.js';
import { JobStore } from '../storage/job-store.js';
import type { CoreSavedSearchTarget } from '../types/job.js';

export interface VerifyCoreSavedSearchTargetInput {
  platform: CoreSavedSearchPlatform;
  jobKey: string;
  expectedRevision: number;
  name: string;
  expectedKeyword: string;
}

export interface VerifyCoreSavedSearchTargetSummary {
  platform: CoreSavedSearchPlatform;
  jobKey: string;
  sourceRevision: number;
  targetKind: CoreSavedSearchTarget['targetKind'];
  targetFingerprint: string;
  evidenceHash: string;
  observedName?: string;
  nativeConditionId?: string;
  conditionFingerprint?: string;
  observedKeyword: string;
  verifiedAt: string;
  candidateSideEffects: false;
  jobRecordModified: false;
}

export async function verifyCoreSavedSearchTarget(
  input: VerifyCoreSavedSearchTargetInput,
  dependencies: {
    store?: JobStore;
    evidenceStore?: SavedSearchEvidenceStore;
    resolveAdapter?: (platform: CoreSavedSearchPlatform) => PlatformAdapter;
    preflightRuntimes?: (platforms: readonly CoreSavedSearchPlatform[]) => Promise<void>;
    openSession?: (platform: CoreSavedSearchPlatform) => Promise<BrowserSession>;
    closeSession?: (session: BrowserSession) => Promise<void>;
    handoffWorkPage?: typeof handoffPlatformWorkPage;
    now?: () => Date;
  } = {},
): Promise<VerifyCoreSavedSearchTargetSummary> {
  const store = dependencies.store ?? new JobStore();
  const record = await store.readJobRecord(input.platform, input.jobKey);
  const revision = record.revision ?? 1;
  if (revision !== input.expectedRevision) {
    throw new Error(`Core saved-search verification revision conflict: expected ${input.expectedRevision}, found ${revision}.`);
  }
  if (!record.jobIdentity) {
    throw new Error(`Core saved-search verification requires strict jobIdentity for ${input.platform}/${input.jobKey}.`);
  }
  if (record.searchSettings?.source !== 'saved') {
    throw new Error(`Core saved-search verification requires ${input.platform}/${input.jobKey} to use saved source.`);
  }
  const currentTarget = record.searchSettings.coreSavedSearchTarget;
  const normalizedName = input.name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const normalizedKeyword = input.expectedKeyword.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const sameTarget = currentTarget?.name === normalizedName
    && currentTarget.expectedKeyword === normalizedKeyword;
  const bindingRevision = sameTarget
    ? currentTarget!.bindingRevision
    : (currentTarget?.bindingRevision ?? 0) + 1;
  const adapter = (dependencies.resolveAdapter ?? getPlatformAdapter)(input.platform);
  if (input.platform === 'zhilian' && !adapter.verifySavedSearchTarget) {
    throw new Error('zhilian does not register native saved-search verification.');
  }
  if (input.platform !== 'zhilian' && !adapter.openBoundSavedSearch) {
    throw new Error(`${input.platform} does not register strict saved-search verification.`);
  }
  const estimatedTimeoutMs = adapter.estimateSearchTimeoutMs?.({
    source: 'saved',
    conditions: [],
    includeViewedCandidates: false,
  });
  const timeoutMs = Math.max(
    config.playwright.searchPageTimeoutMs,
    typeof estimatedTimeoutMs === 'number' && Number.isFinite(estimatedTimeoutMs)
      ? Math.max(1, estimatedTimeoutMs)
      : 0,
  );
  await (dependencies.preflightRuntimes ?? preflightPlatformRuntimeManifests)([input.platform]);
  const session = await (dependencies.openSession ?? ensureAuthenticatedBrowserSession)(input.platform);
  try {
    const openOptions = {
      boundJobKey: input.jobKey,
      includeViewedCandidates: false,
      deadline: (dependencies.now ?? (() => new Date()))().getTime() + timeoutMs,
    };
    const opened = input.platform === 'zhilian'
      ? await adapter.verifySavedSearchTarget!(session.page, {
        platform: 'zhilian',
        boundJobKey: input.jobKey,
        bindingRevision,
        name: normalizedName,
        expectedKeyword: normalizedKeyword,
      }, openOptions)
      : await (async () => {
        const target = buildCoreSavedSearchTarget({
          platform: input.platform as '51job' | 'liepin',
          boundJobKey: input.jobKey,
          bindingRevision,
          name: normalizedName,
          expectedKeyword: normalizedKeyword,
        });
        const result = await adapter.openBoundSavedSearch!(session.page, target, openOptions);
        return { ...result, target };
      })();
    const target = assertCoreSavedSearchTarget(opened.target, {
      platform: input.platform,
      boundJobKey: input.jobKey,
      label: 'verified saved-search target',
    });
    const openedEvidence = assertPlatformSavedSearchOpenEvidence(opened.evidence);
    if (openedEvidence.platform !== input.platform
      || openedEvidence.boundJobKey !== input.jobKey
      || openedEvidence.targetFingerprint !== target.targetFingerprint
      || openedEvidence.observedKeyword !== target.expectedKeyword
      || (target.targetKind === 'zhilian-native-condition'
        ? !isZhilianNativeSavedSearchOpenEvidence(openedEvidence)
          || openedEvidence.observedNativeConditionId !== target.nativeConditionId
          || openedEvidence.observedConditionFingerprint !== target.conditionFingerprint
        : isZhilianNativeSavedSearchOpenEvidence(openedEvidence)
          || openedEvidence.observedName !== target.name)) {
      throw new Error('Saved-search verification returned evidence for another target.');
    }
    if (session.runtimeLease && opened.page !== session.page) {
      await (dependencies.handoffWorkPage ?? handoffPlatformWorkPage)(session, session.page, opened.page);
      session.page = opened.page;
    }
    const evidence = await (dependencies.evidenceStore ?? new SavedSearchEvidenceStore()).save(openedEvidence);
    return {
      platform: input.platform,
      jobKey: input.jobKey,
      sourceRevision: revision,
      targetKind: target.targetKind,
      targetFingerprint: target.targetFingerprint,
      evidenceHash: evidence.evidenceHash,
      ...(!isZhilianNativeSavedSearchOpenEvidence(evidence)
        ? { observedName: evidence.observedName }
        : {
          nativeConditionId: evidence.observedNativeConditionId,
          conditionFingerprint: evidence.observedConditionFingerprint,
        }),
      observedKeyword: evidence.observedKeyword,
      verifiedAt: evidence.verifiedAt,
      candidateSideEffects: false,
      jobRecordModified: false,
    };
  } finally {
    await (dependencies.closeSession ?? closeBrowserSession)(session);
  }
}
