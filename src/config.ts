import path from 'node:path';
import dotenv from 'dotenv';
import type { SupportedPlatform } from './platforms/types.js';

dotenv.config();

export type BrowserEngine = 'cloakbrowser' | 'playwright';

const platformEnvPrefixes: Record<SupportedPlatform, string> = {
  '51job': '51JOB',
  liepin: 'LIEPIN',
  zhilian: 'ZHILIAN',
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getNumberEnv(name: string): number | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return parsed;
}

function getOptionalNumberEnv(name: string, fallback: number): number {
  return getNumberEnv(name) ?? fallback;
}

function getBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  throw new Error(`Environment variable ${name} must be true or false`);
}

function getBrowserEngineEnv(): BrowserEngine {
  const value = (process.env.BROWSER_ENGINE ?? 'cloakbrowser').trim().toLowerCase();

  if (value === 'cloakbrowser' || value === 'playwright') {
    return value;
  }

  throw new Error('Environment variable BROWSER_ENGINE must be either "cloakbrowser" or "playwright"');
}

function getDefaultStorageStatePath(platform: SupportedPlatform): string {
  return path.resolve(platform === '51job' ? './storage-state.json' : `./storage-state.${platform}.json`);
}

function normalizeStorageStateBasename(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}

function isSafeStorageStateOverride(platform: SupportedPlatform, resolvedPath: string): boolean {
  const baseName = normalizeStorageStateBasename(resolvedPath);

  if (platform === '51job') {
    return baseName === 'storage-state.json' || baseName.includes('51job');
  }

  return baseName.includes(platform);
}

export function resolveStorageStatePath(platform: SupportedPlatform): string {
  const configuredPath = process.env.STORAGE_STATE_PATH;
  const resolvedPath = path.resolve(configuredPath ?? getDefaultStorageStatePath(platform));

  if (configuredPath && !isSafeStorageStateOverride(platform, resolvedPath)) {
    throw new Error(
      `Configured STORAGE_STATE_PATH=${JSON.stringify(configuredPath)} is not safe for ${platform}. `
      + `Remove STORAGE_STATE_PATH to use the platform default, or set a platform-specific path.`,
    );
  }

  return resolvedPath;
}

function getPlatformNumberEnv(platform: SupportedPlatform, suffix: string, fallback: number): number {
  return getNumberEnv(`PLAYWRIGHT_${platformEnvPrefixes[platform]}_${suffix}`)
    ?? getNumberEnv(`PLAYWRIGHT_${suffix}`)
    ?? fallback;
}

function getPlatformBooleanEnv(platform: SupportedPlatform, suffix: string, fallback: boolean): boolean {
  return getBooleanEnv(`PLAYWRIGHT_${platformEnvPrefixes[platform]}_${suffix}`)
    ?? getBooleanEnv(`PLAYWRIGHT_${suffix}`)
    ?? fallback;
}

const actionDelayMinMsByPlatform: Record<SupportedPlatform, number> = {
  '51job': getPlatformNumberEnv('51job', 'ACTION_DELAY_MIN_MS', 0),
  liepin: getPlatformNumberEnv('liepin', 'ACTION_DELAY_MIN_MS', 2000),
  zhilian: getPlatformNumberEnv('zhilian', 'ACTION_DELAY_MIN_MS', 0),
};
const actionDelayMaxMsByPlatform: Record<SupportedPlatform, number> = {
  '51job': getPlatformNumberEnv('51job', 'ACTION_DELAY_MAX_MS', 0),
  liepin: getPlatformNumberEnv('liepin', 'ACTION_DELAY_MAX_MS', 3000),
  zhilian: getPlatformNumberEnv('zhilian', 'ACTION_DELAY_MAX_MS', 0),
};
const candidateDelayMinMsByPlatform: Record<SupportedPlatform, number> = {
  '51job': getPlatformNumberEnv('51job', 'CANDIDATE_DELAY_MIN_MS', 0),
  liepin: getPlatformNumberEnv('liepin', 'CANDIDATE_DELAY_MIN_MS', 2000),
  zhilian: getPlatformNumberEnv('zhilian', 'CANDIDATE_DELAY_MIN_MS', 0),
};
const candidateDelayMaxMsByPlatform: Record<SupportedPlatform, number> = {
  '51job': getPlatformNumberEnv('51job', 'CANDIDATE_DELAY_MAX_MS', 0),
  liepin: getPlatformNumberEnv('liepin', 'CANDIDATE_DELAY_MAX_MS', 3000),
  zhilian: getPlatformNumberEnv('zhilian', 'CANDIDATE_DELAY_MAX_MS', 0),
};
const reuseBrowserByPlatform: Record<SupportedPlatform, boolean> = {
  '51job': getPlatformBooleanEnv('51job', 'REUSE_BROWSER', true),
  liepin: getPlatformBooleanEnv('liepin', 'REUSE_BROWSER', true),
  zhilian: getPlatformBooleanEnv('zhilian', 'REUSE_BROWSER', true),
};
const reuseCdpPortByPlatform: Record<SupportedPlatform, number> = {
  '51job': getOptionalNumberEnv('PLAYWRIGHT_51JOB_REUSE_CDP_PORT', 19325),
  liepin: getOptionalNumberEnv('PLAYWRIGHT_LIEPIN_REUSE_CDP_PORT', 19327),
  zhilian: getOptionalNumberEnv('PLAYWRIGHT_ZHILIAN_REUSE_CDP_PORT', 19329),
};

export const config = {
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  browser: {
    engine: getBrowserEngineEnv(),
  },
  playwright: {
    headless: process.env.PLAYWRIGHT_HEADLESS === 'true',
    storageStatePath: path.resolve(process.env.STORAGE_STATE_PATH ?? './storage-state.json'),
    subscribeUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
    authCheckTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_AUTH_CHECK_TIMEOUT_MS', 15000),
    loginTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_LOGIN_TIMEOUT_MS', 300000),
    loginPollIntervalMs: getOptionalNumberEnv('PLAYWRIGHT_LOGIN_POLL_INTERVAL_MS', 2000),
    searchPageTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS', 20000),
    emptyResultsStableMs: getOptionalNumberEnv('PLAYWRIGHT_EMPTY_RESULTS_STABLE_MS', 2000),
    apiFallbackTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_API_FALLBACK_TIMEOUT_MS', 3000),
    resumeDetailTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS', 20000),
    actionDelayMinMsByPlatform,
    actionDelayMaxMsByPlatform,
    candidateDelayMinMsByPlatform,
    candidateDelayMaxMsByPlatform,
    reuseBrowserByPlatform,
    reuseCdpPortByPlatform,
    liepinActionDelayMinMs: actionDelayMinMsByPlatform.liepin,
    liepinActionDelayMaxMs: actionDelayMaxMsByPlatform.liepin,
    liepinCandidateDelayMinMs: candidateDelayMinMsByPlatform.liepin,
    liepinCandidateDelayMaxMs: candidateDelayMaxMsByPlatform.liepin,
    liepinReuseBrowser: reuseBrowserByPlatform.liepin,
    liepinReuseCdpPort: reuseCdpPortByPlatform.liepin,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.OPENAI_BASE_URL ?? '',
    model: process.env.OPENAI_MODEL ?? '',
  },
  jdParsing: {
    model: process.env.JD_PARSING_MODEL ?? process.env.OPENAI_MODEL ?? '',
  },
  scoring: {
    model: process.env.SCORING_MODEL ?? process.env.OPENAI_MODEL ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: getOptionalNumberEnv('SMTP_PORT', 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? '',
  },
};

export { getRequiredEnv };
