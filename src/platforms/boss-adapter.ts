import type { PlatformAdapter } from './types.js';
import {
  applyBossSearchCondition,
  assertBossAuthenticated,
  bossChatSearchUrl,
  bossLoginUrl,
  closeBossResumeDetail,
  discoverBossSearchFilters,
  estimateBossSearchTimeoutMs,
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
import {
  executeBossSearchConditionPlan,
  openBossSavedSubscriptionSearch,
  saveBossSearchCondition,
} from './boss/actions/subscription-actions.js';
import { parseBossResumeDetail } from './boss/actions/resume-detail-actions.js';
import { parseBossResumeData } from './boss/actions/resume-actions.js';

export {
  closeBossResumeDetail,
} from './boss/actions/search-actions.js';
export {
  BossUnexpectedContactDialogError,
  BossForwardPreConfirmationError,
  BossForwardUncertainError,
  BossResumeDetailCloseError,
  BossResumeIdentityVerificationError,
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
  openSavedSearch: openBossSavedSubscriptionSearch,
  prepareSearchConditionPage: prepareBossSearchConditionPage,
  executeSearchConditionPlan: executeBossSearchConditionPlan,
  discoverSearchFilters: discoverBossSearchFilters,
  estimateSearchTimeoutMs: estimateBossSearchTimeoutMs,
  openDirectSearch: openBossDirectSearch,
  applySearchCondition: applyBossSearchCondition,
  readSearchConditionResultTotal: readBossSearchConditionResultTotal,
  saveSearchCondition: saveBossSearchCondition,
  extractCandidateList: extractBossCandidateList,
  openResumeDetail: openBossResumeDetail,
  afterResumeDetailOpened: runBossPostOpenActions,
  parseResumeDetail: parseBossResumeDetail,
  closeResumeDetail: closeBossResumeDetail,
};
