import {
  isOperationModeTaskKind,
  isRecurringScheduleTaskKind,
} from '../operation-modes.js';
import type {
  NormalizedScheduledTaskTemplate,
  ScheduleValidationIssue,
  ScheduledTaskReadView,
  SchedulableTaskKind,
} from './types.js';

export const SCHEDULED_TASK_KIND_NOT_ALLOWED = 'scheduled-task-kind-not-allowed' as const;
export const SCHEDULED_TASK_KIND_UNKNOWN = 'scheduled-task-kind-unknown' as const;
export const SCHEDULED_TASK_TEMPLATE_INVALID = 'scheduled-task-template-invalid' as const;
export const SCHEDULE_RECORD_INVALID = 'schedule-record-invalid' as const;

export type ScheduleTemplateValidationCode =
  | typeof SCHEDULED_TASK_KIND_NOT_ALLOWED
  | typeof SCHEDULED_TASK_KIND_UNKNOWN
  | typeof SCHEDULED_TASK_TEMPLATE_INVALID
  | typeof SCHEDULE_RECORD_INVALID;

export interface ScheduleTemplateInspection {
  issues: ScheduleValidationIssue[];
  readableTasks: ScheduledTaskReadView[];
  recurringTasks: NormalizedScheduledTaskTemplate[];
  enabledTaskCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SAFE_TASK_KEY = /^[\p{L}\p{N}._:-]+$/u;
const SAFE_KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function describeKind(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '<missing>';
  }
  const normalized = value.trim();
  return normalized.length <= 80 && SAFE_KIND.test(normalized) ? normalized : '<invalid>';
}

function describeTaskKey(value: unknown, index: number): string {
  if (typeof value !== 'string') return `task-${index + 1}`;
  const normalized = value.trim();
  return normalized.length <= 128 && SAFE_TASK_KEY.test(normalized)
    ? normalized
    : `task-${index + 1}`;
}

function createKindIssue(taskKey: string, value: unknown): ScheduleValidationIssue {
  const kind = describeKind(value);
  const code = typeof value === 'string' && isOperationModeTaskKind(value)
    ? SCHEDULED_TASK_KIND_NOT_ALLOWED
    : SCHEDULED_TASK_KIND_UNKNOWN;
  return {
    code,
    taskKey,
    kind,
    message: code === SCHEDULED_TASK_KIND_NOT_ALLOWED
      ? `${code}: ${kind}; run it manually or through an assistant-confirmed task`
      : `${code}: ${kind}; replace it with a supported recurring schedule task`,
  };
}

function createStructuralIssue(taskKey: string, value: unknown): ScheduleValidationIssue {
  const kind = describeKind(isRecord(value) ? value.kind : undefined);
  return {
    code: SCHEDULED_TASK_TEMPLATE_INVALID,
    taskKey,
    kind,
    message: `${SCHEDULED_TASK_TEMPLATE_INVALID}: ${kind}; replace it with a complete supported recurring schedule task`,
  };
}

function hasTemplateShape(item: Record<string, unknown>): boolean {
  return typeof item.taskKey === 'string'
    && Boolean(item.taskKey.trim())
    && item.taskKey.trim().length <= 128
    && SAFE_TASK_KEY.test(item.taskKey.trim())
    && typeof item.name === 'string'
    && Boolean(item.name.trim())
    && typeof item.enabled === 'boolean'
    && isRecord(item.input);
}

function toReadableTask(
  item: unknown,
  index: number,
  issue: ScheduleValidationIssue | undefined,
): ScheduledTaskReadView {
  const record = isRecord(item) ? item : undefined;
  const taskKey = describeTaskKey(record?.taskKey, index);
  const kind = describeKind(record?.kind);
  return {
    taskKey,
    name: issue === undefined && typeof record?.name === 'string' && record.name.trim()
      ? record.name.trim()
      : `Historical task ${index + 1}`,
    enabled: issue === undefined && record?.enabled === true,
    kind,
    input: issue === undefined && isRecord(record?.input) ? record.input : {},
  };
}

function canonicalIssueMessage(
  code: ScheduleTemplateValidationCode,
  kind: string,
): string {
  if (code === SCHEDULED_TASK_KIND_NOT_ALLOWED) {
    return `${code}: ${kind}; run it manually or through an assistant-confirmed task`;
  }
  if (code === SCHEDULED_TASK_KIND_UNKNOWN) {
    return `${code}: ${kind}; replace it with a supported recurring schedule task`;
  }
  if (code === SCHEDULE_RECORD_INVALID) {
    return `${code}: <metadata>; replace the malformed schedule metadata with a complete valid configuration`;
  }
  return `${code}: ${kind}; replace it with a complete supported recurring schedule task`;
}

