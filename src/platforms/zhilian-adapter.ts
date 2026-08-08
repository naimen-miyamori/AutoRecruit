import type { PlatformAdapter } from './types.js';
import {
  advanceZhilianToNextCandidateBatch,
  extractZhilianCandidateList,
  extractZhilianCandidateIdFromText,
  extractZhilianCardsInPage,
  parseZhilianApiCandidates,
  parseZhilianDomCandidateSnapshots,
  parseZhilianVueCandidateSnapshots,
  readZhilianCurrentCandidateBatch,
} from './zhilian/actions/candidate-actions.js';
import {
  applyZhilianSearchCondition,
  buildZhilianAgePresetLabel,
  discoverZhilianStaticSearchFilters,
  ensureZhilianSearchConditionPanelOpen,
  shouldIgnoreZhilianFilterDiscoveryControl,
  shouldIncludeZhilianFilterDiscoveryControl,
} from './zhilian/actions/filter-actions.js';
import {
  assertZhilianAuthenticated,
  openZhilianAuthenticatedHome,
  openZhilianLoginPage,
  zhilianAuthenticatedHomeUrl,
  zhilianLoginUrl,
} from './zhilian/actions/navigation-actions.js';
import {
  clearZhilianUnviewedFilter,
  hasAppliedZhilianQuickSearchKeyword,
  isZhilianQuickSearchApplied,
  listVisibleZhilianQuickSearchTags,
  openZhilianSubscribeSearch,
  readZhilianSearchConditionResultTotal,
  savePreparedZhilianSearchCondition,
} from './zhilian/actions/search-actions.js';
import {
  openZhilianDirectSearch,
  prepareZhilianDirectSearchConditionPage,
  prepareZhilianSearchConditionPage,
} from './zhilian/actions/search-entry-actions.js';
import {
  closeZhilianResumeDetail,
  openZhilianResumeDetail,
  parseZhilianResumeDetail,
  readZhilianCandidateProfileDetail,
} from './zhilian/actions/resume-actions.js';
import { estimateZhilianCandidateDetailBudget } from './zhilian/actions/context.js';
import { collectZhilianResumeDeliveryMetadata } from './zhilian/actions/delivery-actions.js';

export const zhilianTestExports = {
  parseZhilianApiCandidates,
  extractZhilianCandidateIdFromText,
  extractZhilianCardsInPage,
  parseZhilianDomCandidateSnapshots,
  parseZhilianVueCandidateSnapshots,
  clearZhilianUnviewedFilter,
  hasAppliedZhilianQuickSearchKeyword,
  isZhilianQuickSearchApplied,
  listVisibleZhilianQuickSearchTags,
  prepareZhilianDirectSearchConditionPage,
  prepareZhilianSearchConditionPage,
  readZhilianSearchConditionResultTotal,
  ensureZhilianSearchConditionPanelOpen,
  shouldIncludeZhilianFilterDiscoveryControl,
  shouldIgnoreZhilianFilterDiscoveryControl,
  buildZhilianAgePresetLabel,
};

export const zhilianAdapter: PlatformAdapter = {
  platform: 'zhilian',
  displayName: 'Zhilian',
  subscribeSearchUrl: zhilianAuthenticatedHomeUrl,
  loginUrl: zhilianLoginUrl,
  storageStateFileName: 'storage-state.zhilian.json',
  openLoginPage: openZhilianLoginPage,
  openAuthenticatedHome: openZhilianAuthenticatedHome,
  assertAuthenticated: assertZhilianAuthenticated,
  openSubscribeSearch: openZhilianSubscribeSearch,
  openDirectSearch: openZhilianDirectSearch,
  prepareSearchConditionPage: prepareZhilianSearchConditionPage,
  discoverSearchFilters: discoverZhilianStaticSearchFilters,
  applySearchCondition: applyZhilianSearchCondition,
  readSearchConditionResultTotal: readZhilianSearchConditionResultTotal,
  saveSearchCondition: savePreparedZhilianSearchCondition,
  extractCandidateList: extractZhilianCandidateList,
  estimateCandidateDetailBudget: estimateZhilianCandidateDetailBudget,
  readCurrentCandidateBatch: readZhilianCurrentCandidateBatch,
  advanceToNextCandidateBatch: advanceZhilianToNextCandidateBatch,
  openResumeDetail: openZhilianResumeDetail,
  afterResumeDetailOpened: collectZhilianResumeDeliveryMetadata,
  parseResumeDetail: parseZhilianResumeDetail,
  closeResumeDetail: closeZhilianResumeDetail,
  readCandidateProfileDetail: readZhilianCandidateProfileDetail,
};
