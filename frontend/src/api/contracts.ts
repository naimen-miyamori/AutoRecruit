export type { ArtifactDescriptor, PlatformRuntimeSafeViewResponse } from '../../../src/server/api-contracts.js';
export { parseOperationModeCatalogResponse, parsePlatformRuntimeListResponse } from '../../../src/server/api-contracts.js';
export type {
  OperationModeCatalog,
  OperationModeCatalogItem,
} from '../../../src/server/api-contracts.js';
export {
  compileSearchOperationMode,
  isCliSearchModeId,
  recurringScheduleTaskKindIds,
} from '../../../src/operation-modes.js';
export {
  inspectScheduleTemplates,
  mergeScheduleValidationIssues,
} from '../../../src/server/schedule-template-validation.js';
export type { CliSearchModeId } from '../../../src/operation-modes.js';
export type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantConfirmResponse,
  AssistantDraft,
  AssistantMessage,
  CandidateDetail,
  CandidateSummary,
  DashboardHealth,
  JobDetail,
  JobSummary,
  ModelConfig,
  RunResultView,
  ScheduleDetailView,
  ScheduleDefinition,
  ScheduleRunRecord,
  ScheduleSummary,
  ScheduleValidationIssue,
  ScheduledTaskTemplate,
  SchedulableTaskKind,
  TaskDetail,
  TaskKind,
  TaskStatus,
  TaskSummary,
} from '../../../src/server/types.js';
export type {
  BossChatReceiptRecord,
  BossChatReviewRunSummary,
  BossJobSyncRunSummary,
  BossPositionView,
} from '../../../src/server/boss-read-model.js';
export type {
  TalentMappingDetailSelectionPreview,
  TalentMappingProjectDetail,
  TalentMappingProjectSummary,
  TalentMappingRunReference,
} from '../../../src/server/talent-mapping-read-model.js';
export type {
  MappingCandidateView,
  MappingClassificationSuggestionView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingEntityLink,
  MappingEntityLinkReviewView,
  MappingRunChangeReport,
  MappingRunRecord,
  TalentMappingCorePlatform,
  TalentMappingProject,
  TalentMappingStage,
} from '../../../src/types/talent-mapping.js';
export type {
  BossChatOperation,
  BossChatOperationResult,
  BossJobSyncRun,
  BossTalentCandidate,
  BossTalentSearchResult,
} from '../../../src/types/boss.js';
export type { BossChatReviewRun } from '../../../src/types/job.js';
export type { ApplicationFilterOptions } from '../../../src/search/filter-application-options.js';

import {
  inspectScheduleTemplates as inspectTemplates,
  mergeScheduleValidationIssues as mergeIssues,
} from '../../../src/server/schedule-template-validation.js';
import type {
  ScheduleDetailView as ServerScheduleDetailView,
  ScheduleValidationIssue as ServerScheduleValidationIssue,
} from '../../../src/server/types.js';

export type Platform = '51job' | 'liepin' | 'zhilian' | 'boss';
export type PlatformSelection = Platform | 'all';
export type TalentMappingPlatformSelection = Exclude<Platform, 'boss'> | 'all';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const normalized = boundedString(value, 64);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function validTimeZone(value: unknown): string | undefined {
  const normalized = boundedString(value, 100);
  if (!normalized) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format();
    return normalized;
  } catch {
    return undefined;
  }
}

function validDailyTime(value: unknown, allowEndOfDay: boolean): string | undefined {
  const normalized = boundedString(value, 5);
  if (!normalized || !/^\d{2}:\d{2}$/.test(normalized)) return undefined;
  const [hourText, minuteText] = normalized.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (hour < 0 || hour > (allowEndOfDay ? 24 : 23) || (hour === 24 && minute !== 0)) return undefined;
  return normalized;
}

function structuralIssue(taskKey = 'schedule'): ServerScheduleValidationIssue {
  return {
    code: 'scheduled-task-template-invalid',
    taskKey,
    kind: '<missing>',
    message: 'scheduled-task-template-invalid: <missing>; replace it with a complete supported recurring schedule task',
  };
}

