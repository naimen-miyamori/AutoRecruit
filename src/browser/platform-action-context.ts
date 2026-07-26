import type { Page } from 'playwright';

export interface PlatformActionContext {
  page: Page;
  deadline: number;
  operation: string;
}

export function createPlatformActionContext(
  page: Page,
  timeoutMs: number,
  operation: string,
): PlatformActionContext {
  return {
    page,
    deadline: Date.now() + Math.max(1, timeoutMs),
    operation,
  };
}

export function withPlatformActionPage<T extends PlatformActionContext>(
  context: T,
  page: Page,
  deadline = context.deadline,
): T {
  return { ...context, page, deadline };
}

export function remainingPlatformActionMs(
  context: PlatformActionContext,
  minimumMs = 1,
): number {
  const remaining = context.deadline - Date.now();
  if (remaining < minimumMs) {
    throw new Error(`${context.operation} exceeded its action deadline.`);
  }
  return remaining;
}
