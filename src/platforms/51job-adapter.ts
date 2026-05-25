import { collectCandidateList } from '../browser/candidate-list.js';
import { openSubscribeSearch } from '../browser/subscribe-search.js';
import { openResumeDetail, parseResumeDetail } from '../browser/resume-detail.js';
import type { PlatformAdapter } from './types.js';
import { assertAuthenticatedPage } from '../browser/subscribe-search.js';

export const fiftyOneJobAdapter: PlatformAdapter = {
  platform: '51job',
  displayName: '51job',
  subscribeSearchUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
  loginUrl: 'https://ehire.51job.com/Revision/talent/subscribe',
  storageStateFileName: 'storage-state.json',
  openLoginPage: async (page) => {
    await page.goto('https://ehire.51job.com/Revision/talent/subscribe', { waitUntil: 'domcontentloaded' });
  },
  openAuthenticatedHome: async (page) => {
    await page.goto('https://ehire.51job.com/Revision/talent/subscribe', { waitUntil: 'domcontentloaded' });
    await assertAuthenticatedPage(page);
    return page;
  },
  assertAuthenticated: assertAuthenticatedPage,
  openSubscribeSearch,
  extractCandidateList: async (page, options) => ({ candidates: await collectCandidateList(page, options) }),
  openResumeDetail,
  parseResumeDetail: async (page, candidate) => (await parseResumeDetail(page, candidate)).resume,
};
