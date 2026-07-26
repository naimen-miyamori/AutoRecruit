import { config } from '../../../config.js';
import type { SearchWaitOptions } from '../../types.js';

export function createZhilianActionDeadline(
  timeoutMs = config.playwright.resumeDetailTimeoutMs,
): number {
  return Date.now() + Math.max(timeoutMs, 1);
}

export function createZhilianSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? createZhilianActionDeadline(config.playwright.searchPageTimeoutMs);
}

export function remainingZhilianActionMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

export function boundedZhilianActionMs(
  deadline: number,
  maxTimeoutMs = Number.POSITIVE_INFINITY,
): number {
  return Math.max(1, Math.min(remainingZhilianActionMs(deadline), maxTimeoutMs));
}
