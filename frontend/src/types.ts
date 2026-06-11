export type Platform = '51job' | 'liepin' | 'zhilian';
export type PlatformSelection = Platform | 'all';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskKind = 'resume-capture' | 'batch' | 'search-subscription' | 'login-refresh' | 'rag-ops';
export type AssistantActionKind = TaskKind | 'rag-answer';

export interface TaskLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
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
  input: Record<string, unknown>;
  output?: unknown;
  logs: TaskLogEntry[];
}

export interface RunResultView {
  jobKey: string;
  platform: Platform;
  fetchedAt: string;
  totalCandidates: number;
  newCandidateIds: string[];
  scoredCandidates: string[];
  failedCandidates: Array<{ candidateId: string; error: string }>;
  resultFile?: string;
}

export interface JobSummary {
  platform: Platform;
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
  jobRecord?: unknown;
  normalizedJob?: Record<string, unknown>;
  rawText?: string;
  recipientEmail?: string;
  ccEmails?: string[];
  exportPath?: string;
}

export interface ScoreView {
  status?: 'success' | 'failed';
  totalScore?: number;
  summary?: string;
  error?: string;
  artifact?: unknown;
}

export interface CandidateSummary {
  platform: Platform;
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
  resume: Record<string, unknown>;
  snapshotPath?: string;
  snapshotPreview?: string;
  domSnapshotPath?: string;
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

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export interface AssistantDraft {
  kind: AssistantActionKind;
  input: Record<string, unknown>;
  missingFields: string[];
  warnings: string[];
  argvPreview?: string[];
}

export interface AssistantChatRequest {
  messages: AssistantMessage[];
  draft?: AssistantDraft;
}

export interface AssistantChatResponse {
  message: AssistantMessage;
  draft?: AssistantDraft;
  clarificationQuestions: string[];
  rejected?: boolean;
}

export type AssistantConfirmResponse =
  | {
    kind: Exclude<AssistantActionKind, 'rag-answer'>;
    task: TaskDetail;
  }
  | {
    kind: 'rag-answer';
    answer: RagAnswer;
  };

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

export interface ApplicationFilterOption {
  label: string;
  value: string;
  disabled: boolean;
  selected: boolean;
  pathLabels?: string[];
  inputSpec?: {
    kind: 'numberRange' | 'selectRange';
    unit?: string;
    fields: Array<{
      key: string;
      valueType: 'string' | 'number';
      label?: string;
      placeholder?: string;
    }>;
  };
}

export interface ApplicationFilterTreeNode {
  key?: string;
  label: string;
  value: string;
  depth?: number;
  pathLabels: string[];
  children: ApplicationFilterTreeNode[];
}

export type ApplicationFilterField =
  | {
    fieldId: string;
    label: string;
    kind: 'singleSelect';
    allowedValues: string[];
    options: ApplicationFilterOption[];
    customInput?: {
      label: string;
      value: string;
      inputSpec: ApplicationFilterOption['inputSpec'];
    };
  }
  | {
    fieldId: string;
    label: string;
    kind: 'textInput';
    semanticKind: string;
    restrictInput: boolean;
    allowedValues: string[];
    rootValues: string[];
    tree: ApplicationFilterTreeNode[];
  }
  | {
    fieldId: string;
    label: string;
    kind: 'salaryRange';
    minLabel: string;
    maxLabel: string;
    minOptions: string[];
    maxOptions: string[];
  }
  | {
    fieldId: string;
    label: string;
    kind: 'numberRange';
    minLabel: string;
    maxLabel: string;
    unit?: string;
    min?: number;
    max?: number;
    minOptions: string[];
    maxOptions: string[];
  };

export interface ApplicationFilterOptions {
  platform: Platform;
  capturedAt: string;
  keyword: string;
  fieldCount: number;
  fieldIds: string[];
  fieldsById: Record<string, ApplicationFilterField>;
}

export interface SavedFilterInput {
  path: string;
  absolutePath: string;
  fieldCount: number;
  validation: {
    ok: boolean;
    errors: Array<{
      fieldId: string;
      code: string;
      message: string;
    }>;
  };
}

export interface DataAnomalySummary {
  platform: Platform;
  jobDirectories: number;
  validJobRecords: number;
  missingJd: number;
  emptyDirectories: number;
  exportOnlyDirectories: number;
  sampleOrphanDirectories: string[];
}

export interface PlatformRunHealth {
  platform: Platform;
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
  platform: Platform;
  totalCandidates: number;
  newCandidates: number;
  capturedResumes: number;
  scoredCandidates: number;
  failedCandidates: number;
  scoreArtifacts: number;
}

export interface SessionHealth {
  platform: Platform;
  storageStatePath: string;
  exists: boolean;
  updatedAt?: string;
  recentLoginRefreshAt?: string;
  recentLoginRefreshStatus?: TaskStatus;
  recentLoginRefreshError?: string;
}

export interface FilterCatalogHealth {
  platform: Platform;
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
