import type { PlatformAdapter } from './types.js';
import {
  advanceZhilianToNextCandidateBatch,
  extractZhilianCandidateList,
  readZhilianCurrentCandidateBatch,
} from './zhilian/actions/candidate-actions.js';
import {
  applyZhilianSearchCondition,
  discoverZhilianStaticSearchFilters,
} from './zhilian/actions/filter-actions.js';
import {
  assertZhilianAuthenticated,
  openZhilianAuthenticatedHome,
  openZhilianLoginPage,
  zhilianAuthenticatedHomeUrl,
  zhilianLoginUrl,
} from './zhilian/actions/navigation-actions.js';
import {
  openZhilianDirectSearch,
  openZhilianSubscribeSearch,
  prepareZhilianSearchConditionPage,
  readZhilianSearchConditionResultTotal,
  savePreparedZhilianSearchCondition,
} from './zhilian/actions/search-actions.js';
import {
  closeZhilianResumeDetail,
  openZhilianResumeDetail,
  parseZhilianResumeDetail,
  readZhilianCandidateProfileDetail,
} from './zhilian/actions/resume-actions.js';
import { estimateZhilianCandidateDetailBudget } from './zhilian/actions/context.js';
import { collectZhilianResumeDeliveryMetadata } from './zhilian/actions/delivery-actions.js';
import { zhilianTestExports } from './zhilian/actions/internal-page-actions.js';

export { zhilianTestExports };

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
