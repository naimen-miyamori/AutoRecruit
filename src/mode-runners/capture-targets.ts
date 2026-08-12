import { createHash } from 'node:crypto';

import { buildJobKey } from '../parsers/jd-parser.js';
import { assertBossCaptureTaskSnapshotHash } from '../platforms/boss/capture-snapshot.js';
import type { CoreSavedSearchVerificationRequest, SupportedPlatform } from '../platforms/types.js';
import { assertCoreSavedSearchTarget } from '../search/saved-search-target.js';
import { resolvePlatformJobIdentityView, type PlatformJobIdentityView } from '../storage/job-identity.js';
import type {
  BossCaptureTaskSnapshot,
  JobRecord,
  PlatformJobIdentity,
  SearchCondition,
} from '../types/job.js';
import type { ResolvedResumeCaptureContext } from './capture-runner.js';
import type { RunnableJobInput, SinglePlatformCliInput } from './types.js';

export interface PlatformCaptureTargetRequest {
  platform: SupportedPlatform;
  selection: {
    keyword: string;
    bossJobId?: string;
  };
  creation?: {
    jdTextHash?: string;
    jdFilePath?: string;
  };
  overrides: {
    searchSource?: 'saved' | 'direct';
    applicationFilterInputFilePath?: string;
    conditionSetRef?: SinglePlatformCliInput['searchConditionSetRef'];
  };
}

export interface ResolvedCorePlatformCaptureTarget {
  targetKind: 'core';
  platform: '51job' | 'liepin' | 'zhilian';
  jobKey: string;
  recordState: 'existing' | 'new';
  identity: PlatformJobIdentityView | ({ kind: 'prospective' } & PlatformJobIdentity);
  sourceRevision?: number;
  sourceRecordHash?: string;
  expectedAbsent?: true;
  jdInputHash?: string;
  searchPlan: {
    source: 'saved' | 'direct';
    pageKeyword: string;
    conditions: SearchCondition[];
    conditionSetRef?: SinglePlatformCliInput['searchConditionSetRef'];
    savedTarget?: NonNullable<JobRecord['searchSettings']>['coreSavedSearchTarget'];
    savedTargetRequest?: CoreSavedSearchVerificationRequest;
  };
  targetHash: string;
}

export interface ResolvedBossPlatformCaptureTarget {
  targetKind: 'boss-v4';
  platform: 'boss';
  snapshot: BossCaptureTaskSnapshot;
  snapshotHash: string;
  targetHash: string;
}

export type ResolvedPlatformCaptureTarget =
  | ResolvedCorePlatformCaptureTarget
  | ResolvedBossPlatformCaptureTarget;

export interface CaptureExecutionPlan {
  version: 1;
  displayLabel: string;
  platformOrder: SupportedPlatform[];
  targets: ResolvedPlatformCaptureTarget[];
  planHash: string;
}

