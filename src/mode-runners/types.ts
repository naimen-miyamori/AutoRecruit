import type { CliSearchModeId } from '../operation-modes.js';
import type { BossForwardMode, SupportedPlatform } from '../platforms/types.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';
import type {
  BossCaptureSettingsSnapshot,
  BossCaptureTaskSnapshot,
  JobSearchSource,
  ReportDeliveryOptions,
  SavedSearchReference,
} from '../types/job.js';
import type {
  BossChatOperationInput,
  BossGreetInput,
  BossJobSyncInput,
  BossTalentSearchInput,
} from '../types/boss.js';
import type { TalentMappingPlatformSelection, TalentMappingStage } from '../types/talent-mapping.js';

export type CliPlatformSelection = SupportedPlatform | 'all';
export type SearchSource = JobSearchSource;

export interface RunnableJobInput extends ReportDeliveryOptions {
  searchKeyword: string;
  bossJobId?: string;
  bossSearchKeyword?: string;
  bossSavedSearchReference?: SavedSearchReference;
  bossSearchConditionSetRef?: SearchConditionSetReference;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  includeBoss: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  bossCaptureSettingsSnapshot?: BossCaptureSettingsSnapshot;
  bossCaptureTaskSnapshot?: BossCaptureTaskSnapshot;
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

export interface SingleJobCliInput extends RunnableJobInput {
  mode: 'single';
  platform: CliPlatformSelection;
  modeId?: CliSearchModeId;
}

export interface BatchCliInput extends ReportDeliveryOptions {
  mode: 'batch';
  platform: CliPlatformSelection;
  modeId?: CliSearchModeId;
  jobsFilePath: string;
  includeViewedCandidates: boolean;
  includeBoss: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

export interface SearchSubscriptionCliInput {
  mode: 'search-subscription';
  platform: CliPlatformSelection;
  modeId?: CliSearchModeId;
  keyword?: string;
  filePath: string;
  includeBoss: boolean;
  save: boolean;
  savedSearchName?: string;
  searchConditionSetRefs?: Partial<Record<SupportedPlatform, SearchConditionSetReference>>;
}

export interface BossSavedSearchBindingCliInput {
  mode: 'boss-saved-search-binding';
  platform: 'boss';
  searchKeyword: string;
  bossJobId?: string;
  savedSearch: SavedSearchReference;
}

export interface TalentMappingCliInput {
  mode: 'talent-mapping';
  platform: TalentMappingPlatformSelection;
  filePath: string;
  stage: TalentMappingStage;
  confirmedDetailOpen: boolean;
  sourceScanRunId?: string;
}

export interface JdQuestionCliInput {
  mode: 'jd-question';
  platform: CliPlatformSelection;
  keyword?: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  question: string;
}

export interface BossAutoChatCliInput {
  mode: 'boss-auto-chat';
  platform: 'boss';
  scoreThreshold: number;
  requireAllHardRequirements: boolean;
  replyToUnqualifiedCandidates: boolean;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  summaryEmail?: string;
  summaryCcEmails?: string[];
  syncJobsBeforeReview: boolean;
}

export interface BossTalentSearchCliInput extends BossTalentSearchInput {
  mode: 'boss-talent-search';
}

export interface BossGreetCliInput extends BossGreetInput {
  mode: 'boss-greet';
}

export interface BossChatOperationCliInput extends BossChatOperationInput {
  mode: 'boss-chat-operation';
}

export interface BossJobSyncCliInput extends BossJobSyncInput {
  mode: 'boss-job-sync';
}

export interface BatchRunnableJobInput extends RunnableJobInput {
  sourceIndex: number;
}

export type CliInput = SingleJobCliInput
  | BatchCliInput
  | SearchSubscriptionCliInput
  | BossSavedSearchBindingCliInput
  | TalentMappingCliInput
  | JdQuestionCliInput
  | BossAutoChatCliInput
  | BossTalentSearchCliInput
  | BossGreetCliInput
  | BossChatOperationCliInput
  | BossJobSyncCliInput;

export interface SinglePlatformCliInput extends ReportDeliveryOptions {
  platform: SupportedPlatform;
  searchKeyword: string;
  bossJobId?: string;
  bossSearchKeyword?: string;
  bossSavedSearchReference?: SavedSearchReference;
  bossSearchConditionSetRef?: SearchConditionSetReference;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  liepinForwardContact?: string;
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCc?: string[];
  bossScreeningEnabled?: boolean;
  bossScreeningPolicyFile?: string;
  bossSecondaryEmail?: string;
  bossSecondaryCc?: string[];
  resultRoutingEnabled?: boolean;
  resultRoutingPolicyFile?: string;
  secondaryEmail?: string;
  secondaryCc?: string[];
  bossCaptureSettingsSnapshot?: BossCaptureSettingsSnapshot;
  bossCaptureTaskSnapshot?: BossCaptureTaskSnapshot;
  searchSource: SearchSource;
  searchSourceExplicit: boolean;
  applicationFilterInputFilePath?: string;
  searchConditionSetRef?: SearchConditionSetReference;
}
