import type { PlatformAdapter } from './types.js';
import {
  extractLiepinCandidateList,
  getLiepinCandidatePaceDelayMs,
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
} from './liepin/actions/resume-actions.js';
import {
  isLiepinSearchUrl,
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
  openDirectSearch: openLiepinDirectSearch,
  prepareSearchConditionPage: prepareLiepinSearchConditionPage,
  discoverSearchFilters: discoverLiepinSearchFilters,
  readSearchConditionResultTotal: readLiepinSearchConditionResultTotal,
  applySearchCondition: applyLiepinSearchCondition,
  saveSearchCondition: savePreparedLiepinSearchCondition,
  extractCandidateList: extractLiepinCandidateList,
  openResumeDetail: openLiepinResumePage,
  afterResumeDetailOpened: runLiepinPostOpenActions,
  parseResumeDetail: parseLiepinResumeDetail,
};