function recordIssue(): ServerScheduleValidationIssue {
  return {
    code: 'schedule-record-invalid',
    taskKey: 'schedule',
    kind: '<metadata>',
    message: 'schedule-record-invalid: <metadata>; replace the malformed schedule metadata with a complete valid configuration',
  };
}

function parseCurrentTasks(
  tasks: unknown,
  persistedIssues: readonly ServerScheduleValidationIssue[],
): ReturnType<typeof inspectTemplates> {
  const inspected = inspectTemplates(tasks);
  if (!Array.isArray(tasks)) return inspected;
  const trustedIssueKeys = new Set(persistedIssues.map((issue) => `${issue.taskKey}:${issue.kind}`));
  const issues = inspected.issues.flatMap((issue) => {
    if (trustedIssueKeys.has(`${issue.taskKey}:${issue.kind}`)) return [];
    if (issue.kind === '<missing>' || issue.kind === '<invalid>') {
      return [structuralIssue(issue.taskKey)];
    }
    return [issue];
  });
  return { ...inspected, issues };
}

export interface ParsedScheduleDetailResponse {
  contract: 'current' | 'legacy' | 'invalid';
  schedule: ServerScheduleDetailView;
}

/** Runtime boundary for both current and legacy schedule detail responses. */
export function parseScheduleDetailResponse(
  value: unknown,
  expectedScheduleId: string,
): ParsedScheduleDetailResponse {
  const record = isRecord(value) ? value : {};
  let metadataValid = isRecord(value);
  const invalidate = () => {
    metadataValid = false;
  };
  const declaredScheduleId = boundedString(record.scheduleId, 128);
  if (!declaredScheduleId || declaredScheduleId !== expectedScheduleId) invalidate();
  const scheduleId = expectedScheduleId;
  const name = boundedString(record.name, 200);
  if (!name) invalidate();
  const status = record.status === 'enabled' || record.status === 'paused'
    || record.status === 'stop_requested' || record.status === 'stopped'
    ? record.status
    : undefined;
  if (!status) invalidate();
  const timeZone = validTimeZone(record.timeZone);
  if (!timeZone) invalidate();
  const dailyWindowRecord = isRecord(record.dailyWindow) ? record.dailyWindow : {};
  const start = validDailyTime(dailyWindowRecord.start, false);
  const end = validDailyTime(dailyWindowRecord.end, true);
  if (!start || !end || start === end) invalidate();
  const repeatRecord = isRecord(record.repeat) ? record.repeat : {};
  const delaySeconds = nonNegativeInteger(repeatRecord.delaySeconds);
  const failureDelaySeconds = positiveInteger(repeatRecord.failureDelaySeconds);
  if (repeatRecord.mode !== 'after-completion' || delaySeconds === undefined || failureDelaySeconds === undefined) invalidate();
  const failurePolicy = record.failurePolicy === 'stop-round' || record.failurePolicy === 'continue'
    ? record.failurePolicy
    : undefined;
  if (!failurePolicy) invalidate();
  const pauseAfterConsecutiveFailures = positiveInteger(record.pauseAfterConsecutiveFailures);
  const consecutiveFailures = nonNegativeInteger(record.consecutiveFailures);
  if (pauseAfterConsecutiveFailures === undefined || consecutiveFailures === undefined) invalidate();
  const createdAt = validTimestamp(record.createdAt);
  const updatedAt = validTimestamp(record.updatedAt);
  if (!createdAt || !updatedAt) invalidate();
  const optionalTimestamp = (item: unknown): string | undefined | null => item === undefined
    ? undefined
    : validTimestamp(item) ?? null;
  const stopRequestedAt = optionalTimestamp(record.stopRequestedAt);
  const activeRunId = record.activeRunId === undefined
    ? undefined
    : typeof record.activeRunId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.activeRunId)
      ? record.activeRunId
      : null;
  const nextRunAt = optionalTimestamp(record.nextRunAt);
  const lastRunAt = optionalTimestamp(record.lastRunAt);
  if ([stopRequestedAt, activeRunId, nextRunAt, lastRunAt].some((item) => item === null)) invalidate();

  const persistedIssues = mergeIssues(record.validationIssues, []);
  const current = record.readViewVersion === 1;
  if (record.readViewVersion !== undefined && !current) invalidate();
  const taskInspection = current
    ? parseCurrentTasks(record.tasks, persistedIssues)
    : inspectTemplates(record.tasks);
  const issues = mergeIssues(
    persistedIssues,
    [...(metadataValid ? [] : [recordIssue()]), ...taskInspection.issues],
  );
  const schedule: ServerScheduleDetailView = {
    readViewVersion: 1,
    scheduleId,
    name: name ?? `Historical schedule ${scheduleId.slice(0, 8)}`,
    status: status ?? 'paused',
    timeZone: timeZone ?? 'UTC',
    dailyWindow: { start: start ?? '00:00', end: end ?? '23:59' },
    repeat: {
      mode: 'after-completion',
      delaySeconds: delaySeconds ?? 0,
      failureDelaySeconds: failureDelaySeconds ?? 300,
    },
    failurePolicy: failurePolicy ?? 'stop-round',
    pauseAfterConsecutiveFailures: pauseAfterConsecutiveFailures ?? 1,
    tasks: taskInspection.readableTasks,
    createdAt: createdAt ?? '1970-01-01T00:00:00.000Z',
    updatedAt: updatedAt ?? '1970-01-01T00:00:00.000Z',
    ...(stopRequestedAt ? { stopRequestedAt } : {}),
    ...(activeRunId ? { activeRunId } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    consecutiveFailures: consecutiveFailures ?? 0,
    ...(issues.length > 0 ? { validationIssues: issues } : {}),
  };
  return {
    contract: !metadataValid ? 'invalid' : current ? 'current' : 'legacy',
    schedule,
  };
}

