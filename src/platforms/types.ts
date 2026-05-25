import type { BrowserContext, Page } from 'playwright';
import type { CandidateListItem, CandidateResume } from '../types/job.js';

export const SUPPORTED_PLATFORMS = ['51job', 'liepin', 'zhilian'] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface SearchWaitOptions {
  deadline?: number;
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
  extractCandidateList(page: Page, options?: SearchWaitOptions): Promise<{ candidates: CandidateListItem[] }>;
  openResumeDetail(context: BrowserContext, searchPage: Page, candidate: CandidateListItem): Promise<Page>;
  parseResumeDetail(page: Page, candidate: CandidateListItem): Promise<CandidateResume>;
}
