import type { MainResult } from '../index.js';
import type { BossForwardMode, SupportedPlatform } from '../platforms/types.js';
import type {
  CandidateResume,
  CandidateScoreArtifact,
  JobRecord,
  NormalizedJob,
  RunResult,
} from '../types/job.js';
import type {
  BossChatOperationInput,
  BossChatOperationResult,
  BossGreetInput,
  BossGreetResult,
  BossJobSyncInput,
  BossJobSyncRun,
  BossTalentSearchInput,
  BossTalentSearchResult,
} from '../types/boss.js';

export type ConsolePlatformSelection = SupportedPlatform | 'all';
export type SearchSource = 'saved' | 'direct';
export type TaskKind = 'resume-capture'
  | 'batch'
  | 'search-subscription'
  | 'boss-auto-chat'
  | 'boss-talent-search'
  | 'boss-greet'
  | 'boss-chat-operation'
  | 'boss-job-sync'
  | 'login-refresh'
  | 'rag-ops';
export type AssistantActionKind = TaskKind | 'rag-answer';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskLogLevel = 'info' | 'warn' | 'error';
export type SchedulableTaskKind = 'resume-capture' | 'batch' | 'search-subscription' | 'boss-auto-chat' | 'boss-job-sync';
export type ScheduleStatus = 'enabled' | 'paused' | 'stop_requested' | 'stopped';
export type ScheduleRunStatus = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'interrupted' | 'skipped';
export type WorkflowFailurePolicy = 'stop-round' | 'continue';

export interface TaskLogEntry {
  at: string;
  level: TaskLogLevel;
  message: string;
}

export interface ResumeCaptureTaskInput {
  platform: ConsolePlatformSelection;
  keyword: string;
  jd?: string;
  jdFile?: string;
  includeViewed?: boolean;
  searchSource?: SearchSource;
  applicationFilterInputFile?: string;
  email?: string;
  cc?: string[];
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
}

export interface BatchTaskInput {
  platform: ConsolePlatformSelection;
  jobsFile: string;
  includeViewed?: boolean;
  searchSource?: SearchSource;
  applicationFilterInputFile?: string;
  email?: string;
  cc?: string[];
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
}

export interface SearchSubscriptionTaskInput {
  platform: ConsolePlatformSelection;
  searchSubscriptionFile: string;
  keyword?: string;
  applicationFilterInputFile?: string;
  saveSearchSubscription?: boolean;
  searchSubscriptionName?: string;
}

export interface LoginRefreshTaskInput {
  platform: SupportedPlatform;
}

export interface BossAutoChatTaskInput {
  platform: 'boss';
  scoreThreshold?: number;
  requireAllHardRequirements?: boolean;
  replyToUnqualifiedCandidates?: boolean;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  summaryEmail?: string;
  summaryCc?: string[];
  syncJobsBeforeReview?: boolean;
}

export type BossTalentSearchTaskInput = BossTalentSearchInput;
export type BossGreetTaskInput = BossGreetInput;
export type BossChatOperationTaskInput = BossChatOperationInput;
export type BossJobSyncTaskInput = BossJobSyncInput;

export interface LoginRefreshTaskOutput {
  platform: SupportedPlatform;
  storageStatePath: string;
  refreshedAt: string;
}

export type RagOpsAction = 'doctor' | 'review' | 'metrics' | 'ops' | 'rebuild';

export interface RagOpsTaskInput {
  action: RagOpsAction;
  platform?: SupportedPlatform;
  jobKey?: string;
  keyword?: string;
  question?: string;
  file?: string;
  policyFile?: string;
  reviewer?: string;
  limit?: number;
  includeReviewed?: boolean;
  failOnIssue?: boolean;
}