export interface RagAnswer {
  platform: Platform;
  jobKey: string;
  question: string;
  answer: string;
  temporary?: boolean;
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
  sources: Array<{
    id: string;
    label: string;
    text: string;
    score: number;
    sourceType?: string;
    chunkId?: string;
    verified?: boolean;
    active?: boolean;
  }>;
}

export interface FilterCatalog {
  platform: Platform;
  keyword: string;
  capturedAt: string;
  pageUrl: string;
  filters: Array<{
    key: string;
    label: string;
    controlType: string;
    valueShape: string;
    status: string;
    options?: unknown[];
  }>;
  failures: unknown[];
  stats: {
    discoveredControls: number;
    inspectedControls: number;
    optionsExtracted: number;
    failedControls: number;
    unknownControls: number;
  };
}

export interface SavedFilterInput {
  path: string;
  absolutePath: string;
  fieldCount: number;
  validation: {
    ok: boolean;
    errors: Array<{ fieldId: string; code: string; message: string }>;
  };
}

/**
 * A reusable filter set is deliberately separate from a job and from legacy
 * filter-input files.  A reference always names an immutable revision so a
 * task can be reviewed without following a mutable "latest" pointer.
 */
export interface SearchConditionSetRef {
  conditionSetId: string;
  platform: Platform;
  revision: number;
}

export type SearchConditionSetStatus = 'active' | 'archived';
export type SearchConditionSetCompatibilityStatus = 'compatible' | 'drifted' | 'incompatible' | 'unknown';

export interface SearchConditionSetCompatibility {
  status: SearchConditionSetCompatibilityStatus;
  message?: string;
  selectedFieldsFingerprint?: string;
  checkedAt?: string;
  errors?: Array<{ fieldId?: string; code?: string; message: string }>;
}

export interface SearchConditionSetSummary extends SearchConditionSetRef {
  name: string;
  description?: string;
  defaultKeyword?: string;
  status: SearchConditionSetStatus;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
  compatibility?: SearchConditionSetCompatibility;
}

export interface SearchConditionSetRevision extends SearchConditionSetSummary {
  applicationFilterInput: Record<string, unknown>;
  compiledConditions?: unknown[];
  catalogEvidence?: {
    capturedAt?: string;
    selectedFieldsFingerprint?: string;
  };
}

export interface SearchConditionSetDetail {
  conditionSet: SearchConditionSetRevision;
  revisions: SearchConditionSetRevision[];
  compatibility: SearchConditionSetCompatibility;
}
