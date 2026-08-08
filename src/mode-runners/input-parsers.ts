import type { BossForwardMode } from '../platforms/types.js';
import type { SearchSource } from './types.js';

export function parseSearchSource(value: string | undefined, argumentName: string): SearchSource {
  if (value === undefined) {
    return 'saved';
  }

  if (value === 'saved' || value === 'direct') {
    return value;
  }

  throw new Error(`${argumentName} must be saved or direct`);
}

export function parseBossForwardMode(
  value: string | undefined,
  argumentName = '--boss-forward-mode',
): BossForwardMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'colleague' || value === 'email') {
    return value;
  }

  throw new Error(`${argumentName} must be colleague or email`);
}