export interface RagAnswerInput {
  platform: SupportedPlatform;
  jobKey?: string;
  keyword?: string;
  jd?: string;
  jdFile?: string;
  question: string;
  topK?: number;
  autoIndex?: boolean;
  logAnswer?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RagOpsTaskOutput {
  action: RagOpsAction;
  status: 'ok' | 'warning' | 'error' | 'needs_review' | 'needs_attention' | 'failed' | 'succeeded';
  platform?: SupportedPlatform;
  jobKey?: string;
  file?: string;
  outputPath?: string;
  summary: Record<string, unknown>;
}

export type TaskInput = ResumeCaptureTaskInput
  | BatchTaskInput
  | SearchSubscriptionTaskInput
  | BossAutoChatTaskInput
  | BossTalentSearchTaskInput
  | BossGreetTaskInput
  | BossChatOperationTaskInput
  | BossJobSyncTaskInput
  | LoginRefreshTaskInput
  | RagOpsTaskInput;
export type TaskOutput = MainResult
  | LoginRefreshTaskOutput
  | RagOpsTaskOutput
  | BossTalentSearchResult
  | BossGreetResult
  | BossChatOperationResult
  | BossJobSyncRun;

export interface ScheduledTaskTemplate {
  taskKey: string;
  name: string;
  enabled: boolean;
  kind: SchedulableTaskKind;
  input: Record<string, unknown>;
}

export interface ScheduleDefinition {
  scheduleId: string;
  name: string;
  status: ScheduleStatus;
  timeZone: string;
  dailyWindow: {
    start: string;
    end: string;
  };
  repeat: {
    mode: 'after-completion';
    delaySeconds: number;
    failureDelaySeconds: number;
  };
  failurePolicy: WorkflowFailurePolicy;
  pauseAfterConsecutiveFailures: number;
  tasks: ScheduledTaskTemplate[];
  createdAt: string;
  updatedAt: string;
  stopRequestedAt?: string;
  activeRunId?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  consecutiveFailures: number;
}

export interface ScheduleRunRecord {
  runId: string;
  scheduleId: string;
  cycleNumber: number;
  status: ScheduleRunStatus;
  scheduledAt: string;
  startedAt?: string;
  stopRequestedAt?: string;
  finishedAt?: string;
  taskIds: string[];
  currentTaskId?: string;
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  error?: string;
}

export interface ScheduledTaskMetadata {
  scheduleId: string;
  scheduleRunId: string;
  scheduleTaskKey: string;
  scheduleTaskIndex: number;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export interface ModelConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export type AssistantDraft =
  | {
    kind: 'resume-capture';
    input: Partial<ResumeCaptureTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'batch';
    input: Partial<BatchTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'search-subscription';
    input: Partial<SearchSubscriptionTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'login-refresh';
    input: Partial<LoginRefreshTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'boss-auto-chat';
    input: Partial<BossAutoChatTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'boss-talent-search';
    input: Partial<BossTalentSearchTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'boss-greet';
    input: Partial<BossGreetTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'boss-chat-operation';
    input: Partial<BossChatOperationTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'boss-job-sync';
    input: Partial<BossJobSyncTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'rag-ops';
    input: Partial<RagOpsTaskInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
    argvPreview: string[];
  }
  | {
    kind: 'rag-answer';
    input: Partial<RagAnswerInput> & Record<string, unknown>;
    missingFields: string[];
    warnings: string[];
  };

export interface AssistantChatRequest {
  messages: AssistantMessage[];
  draft?: AssistantDraft;
  modelConfig?: ModelConfig;
}

export interface AssistantChatResponse {
  message: AssistantMessage;
  draft?: AssistantDraft;
  clarificationQuestions: string[];
  rejected?: boolean;
}

export interface AssistantConfirmRequest {
  draft: AssistantDraft;
  riskAccepted?: boolean;
}

export type AssistantConfirmResponse =
  | {
    kind: Exclude<AssistantActionKind, 'rag-answer'>;
    task: TaskDetail;
  }
  | {
    kind: 'rag-answer';
    answer: Record<string, unknown>;
  };

export interface TaskRecord {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  input: TaskInput;
  inputSummary: Record<string, unknown>;
  output?: TaskOutput;
  outputSummary?: Record<string, unknown>;
  error?: string;
  argv: string[];
  logs: TaskLogEntry[];
  schedule?: ScheduledTaskMetadata;
}

export interface TaskSummary {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  inputSummary: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: string;
}

export interface TaskDetail extends TaskSummary {
  input: TaskInput;
  output?: TaskOutput;
  logs: TaskLogEntry[];
  schedule?: ScheduledTaskMetadata;
}

export interface ScheduleSummary {
  scheduleId: string;
  name: string;
  status: ScheduleStatus;
  timeZone: string;
  dailyWindow: ScheduleDefinition['dailyWindow'];
  repeat: ScheduleDefinition['repeat'];
  taskCount: number;
  activeRunId?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface RunResultView extends RunResult {
  resultFile?: string;
}

export interface JobSummary {
  platform: SupportedPlatform;
  jobKey: string;
  searchKeyword?: string;
  title?: string;
  location?: string;
  createdAt?: string;
  runCount: number;
  candidateCount: number;
  scoreCount: number;
  latestRunAt?: string;
  latestRun?: RunResultView;
}

export interface JobDetail extends JobSummary {
  jobRecord?: JobRecord;
  normalizedJob?: NormalizedJob;
  rawText?: string;
  recipientEmail?: string;
  ccEmails?: string[];
  exportPath?: string;
}

export interface ScoreView {
  status?: CandidateScoreArtifact['status'];
  artifact?: CandidateScoreArtifact;
  totalScore?: number;
  summary?: string;
  error?: string;
}

export interface CandidateSummary {
  platform: SupportedPlatform;
  jobKey: string;
  candidateId: string;
  name?: string;
  age?: number;
  education?: string;
  regions: string[];
  currentCompany?: string;
  currentTitle?: string;
  candidateShareUrl?: string;
  score?: ScoreView;
}

export interface CandidateDetail extends CandidateSummary {
  resume: CandidateResume;
  snapshotPath?: string;
  snapshotPreview?: string;
  domSnapshotPath?: string;
}

export interface DataAnomalySummary {
  platform: SupportedPlatform;
  jobDirectories: number;
  validJobRecords: number;
  missingJd: number;
  emptyDirectories: number;
  exportOnlyDirectories: number;
  sampleOrphanDirectories: string[];
}

export interface PlatformRunHealth {
  platform: SupportedPlatform;
  jobCount: number;
  runCount: number;
  latestSuccessAt?: string;
  latestFailureAt?: string;
  latestFailureMessage?: string;
  latestFailureDetail?: string;
  consecutiveFailures: number;
  zeroCandidateRuns: number;
  zeroCandidateRate: number;
}

export interface CandidateFunnelHealth {
  platform: SupportedPlatform;
  totalCandidates: number;
  newCandidates: number;
  capturedResumes: number;
  scoredCandidates: number;
  failedCandidates: number;
  scoreArtifacts: number;
}

export interface SessionHealth {
  platform: SupportedPlatform;
  storageStatePath: string;
  exists: boolean;
  updatedAt?: string;
  recentLoginRefreshAt?: string;
  recentLoginRefreshStatus?: TaskStatus;
  recentLoginRefreshError?: string;
}

export interface FilterCatalogHealth {
  platform: SupportedPlatform;
  exists: boolean;
  capturedAt?: string;
  ageHours?: number;
  fieldCount: number;
  failedControls: number;
  unknownControls: number;
  optionsExtracted: number;
}

export interface TaskQueueHealth {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  oldestQueuedAgeMinutes?: number;
  latestFailureAt?: string;
  latestFailureMessage?: string;
  latestFailureDetail?: string;
}

export interface DashboardHealth {
  generatedAt: string;
  dataAnomalies: DataAnomalySummary[];
  platformRuns: PlatformRunHealth[];
  candidateFunnels: CandidateFunnelHealth[];
  sessions: SessionHealth[];
  filters: FilterCatalogHealth[];
  tasks: TaskQueueHealth;
}
