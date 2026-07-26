import type { PlatformAdapter } from './types.js';
import { extract51jobCandidateList } from './51job/actions/candidate-actions.js';
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
  open51jobDirectSearch,
  open51jobSubscribeSearch,
  prepare51jobSearchCondition,
  read51jobSearchConditionResultTotal,
  savePrepared51jobSearchCondition,
} from './51job/actions/search-actions.js';
import {
  open51jobResumeDetail,
  parse51jobResumeDetail,
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
  openDirectSearch: open51jobDirectSearch,
  prepareSearchConditionPage: prepare51jobSearchCondition,
  discoverSearchFilters: discover51jobSearchFilters,
  applySearchCondition: apply51jobSearchCondition,
  readSearchConditionResultTotal: read51jobSearchConditionResultTotal,
  saveSearchCondition: savePrepared51jobSearchCondition,
  extractCandidateList: extract51jobCandidateList,
  openResumeDetail: open51jobResumeDetail,
  parseResumeDetail: parse51jobResumeDetail,
};
