import { isScheduleId, isScheduleRunId } from './schedule-identifiers.js';
import { assertTimeZone, validateDailyWindow } from './schedule-time.js';
import {
  inspectScheduleTemplates,
  mergeScheduleValidationIssues,
} from './schedule-template-validation.js';
import type {
  NormalizedScheduleDefinition,
  ScheduleDetailView,
  ScheduleStatus,
  ScheduleSummary,
  ScheduleValidationIssue,
  WorkflowFailurePolicy,
} from './types.js';

export const SCHEDULE_RECORD_INVALID = 'schedule-record-invalid' as const;

const FALLBACK_TIME_ZONE = 'UTC';
const FALLBACK_WINDOW = { start: '00:00', end: '23:59' } as const;
const FALLBACK_REPEAT = {
  mode: 'after-completion' as const,
  delaySeconds: 0,
  failureDelaySeconds: 300,
};
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createRecordIssue(): ScheduleValidationIssue {
  return {
    code: SCHEDULE_RECORD_INVALID,
    taskKey: 'schedule',
    kind: '<metadata>',
    message: `${SCHEDULE_RECORD_INVALID}: <metadata>; replace the malformed schedule metadata with a complete valid configuration`,
  };
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const normalized = boundedString(value, 64);
  if (!normalized) return undefined;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? normalized : undefined;
}

