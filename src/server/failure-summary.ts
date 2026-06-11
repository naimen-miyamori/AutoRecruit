const DEFAULT_FAILURE_SUMMARY_LENGTH = 140;

export function normalizeFailureMessage(message?: string): string | undefined {
  const normalized = message?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export function summarizeFailureMessage(message?: string, maxLength = DEFAULT_FAILURE_SUMMARY_LENGTH): string | undefined {
  const normalized = normalizeFailureMessage(message);
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const suffix = '...';
  return `${normalized.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}
