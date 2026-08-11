import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { BossCapturePlanStore } from '../platforms/boss/capture-plan.js';
import {
  answerCandidateQuestionFromJd,
  type AnswerCandidateQuestionFromJdInput,
  type JdQuestionAnswer,
} from '../rag/jd-question-answering.js';
import {
  answerQuestionWithRag,
  ingestConversation,
  type AskRagQuestionOptions,
  type IngestConversationOptions,
} from '../rag/service.js';
import type { RagAnswer } from '../rag/types.js';
import { validateApplicationFilterInput, type ApplicationFilterOptions } from '../search/filter-application-options.js';
import {
  SearchConditionSetConflictError,
  SearchConditionSetNotFoundError,
  SearchConditionSetService,
  SearchConditionSetValidationError,
  type SearchConditionSetDetail,
  type SearchConditionSetRevision,
  type SearchConditionSetSummary,
} from '../search/search-condition-sets.js';
import {
  assistantDraftRequiresRiskAcceptance,
  chatWithCliAssistant,
  finalizeAssistantDraft,
  normalizeModelConfig,
  validateAssistantDraft,
  type AssistantCompletion,
} from './cli-assistant.js';
import { JobReadModel } from './job-read-model.js';
import { BossReadModel } from './boss-read-model.js';
import { TalentMappingReadModel } from './talent-mapping-read-model.js';
import { TalentMappingConflictError, TalentMappingQualityService } from '../talent-mapping/quality-service.js';
import { ArtifactReadModel } from './artifact-read-model.js';
import { TaskScheduler } from './task-scheduler.js';
import {
  snapshotBossBatchCaptureSettings,
  snapshotBossCaptureSettings,
  type BossCapturePlanResolver,
} from './boss-capture-snapshot.js';
import { preflightTaskSearchConditionSets } from './search-condition-set-preflight.js';
import { TaskQueue } from './task-queue.js';
import { ScheduleTemplateValidationError } from './schedule-template-validation.js';
import {
  ScheduleLeaseOwnershipLostError,
  ScheduleLeaseRecoveryRequiredError,
  ScheduleLeaseTimeoutError,
  ScheduleStoreConflictError,
} from './schedule-store.js';
import {
  listOperationModeDefinitions,
  listOperationModePickerGroups,
  type OperationModePickerTarget,
  type OperationModeSurface,
} from '../operation-modes.js';
import {
  normalizeApplicationFilterInputRequest,
  normalizeBatchTask,
  normalizeBossAutoChatTask,
  normalizeBossChatOperationTask,
  normalizeBossGreetTask,
  normalizeBossJobSyncTask,
  normalizeBossTalentSearchTask,
  normalizeConversationRequest,
  normalizeLoginRefreshTask,
  normalizePlatform,
  normalizeJsonObject,
  getOptionalPositiveInteger,
  getOptionalString,
  getRequiredString,
  normalizeRagAnswerRequest,
  normalizeRagOpsTask,
  normalizeResumeCaptureTask,
  prepareSearchSubscriptionTask,
  normalizeTalentMappingTask,
  normalizeTalentMappingClassificationTask,
  type NormalizedTask,
} from './task-normalizers.js';
import type {
  AssistantChatRequest,
  AssistantConfirmResponse,
  AssistantDraft,
  BatchTaskInput,
  DashboardHealth,
  ModelConfig,
  TaskDetail,
  TaskKind,
  TaskInput,
  ResumeCaptureTaskInput,
} from './types.js';
import { inspectAllPlatformRuntimeStatuses } from '../browser/platform-runtime.js';
import { PlatformRuntimeError } from '../browser/platform-runtime-inspector.js';

export interface ApiResponse<T = unknown> {
  statusCode: number;
  body: T;
  headers?: Record<string, string>;
}

interface RouteDependencies {
  taskQueue?: TaskQueue;
  taskScheduler?: TaskScheduler;
  jobReadModel?: JobReadModel;
  bossReadModel?: BossReadModel;
  talentMappingReadModel?: TalentMappingReadModel;
  talentMappingQualityService?: TalentMappingQualityService;
  artifactReadModel?: ArtifactReadModel;
  searchConditionSetService?: SearchConditionSetService;
  /** Injectable only for isolated API tests; normal routes use the pure resolver. */
  bossCapturePlanResolver?: BossCapturePlanResolver;
  bossCapturePlanStore?: BossCapturePlanStore;
  dataDir?: string;
  answerQuestion?: (options: AskRagQuestionOptions) => Promise<RagAnswer>;
  answerTemporaryJdQuestion?: (input: AnswerCandidateQuestionFromJdInput) => Promise<JdQuestionAnswer>;
  ingestConversationFn?: (options: IngestConversationOptions) => Promise<unknown>;
  assistantCompleteJsonText?: AssistantCompletion;
}

interface RouteRequest extends RouteDependencies {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
  body?: unknown;
}

function jsonResponse<T>(statusCode: number, body: T): ApiResponse<T> {
  return { statusCode, body };
}

function badRequest(message: string): ApiResponse {
  return jsonResponse(400, {
    error: {
      code: 'bad_request',
      message,
    },
  });
}

function notFound(message: string): ApiResponse {
  return jsonResponse(404, {
    error: {
      code: 'not_found',
      message,
    },
  });
}

