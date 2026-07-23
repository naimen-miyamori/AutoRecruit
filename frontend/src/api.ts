import { mockApplicationFilterOptions, mockCandidateDetail, mockCandidates, mockCatalogs, mockDashboardHealth, mockJobDetail, mockJobs, mockTaskDetail, mockTasks } from './mock-data';
import type { ApplicationFilterOptions, AssistantChatRequest, AssistantChatResponse, AssistantConfirmResponse, AssistantDraft, CandidateDetail, CandidateSummary, DashboardHealth, FilterCatalog, JobDetail, JobSummary, RagAnswer, SavedFilterInput, ScheduleDefinition, ScheduleRunRecord, ScheduleSummary, TaskDetail, TaskKind, TaskSummary } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as ApiErrorBody;
      message = body.error?.message ?? message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new ApiRequestError(message, response.status);
  }

  return response.json() as Promise<T>;
}

async function withFallback<T>(request: Promise<T>, fallback: T): Promise<{ data: T; mocked: boolean }> {
  try {
    return { data: await request, mocked: false };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status < 500) {
      throw error;
    }

    return { data: fallback, mocked: true };
  }
}

export const api = {
  async dashboard() {
    const [tasks, jobs, catalogs, health] = await Promise.all([
      withFallback(requestJson<{ tasks: TaskSummary[] }>('/tasks'), { tasks: mockTasks }),
      withFallback(requestJson<{ jobs: JobSummary[] }>('/jobs'), { jobs: mockJobs }),
      withFallback(requestJson<{ catalogs: FilterCatalog[] }>('/ops/filter-catalogs'), { catalogs: mockCatalogs }),
      withFallback(requestJson<DashboardHealth>('/dashboard/health'), mockDashboardHealth),
    ]);
    return {
      tasks: tasks.data.tasks,
      jobs: jobs.data.jobs,
      catalogs: catalogs.data.catalogs,
      health: health.data,
      mocked: tasks.mocked || jobs.mocked || catalogs.mocked || health.mocked,
    };
  },
  async listTasks() {
    return withFallback(requestJson<{ tasks: TaskSummary[] }>('/tasks'), { tasks: mockTasks });
  },
  async getTask(taskId: string) {
    return withFallback(requestJson<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}`), {
      ...mockTaskDetail,
      taskId,
    });
  },
  async listSchedules() {
    return withFallback(requestJson<{ schedules: ScheduleSummary[] }>('/schedules'), { schedules: [] });
  },
  async getSchedule(scheduleId: string) {
    return requestJson<ScheduleDefinition>(`/schedules/${encodeURIComponent(scheduleId)}`);
  },
  async listScheduleRuns(scheduleId: string) {
    return requestJson<{ runs: ScheduleRunRecord[] }>(`/schedules/${encodeURIComponent(scheduleId)}/runs`);
  },
  async createSchedule(body: Record<string, unknown>) {
    return requestJson<ScheduleDefinition>('/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async updateSchedule(scheduleId: string, body: Record<string, unknown>) {
    return requestJson<ScheduleDefinition>(`/schedules/${encodeURIComponent(scheduleId)}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async controlSchedule(scheduleId: string, action: 'start' | 'pause' | 'stop' | 'run-now') {
    return requestJson<ScheduleDefinition>(`/schedules/${encodeURIComponent(scheduleId)}/${action}`, { method: 'POST' });
  },
  async stopAllSchedules() {
    return requestJson<{ schedules: ScheduleSummary[] }>('/schedules/stop-all', { method: 'POST' });
  },
  async listJobs(platform?: string) {
    const query = platform && platform !== 'all' ? `?platform=${encodeURIComponent(platform)}` : '';
    return withFallback(requestJson<{ jobs: JobSummary[] }>(`/jobs${query}`), { jobs: mockJobs });
  },
  async getJob(platform: string, jobKey: string) {
    return withFallback(requestJson<JobDetail>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}`), {
      ...mockJobDetail,
      platform: platform as JobDetail['platform'],
      jobKey,
    });
  },
  async listCandidates(platform: string, jobKey: string) {
    return withFallback(requestJson<{ candidates: CandidateSummary[] }>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/candidates`), {
      candidates: mockCandidates.map((candidate) => ({
        ...candidate,
        platform: platform as CandidateSummary['platform'],
        jobKey,
      })),
    });
  },
  async getCandidate(platform: string, jobKey: string, candidateId: string) {
    return withFallback(requestJson<CandidateDetail>(`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/candidates/${encodeURIComponent(candidateId)}`), {
      ...mockCandidateDetail,
      platform: platform as CandidateDetail['platform'],
      jobKey,
      candidateId,
    });
  },
  async submitTask(kind: TaskKind, body: Record<string, unknown>) {
    return requestJson<TaskDetail>(`/tasks/${kind}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async askRag(body: Record<string, unknown>) {
    return requestJson<RagAnswer>('/rag/answer', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async chatWithAssistant(payload: AssistantChatRequest) {
    return requestJson<AssistantChatResponse>('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  async confirmAssistantDraft(draft: AssistantDraft, riskAccepted: boolean) {
    return requestJson<AssistantConfirmResponse>('/assistant/confirm', {
      method: 'POST',
      body: JSON.stringify({ draft, riskAccepted }),
    });
  },
  async validateAssistantDraft(draft: AssistantDraft) {
    return requestJson<AssistantChatResponse>('/assistant/validate', {
      method: 'POST',
      body: JSON.stringify({ draft }),
    });
  },
  async listFilterCatalogs(platform?: string) {
    const query = platform && platform !== 'all' ? `?platform=${encodeURIComponent(platform)}` : '';
    return withFallback(requestJson<{ catalogs: FilterCatalog[] }>(`/ops/filter-catalogs${query}`), { catalogs: mockCatalogs });
  },
  async getApplicationFilterOptions(platform: string) {
    return withFallback(
      requestJson<ApplicationFilterOptions>(`/ops/application-filter-options?platform=${encodeURIComponent(platform)}`),
      mockApplicationFilterOptions,
    );
  },
  async saveApplicationFilterInput(body: Record<string, unknown>) {
    return requestJson<SavedFilterInput>('/ops/filter-inputs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
