import type { PlatformAdapter } from './types.js';
import {
  advance51jobToNextCandidateBatch,
  extract51jobCandidateList,
  read51jobCurrentCandidateBatch,
} from './51job/actions/candidate-actions.js';
import {
  apply51jobSearchCondition,
  discover51jobSearchFilters,
} from './51job/actions/filter-actions.js';
import {
  assert51jobAuthenticated,
  fiftyOneJobLoginUrl,
  fiftyOneJobSubscribeSearchUrl,
  open51jobAuthenticatedHome,
  open51jobLoginPage,
} from './51job/actions/navigation-actions.js';
import {
  estimate51jobSearchTimeoutMs,
  openBound51jobSavedSearch,
  open51jobDirectSearch,
  open51jobSubscribeSearch,
  prepare51jobSearchCondition,
  read51jobSearchConditionResultTotal,
  savePrepared51jobSearchCondition,
} from './51job/actions/search-actions.js';
import {
  open51jobResumeDetail,
  parse51jobResumeDetail,
  read51jobCandidateProfileDetail,
} from './51job/actions/resume-actions.js';

export const fiftyOneJobAdapter: PlatformAdapter = {
  platform: '51job',
  displayName: '51job',
  subscribeSearchUrl: fiftyOneJobSubscribeSearchUrl,
  loginUrl: fiftyOneJobLoginUrl,
  storageStateFileName: 'storage-state.json',
  openLoginPage: open51jobLoginPage,
  openAuthenticatedHome: open51jobAuthenticatedHome,
  assertAuthenticated: assert51jobAuthenticated,
  openSubscribeSearch: open51jobSubscribeSearch,
  openBoundSavedSearch: openBound51jobSavedSearch,
  estimateSearchTimeoutMs: estimate51jobSearchTimeoutMs,
  openDirectSearch: open51jobDirectSearch,
  prepareSearchConditionPage: prepare51jobSearchCondition,
  discoverSearchFilters: discover51jobSearchFilters,
  applySearchCondition: apply51jobSearchCondition,
  readSearchConditionResultTotal: read51jobSearchConditionResultTotal,
  saveSearchCondition: savePrepared51jobSearchCondition,
  extractCandidateList: extract51jobCandidateList,
  readCurrentCandidateBatch: read51jobCurrentCandidateBatch,
  advanceToNextCandidateBatch: advance51jobToNextCandidateBatch,
  openResumeDetail: open51jobResumeDetail,
  parseResumeDetail: parse51jobResumeDetail,
  readCandidateProfileDetail: read51jobCandidateProfileDetail,
};