function assertRequestFields(item: Record<string, unknown>, allowedFields: readonly string[], context: string): void {
  const allowed = new Set(allowedFields);
  const unsupported = Object.keys(item).filter((fieldName) => !allowed.has(fieldName));
  if (unsupported.length > 0) {
    throw new Error(`${context} cannot include ${unsupported.join(', ')}`);
  }
}

function getOptionalNullableString(item: Record<string, unknown>, fieldName: string): string | null | undefined {
  if (item[fieldName] === null) {
    return null;
  }
  return getOptionalString(item, fieldName);
}

function normalizeSearchConditionSetStatus(value: string | null): 'active' | 'archived' | undefined {
  if (value === null || value === 'all') {
    return undefined;
  }
  if (value === 'active' || value === 'archived') {
    return value;
  }
  throw new Error('status must be active, archived, or all');
}

function toApiSearchConditionSetRevision(revision: SearchConditionSetRevision): Record<string, unknown> {
  const { applicationFilterInput, ...rest } = revision;
  return {
    ...rest,
    applicationFilterInput,
    fieldCount: Object.keys(applicationFilterInput).length,
  };
}

function toApiSearchConditionSetSummary(summary: SearchConditionSetSummary): Record<string, unknown> {
  const { fieldIds, ...rest } = summary;
  return {
    ...rest,
    fieldCount: fieldIds.length,
  };
}

function toApiSearchConditionSetDetail(detail: SearchConditionSetDetail): Record<string, unknown> {
  return {
    conditionSet: toApiSearchConditionSetRevision(detail.conditionSet),
    revisions: detail.revisions.map(toApiSearchConditionSetRevision),
    compatibility: detail.compatibility,
  };
}

function normalizeSearchConditionSetCreateRequest(payload: unknown): {
  platform: SupportedPlatform;
  name: string;
  description?: string;
  defaultKeyword?: string;
  applicationFilterInput: Record<string, unknown>;
} {
  const item = normalizeJsonObject(payload, 'request body');
  assertRequestFields(item, ['platform', 'name', 'description', 'defaultKeyword', 'applicationFilterInput'], 'search-condition-set create request');
  return {
    platform: normalizePlatform(item.platform),
    name: getRequiredString(item, 'name'),
    description: getOptionalString(item, 'description'),
    defaultKeyword: getOptionalString(item, 'defaultKeyword'),
    applicationFilterInput: normalizeJsonObject(item.applicationFilterInput, 'applicationFilterInput'),
  };
}

function normalizeSearchConditionSetReviseRequest(payload: unknown): {
  platform?: SupportedPlatform;
  expectedRevision: number;
  name?: string;
  description?: string | null;
  defaultKeyword?: string | null;
  applicationFilterInput?: Record<string, unknown>;
} {
  const item = normalizeJsonObject(payload, 'request body');
  assertRequestFields(item, ['platform', 'expectedRevision', 'name', 'description', 'defaultKeyword', 'applicationFilterInput'], 'search-condition-set revise request');
  const expectedRevision = getOptionalPositiveInteger(item, 'expectedRevision');
  if (!expectedRevision) {
    throw new Error('expectedRevision is required');
  }
  return {
    platform: item.platform === undefined ? undefined : normalizePlatform(item.platform),
    expectedRevision,
    name: getOptionalString(item, 'name'),
    description: getOptionalNullableString(item, 'description'),
    defaultKeyword: getOptionalNullableString(item, 'defaultKeyword'),
    applicationFilterInput: item.applicationFilterInput === undefined
      ? undefined
      : normalizeJsonObject(item.applicationFilterInput, 'applicationFilterInput'),
  };
}

function normalizeSearchConditionSetCloneRequest(payload: unknown): {
  name?: string;
  description?: string;
  defaultKeyword?: string;
} {
  const item = normalizeJsonObject(payload ?? {}, 'request body');
  assertRequestFields(item, ['name', 'description', 'defaultKeyword'], 'search-condition-set clone request');
  return {
    name: getOptionalString(item, 'name'),
    description: getOptionalString(item, 'description'),
    defaultKeyword: getOptionalString(item, 'defaultKeyword'),
  };
}

function normalizeSearchConditionSetArchiveRequest(payload: unknown): { expectedRevision: number } {
  const item = normalizeJsonObject(payload, 'request body');
  assertRequestFields(item, ['expectedRevision'], 'search-condition-set archive request');
  const expectedRevision = getOptionalPositiveInteger(item, 'expectedRevision');
  if (!expectedRevision) {
    throw new Error('expectedRevision is required');
  }
  return { expectedRevision };
}

