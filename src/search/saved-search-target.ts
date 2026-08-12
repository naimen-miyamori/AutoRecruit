import { createHash } from 'node:crypto';

import type { SupportedPlatform } from '../platforms/types.js';
import type {
  CoreExactNameSavedSearchTarget,
  CoreSavedSearchTarget,
  ExactNameSavedSearchOpenEvidence,
  PlatformSavedSearchOpenEvidence,
  PlatformSavedSearchTarget,
  SavedSearchReference,
  ZhilianNativeSavedSearchOpenEvidence,
  ZhilianNativeSavedSearchTarget,
} from '../types/job.js';

export const CORE_SAVED_SEARCH_PLATFORMS = ['51job', 'liepin', 'zhilian'] as const;
export type CoreSavedSearchPlatform = typeof CORE_SAVED_SEARCH_PLATFORMS[number];
export const EXACT_NAME_SAVED_SEARCH_PLATFORMS = ['51job', 'liepin'] as const;
export type ExactNameSavedSearchPlatform = typeof EXACT_NAME_SAVED_SEARCH_PLATFORMS[number];

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

function hashSemantic(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() || undefined;
}

function requireNormalizedText(value: unknown, label: string): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized !== value) throw new Error(`${label} must be a non-empty normalized string.`);
  return normalized;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function requireNativeConditionId(value: unknown, label: string): string {
  const normalized = requireNormalizedText(value, label);
  if (!/^\d+$/u.test(normalized)) throw new Error(`${label} must be a numeric platform condition ID.`);
  return normalized;
}

function requireBindingRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function exactTargetSemanticValue(
  target: Omit<CoreExactNameSavedSearchTarget, 'targetFingerprint'>,
): unknown {
  return {
    version: target.version,
    targetKind: target.targetKind,
    platform: target.platform,
    boundJobKey: target.boundJobKey,
    name: target.name,
    expectedKeyword: target.expectedKeyword,
  };
}

function zhilianTargetSemanticValue(
  target: Omit<ZhilianNativeSavedSearchTarget, 'targetFingerprint'>,
): unknown {
  return {
    version: target.version,
    targetKind: target.targetKind,
    platform: target.platform,
    boundJobKey: target.boundJobKey,
    name: target.name,
    nativeConditionId: target.nativeConditionId,
    expectedKeyword: target.expectedKeyword,
    conditionFingerprint: target.conditionFingerprint,
  };
}

export function fingerprintCoreSavedSearchTarget(
  target:
    | Omit<CoreExactNameSavedSearchTarget, 'targetFingerprint'>
    | Omit<ZhilianNativeSavedSearchTarget, 'targetFingerprint'>,
): string {
  return hashSemantic(target.targetKind === 'zhilian-native-condition'
    ? zhilianTargetSemanticValue(target)
    : exactTargetSemanticValue(target));
}

export function buildCoreSavedSearchTarget(input: {
  platform: ExactNameSavedSearchPlatform;
  boundJobKey: string;
  bindingRevision: number;
  name: string;
  expectedKeyword: string;
}): CoreExactNameSavedSearchTarget {
  if (!EXACT_NAME_SAVED_SEARCH_PLATFORMS.includes(input.platform)) {
    throw new Error(`Exact-name saved-search target does not support platform ${input.platform}; Zhilian requires native-condition migration.`);
  }
  const boundJobKey = normalizeText(input.boundJobKey);
  const name = normalizeText(input.name);
  const expectedKeyword = normalizeText(input.expectedKeyword);
  if (!boundJobKey || !name || !expectedKeyword) {
    throw new Error('Exact-name saved-search target requires boundJobKey, name, and expectedKeyword.');
  }
  const bindingRevision = requireBindingRevision(input.bindingRevision, 'Exact-name saved-search bindingRevision');
  const targetWithoutFingerprint = {
    version: 1 as const,
    targetKind: 'core-exact-name-keyword' as const,
    platform: input.platform,
    boundJobKey,
    bindingRevision,
    name,
    expectedKeyword,
  };
  return {
    ...targetWithoutFingerprint,
    targetFingerprint: fingerprintCoreSavedSearchTarget(targetWithoutFingerprint),
  };
}

