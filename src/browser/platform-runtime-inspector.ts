import type { SupportedPlatform } from '../platforms/types.js';

export const platformRuntimeIssueCodes = [
  'browser-runtime-missing',
  'browser-runtime-manifest-invalid',
  'browser-runtime-unreachable',
  'browser-runtime-generation-mismatch',
  'browser-runtime-work-page-missing',
  'browser-runtime-work-page-ambiguous',
  'browser-runtime-auth-required',
  'browser-runtime-busy',
  'browser-runtime-lease-lost',
  'browser-runtime-recovery-required',
  'browser-runtime-config-conflict',
  'browser-runtime-handoff-uncertain',
  'browser-runtime-unpublished-endpoint',
  'browser-runtime-degraded',
] as const;

export type PlatformRuntimeIssueCode = typeof platformRuntimeIssueCodes[number];

export type PlatformBrowserRuntimeManifestV1 = {
  version: 1;
  platform: SupportedPlatform;
  generationId: string;
  revision: number;
  browserInstanceId: string;
  browserContextId: string;
  cdpPort: number;
  profilePathFingerprint: string;
  workPageTargetId: string;
  authenticatedOrigin: string;
  authenticatedAt: string;
  storageStatePersistedAt: string;
  publishedAt: string;
  health?: 'ready' | 'degraded' | 'recovery_required';
  healthIssueCode?: PlatformRuntimeIssueCode;
};

export type PlatformRuntimeExecutableDescriptor = Readonly<PlatformBrowserRuntimeManifestV1>;

export type PlatformRuntimeSafeStatus =
  | 'absent'
  | 'starting'
  | 'login_required'
  | 'published'
  | 'busy'
  | 'unreachable'
  | 'invalid'
  | 'degraded'
  | 'recovery_required';

export type PlatformRuntimeSafeView = {
  platform: SupportedPlatform;
  status: PlatformRuntimeSafeStatus;
  issueCodes: PlatformRuntimeIssueCode[];
  generationFingerprint?: string;
  revision?: number;
  authenticatedAt?: string;
  publishedAt?: string;
  occupiedBy?: {
    operationId: string;
    operationKind: string;
    acquiredAt: string;
  };
  endpointReachable?: boolean;
};

export type PlatformRuntimeInspection = {
  safeView: PlatformRuntimeSafeView;
  issues: PlatformRuntimeIssueCode[];
  validatedManifest?: Readonly<PlatformBrowserRuntimeManifestV1>;
  executableDescriptor?: PlatformRuntimeExecutableDescriptor;
};

const supportedPlatforms = new Set<SupportedPlatform>(['51job', 'liepin', 'zhilian', 'boss']);

const allowedOrigins: Record<SupportedPlatform, ReadonlySet<string>> = {
  '51job': new Set(['https://ehire.51job.com']),
  liepin: new Set(['https://h.liepin.com']),
  zhilian: new Set([
    'https://rd.zhaopin.com',
    'https://rd5.zhaopin.com',
    'https://rd6.zhaopin.com',
  ]),
  boss: new Set(['https://www.zhipin.com']),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maximumLength = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value, 64)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function normalizeOrigin(value: unknown): string | undefined {
  if (!isNonEmptyString(value, 256)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function invalidInspection(platform: SupportedPlatform): PlatformRuntimeInspection {
  return {
    safeView: {
      platform,
      status: 'invalid',
      issueCodes: ['browser-runtime-manifest-invalid'],
    },
    issues: ['browser-runtime-manifest-invalid'],
  };
}

export function inspectPlatformRuntime(
  platform: SupportedPlatform,
  raw: unknown,
): PlatformRuntimeInspection {
  if (raw === undefined || raw === null) {
    return {
      safeView: {
        platform,
        status: 'absent',
        issueCodes: ['browser-runtime-missing'],
      },
      issues: ['browser-runtime-missing'],
    };
  }

  if (!isRecord(raw) || raw.version !== 1 || raw.platform !== platform || !supportedPlatforms.has(raw.platform as SupportedPlatform)) {
    return invalidInspection(platform);
  }

  const origin = normalizeOrigin(raw.authenticatedOrigin);
  const valid = isUuid(raw.generationId)
    && Number.isSafeInteger(raw.revision)
    && (raw.revision as number) >= 1
    && isNonEmptyString(raw.browserInstanceId, 256)
    && isNonEmptyString(raw.browserContextId, 256)
    && Number.isSafeInteger(raw.cdpPort)
    && (raw.cdpPort as number) >= 1
    && (raw.cdpPort as number) <= 65535
    && isSha256(raw.profilePathFingerprint)
    && isNonEmptyString(raw.workPageTargetId, 256)
    && origin !== undefined
    && allowedOrigins[platform].has(origin)
    && isIsoTimestamp(raw.authenticatedAt)
    && isIsoTimestamp(raw.storageStatePersistedAt)
    && isIsoTimestamp(raw.publishedAt)
    && (raw.health === undefined || ['ready', 'degraded', 'recovery_required'].includes(raw.health as string))
    && (raw.healthIssueCode === undefined || platformRuntimeIssueCodes.includes(raw.healthIssueCode as PlatformRuntimeIssueCode));

  if (!valid) return invalidInspection(platform);

  const manifest: PlatformBrowserRuntimeManifestV1 = {
    version: 1,
    platform,
    generationId: raw.generationId as string,
    revision: raw.revision as number,
    browserInstanceId: raw.browserInstanceId as string,
    browserContextId: raw.browserContextId as string,
    cdpPort: raw.cdpPort as number,
    profilePathFingerprint: (raw.profilePathFingerprint as string).toLowerCase(),
    workPageTargetId: raw.workPageTargetId as string,
    authenticatedOrigin: origin,
    authenticatedAt: raw.authenticatedAt as string,
    storageStatePersistedAt: raw.storageStatePersistedAt as string,
    publishedAt: raw.publishedAt as string,
    ...(raw.health ? { health: raw.health as PlatformBrowserRuntimeManifestV1['health'] } : {}),
    ...(raw.healthIssueCode ? { healthIssueCode: raw.healthIssueCode as PlatformRuntimeIssueCode } : {}),
  };
  const issueCodes = manifest.healthIssueCode ? [manifest.healthIssueCode] : [];
  const status = manifest.health === 'recovery_required'
    ? 'recovery_required'
    : manifest.health === 'degraded'
      ? 'degraded'
      : 'published';

  return {
    safeView: {
      platform,
      status,
      issueCodes,
      generationFingerprint: manifest.generationId.slice(0, 8),
      revision: manifest.revision,
      authenticatedAt: manifest.authenticatedAt,
      publishedAt: manifest.publishedAt,
    },
    issues: issueCodes,
    validatedManifest: Object.freeze(manifest),
    ...(status === 'published' || status === 'degraded'
      ? { executableDescriptor: Object.freeze(manifest) }
      : {}),
  };
}

export class PlatformRuntimeError extends Error {
  readonly code: PlatformRuntimeIssueCode;
  readonly platform: SupportedPlatform;

  constructor(platform: SupportedPlatform, code: PlatformRuntimeIssueCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformRuntimeError';
    this.platform = platform;
    this.code = code;
  }
}