function buildApplicationFilterOptionsPath(dataDir: string, platform: SupportedPlatform): string {
  return path.join(dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

function safeFileSlug(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'filter-input';
}

async function readApplicationFilterOptions(dataDir: string, platform: SupportedPlatform): Promise<ApplicationFilterOptions> {
  return JSON.parse(await readFile(buildApplicationFilterOptionsPath(dataDir, platform), 'utf8')) as ApplicationFilterOptions;
}

async function saveApplicationFilterInputFile(input: {
  dataDir: string;
  platform: SupportedPlatform;
  applicationFilterInput: Record<string, unknown>;
  label?: string;
}): Promise<{
  path: string;
  absolutePath: string;
  fieldCount: number;
  validation: ReturnType<typeof validateApplicationFilterInput>;
}> {
  const options = await readApplicationFilterOptions(input.dataDir, input.platform);
  if (options.platform !== input.platform) {
    throw new Error(`Application filter options platform mismatch: expected ${input.platform}, got ${options.platform}`);
  }

  const validation = validateApplicationFilterInput(options, input.applicationFilterInput);
  if (!validation.ok) {
    return {
      path: '',
      absolutePath: '',
      fieldCount: Object.keys(input.applicationFilterInput).length,
      validation,
    };
  }

  const dirPath = path.join(input.dataDir, 'runtime', 'filter-inputs');
  await mkdir(dirPath, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = safeFileSlug(input.label ?? `${input.platform}-${timestamp}`);
  const filePath = path.join(dirPath, `${slug}-${crypto.randomUUID().slice(0, 8)}.json`);
  await writeFile(filePath, `${JSON.stringify(input.applicationFilterInput, null, 2)}\n`, 'utf8');

  return {
    path: path.relative(process.cwd(), filePath),
    absolutePath: filePath,
    fieldCount: Object.keys(input.applicationFilterInput).length,
    validation,
  };
}

async function enqueueTask(
  queue: TaskQueue,
  kind: TaskKind,
  normalized: { input: TaskInput; argv: string[]; inputSummary: Record<string, unknown> },
): Promise<TaskDetail> {
  return queue.enqueue({
    kind,
    input: normalized.input,
    inputSummary: normalized.inputSummary,
    argv: normalized.argv,
  });
}

async function enqueueTaskWithConditionSetPreflight(
  queue: TaskQueue,
  kind: TaskKind,
  normalized: { input: TaskInput; argv: string[]; inputSummary: Record<string, unknown> },
  searchConditionSetService: SearchConditionSetService,
): Promise<TaskDetail> {
  await preflightTaskSearchConditionSets(normalized.input, searchConditionSetService);
  return enqueueTask(queue, kind, normalized);
}

async function enqueueResumeCaptureTaskWithPreflight(
  queue: TaskQueue,
  normalized: NormalizedTask<ResumeCaptureTaskInput>,
  options: {
    dataDir: string;
    searchConditionSetService: SearchConditionSetService;
    bossCapturePlanResolver?: BossCapturePlanResolver;
    bossCapturePlanStore?: BossCapturePlanStore;
  },
): Promise<TaskDetail> {
  const snapshot = await snapshotBossCaptureSettings(normalized, {
    dataDir: options.dataDir,
    ...(options.bossCapturePlanResolver ? { resolveBossCapturePlan: options.bossCapturePlanResolver } : {}),
    ...(options.bossCapturePlanStore ? { store: options.bossCapturePlanStore } : {}),
    searchConditionSets: options.searchConditionSetService,
  });
  await preflightTaskSearchConditionSets(snapshot.input, options.searchConditionSetService);
  return enqueueTask(queue, 'resume-capture', snapshot);
}

async function enqueueBatchTaskWithPreflight(
  queue: TaskQueue,
  normalized: NormalizedTask<BatchTaskInput>,
  options: {
    dataDir: string;
    searchConditionSetService: SearchConditionSetService;
    bossCapturePlanResolver?: BossCapturePlanResolver;
    bossCapturePlanStore?: BossCapturePlanStore;
  },
): Promise<TaskDetail> {
  const snapshot = await snapshotBossBatchCaptureSettings(normalized, {
    dataDir: options.dataDir,
    ...(options.bossCapturePlanResolver ? { resolveBossCapturePlan: options.bossCapturePlanResolver } : {}),
    ...(options.bossCapturePlanStore ? { store: options.bossCapturePlanStore } : {}),
    searchConditionSets: options.searchConditionSetService,
  });
  await preflightTaskSearchConditionSets(snapshot.input, options.searchConditionSetService);
  return enqueueTask(queue, 'batch', snapshot);
}

async function answerRagRequest(request: RouteDependencies, payload: unknown): Promise<Record<string, unknown>> {
  const item = normalizeJsonObject(payload, 'request body');
  const llmSettings = normalizeModelConfig(item.modelConfig as ModelConfig | undefined);
  const normalized = normalizeRagAnswerRequest(payload);
  if (normalized.mode === 'temporary-jd') {
    const rawJdText = normalized.jd ?? await readFile(normalized.jdFile!, 'utf8');
    const answerJdQuestion = request.answerTemporaryJdQuestion ?? answerCandidateQuestionFromJd;
    const answer = await answerJdQuestion({
      rawJdText,
      question: normalized.question,
      ...(llmSettings ? { llmSettings } : {}),
    });

    return {
      platform: normalized.platform,
      jobKey: normalized.jobKey,
      question: normalized.question,
      temporary: true,
      ...answer,
    };
  }

  const requestOptions = {
    ...normalized.options,
    ...(llmSettings ? { llmSettings } : {}),
  };
  const answerQuestion = request.answerQuestion ?? answerQuestionWithRag;
  const answer = await answerQuestion(requestOptions);
  return {
    platform: requestOptions.platform,
    jobKey: requestOptions.jobKey,
    question: requestOptions.question,
    ...answer,
  };
}

async function confirmAssistantDraft(
  request: RouteRequest,
  taskQueue: TaskQueue,
  dataDir: string,
  searchConditionSetService: SearchConditionSetService,
): Promise<AssistantConfirmResponse> {
  const item = normalizeJsonObject(request.body, 'request body');
  if (!item.draft || typeof item.draft !== 'object' || Array.isArray(item.draft)) {
    throw new Error('draft is required');
  }

  const draft = finalizeAssistantDraft(item.draft as AssistantDraft);
  if (draft.missingFields.length > 0) {
    throw new Error(`draft is missing required fields: ${draft.missingFields.join(', ')}`);
  }

  if (assistantDraftRequiresRiskAcceptance(draft) && item.riskAccepted !== true) {
    throw new Error('riskAccepted is required for this draft');
  }

  switch (draft.kind) {
    case 'resume-capture':
      return {
        kind: draft.kind,
        task: await enqueueResumeCaptureTaskWithPreflight(
          taskQueue,
          normalizeResumeCaptureTask(draft.input),
          {
            dataDir,
            searchConditionSetService,
            ...(request.bossCapturePlanResolver ? { bossCapturePlanResolver: request.bossCapturePlanResolver } : {}),
            ...(request.bossCapturePlanStore ? { bossCapturePlanStore: request.bossCapturePlanStore } : {}),
          },
        ),
      };
    case 'batch':
      return {
        kind: draft.kind,
        task: await enqueueBatchTaskWithPreflight(
          taskQueue,
          normalizeBatchTask(draft.input),
          {
            dataDir,
            searchConditionSetService,
            ...(request.bossCapturePlanResolver ? { bossCapturePlanResolver: request.bossCapturePlanResolver } : {}),
            ...(request.bossCapturePlanStore ? { bossCapturePlanStore: request.bossCapturePlanStore } : {}),
          },
        ),
      };
    case 'talent-mapping':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, await normalizeTalentMappingTask(draft.input)),
      };
    case 'search-subscription':
      return {
        kind: draft.kind,
        task: await enqueueTaskWithConditionSetPreflight(
          taskQueue,
          draft.kind,
          await prepareSearchSubscriptionTask(draft.input, dataDir),
          searchConditionSetService,
        ),
      };
    case 'boss-auto-chat':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossAutoChatTask(draft.input)),
      };
    case 'boss-talent-search':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossTalentSearchTask(draft.input)),
      };
    case 'boss-greet':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossGreetTask(draft.input)),
      };
    case 'boss-chat-operation':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossChatOperationTask(draft.input)),
      };
    case 'boss-job-sync':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossJobSyncTask(draft.input)),
      };
    case 'login-refresh':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeLoginRefreshTask(draft.input)),
      };
    case 'rag-ops':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeRagOpsTask(draft.input)),
      };
    case 'rag-answer':
      return {
        kind: draft.kind,
        answer: await answerRagRequest(request, draft.input),
      };
  }
}

