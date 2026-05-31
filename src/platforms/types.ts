import type { BrowserContext, Page } from 'playwright';
import type { CandidateListItem, CandidateResume, SearchCondition, SearchConditionApplyResult } from '../types/job.js';

export const SUPPORTED_PLATFORMS = ['51job', 'liepin', 'zhilian'] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface SearchWaitOptions {
  deadline?: number;
  includeViewedCandidates?: boolean;
}

export interface CandidatePostOpenActions {
  liepinForwardContact?: string;
  liepinForwardContactMode?: 'confirm' | 'select-only';
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
  prepareSearchConditionPage?(page: Page, keyword: string, options?: SearchWaitOptions): Promise<Page>;
  applySearchCondition?(page: Page, condition: SearchCondition): Promise<SearchConditionApplyResult>;
  readSearchConditionResultTotal?(page: Page, options?: SearchWaitOptions): Promise<{
    resultTotal: number;
    resultTotalSource: 'page' | 'api';
  }>;
  saveSearchCondition?(page: Page, savedSearchName: string, options?: SearchWaitOptions): Promise<void>;
  extractCandidateList(page: Page, options?: SearchWaitOptions): Promise<{ candidates: CandidateListItem[] }>;
  openResumeDetail(context: BrowserContext, searchPage: Page, candidate: CandidateListItem): Promise<Page>;
  afterResumeDetailOpened?(page: Page, candidate: CandidateListItem, actions: CandidatePostOpenActions): Promise<void>;
  parseResumeDetail(page: Page, candidate: CandidateListItem): Promise<CandidateResume>;
}
