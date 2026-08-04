import type { BrowserContext, Page } from 'playwright';
import type { SearchFilterCatalog, SearchFilterDiscoveryRunOptions } from '../search/filter-catalog.js';
import type {
  CandidateListItem,
  CandidateResume,
  SavedSearchReference,
  SearchCondition,
  SearchConditionApplyResult,
  SearchConditionPlan,
  SearchConditionPlanExecutionResult,
  SearchConditionSaveResult,
  SearchSortPolicy,
} from '../types/job.js';
import type {
  AdvanceCandidateBatchInput,
  AdvanceCandidateBatchResult,
  CandidateProfileDetailResult,
  CandidateResultBatch,
} from '../types/talent-mapping.js';

export const CORE_PLATFORM_RUN_ORDER = ['51job', 'liepin', 'zhilian'] as const;
// Kept as a compatibility alias for modes whose public `all` contract remains core-platform only.
export const ALL_PLATFORM_RUN_ORDER = CORE_PLATFORM_RUN_ORDER;
export const CAPTURE_PLATFORM_RUN_ORDER = [...CORE_PLATFORM_RUN_ORDER, 'boss'] as const;
export const SUPPORTED_PLATFORMS = CAPTURE_PLATFORM_RUN_ORDER;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
export type BossForwardMode = 'colleague' | 'email';

export interface SearchWaitOptions {
  deadline?: number;
  includeViewedCandidates?: boolean;
  sortPolicy?: SearchSortPolicy;
  /**
   * A caller-owned cancellation signal. Platform actions must stop before the
   * next page mutation when it is aborted; they never create their own signal.
   */
  signal?: AbortSignal;
}

export interface CandidatePostOpenActions {
  liepinForwardContact?: string;
  liepinForwardContactMode?: 'confirm' | 'select-only';
  bossForwardMode?: BossForwardMode;
  bossForwardRecipient?: string;
  bossForwardCcEmails?: string[];
  bossForwardActionMode?: 'confirm' | 'prepare-only';
  /** Internal capture seam: the workflow owns the durable pre-capture outbox. */
  bossForwardTransactionManaged?: boolean;
}

export interface CandidatePostOpenResult {
  candidateShareUrl?: string;
}

export interface CandidateProfileDetailOptions {
  deadline: number;
  cleanupReserveMs?: number;
}

export interface PlatformAdapter {
  platform: SupportedPlatform;
  displayName: string;
  subscribeSearchUrl: string;
  loginUrl: string;
  storageStateFileName: string;
  openLoginPage(page: Page): Promise<void>;
  openAuthenticatedHome(page: Page): Promise<Page>;
  assertAuthenticated(page: Page): Promise<void>;
  openSubscribeSearch(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page>;
  /** Platform-native saved-search selection. Callers pass complete business identity. */
  openSavedSearch?(page: Page, target: SavedSearchReference, options?: SearchWaitOptions): Promise<Page>;
  /**
   * Optional platform-owned estimate for one whole search budget. The caller
   * creates the one absolute deadline shared by search entry and extraction.
   */
  estimateSearchTimeoutMs?(input: {
    source: 'saved' | 'direct';
    conditions: SearchCondition[];
    includeViewedCandidates?: boolean;
  }): number;
  openDirectSearch?(page: Page, keyword: string, conditions: SearchCondition[], options?: SearchWaitOptions): Promise<Page>;
  prepareSearchConditionPage?(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page>;
  /** High-level condition replay for platforms whose controls require one final submit. */
  executeSearchConditionPlan?(
    page: Page,
    plan: SearchConditionPlan,
    options?: SearchWaitOptions,
  ): Promise<SearchConditionPlanExecutionResult>;
  discoverSearchFilters?(page: Page, options: SearchFilterDiscoveryRunOptions): Promise<SearchFilterCatalog>;
  applySearchCondition?(page: Page, condition: SearchCondition): Promise<SearchConditionApplyResult>;
  readSearchConditionResultTotal?(page: Page, options?: SearchWaitOptions): Promise<{
    resultTotal: number;
    resultTotalSource: 'page' | 'api';
  }>;
  saveSearchCondition?(page: Page, savedSearchName: string, options?: SearchWaitOptions): Promise<void | SearchConditionSaveResult>;
  extractCandidateList(page: Page, options?: SearchWaitOptions): Promise<{ candidates: CandidateListItem[] }>;
  openResumeDetail(context: BrowserContext, searchPage: Page, candidate: CandidateListItem, options?: CandidateProfileDetailOptions): Promise<Page>;
  afterResumeDetailOpened?(page: Page, candidate: CandidateListItem, actions: CandidatePostOpenActions, options?: CandidateProfileDetailOptions): Promise<void | CandidatePostOpenResult>;
  parseResumeDetail(page: Page, candidate: CandidateListItem, options?: CandidateProfileDetailOptions): Promise<CandidateResume>;
  closeResumeDetail?(searchPage: Page, detailPage: Page, candidate: CandidateListItem, options?: CandidateProfileDetailOptions): Promise<void>;
  readCurrentCandidateBatch?(page: Page, options: SearchWaitOptions): Promise<CandidateResultBatch>;
  advanceToNextCandidateBatch?(page: Page, input: AdvanceCandidateBatchInput): Promise<AdvanceCandidateBatchResult>;
  readCandidateProfileDetail?(
    context: BrowserContext,
    searchPage: Page,
    candidate: CandidateListItem,
    options: CandidateProfileDetailOptions,
  ): Promise<CandidateProfileDetailResult>;
}
