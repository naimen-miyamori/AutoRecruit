import type { PlatformAdapter } from './types.js';
import {
  advanceLiepinToNextCandidateBatch,
  extractLiepinCandidateList,
  getLiepinCandidatePaceDelayMs,
  readLiepinCurrentCandidateBatch,
  waitLiepinCandidatePace,
} from './liepin/actions/candidate-actions.js';
import {
  applyLiepinSearchCondition,
  discoverLiepinSearchFilters,
} from './liepin/actions/filter-actions.js';
import { runLiepinPostOpenActions } from './liepin/actions/forwarding-actions.js';
import {
  assertLiepinAuthenticated,
  liepinAuthenticatedUrl,
  liepinLoginUrl,
  openLiepinAuthenticatedHome,
  openLiepinLoginPage,
} from './liepin/actions/navigation-actions.js';
import {
  isLiepinPublicZhaopinUrl,
  isSafeLiepinResumeUrl,
  openLiepinResumePage,
  parseLiepinResumeDetail,
  readLiepinCandidateProfileDetail,
} from './liepin/actions/resume-actions.js';
import {
  isLiepinSearchUrl,
  inspectExistingLiepinSavedSearch,
  openBoundLiepinSavedSearch,
  openLiepinDirectSearch,
  openLiepinSubscribeSearch,
  prepareLiepinSearchConditionPage,
  readLiepinSearchConditionResultTotal,
  savePreparedLiepinSearchCondition,
} from './liepin/actions/search-actions.js';

export {
  getLiepinCandidatePaceDelayMs,
  isLiepinPublicZhaopinUrl,
  isLiepinSearchUrl,
  isSafeLiepinResumeUrl,
  waitLiepinCandidatePace,
};

export const liepinAdapter: PlatformAdapter = {
  platform: 'liepin',
  displayName: 'Liepin',
  subscribeSearchUrl: liepinAuthenticatedUrl,
  loginUrl: liepinLoginUrl,
  storageStateFileName: 'storage-state.liepin.json',
  openLoginPage: openLiepinLoginPage,
  openAuthenticatedHome: openLiepinAuthenticatedHome,
  assertAuthenticated: assertLiepinAuthenticated,
  openSubscribeSearch: openLiepinSubscribeSearch,
  openBoundSavedSearch: async (page, target, options) => {
    if (!('targetKind' in target) || target.targetKind !== 'core-exact-name-keyword') {
      throw new Error('Liepin requires a core exact-name saved-search target.');
    }
    return openBoundLiepinSavedSearch(page, target, options);
  },
  inspectExistingSavedSearch: inspectExistingLiepinSavedSearch,
  openDirectSearch: openLiepinDirectSearch,
  prepareSearchConditionPage: prepareLiepinSearchConditionPage,
  discoverSearchFilters: discoverLiepinSearchFilters,
  readSearchConditionResultTotal: readLiepinSearchConditionResultTotal,
  applySearchCondition: applyLiepinSearchCondition,
  saveSearchCondition: savePreparedLiepinSearchCondition,
  extractCandidateList: extractLiepinCandidateList,
  readCurrentCandidateBatch: readLiepinCurrentCandidateBatch,
  advanceToNextCandidateBatch: advanceLiepinToNextCandidateBatch,
  openResumeDetail: openLiepinResumePage,
  afterResumeDetailOpened: runLiepinPostOpenActions,
  parseResumeDetail: parseLiepinResumeDetail,
  readCandidateProfileDetail: readLiepinCandidateProfileDetail,
};
