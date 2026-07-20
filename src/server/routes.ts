import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
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
  assistantDraftRequiresRiskAcceptance,
  chatWithCliAssistant,
  finalizeAssistantDraft,
  normalizeModelConfig,
  validateAssistantDraft,
  type AssistantCompletion,
} from './cli-assistant.js';
import { JobReadModel } from './job-read-model.js';
import { TaskScheduler } from './task-scheduler.js';
import { TaskQueue } from './task-queue.js';
import {
  normalizeApplicationFilterInputRequest,
  normalizeBatchTask,
  normalizeBossAutoChatTask,
  normalizeConversationRequest,
  normalizeLoginRefreshTask,
  normalizePlatform,
  normalizeJsonObject,
  normalizeRagAnswerRequest,
  normalizeRagOpsTask,
  normalizeResumeCaptureTask,
  prepareSearchSubscriptionTask,
  type NormalizedTask,
} from './task-normalizers.js';
import type {
  AssistantChatRequest,
  AssistantConfirmResponse,
  AssistantDraft,
  DashboardHealth,
  ModelConfig,
  TaskDetail,
  TaskKind,
  TaskInput,
} from './types.js';

export interface ApiResponse<T = unknown> {
  statusCode: number;
  body: T;
}

interface RouteDependencies {
  taskQueue?: TaskQueue;
  taskScheduler?: TaskScheduler;
  jobReadModel?: JobReadModel;
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
        task: await enqueueTask(taskQueue, draft.kind, normalizeResumeCaptureTask(draft.input)),
      };
    case 'batch':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBatchTask(draft.input)),
      };
    case 'search-subscription':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, await prepareSearchSubscriptionTask(draft.input, dataDir)),
      };
    case 'boss-auto-chat':
      return {
        kind: draft.kind,
        task: await enqueueTask(taskQueue, draft.kind, normalizeBossAutoChatTask(draft.input)),
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
  const taskQueue = request.taskQueue ?? new TaskQueue();
  let taskScheduler = request.taskScheduler;
  const getTaskScheduler = () => {
    taskScheduler ??= new TaskScheduler({ taskQueue, dataDir });
    return taskScheduler;
  };
  const jobReadModel = request.jobReadModel ?? new JobReadModel({ dataDir });
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
      return jsonResponse(200, await confirmAssistantDraft(request, taskQueue, dataDir));
    }

    if (method === 'POST' && pathname === '/api/tasks/resume-capture') {
      const task = await enqueueTask(taskQueue, 'resume-capture', normalizeResumeCaptureTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/batch') {
      const task = await enqueueTask(taskQueue, 'batch', normalizeBatchTask(request.body));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/search-subscription') {
      const task = await enqueueTask(taskQueue, 'search-subscription', await prepareSearchSubscriptionTask(request.body, dataDir));
      return jsonResponse(202, task);
    }

    if (method === 'POST' && pathname === '/api/tasks/boss-auto-chat') {
      const task = await enqueueTask(taskQueue, 'boss-auto-chat', normalizeBossAutoChatTask(request.body));
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
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}