export interface CaptureExecutionEnvelope {
  version: 1;
  plans: CaptureExecutionPlan[];
  envelopeHash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function hashCaptureSemanticValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function hashCaptureJobRecord(record: JobRecord): string {
  return hashCaptureSemanticValue(record);
}

function normalizeText(value: string, label: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}

export function buildPlatformCaptureTargetRequest(
  input: RunnableJobInput,
  platformInput: SinglePlatformCliInput,
): PlatformCaptureTargetRequest {
  return {
    platform: platformInput.platform,
    selection: {
      keyword: normalizeText(input.searchKeyword, 'capture keyword'),
      ...(platformInput.bossJobId ? { bossJobId: platformInput.bossJobId } : {}),
    },
    ...(platformInput.jobDescriptionText || platformInput.jobDescriptionFilePath ? {
      creation: {
        ...(platformInput.jobDescriptionText
          ? { jdTextHash: hashCaptureSemanticValue(platformInput.jobDescriptionText) }
          : {}),
        ...(platformInput.jobDescriptionFilePath
          ? { jdFilePath: platformInput.jobDescriptionFilePath }
          : {}),
      },
    } : {}),
    overrides: {
      ...(platformInput.searchSourceExplicit ? { searchSource: platformInput.searchSource } : {}),
      ...(platformInput.applicationFilterInputFilePath
        ? { applicationFilterInputFilePath: platformInput.applicationFilterInputFilePath }
        : {}),
      ...(platformInput.searchConditionSetRef
        ? { conditionSetRef: platformInput.searchConditionSetRef }
        : {}),
    },
  };
}

export function resolvePlatformCaptureTarget(input: {
  request: PlatformCaptureTargetRequest;
  platformInput: SinglePlatformCliInput;
  context: ResolvedResumeCaptureContext;
}): ResolvedPlatformCaptureTarget {
  const { request, platformInput, context } = input;
  if (request.platform === 'boss') {
    const suppliedSnapshot = platformInput.bossCaptureTaskSnapshot;
    if (!suppliedSnapshot) {
      throw new Error('Boss execution target requires the authoritative version 4 capture snapshot.');
    }
    const snapshot = assertBossCaptureTaskSnapshotHash(suppliedSnapshot);
    if (snapshot.sourceJobKey !== context.jobKey) {
      throw new Error(`Boss v4 snapshot belongs to ${snapshot.sourceJobKey}, not ${context.jobKey}.`);
    }
    const targetWithoutHash = {
      targetKind: 'boss-v4' as const,
      platform: 'boss' as const,
      snapshot,
      snapshotHash: snapshot.snapshotHash,
    };
    return { ...targetWithoutHash, targetHash: hashCaptureSemanticValue(targetWithoutHash) };
  }

  const expectedJobKey = buildJobKey(request.selection.keyword, '');
  if (context.jobKey !== expectedJobKey) {
    throw new Error(`${request.platform} resolved job ${context.jobKey}, not requested key ${expectedJobKey}.`);
  }
  const existing = context.existingJobRecord;
  const identity = existing
    ? resolvePlatformJobIdentityView(existing)
    : {
      kind: 'prospective' as const,
      version: 1 as const,
      expectedJobName: request.selection.keyword,
      nameAuthority: 'user-confirmed' as const,
    };
  const savedTarget = context.searchSettings.coreSavedSearchTarget
    ? assertCoreSavedSearchTarget(context.searchSettings.coreSavedSearchTarget, {
      platform: request.platform,
      boundJobKey: context.jobKey,
    })
    : undefined;
  const savedTargetRequest = context.prospectiveCoreSavedSearchRequest;
  if (savedTargetRequest && (existing
    || savedTargetRequest.platform !== request.platform
    || savedTargetRequest.boundJobKey !== context.jobKey
    || request.platform !== 'zhilian')) {
    throw new Error('Prospective Zhilian saved-search request does not belong to this new capture target.');
  }
  if (context.searchSettings.source === 'saved'
    && identity.kind !== 'legacy-derived'
    && !savedTarget
    && !savedTargetRequest) {
    throw new Error(`${request.platform}/${context.jobKey} has strict identity but no executable saved-search target.`);
  }
  const targetWithoutHash = {
    targetKind: 'core' as const,
    platform: request.platform,
    jobKey: context.jobKey,
    recordState: existing ? 'existing' as const : 'new' as const,
    identity,
    ...(existing ? {
      sourceRevision: existing.revision ?? 1,
      sourceRecordHash: hashCaptureJobRecord(existing),
    } : {
      expectedAbsent: true as const,
      ...(request.creation?.jdTextHash ? { jdInputHash: request.creation.jdTextHash } : {}),
    }),
    searchPlan: {
      source: context.searchSettings.source,
      pageKeyword: context.pageKeyword,
      conditions: context.searchSettings.conditions,
      ...(context.searchSettings.conditionSetRef
        ? { conditionSetRef: context.searchSettings.conditionSetRef }
        : {}),
      ...(savedTarget ? { savedTarget } : {}),
      ...(savedTargetRequest ? { savedTargetRequest } : {}),
    },
  };
  return { ...targetWithoutHash, targetHash: hashCaptureSemanticValue(targetWithoutHash) };
}

export function buildCaptureExecutionPlan(input: {
  displayLabel: string;
  platformOrder: readonly SupportedPlatform[];
  targets: readonly ResolvedPlatformCaptureTarget[];
}): CaptureExecutionPlan {
  if (input.platformOrder.length === 0 || input.targets.length !== input.platformOrder.length) {
    throw new Error('Capture execution plan requires exactly one target per selected platform.');
  }
  input.platformOrder.forEach((platform, index) => {
    if (input.targets[index]?.platform !== platform) {
      throw new Error(`Capture execution plan target order differs at index ${index}.`);
    }
  });
  const unsigned = {
    version: 1 as const,
    displayLabel: normalizeText(input.displayLabel, 'capture display label'),
    platformOrder: [...input.platformOrder],
    targets: [...input.targets],
  };
  return { ...unsigned, planHash: hashCaptureSemanticValue(unsigned) };
}

export function buildCaptureExecutionEnvelope(
  plans: readonly CaptureExecutionPlan[],
): CaptureExecutionEnvelope {
  const unsigned = { version: 1 as const, plans: [...plans] };
  return { ...unsigned, envelopeHash: hashCaptureSemanticValue(unsigned) };
}

export function assertCaptureExecutionEnvelope(
  value: CaptureExecutionEnvelope,
): CaptureExecutionEnvelope {
  if (value.version !== 1 || !Array.isArray(value.plans)) {
    throw new Error('Capture execution envelope is malformed.');
  }
  for (const plan of value.plans) {
    const { planHash, ...unsignedPlan } = plan;
    if (hashCaptureSemanticValue(unsignedPlan) !== planHash) {
      throw new Error('Capture execution plan hash does not match its canonical content.');
    }
    for (const target of plan.targets) {
      const { targetHash, ...unsignedTarget } = target;
      if (hashCaptureSemanticValue(unsignedTarget) !== targetHash) {
        throw new Error('Capture execution target hash does not match its canonical content.');
      }
      if (target.targetKind === 'boss-v4') assertBossCaptureTaskSnapshotHash(target.snapshot);
    }
  }
  const { envelopeHash, ...unsigned } = value;
  if (hashCaptureSemanticValue(unsigned) !== envelopeHash) {
    throw new Error('Capture execution envelope hash does not match its canonical content.');
  }
  return value;
}