export async function handleApiRequest(request: RouteRequest): Promise<ApiResponse> {
  const dataDir = request.dataDir ?? config.dataDir;
  const earlyMethod = request.method.toUpperCase();
  const earlyPathname = request.pathname.replace(/\/+$/, '') || '/';
  if (earlyMethod === 'GET' && earlyPathname === '/api/platform-browser-runtimes') {
    return jsonResponse(200, {
      runtimes: await inspectAllPlatformRuntimeStatuses({ dataDir }),
    });
  }
  const taskQueue = request.taskQueue ?? new TaskQueue();
  const searchConditionSetService = request.searchConditionSetService
    ?? new SearchConditionSetService({ dataDir });
  let taskScheduler = request.taskScheduler;
  const getTaskScheduler = () => {
    taskScheduler ??= new TaskScheduler({
      taskQueue,
      dataDir,
      searchConditionSetService,
      ...(request.bossCapturePlanResolver ? { bossCapturePlanResolver: request.bossCapturePlanResolver } : {}),
      ...(request.bossCapturePlanStore ? { bossCapturePlanStore: request.bossCapturePlanStore } : {}),
    });
    return taskScheduler;
  };
  const jobReadModel = request.jobReadModel ?? new JobReadModel({ dataDir });
  const bossReadModel = request.bossReadModel ?? new BossReadModel({ dataDir });
  const talentMappingReadModel = request.talentMappingReadModel ?? new TalentMappingReadModel({ dataDir });
  const talentMappingQualityService = request.talentMappingQualityService ?? new TalentMappingQualityService({ dataDir });
  const artifactReadModel = request.artifactReadModel ?? new ArtifactReadModel({ dataDir });
  const searchParams = request.searchParams ?? new URLSearchParams();
  const method = request.method.toUpperCase();
  const pathname = request.pathname.replace(/\/+$/, '') || '/';
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    if (method === 'GET' && pathname === '/api/health') {
      return jsonResponse(200, {
        status: 'ok',
        service: 'autorecruit-console-api',
      });
    }

    if (method === 'GET' && pathname === '/api/operation-modes') {
      const surfaceValue = searchParams.get('surface');
      if (surfaceValue && !['assistant', 'manual', 'schedule', 'cli'].includes(surfaceValue)) {
        throw new Error('surface must be assistant, manual, schedule, or cli');
      }
      const surface = surfaceValue ? surfaceValue as OperationModeSurface : undefined;
      const pickerTarget: OperationModePickerTarget | undefined = surface === 'manual'
        ? 'manual-search-create'
        : surface === 'schedule'
          ? 'schedule-search-create'
          : undefined;
      return jsonResponse(200, {
        groups: pickerTarget ? listOperationModePickerGroups(pickerTarget) : [],
        modes: listOperationModeDefinitions(surface).map((definition) => ({
          modeId: definition.modeId,
          label: definition.label,
          taskKind: definition.taskKind,
          ...(definition.searchSource ? { searchSource: definition.searchSource } : {}),
          effectSummary: definition.effectSummary,
          declaredEffects: definition.effectSummary,
          surfaces: definition.surfaces,
          pickerTargets: definition.pickerTargets,
          ...(definition.pickerGroupId ? { pickerGroupId: definition.pickerGroupId } : {}),
          ...(definition.pickerOrder !== undefined ? { pickerOrder: definition.pickerOrder } : {}),
        })),
      });
    }

    if (method === 'GET' && pathname === '/api/dashboard/health') {
      const platform = jobReadModel.parsePlatform(searchParams.get('platform') ?? undefined);
      const tasks = await taskQueue.listTasks();
      const body: DashboardHealth = {
        generatedAt: new Date().toISOString(),
        dataAnomalies: await jobReadModel.getDataAnomalies(platform),
        platformRuns: await jobReadModel.getPlatformRunHealth(platform),
        candidateFunnels: await jobReadModel.getCandidateFunnels(platform),
        sessions: await jobReadModel.getSessionHealth(tasks, platform),
        filters: await jobReadModel.getFilterHealth(platform),
        tasks: await taskQueue.getHealth(),
        bossRejectionEmails: await jobReadModel.getBossRejectionEmailHealth(platform),
      };
      return jsonResponse(200, body);
    }

    if (method === 'GET' && pathname === '/api/tasks') {
      return jsonResponse(200, {
        tasks: await taskQueue.listTasks(),
      });
    }

    if (method === 'GET' && pathname === '/api/schedules') {
      return jsonResponse(200, {
        schedules: await getTaskScheduler().listSchedules(),
      });
    }

    if (method === 'POST' && pathname === '/api/schedules') {
      return jsonResponse(201, await getTaskScheduler().createSchedule(request.body));
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments.length === 3) {
      const schedule = await getTaskScheduler().getSchedule(segments[2]);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'runs') {
      const scheduler = getTaskScheduler();
      const schedule = await scheduler.getSchedule(segments[2]);
      return schedule ? jsonResponse(200, { runs: await scheduler.listRuns(segments[2]) }) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'update') {
      const schedule = await getTaskScheduler().updateSchedule(segments[2], request.body);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'start') {
      const schedule = await getTaskScheduler().startSchedule(segments[2]);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'pause') {
      const schedule = await getTaskScheduler().pauseSchedule(segments[2]);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'stop') {
      const schedule = await getTaskScheduler().stopScheduleAfterCurrentTask(segments[2]);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'schedules' && segments[2] && segments[3] === 'run-now') {
      const schedule = await getTaskScheduler().runScheduleNow(segments[2]);
      return schedule ? jsonResponse(200, schedule) : notFound(`Schedule not found: ${segments[2]}`);
    }

    if (method === 'POST' && pathname === '/api/schedules/stop-all') {
      return jsonResponse(200, {
        schedules: await getTaskScheduler().stopAllAfterCurrentTask(),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'tasks' && segments[2]) {
      const task = await taskQueue.getTask(segments[2]);
      return task ? jsonResponse(200, task) : notFound(`Task not found: ${segments[2]}`);
    }

    if (method === 'POST' && pathname === '/api/assistant/chat') {
      return jsonResponse(200, await chatWithCliAssistant(request.body as AssistantChatRequest, {
        completeJsonText: request.assistantCompleteJsonText,
      }));
    }

    if (method === 'POST' && pathname === '/api/assistant/validate') {
      const item = normalizeJsonObject(request.body, 'request body');
      if (!item.draft || typeof item.draft !== 'object' || Array.isArray(item.draft)) {
        throw new Error('draft is required');
      }
      return jsonResponse(200, validateAssistantDraft(item.draft as AssistantDraft));
    }

    if (method === 'POST' && pathname === '/api/assistant/confirm') {
      return jsonResponse(200, await confirmAssistantDraft(request, taskQueue, dataDir, searchConditionSetService));
    }

    if (method === 'POST' && pathname === '/api/tasks/resume-capture') {
      const task = await enqueueResumeCaptureTaskWithPreflight(
        taskQueue,
        normalizeResumeCaptureTask(request.body),
        {
          dataDir,
          searchConditionSetService,
          ...(request.bossCapturePlanResolver ? { bossCapturePlanResolver: request.bossCapturePlanResolver } : {}),
          ...(request.bossCapturePlanStore ? { bossCapturePlanStore: request.bossCapturePlanStore } : {}),
        },
      );
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/batch') {
      const task = await enqueueBatchTaskWithPreflight(
        taskQueue,
        normalizeBatchTask(request.body),
        {
          dataDir,
          searchConditionSetService,
          ...(request.bossCapturePlanResolver ? { bossCapturePlanResolver: request.bossCapturePlanResolver } : {}),
          ...(request.bossCapturePlanStore ? { bossCapturePlanStore: request.bossCapturePlanStore } : {}),
        },
      );
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/talent-mapping') {
      const task = await enqueueTask(taskQueue, 'talent-mapping', await normalizeTalentMappingTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/talent-mapping-classification') {
      const task = await enqueueTask(
        taskQueue,
        'talent-mapping-classification',
        normalizeTalentMappingClassificationTask(request.body),
      );
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/search-subscription') {
      const task = await enqueueTaskWithConditionSetPreflight(
        taskQueue,
        'search-subscription',
        await prepareSearchSubscriptionTask(request.body, dataDir),
        searchConditionSetService,
      );
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-auto-chat') {
      const task = await enqueueTask(taskQueue, 'boss-auto-chat', normalizeBossAutoChatTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-talent-search') {
      const task = await enqueueTask(taskQueue, 'boss-talent-search', normalizeBossTalentSearchTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-greet') {
      const task = await enqueueTask(taskQueue, 'boss-greet', normalizeBossGreetTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-chat-operation') {
      const task = await enqueueTask(taskQueue, 'boss-chat-operation', normalizeBossChatOperationTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-job-sync') {
      const task = await enqueueTask(taskQueue, 'boss-job-sync', normalizeBossJobSyncTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/login-refresh') {
      const task = await enqueueTask(taskQueue, 'login-refresh', normalizeLoginRefreshTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/rag-ops') {
      const task = await enqueueTask(taskQueue, 'rag-ops', normalizeRagOpsTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      const platform = jobReadModel.parsePlatform(searchParams.get('platform') ?? undefined);
      return jsonResponse(200, {
        jobs: await jobReadModel.listJobs(platform),
      });
    }

    if (method === 'GET' && pathname === '/api/talent-mappings') {
      return jsonResponse(200, {
        mappings: await talentMappingReadModel.listProjects(),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments.length === 3) {
      const mapping = await talentMappingReadModel.getProject(segments[2]);
      return mapping ? jsonResponse(200, mapping) : notFound(`Talent Mapping project not found: ${segments[2]}`);
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'runs' && segments.length === 4) {
      return jsonResponse(200, {
        runs: await talentMappingReadModel.listRuns(segments[2]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'candidates' && segments.length === 4) {
      return jsonResponse(200, {
        candidates: await talentMappingReadModel.listCandidates(segments[2]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'companies' && segments.length === 4) {
      return jsonResponse(200, {
        companies: await talentMappingReadModel.listCompanies(segments[2]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'coverage' && segments.length === 4) {
      return jsonResponse(200, {
        coverage: await talentMappingReadModel.getCoverage(segments[2]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'changes' && segments.length === 4) {
      return jsonResponse(200, {
        changes: await talentMappingQualityService.getChangeReport(segments[2], {
          baseRunId: searchParams.get('baseRunId')?.trim() || undefined,
          compareRunId: searchParams.get('compareRunId')?.trim() || undefined,
        }),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'entity-links' && segments.length === 4) {
      return jsonResponse(200, {
        entityLinks: await talentMappingQualityService.getEntityLinkReview(segments[2]),
      });
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'entity-links' && segments.length === 4) {
      return jsonResponse(201, await talentMappingQualityService.confirmEntityLink(segments[2], request.body));
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'entity-links' && segments[4] && segments[5] === 'revoke' && segments.length === 6) {
      return jsonResponse(200, await talentMappingQualityService.revokeEntityLink(segments[2], segments[4], request.body));
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'classification-suggestions' && segments.length === 4) {
      return jsonResponse(200, {
        suggestions: await talentMappingQualityService.listClassificationSuggestions(segments[2]),
      });
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'classification-suggestions' && segments[4] === 'generate' && segments.length === 5) {
      const item = request.body === undefined ? {} : normalizeJsonObject(request.body, 'request body');
      const task = await enqueueTask(
        taskQueue,
        'talent-mapping-classification',
        normalizeTalentMappingClassificationTask({ ...item, mappingKey: segments[2] }),
      );
      return jsonResponse(202, task);
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'classification-suggestions' && segments[4] && segments[5] === 'review' && segments.length === 6) {
      return jsonResponse(200, await talentMappingQualityService.reviewClassificationSuggestion(
        segments[2],
        segments[4],
        request.body,
      ));
    }

    if (method === 'POST' && segments[0] === 'api' && segments[1] === 'talent-mappings' && segments[2] && segments[3] === 'classification-suggestions' && segments[4] && segments[5] === 'revoke' && segments.length === 6) {
      return jsonResponse(200, await talentMappingQualityService.revokeClassificationSuggestion(
        segments[2],
        segments[4],
        request.body,
      ));
    }

    if (method === 'GET' && pathname === '/api/boss/positions') {
      return jsonResponse(200, {
        positions: await bossReadModel.listPositions(),
      });
    }

    if (method === 'GET' && pathname === '/api/boss/job-sync/runs') {
      return jsonResponse(200, {
        runs: await bossReadModel.listJobSyncRuns(),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'boss' && segments[2] === 'job-sync' && segments[3] === 'runs' && segments[4] && segments.length === 5) {
      const run = await bossReadModel.getJobSyncRun(segments[4]);
      return run ? jsonResponse(200, run) : notFound(`Boss job sync run not found: ${segments[4]}`);
    }

    if (method === 'GET' && pathname === '/api/boss/chat-reviews') {
      return jsonResponse(200, {
        runs: await bossReadModel.listChatReviewRuns(),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'boss' && segments[2] === 'chat-reviews' && segments[3] && segments.length === 4) {
      const run = await bossReadModel.getChatReviewRun(segments[3]);
      return run ? jsonResponse(200, run) : notFound(`Boss chat review run not found: ${segments[3]}`);
    }

    if (method === 'GET' && pathname === '/api/boss/chat-receipts') {
      return jsonResponse(200, {
        receipts: await bossReadModel.listChatReceipts(),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'boss' && segments[2] === 'chat-receipts' && segments[3] && segments.length === 4) {
      const receipt = await bossReadModel.getChatReceipt(segments[3]);
      return receipt ? jsonResponse(200, receipt) : notFound(`Boss chat receipt not found: ${segments[3]}`);
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'artifacts' && segments[2] && segments.length === 3) {
      const artifact = await artifactReadModel.readArtifact(segments[2]);
      return artifact ? {
        statusCode: 200,
        body: artifact.content,
        headers: {
          'content-type': artifact.descriptor.contentType,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.descriptor.fileName)}`,
        },
      } : notFound('Artifact not found');
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments[2] && segments[3] && segments.length === 4) {
      const platform = parsePlatformArg(segments[2]);
      const detail = await jobReadModel.getJobDetail(platform, segments[3]);
      return detail ? jsonResponse(200, detail) : notFound(`Job not found: ${segments[2]}/${segments[3]}`);
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments[2] && segments[3] && segments[4] === 'runs') {
      const platform = parsePlatformArg(segments[2]);
      return jsonResponse(200, {
        runs: await jobReadModel.listRuns(platform, segments[3]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments[2] && segments[3] && segments[4] === 'candidates' && !segments[5]) {
      const platform = parsePlatformArg(segments[2]);
      return jsonResponse(200, {
        candidates: await jobReadModel.listCandidates(platform, segments[3]),
      });
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments[2] && segments[3] && segments[4] === 'candidates' && segments[5]) {
      const platform = parsePlatformArg(segments[2]);
      const candidate = await jobReadModel.getCandidateDetail(platform, segments[3], segments[5]);
      return candidate ? jsonResponse(200, candidate) : notFound(`Candidate not found: ${segments[5]}`);
    }

    if (method === 'POST' && pathname === '/api/rag/answer') {
      return jsonResponse(200, await answerRagRequest(request, request.body));
    }

    if (method === 'POST' && pathname === '/api/rag/conversations') {
      const requestOptions = normalizeConversationRequest(request.body);
      const ingestConversationFn = request.ingestConversationFn ?? ingestConversation;
      const summary = await ingestConversationFn(requestOptions);
      return jsonResponse(200, {
        platform: requestOptions.platform,
        jobKey: requestOptions.jobKey,
        conversationId: requestOptions.conversationId,
        turnCount: requestOptions.turns.length,
        verifiedTurnCount: requestOptions.turns.filter((turn) => turn.role === 'recruiter' && turn.verified === true).length,
        summary,
      });
    }

    if (method === 'GET' && pathname === '/api/ops/filter-catalogs') {
      const platform = jobReadModel.parsePlatform(searchParams.get('platform') ?? undefined);
      return jsonResponse(200, {
        catalogs: await jobReadModel.listFilterCatalogs(platform),
      });
    }

    if (method === 'GET' && pathname === '/api/ops/application-filter-options') {
      const platform = normalizePlatform(searchParams.get('platform'));
      return jsonResponse(200, await readApplicationFilterOptions(dataDir, platform));
    }

    if (method === 'GET' && pathname === '/api/ops/search-condition-sets') {
      const platformValue = searchParams.get('platform');
      const platform = !platformValue || platformValue === 'all' ? undefined : normalizePlatform(platformValue);
      const status = normalizeSearchConditionSetStatus(searchParams.get('status'));
      const conditionSets = await searchConditionSetService.list({ platform, status });
      return jsonResponse(200, {
        conditionSets: conditionSets.map(toApiSearchConditionSetSummary),
      });
    }

    if (method === 'POST' && pathname === '/api/ops/search-condition-sets') {
      const created = await searchConditionSetService.create(normalizeSearchConditionSetCreateRequest(request.body));
      return jsonResponse(201, toApiSearchConditionSetDetail(await searchConditionSetService.get(created)));
    }

    // Promotion accepts the already-read canonical filter input, never an
    // arbitrary server-side filename.  It has the same safe persistence path
    // as create and lets a caller explicitly promote a legacy UI/file value.
    if (method === 'POST' && pathname === '/api/ops/search-condition-sets/promote') {
      const created = await searchConditionSetService.create(normalizeSearchConditionSetCreateRequest(request.body));
      return jsonResponse(201, toApiSearchConditionSetDetail(await searchConditionSetService.get(created)));
    }

    if (method === 'GET'
      && segments[0] === 'api'
      && segments[1] === 'ops'
      && segments[2] === 'search-condition-sets'
      && segments[3]
      && segments.length === 4) {
      const platformValue = searchParams.get('platform');
      const platform = !platformValue || platformValue === 'all' ? undefined : normalizePlatform(platformValue);
      return jsonResponse(200, toApiSearchConditionSetDetail(
        await searchConditionSetService.getById(segments[3], platform),
      ));
    }

    if (method === 'POST'
      && segments[0] === 'api'
      && segments[1] === 'ops'
      && segments[2] === 'search-condition-sets'
      && segments[3]
      && segments[4] === 'revise'
      && segments.length === 5) {
      const revise = normalizeSearchConditionSetReviseRequest(request.body);
      const current = await searchConditionSetService.getById(segments[3]);
      if (revise.platform && revise.platform !== current.conditionSet.platform) {
        throw new Error('platform must match the condition set platform');
      }
      const { platform: _platform, ...input } = revise;
      const revised = await searchConditionSetService.revise({
        conditionSetId: current.conditionSet.conditionSetId,
        platform: current.conditionSet.platform,
      }, input);
      return jsonResponse(200, toApiSearchConditionSetDetail(await searchConditionSetService.get(revised)));
    }

    if (method === 'POST'
      && segments[0] === 'api'
      && segments[1] === 'ops'
      && segments[2] === 'search-condition-sets'
      && segments[3]
      && segments[4] === 'clone'
      && segments.length === 5) {
      const clone = normalizeSearchConditionSetCloneRequest(request.body);
      if (!clone.name) {
        throw new Error('name is required to clone a search condition set');
      }
      const current = await searchConditionSetService.getById(segments[3]);
      const cloned = await searchConditionSetService.clone({
        source: {
          conditionSetId: current.conditionSet.conditionSetId,
          platform: current.conditionSet.platform,
          revision: current.conditionSet.revision,
        },
        ...clone,
        name: clone.name,
      });
      return jsonResponse(201, toApiSearchConditionSetDetail(await searchConditionSetService.get(cloned)));
    }

    if (method === 'POST'
      && segments[0] === 'api'
      && segments[1] === 'ops'
      && segments[2] === 'search-condition-sets'
      && segments[3]
      && segments[4] === 'archive'
      && segments.length === 5) {
      const archive = normalizeSearchConditionSetArchiveRequest(request.body);
      const current = await searchConditionSetService.getById(segments[3]);
      const archived = await searchConditionSetService.archive({
        conditionSetId: current.conditionSet.conditionSetId,
        platform: current.conditionSet.platform,
      }, archive);
      return jsonResponse(200, toApiSearchConditionSetDetail(await searchConditionSetService.get(archived)));
    }

    if (method === 'POST' && pathname === '/api/ops/filter-inputs') {
      const result = await saveApplicationFilterInputFile({
        dataDir,
        ...normalizeApplicationFilterInputRequest(request.body),
      });
      return result.validation.ok ? jsonResponse(201, result) : badRequest(
        `Invalid applicationFilterInput: ${result.validation.errors.map((error) => `${error.fieldId}:${error.code}`).join(', ')}`,
      );
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'ops' && segments[2] === 'filter-catalogs' && segments[3]) {
      const platform = parsePlatformArg(segments[3]);
      const [catalog] = await jobReadModel.listFilterCatalogs(platform);
      return catalog ? jsonResponse(200, catalog) : notFound(`Filter catalog not found: ${segments[3]}`);
    }

    return notFound(`No route for ${method} ${pathname}`);
  } catch (error) {
    if (error instanceof PlatformRuntimeError) {
      const statusCode = error.code === 'browser-runtime-busy'
        || error.code === 'browser-runtime-generation-mismatch'
        || error.code === 'browser-runtime-recovery-required'
        ? 409
        : error.code === 'browser-runtime-unreachable'
          ? 503
          : 400;
      return jsonResponse(statusCode, {
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof ScheduleLeaseRecoveryRequiredError
      || error instanceof ScheduleLeaseOwnershipLostError
      || error instanceof ScheduleStoreConflictError) {
      return jsonResponse(409, {
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof ScheduleLeaseTimeoutError) {
      return jsonResponse(503, {
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof ScheduleTemplateValidationError) {
      return jsonResponse(400, {
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof SearchConditionSetConflictError) {
      const latest = await searchConditionSetService.get(error.reference)
        .then(toApiSearchConditionSetDetail)
        .catch(() => undefined);
      return jsonResponse(409, {
        error: {
          code: 'conflict',
          message: error.message,
          latest,
        },
      });
    }
    if (error instanceof SearchConditionSetNotFoundError) {
      return notFound(error.message);
    }
    if (error instanceof SearchConditionSetValidationError) {
      return jsonResponse(400, {
        error: {
          code: 'bad_request',
          message: error.message,
          errors: error.fieldErrors,
        },
      });
    }
    if (error instanceof TalentMappingConflictError) {
      return jsonResponse(409, {
        error: {
          code: 'conflict',
          message: error.message,
          latest: error.latest,
        },
      });
    }
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}
