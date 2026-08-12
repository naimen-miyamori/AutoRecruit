import type { SupportedPlatform } from '../platforms/types.js';
import type { JobRecord, PlatformJobIdentity } from '../types/job.js';

export type PlatformJobIdentityIssueCode =
  | 'job-identity-shape-invalid'
  | 'job-identity-version-unsupported'
  | 'job-identity-name-invalid'
  | 'job-identity-authority-invalid'
  | 'job-identity-field-unknown'
  | 'job-identity-native-id-invalid'
  | 'job-identity-native-id-not-supported'
  | 'job-identity-native-id-required'
  | 'job-identity-native-id-mismatch'
  | 'job-identity-boss-position-missing';

export interface PlatformJobIdentityIssue {
  code: PlatformJobIdentityIssueCode;
  message: string;
}

export interface PlatformJobIdentityInspection {
  safeView: {
    kind: 'absent' | 'valid' | 'invalid';
    expectedJobName?: string;
    nameAuthority?: PlatformJobIdentity['nameAuthority'];
    hasNativePositionId?: boolean;
  };
  issues: PlatformJobIdentityIssue[];
  executableIdentity?: PlatformJobIdentity;
}

export type PlatformJobIdentityView =
  | {
      kind: 'legacy-derived';
      expectedJobName: string;
    }
  | ({ kind: 'persisted' } & PlatformJobIdentity);

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() || undefined;
}

function issue(code: PlatformJobIdentityIssueCode, message: string): PlatformJobIdentityIssue {
  return { code, message };
}

export function inspectPlatformJobIdentity(
  raw: unknown,
  context: { platform: SupportedPlatform; bossPositionId?: string },
): PlatformJobIdentityInspection {
  if (raw === undefined) {
    return { safeView: { kind: 'absent' }, issues: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      safeView: { kind: 'invalid' },
      issues: [issue('job-identity-shape-invalid', 'jobIdentity must be an object.')],
    };
  }

  const value = raw as Record<string, unknown>;
  const issues: PlatformJobIdentityIssue[] = [];
  const expectedJobName = normalizeText(value.expectedJobName);
  const nativePositionId = normalizeText(value.nativePositionId);
  const nameAuthority = value.nameAuthority === 'user-confirmed' || value.nameAuthority === 'platform-sync'
    ? value.nameAuthority
    : undefined;
  const allowedKeys = new Set(['version', 'expectedJobName', 'nameAuthority', 'nativePositionId']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();

  if (value.version !== 1) {
    issues.push(issue('job-identity-version-unsupported', 'jobIdentity.version must be 1.'));
  }
  if (!expectedJobName) {
    issues.push(issue('job-identity-name-invalid', 'jobIdentity.expectedJobName must be non-empty.'));
  }
  if (!nameAuthority) {
    issues.push(issue('job-identity-authority-invalid', 'jobIdentity.nameAuthority is invalid.'));
  }
  if (unknownKeys.length > 0) {
    issues.push(issue('job-identity-field-unknown', `jobIdentity contains unknown fields: ${unknownKeys.join(', ')}.`));
  }
  if (value.nativePositionId !== undefined && !nativePositionId) {
    issues.push(issue('job-identity-native-id-invalid', 'jobIdentity.nativePositionId must be non-empty when present.'));
  }

  if (context.platform === 'boss') {
    if (nameAuthority && nameAuthority !== 'platform-sync') {
      issues.push(issue('job-identity-authority-invalid', 'Boss job identity must be owned by platform-sync.'));
    }
    if (!nativePositionId) {
      issues.push(issue('job-identity-native-id-required', 'Boss platform-sync identity requires nativePositionId.'));
    }
    if (!context.bossPositionId) {
      issues.push(issue('job-identity-boss-position-missing', 'Boss platform-sync identity requires bossPosition.bossJobId.'));
    } else if (nativePositionId && nativePositionId !== context.bossPositionId) {
      issues.push(issue(
        'job-identity-native-id-mismatch',
        `jobIdentity.nativePositionId ${nativePositionId} does not match bossPosition.bossJobId ${context.bossPositionId}.`,
      ));
    }
  } else {
    if (nameAuthority && nameAuthority !== 'user-confirmed') {
      issues.push(issue('job-identity-authority-invalid', `${context.platform} job identity must be user-confirmed.`));
    }
    if (nativePositionId) {
      issues.push(issue(
        'job-identity-native-id-not-supported',
        `${context.platform} does not have an authoritative native position ID contract.`,
      ));
    }
  }

  const safeView: PlatformJobIdentityInspection['safeView'] = {
    kind: issues.length === 0 ? 'valid' : 'invalid',
    ...(expectedJobName ? { expectedJobName } : {}),
    ...(nameAuthority ? { nameAuthority } : {}),
    ...(value.nativePositionId !== undefined ? { hasNativePositionId: Boolean(nativePositionId) } : {}),
  };
  if (issues.length > 0 || !expectedJobName || !nameAuthority) {
    return { safeView, issues };
  }

  return {
    safeView,
    issues,
    executableIdentity: {
      version: 1,
      expectedJobName,
      nameAuthority,
      ...(nativePositionId ? { nativePositionId } : {}),
    },
  };
}

export function assertPlatformJobIdentity(
  raw: unknown,
  context: { platform: SupportedPlatform; bossPositionId?: string; label?: string },
): PlatformJobIdentity | undefined {
  const inspection = inspectPlatformJobIdentity(raw, context);
  if (inspection.issues.length > 0) {
    const label = context.label ?? `${context.platform} jobIdentity`;
    throw new Error(`${label} is invalid: ${inspection.issues.map((item) => item.code).join(', ')}.`);
  }
  return inspection.executableIdentity;
}

export function resolvePlatformJobIdentityView(record: JobRecord): PlatformJobIdentityView {
  if (record.jobIdentity === undefined) {
    const expectedJobName = normalizeText(record.searchKeyword);
    if (!expectedJobName) {
      throw new Error(`Legacy job identity for ${record.platform}/${record.jobKey} has an empty searchKeyword.`);
    }
    return { kind: 'legacy-derived', expectedJobName };
  }
  const identity = assertPlatformJobIdentity(record.jobIdentity, {
    platform: record.platform,
    bossPositionId: record.bossPosition?.bossJobId,
    label: `${record.platform}/${record.jobKey} jobIdentity`,
  });
  if (!identity) {
    throw new Error(`${record.platform}/${record.jobKey} jobIdentity unexpectedly resolved as absent.`);
  }
  return { kind: 'persisted', ...identity };
}
