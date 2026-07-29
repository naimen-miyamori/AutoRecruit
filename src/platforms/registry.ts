import { fiftyOneJobAdapter } from './51job-adapter.js';
import { bossAdapter } from './boss-adapter.js';
import { liepinAdapter } from './liepin-adapter.js';
import { zhilianAdapter } from './zhilian-adapter.js';
import {
  ALL_PLATFORM_RUN_ORDER,
  CAPTURE_PLATFORM_RUN_ORDER,
  SUPPORTED_PLATFORMS,
  type PlatformAdapter,
  type SupportedPlatform,
} from './types.js';

const platformRegistry: Record<SupportedPlatform, PlatformAdapter> = {
  '51job': fiftyOneJobAdapter,
  liepin: liepinAdapter,
  zhilian: zhilianAdapter,
  boss: bossAdapter,
};

export function listSupportedPlatforms(): SupportedPlatform[] {
  return [...ALL_PLATFORM_RUN_ORDER];
}

/**
 * Normal capture and batch can opt into Boss/直猎邦 without broadening the independent
 * `all` contracts used by search subscriptions, questions, filter discovery, or Mapping.
 */
export function listCapturePlatforms(includeBoss = false): SupportedPlatform[] {
  return includeBoss ? [...CAPTURE_PLATFORM_RUN_ORDER] : listSupportedPlatforms();
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
