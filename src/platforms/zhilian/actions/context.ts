import { config } from '../../../config.js';
import type {
  CandidateDetailBudgetEstimate,
  CandidateProfileDetailOptions,
  SearchWaitOptions,
} from '../../types.js';

export function estimateZhilianCandidateDetailBudget(): CandidateDetailBudgetEstimate {
  const actionPaceUpperBoundMs = config.playwright.actionDelayMaxMsByPlatform.zhilian;
  const cleanupReserveMs = Math.max(8_000, actionPaceUpperBoundMs * 2);
  const timeoutMs = Math.max(
    60_000,
    config.playwright.resumeDetailTimeoutMs * 3,
    actionPaceUpperBoundMs * 7 + cleanupReserveMs + 10_000,
  );
  return { timeoutMs, cleanupReserveMs };
}

export function createZhilianActionDeadline(
  timeoutMs = config.playwright.resumeDetailTimeoutMs,
): number {
  return Date.now() + Math.max(timeoutMs, 1);
}

export function createZhilianSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? createZhilianActionDeadline(config.playwright.searchPageTimeoutMs);
}

export function resolveZhilianDetailDeadline(
  options?: CandidateProfileDetailOptions,
  includeCleanupReserve = false,
): number {
  const estimate = estimateZhilianCandidateDetailBudget();
  const deadline = options?.deadline ?? Date.now() + estimate.timeoutMs;
  const cleanupReserveMs = includeCleanupReserve
    ? 0
    : options
      ? options.cleanupReserveMs ?? 0
      : estimate.cleanupReserveMs ?? 0;
  const operationDeadline = deadline - cleanupReserveMs;
  if (operationDeadline <= Date.now()) {
    throw new Error('Zhilian candidate detail deadline cannot preserve its cleanup reserve');
  }
  return operationDeadline;
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
