import type { PlatformAdapter } from './types.js';
import {
  applyBossSearchCondition,
  assertBossAuthenticated,
  bossChatSearchUrl,
  bossLoginUrl,
  closeBossResumeDetail,
  discoverBossSearchFilters,
  extractBossCandidateList,
  openBossAuthenticatedHome,
  openBossDirectSearch,
  openBossLoginPage,
  openBossResumeDetail,
  openBossSubscribeSearch,
  prepareBossSearchConditionPage,
  readBossSearchConditionResultTotal,
  runBossPostOpenActions,
} from './boss/actions/search-actions.js';
import { parseBossResumeDetail } from './boss/actions/resume-detail-actions.js';
import { parseBossResumeData } from './boss/actions/resume-actions.js';

export {
  closeBossResumeDetail,
} from './boss/actions/search-actions.js';
export {
  closeExistingBossResumeDialog,
  forwardBossResume,
  parseBossResumeDetail,
  waitForBossResumeDetailReady,
} from './boss/actions/resume-detail-actions.js';
export { parseBossResumeData };

export const bossAdapter: PlatformAdapter = {
  platform: 'boss',
  displayName: 'Boss',
  subscribeSearchUrl: bossChatSearchUrl,
  loginUrl: bossLoginUrl,
  storageStateFileName: 'storage-state.boss.json',
  openLoginPage: openBossLoginPage,
  openAuthenticatedHome: openBossAuthenticatedHome,
  assertAuthenticated: assertBossAuthenticated,
  openSubscribeSearch: openBossSubscribeSearch,
  prepareSearchConditionPage: prepareBossSearchConditionPage,
  discoverSearchFilters: discoverBossSearchFilters,
  openDirectSearch: openBossDirectSearch,
  applySearchCondition: applyBossSearchCondition,
  readSearchConditionResultTotal: readBossSearchConditionResultTotal,
  extractCandidateList: extractBossCandidateList,
  openResumeDetail: openBossResumeDetail,
  afterResumeDetailOpened: runBossPostOpenActions,
  parseResumeDetail: parseBossResumeDetail,
  closeResumeDetail: closeBossResumeDetail,
};
