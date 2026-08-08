import { parseOperationModeCatalogResponse, parseScheduleDetailResponse } from './contracts';
import type {
  ApplicationFilterOptions,
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantConfirmResponse,
  AssistantDraft,
  BossChatReceiptRecord,
  BossChatReviewRun,
  BossChatReviewRunSummary,
  BossJobSyncRun,
  BossJobSyncRunSummary,
  BossPositionView,
  CandidateDetail,
  CandidateSummary,
  DashboardHealth,
  FilterCatalog,
  JobDetail,
  JobSummary,
  Platform,
  RagAnswer,
  RunResultView,
  SavedFilterInput,
  SearchConditionSetDetail,
  SearchConditionSetRef,
  SearchConditionSetStatus,
  SearchConditionSetSummary,
  ScheduleDefinition,
  ScheduleRunRecord,
  ScheduleSummary,
  TaskDetail,
  TaskKind,
  TaskSummary,
  MappingCandidateView,
  MappingClassificationSuggestionView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingEntityLink,
  MappingEntityLinkReviewView,
  MappingRunChangeReport,
  MappingRunRecord,
  TalentMappingProjectDetail,
  TalentMappingProjectSummary,
} from './contracts';
import type { ArtifactDescriptor } from './contracts';

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';
const API_BASE_STORAGE_KEY = 'autorecruit.consoleApiBase';
const CONSOLE_TOKEN_STORAGE_KEY = 'autorecruit.consoleToken';

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface ConsoleConnectionSettings {
  apiBaseUrl: string;
  token: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getConsoleConnectionSettings(): ConsoleConnectionSettings {
  return {
    apiBaseUrl: window.localStorage.getItem(API_BASE_STORAGE_KEY)?.trim() || DEFAULT_API_BASE,
    token: window.sessionStorage.getItem(CONSOLE_TOKEN_STORAGE_KEY)?.trim() || '',
  };
}

export function saveConsoleConnectionSettings(settings: ConsoleConnectionSettings): void {
  const apiBaseUrl = settings.apiBaseUrl.trim() || DEFAULT_API_BASE;
  window.localStorage.setItem(API_BASE_STORAGE_KEY, apiBaseUrl);
  if (settings.token.trim()) {
    window.sessionStorage.setItem(CONSOLE_TOKEN_STORAGE_KEY, settings.token.trim());
  } else {
    window.sessionStorage.removeItem(CONSOLE_TOKEN_STORAGE_KEY);
  }
}

async function parseError(response: Response): Promise<ApiRequestError> {
  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  try {
    const body = await response.json() as ApiErrorBody;
    message = body.error?.message ?? message;
    code = body.error?.code;
  } catch {
    // Preserve the HTTP status when the body is not JSON.
  }
  return new ApiRequestError(message, response.status, code);
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const settings = getConsoleConnectionSettings();
  const headers = new Headers(options.headers);
  if (!headers.has('content-type') && options.body !== undefined) headers.set('content-type', 'application/json');
  if (settings.token) headers.set('authorization', `Bearer ${settings.token}`);
  const response = await fetch(`${trimTrailingSlash(settings.apiBaseUrl)}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) throw await parseError(response);
  return response;
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  return request(path, options).then((response) => response.json() as Promise<T>);
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function downloadArtifact(artifactId: string, fileName: string): Promise<void> {
  const response = await request(`/artifacts/${encodeURIComponent(artifactId)}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export const api = {
  health: (signal?: AbortSignal) => requestJson<{ status: string; service: string }>('/health', { signal }),
  listOperationModes: (surface?: 'assistant' | 'manual' | 'schedule' | 'cli', signal?: AbortSignal) => requestJson<unknown>(`/operation-modes${surface ? `?surface=${encodeURIComponent(surface)}` : ''}`, { signal })
    .then((value) => parseOperationModeCatalogResponse(value, { surface })),
  dashboardHealth: (signal?: AbortSignal) => requestJson<DashboardHealth>('/dashboard/health', { signal }),
  listTasks: (signal?: AbortSignal) => requestJson<{ tasks: TaskSummary[] }>('/tasks', { signal }),
  getTask: (taskId: string, signal?: AbortSignal) => requestJson<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}`, { signal }),
  submitTask: (kind: TaskKind, body: Record<string, unknown>) => postJson<TaskDetail>(`/tasks/${kind}`, body),

  listSchedules: (signal?: AbortSignal) => requestJson<{ schedules: ScheduleSummary[] }>('/schedules', { signal }),
  getSchedule: (scheduleId: string, signal?: AbortSignal) => requestJson<unknown>(`/schedules/${encodeURIComponent(scheduleId)}`, { signal })
    .then((value) => parseScheduleDetailResponse(value, scheduleId).schedule),
  listScheduleRuns: (scheduleId: string, signal?: AbortSignal) => requestJson<{ runs: ScheduleRunRecord[] }>(`/schedules/${encodeURIComponent(scheduleId)}/runs`, { signal }),
  createSchedule: (body: Record<string, unknown>) => postJson<ScheduleDefinition>('/schedules', body),
  updateSchedule: (scheduleId: string, body: Record<string, unknown>) => postJson<ScheduleDefinition>(`/schedules/${encodeURIComponent(scheduleId)}/update`, body),
  controlSchedule: (scheduleId: string, action: 'start' | 'pause' | 'stop' | 'run-now') => postJson<unknown>(`/schedules/${encodeURIComponent(scheduleId)}/${action}`)
    .then((value) => parseScheduleDetailResponse(value, scheduleId).schedule),
  stopAllSchedules: () => postJson<{ schedules: ScheduleSummary[] }>('/schedules/stop-all'),

  listJobs: (platform?: string, signal?: AbortSignal) => requestJson<{ jobs: JobSummary[] }>(`/jobs${platform && platform !== 'all' ? `?platform=${encodeURIComponent(platform)}` : ''}`, { signal }),
  getJob: (platform: string, jobKey: string, signal?: AbortSignal) => requestJson<JobDetail>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}`, { signal }),
  listJobRuns: (platform: string, jobKey: string, signal?: AbortSignal) => requestJson<{ runs: RunResultView[] }>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/runs`, { signal }),
  listCandidates: (platform: string, jobKey: string, signal?: AbortSignal) => requestJson<{ candidates: CandidateSummary[] }>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/candidates`, { signal }),
  getCandidate: (platform: string, jobKey: string, candidateId: string, signal?: AbortSignal) => requestJson<CandidateDetail>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/candidates/${encodeURIComponent(candidateId)}`, { signal }),

  listTalentMappings: (signal?: AbortSignal) => requestJson<{ mappings: TalentMappingProjectSummary[] }>('/talent-mappings', { signal }),
  getTalentMapping: (mappingKey: string, signal?: AbortSignal) => requestJson<TalentMappingProjectDetail>(`/talent-mappings/${encodeURIComponent(mappingKey)}`, { signal }),
  listTalentMappingRuns: (mappingKey: string, signal?: AbortSignal) => requestJson<{ runs: MappingRunRecord[] }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/runs`, { signal }),
  listTalentMappingCandidates: (mappingKey: string, signal?: AbortSignal) => requestJson<{ candidates: MappingCandidateView[] }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/candidates`, { signal }),
  listTalentMappingCompanies: (mappingKey: string, signal?: AbortSignal) => requestJson<{ companies: MappingCompanyRoleMatrixRow[] }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/companies`, { signal }),
  getTalentMappingCoverage: (mappingKey: string, signal?: AbortSignal) => requestJson<{ coverage: MappingCoverageViewRow[] }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/coverage`, { signal }),
  getTalentMappingChanges: (mappingKey: string, baseRunId?: string, compareRunId?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (baseRunId) params.set('baseRunId', baseRunId);
    if (compareRunId) params.set('compareRunId', compareRunId);
    const query = params.size ? `?${params.toString()}` : '';
    return requestJson<{ changes: MappingRunChangeReport }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/changes${query}`, { signal });
  },
  getTalentMappingEntityLinks: (mappingKey: string, signal?: AbortSignal) => requestJson<{ entityLinks: MappingEntityLinkReviewView }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/entity-links`, { signal }),
  confirmTalentMappingEntityLink: (mappingKey: string, body: Record<string, unknown>) => postJson<MappingEntityLink>(`/talent-mappings/${encodeURIComponent(mappingKey)}/entity-links`, body),
  revokeTalentMappingEntityLink: (mappingKey: string, entityId: string, body: Record<string, unknown>) => postJson<MappingEntityLink>(`/talent-mappings/${encodeURIComponent(mappingKey)}/entity-links/${encodeURIComponent(entityId)}/revoke`, body),
  listTalentMappingClassificationSuggestions: (mappingKey: string, signal?: AbortSignal) => requestJson<{ suggestions: MappingClassificationSuggestionView[] }>(`/talent-mappings/${encodeURIComponent(mappingKey)}/classification-suggestions`, { signal }),
  generateTalentMappingClassificationSuggestions: (mappingKey: string, limit = 25) => postJson<TaskDetail>(`/talent-mappings/${encodeURIComponent(mappingKey)}/classification-suggestions/generate`, { limit }),
  reviewTalentMappingClassificationSuggestion: (mappingKey: string, suggestionId: string, body: Record<string, unknown>) => postJson<MappingClassificationSuggestionView['review']>(`/talent-mappings/${encodeURIComponent(mappingKey)}/classification-suggestions/${encodeURIComponent(suggestionId)}/review`, body),
  revokeTalentMappingClassificationSuggestion: (mappingKey: string, suggestionId: string, body: Record<string, unknown>) => postJson<MappingClassificationSuggestionView['review']>(`/talent-mappings/${encodeURIComponent(mappingKey)}/classification-suggestions/${encodeURIComponent(suggestionId)}/revoke`, body),
  submitTalentMapping: (body: Record<string, unknown>) => postJson<TaskDetail>('/tasks/talent-mapping', body),

  listBossPositions: (signal?: AbortSignal) => requestJson<{ positions: BossPositionView[] }>('/boss/positions', { signal }),
  listBossJobSyncRuns: (signal?: AbortSignal) => requestJson<{ runs: BossJobSyncRunSummary[] }>('/boss/job-sync/runs', { signal }),
  getBossJobSyncRun: (runId: string, signal?: AbortSignal) => requestJson<BossJobSyncRun & { runId: string; artifact: ArtifactDescriptor }>(`/boss/job-sync/runs/${encodeURIComponent(runId)}`, { signal }),
  listBossChatReviews: (signal?: AbortSignal) => requestJson<{ runs: BossChatReviewRunSummary[] }>('/boss/chat-reviews', { signal }),
  getBossChatReview: (runId: string, signal?: AbortSignal) => requestJson<BossChatReviewRun & { runId: string; artifact: ArtifactDescriptor }>(`/boss/chat-reviews/${encodeURIComponent(runId)}`, { signal }),
  listBossChatReceipts: (signal?: AbortSignal) => requestJson<{ receipts: BossChatReceiptRecord[] }>('/boss/chat-receipts', { signal }),
  getBossChatReceipt: (intentId: string, signal?: AbortSignal) => requestJson<BossChatReceiptRecord>(`/boss/chat-receipts/${encodeURIComponent(intentId)}`, { signal }),

  askRag: (body: Record<string, unknown>) => postJson<RagAnswer>('/rag/answer', body),
  chatWithAssistant: (body: AssistantChatRequest) => postJson<AssistantChatResponse>('/assistant/chat', body),
  validateAssistantDraft: (draft: AssistantDraft) => postJson<AssistantChatResponse>('/assistant/validate', { draft }),
  confirmAssistantDraft: (draft: AssistantDraft, riskAccepted: boolean) => postJson<AssistantConfirmResponse>('/assistant/confirm', { draft, riskAccepted }),

  listFilterCatalogs: (platform?: string, signal?: AbortSignal) => requestJson<{ catalogs: FilterCatalog[] }>(`/ops/filter-catalogs${platform && platform !== 'all' ? `?platform=${encodeURIComponent(platform)}` : ''}`, { signal }),
  getApplicationFilterOptions: (platform: Platform, signal?: AbortSignal) => requestJson<ApplicationFilterOptions>(`/ops/application-filter-options?platform=${encodeURIComponent(platform)}`, { signal }),
  listSearchConditionSets: (platform?: Platform, status: SearchConditionSetStatus | 'all' = 'active', signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (platform) params.set('platform', platform);
    if (status !== 'all') params.set('status', status);
    const query = params.size ? `?${params.toString()}` : '';
    return requestJson<{ conditionSets: SearchConditionSetSummary[] }>(`/ops/search-condition-sets${query}`, { signal });
  },
  getSearchConditionSet: (conditionSetId: string, signal?: AbortSignal) => requestJson<SearchConditionSetDetail>(`/ops/search-condition-sets/${encodeURIComponent(conditionSetId)}`, { signal }),
  createSearchConditionSet: (body: Record<string, unknown>) => postJson<SearchConditionSetDetail>('/ops/search-condition-sets', body),
  reviseSearchConditionSet: (conditionSetId: string, body: Record<string, unknown>) => postJson<SearchConditionSetDetail>(`/ops/search-condition-sets/${encodeURIComponent(conditionSetId)}/revise`, body),
  cloneSearchConditionSet: (conditionSetId: string, body: Record<string, unknown> = {}) => postJson<SearchConditionSetDetail>(`/ops/search-condition-sets/${encodeURIComponent(conditionSetId)}/clone`, body),
  archiveSearchConditionSet: (conditionSetId: string, expectedRevision: number) => postJson<SearchConditionSetDetail>(`/ops/search-condition-sets/${encodeURIComponent(conditionSetId)}/archive`, { expectedRevision }),
  saveApplicationFilterInput: (body: Record<string, unknown>) => postJson<SavedFilterInput>('/ops/filter-inputs', body),
};

export const queryKeys = {
  health: ['health'] as const,
  operationModes: (surface?: string) => ['operation-modes', surface ?? 'all'] as const,
  dashboard: ['dashboard'] as const,
  tasks: ['tasks'] as const,
  task: (taskId: string) => ['tasks', taskId] as const,
  schedules: ['schedules'] as const,
  schedule: (scheduleId: string) => ['schedules', scheduleId] as const,
  scheduleRuns: (scheduleId: string) => ['schedules', scheduleId, 'runs'] as const,
  jobs: (platform?: string) => ['jobs', platform ?? 'all'] as const,
  job: (platform: string, jobKey: string) => ['jobs', platform, jobKey] as const,
  jobRuns: (platform: string, jobKey: string) => ['jobs', platform, jobKey, 'runs'] as const,
  candidates: (platform: string, jobKey: string) => ['jobs', platform, jobKey, 'candidates'] as const,
  candidate: (platform: string, jobKey: string, candidateId: string) => ['jobs', platform, jobKey, 'candidates', candidateId] as const,
  talentMappings: ['talent-mappings'] as const,
  talentMapping: (mappingKey: string) => ['talent-mappings', mappingKey] as const,
  talentMappingRuns: (mappingKey: string) => ['talent-mappings', mappingKey, 'runs'] as const,
  talentMappingCandidates: (mappingKey: string) => ['talent-mappings', mappingKey, 'candidates'] as const,
  talentMappingCompanies: (mappingKey: string) => ['talent-mappings', mappingKey, 'companies'] as const,
  talentMappingCoverage: (mappingKey: string) => ['talent-mappings', mappingKey, 'coverage'] as const,
  talentMappingChanges: (mappingKey: string, baseRunId?: string, compareRunId?: string) => ['talent-mappings', mappingKey, 'changes', baseRunId ?? 'auto', compareRunId ?? 'auto'] as const,
  talentMappingEntityLinks: (mappingKey: string) => ['talent-mappings', mappingKey, 'entity-links'] as const,
  talentMappingClassifications: (mappingKey: string) => ['talent-mappings', mappingKey, 'classification-suggestions'] as const,
  bossPositions: ['boss', 'positions'] as const,
  bossSyncRuns: ['boss', 'sync-runs'] as const,
  bossReviews: ['boss', 'reviews'] as const,
  bossReceipts: ['boss', 'receipts'] as const,
  filterCatalogs: (platform?: string) => ['filter-catalogs', platform ?? 'all'] as const,
  searchConditionSets: (platform?: Platform, status: SearchConditionSetStatus | 'all' = 'active') => ['search-condition-sets', platform ?? 'all', status] as const,
  searchConditionSet: (conditionSetId: string) => ['search-condition-sets', conditionSetId] as const,
};