export function buildZhilianNativeSavedSearchTarget(input: {
  boundJobKey: string;
  bindingRevision: number;
  name: string;
  nativeConditionId: string;
  expectedKeyword: string;
  conditionFingerprint: string;
}): ZhilianNativeSavedSearchTarget {
  const boundJobKey = normalizeText(input.boundJobKey);
  const name = normalizeText(input.name);
  const expectedKeyword = normalizeText(input.expectedKeyword);
  if (!boundJobKey || !name || !expectedKeyword) {
    throw new Error('Zhilian native saved-search target requires boundJobKey, name, and expectedKeyword.');
  }
  const targetWithoutFingerprint = {
    version: 1 as const,
    targetKind: 'zhilian-native-condition' as const,
    platform: 'zhilian' as const,
    boundJobKey,
    bindingRevision: requireBindingRevision(input.bindingRevision, 'Zhilian native saved-search bindingRevision'),
    name,
    nativeConditionId: requireNativeConditionId(input.nativeConditionId, 'Zhilian nativeConditionId'),
    expectedKeyword,
    conditionFingerprint: requireFingerprint(input.conditionFingerprint, 'Zhilian conditionFingerprint'),
  };
  return {
    ...targetWithoutFingerprint,
    targetFingerprint: fingerprintCoreSavedSearchTarget(targetWithoutFingerprint),
  };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknownKeys.length > 0) throw new Error(`${label} contains unknown fields: ${unknownKeys.sort().join(', ')}.`);
}

