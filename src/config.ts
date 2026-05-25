import path from 'node:path';
import dotenv from 'dotenv';
import type { SupportedPlatform } from './platforms/types.js';

dotenv.config();

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return parsed;
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

export const config = {
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  playwright: {
    headless: process.env.PLAYWRIGHT_HEADLESS === 'true',
    storageStatePath: path.resolve(process.env.STORAGE_STATE_PATH ?? './storage-state.json'),
    subscribeUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
    authCheckTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_AUTH_CHECK_TIMEOUT_MS', 15000),
    loginTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_LOGIN_TIMEOUT_MS', 300000),
    loginPollIntervalMs: getOptionalNumberEnv('PLAYWRIGHT_LOGIN_POLL_INTERVAL_MS', 2000),
    resumeDetailTimeoutMs: getOptionalNumberEnv('PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS', 20000),
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