function normalizePersistedIssue(value: unknown, index: number): ScheduleValidationIssue | undefined {
  if (!isRecord(value)
    || (value.code !== SCHEDULED_TASK_KIND_NOT_ALLOWED
      && value.code !== SCHEDULED_TASK_KIND_UNKNOWN
      && value.code !== SCHEDULED_TASK_TEMPLATE_INVALID
      && value.code !== SCHEDULE_RECORD_INVALID)
    || typeof value.taskKey !== 'string'
    || typeof value.kind !== 'string') {
    return undefined;
  }
  if (value.code === SCHEDULE_RECORD_INVALID) {
    return {
      code: SCHEDULE_RECORD_INVALID,
      taskKey: 'schedule',
      kind: '<metadata>',
      message: canonicalIssueMessage(SCHEDULE_RECORD_INVALID, '<metadata>'),
    };
  }
  const taskKey = describeTaskKey(value.taskKey, index);
  const kind = describeKind(value.kind);
  return {
    code: value.code,
    taskKey,
    kind,
    message: canonicalIssueMessage(value.code, kind),
  };
}

export function normalizePersistedValidationIssues(value: unknown): ScheduleValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue, index) => {
    const normalized = normalizePersistedIssue(issue, index);
    return normalized ? [normalized] : [];
  });
}

export function mergeScheduleValidationIssues(
  persisted: unknown,
  derived: readonly ScheduleValidationIssue[],
): ScheduleValidationIssue[] {
  const result: ScheduleValidationIssue[] = [];
  const seen = new Set<string>();
  for (const issue of [...derived, ...normalizePersistedValidationIssues(persisted)]) {
    const key = `${issue.taskKey}:${issue.code}:${issue.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

/**
 * Inspect raw persisted templates without normalizing or executing their input.
 * Every return path is safe for JSON values, including malformed task containers.
 */
export function inspectScheduleTemplates(value: unknown): ScheduleTemplateInspection {
  if (!Array.isArray(value)) {
    const issue = createStructuralIssue('schedule', undefined);
    return {
      issues: [issue],
      readableTasks: [],
      recurringTasks: [],
      enabledTaskCount: 0,
    };
  }

  const issues: ScheduleValidationIssue[] = [];
  const readableTasks: ScheduledTaskReadView[] = [];
  const recurringTasks: NormalizedScheduledTaskTemplate[] = [];
  const taskKeys = new Set<string>();
  let enabledTaskCount = 0;

  for (const [index, template] of value.entries()) {
    const item = isRecord(template) ? template : undefined;
    const taskKey = describeTaskKey(item?.taskKey, index);
    const kindIssue = item && !isRecurringScheduleTaskKind(item.kind)
      ? createKindIssue(taskKey, item.kind)
      : undefined;
    const structuralIssue = !item || (!kindIssue && (!hasTemplateShape(item) || taskKeys.has(taskKey)))
      ? createStructuralIssue(taskKey, item)
      : undefined;
    const issue = kindIssue ?? structuralIssue;

    if (issue) {
      issues.push(issue);
    }
    readableTasks.push(toReadableTask(template, index, issue));
    if (!issue && item) {
      const normalized = {
        taskKey: taskKey,
        name: String(item.name).trim(),
        enabled: item.enabled === true,
        kind: item.kind as SchedulableTaskKind,
        input: item.input as Record<string, unknown>,
      } satisfies NormalizedScheduledTaskTemplate;
      recurringTasks.push(normalized);
      if (normalized.enabled) enabledTaskCount += 1;
    }
    taskKeys.add(taskKey);
  }

  return {
    issues,
    readableTasks,
    recurringTasks: issues.length === 0 ? recurringTasks : [],
    enabledTaskCount,
  };
}

export function validateScheduleTemplates(value: unknown): ScheduleValidationIssue[] {
  return inspectScheduleTemplates(value).issues;
}

export class ScheduleTemplateValidationError extends Error {
  readonly code: ScheduleTemplateValidationCode;
  readonly issues: readonly ScheduleValidationIssue[];

  constructor(issues: readonly ScheduleValidationIssue[]) {
    const first = issues[0];
    super(first?.message ?? `${SCHEDULED_TASK_KIND_UNKNOWN}: <missing>`);
    this.name = 'ScheduleTemplateValidationError';
    this.code = first?.code ?? SCHEDULED_TASK_KIND_UNKNOWN;
    this.issues = issues;
  }
}

export function assertRecurringScheduleTaskKind(value: unknown, taskKey = 'schedule-task'): SchedulableTaskKind {
  if (isRecurringScheduleTaskKind(value)) {
    return value;
  }
  throw new ScheduleTemplateValidationError([createKindIssue(taskKey, value)]);
}