export function assertCoreSavedSearchTarget(
  raw: unknown,
  context: { platform?: SupportedPlatform; boundJobKey?: string; label?: string } = {},
): CoreSavedSearchTarget {
  const label = context.label ?? 'core saved-search target';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object.`);
  const value = raw as Record<string, unknown>;
  let target: CoreSavedSearchTarget;
  if (value.version === 1 && value.targetKind === 'core-exact-name-keyword') {
    if (value.platform === 'zhilian') {
      throw new Error(`${label} uses legacy Zhilian exact-name identity; Zhilian native-condition migration is required.`);
    }
    if (value.platform !== '51job' && value.platform !== 'liepin') {
      throw new Error(`${label} exact-name platform is invalid.`);
    }
    target = buildCoreSavedSearchTarget({
      platform: value.platform,
      boundJobKey: String(value.boundJobKey ?? ''),
      bindingRevision: Number(value.bindingRevision),
      name: String(value.name ?? ''),
      expectedKeyword: String(value.expectedKeyword ?? ''),
    });
    assertAllowedKeys(value, [
      'version', 'targetKind', 'platform', 'boundJobKey', 'bindingRevision',
      'name', 'expectedKeyword', 'targetFingerprint',
    ], label);
  } else if (value.version === 1 && value.targetKind === 'zhilian-native-condition') {
    if (value.platform !== 'zhilian') throw new Error(`${label} native-condition platform must be zhilian.`);
    target = buildZhilianNativeSavedSearchTarget({
      boundJobKey: String(value.boundJobKey ?? ''),
      bindingRevision: Number(value.bindingRevision),
      name: String(value.name ?? ''),
      nativeConditionId: String(value.nativeConditionId ?? ''),
      expectedKeyword: String(value.expectedKeyword ?? ''),
      conditionFingerprint: String(value.conditionFingerprint ?? ''),
    });
    assertAllowedKeys(value, [
      'version', 'targetKind', 'platform', 'boundJobKey', 'bindingRevision', 'name',
      'nativeConditionId', 'expectedKeyword', 'conditionFingerprint', 'targetFingerprint',
    ], label);
  } else {
    throw new Error(`${label} has an unsupported version or targetKind.`);
  }
  if (value.targetFingerprint !== target.targetFingerprint) {
    throw new Error(`${label} targetFingerprint does not match its semantic target.`);
  }
  if (context.platform && target.platform !== context.platform) {
    throw new Error(`${label} belongs to ${target.platform}, not ${context.platform}.`);
  }
  if (context.boundJobKey && target.boundJobKey !== context.boundJobKey) {
    throw new Error(`${label} belongs to job ${target.boundJobKey}, not ${context.boundJobKey}.`);
  }
  return target;
}

export function isZhilianNativeSavedSearchTarget(
  target: CoreSavedSearchTarget,
): target is ZhilianNativeSavedSearchTarget {
  return target.targetKind === 'zhilian-native-condition';
}

export function fingerprintSavedSearchTarget(target: PlatformSavedSearchTarget): string {
  return 'targetKind' in target
    ? assertCoreSavedSearchTarget(target).targetFingerprint
    : hashSemantic(target as SavedSearchReference);
}

export function buildSavedSearchOpenEvidence(
  target: PlatformSavedSearchTarget,
  observation: {
    boundJobKey: string;
    observedName: string;
    observedKeyword: string;
    verifiedAt?: string;
    observedConditionFingerprint?: string;
  },
): ExactNameSavedSearchOpenEvidence {
  if ('targetKind' in target && target.targetKind === 'zhilian-native-condition') {
    throw new Error('Zhilian native-condition target requires native saved-search open evidence.');
  }
  const observedName = normalizeText(observation.observedName);
  const observedKeyword = normalizeText(observation.observedKeyword);
  const boundJobKey = normalizeText(observation.boundJobKey);
  const expectedName = normalizeText(target.name);
  const expectedKeyword = normalizeText(target.expectedKeyword);
  if (!boundJobKey || !observedName || !observedKeyword || !expectedName || !expectedKeyword) {
    throw new Error('Saved-search open evidence is missing required identity fields.');
  }
  if (observedName !== expectedName) {
    throw new Error(`Saved-search observed name ${observedName} does not exactly match ${expectedName}.`);
  }
  if (observedKeyword !== expectedKeyword) {
    throw new Error(`Saved-search observed keyword ${observedKeyword} does not exactly match ${expectedKeyword}.`);
  }
  const coreTarget = 'targetKind' in target ? target : undefined;
  if (coreTarget && boundJobKey !== coreTarget.boundJobKey) {
    throw new Error(`Saved-search evidence belongs to job ${boundJobKey}, not ${coreTarget.boundJobKey}.`);
  }
  if ('conditionIdentity' in target
    && target.conditionIdentity.jobScope !== normalizeText(target.conditionIdentity.jobScope)) {
    throw new Error('Boss saved-search job scope is invalid.');
  }
  const unsigned = {
    version: 1 as const,
    platform: target.platform,
    boundJobKey,
    targetFingerprint: fingerprintSavedSearchTarget(target),
    observedName,
    observedKeyword,
    uniqueness: 'unique-exact-match' as const,
    postcondition: 'opened-and-verified' as const,
    verifiedAt: observation.verifiedAt ?? new Date().toISOString(),
    ...(observation.observedConditionFingerprint
      ? { observedConditionFingerprint: observation.observedConditionFingerprint }
      : {}),
  };
  return { ...unsigned, evidenceHash: hashSemantic(unsigned) };
}

export function buildZhilianNativeSavedSearchOpenEvidence(
  target: ZhilianNativeSavedSearchTarget,
  observation: {
    boundJobKey: string;
    observedNativeConditionId: string;
    observedKeyword: string;
    observedConditionFingerprint: string;
    verifiedAt?: string;
  },
): ZhilianNativeSavedSearchOpenEvidence {
  const boundJobKey = normalizeText(observation.boundJobKey);
  const observedKeyword = normalizeText(observation.observedKeyword);
  const observedNativeConditionId = requireNativeConditionId(
    observation.observedNativeConditionId,
    'Zhilian observedNativeConditionId',
  );
  const observedConditionFingerprint = requireFingerprint(
    observation.observedConditionFingerprint,
    'Zhilian observedConditionFingerprint',
  );
  if (!boundJobKey || !observedKeyword) {
    throw new Error('Zhilian native saved-search open evidence is missing required identity fields.');
  }
  if (boundJobKey !== target.boundJobKey) {
    throw new Error(`Zhilian saved-search evidence belongs to job ${boundJobKey}, not ${target.boundJobKey}.`);
  }
  if (observedNativeConditionId !== target.nativeConditionId) {
    throw new Error(`Zhilian observed native condition ${observedNativeConditionId} does not match ${target.nativeConditionId}.`);
  }
  if (observedKeyword !== target.expectedKeyword) {
    throw new Error(`Zhilian observed keyword ${observedKeyword} does not exactly match ${target.expectedKeyword}.`);
  }
  if (observedConditionFingerprint !== target.conditionFingerprint) {
    throw new Error('Zhilian observed condition fingerprint does not match the bound target.');
  }
  const unsigned = {
    version: 1 as const,
    identityKind: 'zhilian-native-condition' as const,
    platform: 'zhilian' as const,
    boundJobKey,
    targetFingerprint: target.targetFingerprint,
    observedNativeConditionId,
    observedKeyword,
    observedConditionFingerprint,
    uniqueness: 'unique-native-condition-match' as const,
    postcondition: 'opened-and-verified' as const,
    verifiedAt: observation.verifiedAt ?? new Date().toISOString(),
  };
  return { ...unsigned, evidenceHash: hashSemantic(unsigned) };
}

function assertCommonEvidenceFields(value: Record<string, unknown>, label: string): void {
  if (value.version !== 1 || value.postcondition !== 'opened-and-verified') {
    throw new Error(`${label} has an unsupported version or postcondition.`);
  }
  if (value.platform !== '51job' && value.platform !== 'liepin'
    && value.platform !== 'zhilian' && value.platform !== 'boss') {
    throw new Error(`${label} platform is invalid.`);
  }
  requireNormalizedText(value.boundJobKey, `${label} boundJobKey`);
  requireFingerprint(value.targetFingerprint, `${label} targetFingerprint`);
  requireNormalizedText(value.observedKeyword, `${label} observedKeyword`);
  requireFingerprint(value.evidenceHash, `${label} evidenceHash`);
  if (typeof value.verifiedAt !== 'string'
    || !Number.isFinite(Date.parse(value.verifiedAt))
    || new Date(value.verifiedAt).toISOString() !== value.verifiedAt) {
    throw new Error(`${label} verifiedAt must be a canonical ISO timestamp.`);
  }
}

export function assertPlatformSavedSearchOpenEvidence(
  raw: unknown,
  label = 'saved-search open evidence',
): PlatformSavedSearchOpenEvidence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object.`);
  const value = raw as Record<string, unknown>;
  assertCommonEvidenceFields(value, label);
  if (value.identityKind === 'zhilian-native-condition') {
    if (value.platform !== 'zhilian' || value.uniqueness !== 'unique-native-condition-match') {
      throw new Error(`${label} native-condition platform or uniqueness is invalid.`);
    }
    requireNativeConditionId(value.observedNativeConditionId, `${label} observedNativeConditionId`);
    requireFingerprint(value.observedConditionFingerprint, `${label} observedConditionFingerprint`);
    assertAllowedKeys(value, [
      'version', 'identityKind', 'platform', 'boundJobKey', 'targetFingerprint',
      'observedNativeConditionId', 'observedKeyword', 'observedConditionFingerprint',
      'uniqueness', 'postcondition', 'verifiedAt', 'evidenceHash',
    ], label);
  } else {
    if (value.identityKind !== undefined && value.identityKind !== 'exact-name-keyword') {
      throw new Error(`${label} identityKind is invalid.`);
    }
    if (value.uniqueness !== 'unique-exact-match') throw new Error(`${label} exact-name uniqueness is invalid.`);
    requireNormalizedText(value.observedName, `${label} observedName`);
    if (value.observedConditionFingerprint !== undefined) {
      requireFingerprint(value.observedConditionFingerprint, `${label} observedConditionFingerprint`);
    }
    assertAllowedKeys(value, [
      'version', 'identityKind', 'platform', 'boundJobKey', 'targetFingerprint', 'observedName',
      'observedKeyword', 'uniqueness', 'postcondition', 'verifiedAt',
      'observedConditionFingerprint', 'evidenceHash',
    ], label);
  }
  const { evidenceHash, ...unsigned } = value;
  if (hashSemantic(unsigned) !== evidenceHash) throw new Error(`${label} hash is invalid or the artifact was tampered.`);
  return value as unknown as PlatformSavedSearchOpenEvidence;
}

export function isZhilianNativeSavedSearchOpenEvidence(
  evidence: PlatformSavedSearchOpenEvidence,
): evidence is ZhilianNativeSavedSearchOpenEvidence {
  return evidence.identityKind === 'zhilian-native-condition';
}
