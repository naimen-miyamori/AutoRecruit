export type { ArtifactDescriptor } from '../../../src/server/api-contracts.js';
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
  ScheduleDefinition,
  ScheduleRunRecord,
  ScheduleSummary,
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
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
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

export type Platform = '51job' | 'liepin' | 'zhilian' | 'boss';
export type PlatformSelection = Platform | 'all';
export type TalentMappingPlatformSelection = Exclude<Platform, 'boss'> | 'all';

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
