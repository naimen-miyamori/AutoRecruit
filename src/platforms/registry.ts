import { fiftyOneJobAdapter } from './51job-adapter.js';
import { liepinAdapter } from './liepin-adapter.js';
import { zhilianAdapter } from './zhilian-adapter.js';
import { SUPPORTED_PLATFORMS, type PlatformAdapter, type SupportedPlatform } from './types.js';

const platformRegistry: Record<SupportedPlatform, PlatformAdapter> = {
  '51job': fiftyOneJobAdapter,
  liepin: liepinAdapter,
  zhilian: zhilianAdapter,
};

export function listSupportedPlatforms(): SupportedPlatform[] {
  return [...SUPPORTED_PLATFORMS];
}

export function parsePlatformArg(platform?: string): SupportedPlatform {
  if (platform === undefined) {
    return '51job';
  }

  if (platform in platformRegistry) {
    return platform as SupportedPlatform;
  }

  throw new Error(`Unsupported platform: ${platform}. Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}`);
}

export function getPlatformAdapter(platform: SupportedPlatform): PlatformAdapter {
  return platformRegistry[platform];
}