function validOptionalTimestamp(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return validTimestamp(value) ?? null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function validStatus(value: unknown): ScheduleStatus | undefined {
  return value === 'enabled' || value === 'paused' || value === 'stop_requested' || value === 'stopped'
    ? value
    : undefined;
}

function validFailurePolicy(value: unknown): WorkflowFailurePolicy | undefined {
  return value === 'stop-round' || value === 'continue' ? value : undefined;
}

export interface ScheduleRecordInspection {
  metadataValid: boolean;
  issues: ScheduleValidationIssue[];
  detail: ScheduleDetailView;
  summary: ScheduleSummary;
  executable?: NormalizedScheduleDefinition;
}

/**
 * Treat every persisted field as untrusted JSON. The returned projections never
 * retain raw object/array references except for validated executable task input.
 */
export function inspectPersistedScheduleRecord(
  value: unknown,
  expectedScheduleId?: string,
): ScheduleRecordInspection {
  const record = isRecord(value) ? value : {};
  let metadataValid = isRecord(value);
  const invalidate = () => {
    metadataValid = false;
  };

  const declaredScheduleId = typeof record.scheduleId === 'string' && isScheduleId(record.scheduleId)
    ? record.scheduleId
    : undefined;
  const scheduleId = expectedScheduleId && isScheduleId(expectedScheduleId)
    ? expectedScheduleId
    : declaredScheduleId ?? '00000000-0000-4000-8000-000000000000';
  if (!declaredScheduleId || (expectedScheduleId !== undefined && declaredScheduleId !== expectedScheduleId)) invalidate();

  const name = boundedString(record.name, 200);
  if (!name) invalidate();

  const status = validStatus(record.status);
  if (!status) invalidate();

  const timeZone = boundedString(record.timeZone, 100);
  if (!timeZone) {
    invalidate();
  } else {
    try {
      assertTimeZone(timeZone);
    } catch {
      invalidate();
    }
  }
  const safeTimeZone = (() => {
    if (!timeZone) return FALLBACK_TIME_ZONE;
    try {
      assertTimeZone(timeZone);
      return timeZone;
    } catch {
      return FALLBACK_TIME_ZONE;
    }
  })();

  const dailyWindowRecord = isRecord(record.dailyWindow) ? record.dailyWindow : {};
  const start = boundedString(dailyWindowRecord.start, 5);
  const end = boundedString(dailyWindowRecord.end, 5);
  let dailyWindow: { start: string; end: string } = { ...FALLBACK_WINDOW };
  if (start && end) {
    try {
      validateDailyWindow({ start, end });
      dailyWindow = { start, end };
    } catch {
      invalidate();
    }
  } else {
    invalidate();
  }

  const repeatRecord = isRecord(record.repeat) ? record.repeat : {};
  const delaySeconds = nonNegativeInteger(repeatRecord.delaySeconds);
  const failureDelaySeconds = positiveInteger(repeatRecord.failureDelaySeconds);
  if (repeatRecord.mode !== 'after-completion' || delaySeconds === undefined || failureDelaySeconds === undefined) {
    invalidate();
  }
  const repeat = repeatRecord.mode === 'after-completion'
    && delaySeconds !== undefined
    && failureDelaySeconds !== undefined
    ? { mode: 'after-completion' as const, delaySeconds, failureDelaySeconds }
    : { ...FALLBACK_REPEAT };

  const failurePolicy = validFailurePolicy(record.failurePolicy);
  if (!failurePolicy) invalidate();
  const pauseAfterConsecutiveFailures = positiveInteger(record.pauseAfterConsecutiveFailures);
  if (pauseAfterConsecutiveFailures === undefined) invalidate();
  const consecutiveFailures = nonNegativeInteger(record.consecutiveFailures);
  if (consecutiveFailures === undefined) invalidate();

  const createdAt = validTimestamp(record.createdAt);
  const updatedAt = validTimestamp(record.updatedAt);
  if (!createdAt || !updatedAt) invalidate();

  const optionalTimes = {
    stopRequestedAt: validOptionalTimestamp(record.stopRequestedAt),
    nextRunAt: validOptionalTimestamp(record.nextRunAt),
    lastRunAt: validOptionalTimestamp(record.lastRunAt),
  };
  if (Object.values(optionalTimes).some((item) => item === null)) invalidate();

  const activeRunId = record.activeRunId === undefined
    ? undefined
    : typeof record.activeRunId === 'string' && isScheduleRunId(record.activeRunId)
      ? record.activeRunId
      : null;
  if (activeRunId === null) invalidate();

  const storageRevision = record.storageRevision === undefined
    ? undefined
    : nonNegativeInteger(record.storageRevision);
  if (record.storageRevision !== undefined && storageRevision === undefined) invalidate();

  const taskInspection = inspectScheduleTemplates(record.tasks);
  const recordIssues = metadataValid ? [] : [createRecordIssue()];
  const issues = mergeScheduleValidationIssues(
    record.validationIssues,
    [...recordIssues, ...taskInspection.issues],
  );
  const safeName = name ?? `Historical schedule ${scheduleId.slice(0, 8)}`;
  const safeStatus = status ?? 'paused';
  const safeCreatedAt = createdAt ?? FALLBACK_TIMESTAMP;
  const safeUpdatedAt = updatedAt ?? FALLBACK_TIMESTAMP;

  const detail: ScheduleDetailView = {
    readViewVersion: 1,
    scheduleId,
    name: safeName,
    status: safeStatus,
    timeZone: safeTimeZone,
    dailyWindow,
    repeat,
    failurePolicy: failurePolicy ?? 'stop-round',
    pauseAfterConsecutiveFailures: pauseAfterConsecutiveFailures ?? 1,
    tasks: taskInspection.readableTasks,
    createdAt: safeCreatedAt,
    updatedAt: safeUpdatedAt,
    ...(optionalTimes.stopRequestedAt ? { stopRequestedAt: optionalTimes.stopRequestedAt } : {}),
    ...(activeRunId ? { activeRunId } : {}),
    ...(optionalTimes.nextRunAt ? { nextRunAt: optionalTimes.nextRunAt } : {}),
    ...(optionalTimes.lastRunAt ? { lastRunAt: optionalTimes.lastRunAt } : {}),
    consecutiveFailures: consecutiveFailures ?? 0,
    ...(issues.length > 0 ? { validationIssues: issues } : {}),
  };
  const summary: ScheduleSummary = {
    scheduleId,
    name: safeName,
    status: safeStatus,
    timeZone: safeTimeZone,
    dailyWindow,
    repeat,
    taskCount: taskInspection.enabledTaskCount,
    ...(activeRunId ? { activeRunId } : {}),
    ...(optionalTimes.nextRunAt ? { nextRunAt: optionalTimes.nextRunAt } : {}),
    ...(optionalTimes.lastRunAt ? { lastRunAt: optionalTimes.lastRunAt } : {}),
    consecutiveFailures: consecutiveFailures ?? 0,
    updatedAt: safeUpdatedAt,
    ...(issues.length > 0 ? { validationIssues: issues } : {}),
  };

  const executable = metadataValid && issues.length === 0
    ? {
      scheduleId,
      name: safeName,
      status: safeStatus,
      timeZone: safeTimeZone,
      dailyWindow,
      repeat,
      failurePolicy: failurePolicy!,
      pauseAfterConsecutiveFailures: pauseAfterConsecutiveFailures!,
      tasks: taskInspection.recurringTasks,
      createdAt: safeCreatedAt,
      updatedAt: safeUpdatedAt,
      ...(optionalTimes.stopRequestedAt ? { stopRequestedAt: optionalTimes.stopRequestedAt } : {}),
      ...(activeRunId ? { activeRunId } : {}),
      ...(optionalTimes.nextRunAt ? { nextRunAt: optionalTimes.nextRunAt } : {}),
      ...(optionalTimes.lastRunAt ? { lastRunAt: optionalTimes.lastRunAt } : {}),
      consecutiveFailures: consecutiveFailures!,
      ...(storageRevision !== undefined ? { storageRevision } : {}),
    } satisfies NormalizedScheduleDefinition
    : undefined;

  return { metadataValid, issues, detail, summary, ...(executable ? { executable } : {}) };
}
