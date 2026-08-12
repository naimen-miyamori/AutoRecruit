import type { PlatformAdapter } from './types.js';
import {
  applyBossSearchCondition,
  discoverBossSearchFilters,
  readBossSearchConditionResultTotal,
} from './boss/actions/filter-actions.js';
import {
  assertBossAuthenticated,
  bossChatSearchUrl,
  bossLoginUrl,
  openBossAuthenticatedHome,
  openBossLoginPage,
} from './boss/actions/navigation-actions.js';
import {
  estimateBossSearchTimeoutMs,
  prepareBossSearchConditionPage,
} from './boss/actions/search-actions.js';
import {
  openBossDirectSearch,
  openBossSubscribeSearch,
} from './boss/actions/search-entry-actions.js';
import { extractBossCandidateList } from './boss/actions/candidate-actions.js';
import { openBossResumeDetail } from './boss/actions/candidate-detail-actions.js';
import {
  closeBossResumeDetail,
  runBossPostOpenActions,
} from './boss/actions/post-open-actions.js';
import {
  executeBossSearchConditionPlan,
  openBossSavedSubscriptionSearch,
  saveBossSearchCondition,
} from './boss/actions/subscription-actions.js';
import { parseBossResumeDetail } from './boss/actions/resume-detail-actions.js';
import { parseBossResumeData } from './boss/actions/resume-actions.js';
import { buildSavedSearchOpenEvidence } from '../search/saved-search-target.js';

export {
  closeBossResumeDetail,
} from './boss/actions/post-open-actions.js';
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
  openBoundSavedSearch: async (page, target, options) => {
    if (!('conditionIdentity' in target)) {
      throw new Error('Boss requires a complete native saved-search reference, not a core target.');
    }
    const searchPage = await bossAdapter.openSavedSearch!(page, target, options);
    return {
      page: searchPage,
      evidence: buildSavedSearchOpenEvidence(target, {
        boundJobKey: options.boundJobKey,
        observedName: target.name,
        observedKeyword: target.expectedKeyword,
        observedConditionFingerprint: target.conditionFingerprint,
      }),
    };
  },
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
