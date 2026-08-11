import type { BrowserSession } from '../browser/session.js';
import type { PlatformAdapter } from '../platforms/types.js';
import type { JobStore } from '../storage/job-store.js';
import type { SavedSearchReference } from '../types/job.js';
import type { BossSavedSearchBindingCliInput } from './types.js';

export interface BossSavedSearchBindingSummary {
  mode: 'boss-saved-search-binding';
  platform: 'boss';
  jobKey: string;
  savedSearch: SavedSearchReference;
  previousRevision: number;
  revision: number;
  verifiedAt: string;
  candidateSideEffects: false;
}

export interface BossSavedSearchBindingRunnerDependencies {
  createStore: () => JobStore;
  buildJobKey: (keyword: string, suffix: string) => string;
  buildSyncedJobKey: (jobName: string, bossJobId: string) => string;
  resolveAdapter: () => PlatformAdapter;
  searchPageTimeoutMs: number;
  acquireSearchLease: () => Promise<{ release: () => Promise<void> }>;
  openSession: () => Promise<BrowserSession>;
  closeSession: (session: BrowserSession) => Promise<void>;
  now: () => Date;
  report: (summary: BossSavedSearchBindingSummary) => void;
}

export async function runBossSavedSearchBindingMode(
  input: BossSavedSearchBindingCliInput,
  dependencies: BossSavedSearchBindingRunnerDependencies,
): Promise<BossSavedSearchBindingSummary> {
  const jobKey = input.bossJobId
    ? dependencies.buildSyncedJobKey(input.searchKeyword, input.bossJobId)
    : dependencies.buildJobKey(input.searchKeyword, '');
  const store = dependencies.createStore();
  const existing = await store.readJobRecordIfExists('boss', jobKey);
  if (!existing) throw new Error(`Boss saved-search binding requires an existing job record for ${jobKey}`);
  if (existing.platform !== 'boss') {
    throw new Error(`Boss saved-search binding found ${existing.platform}/${jobKey}, not a Boss job record`);
  }
  if (existing.searchKeyword !== input.searchKeyword) {
    throw new Error(`Boss saved-search binding job name ${input.searchKeyword} does not match persisted job ${existing.searchKeyword}`);
  }
  if (input.savedSearch.conditionIdentity.jobScope !== existing.searchKeyword) {
    throw new Error(`Boss saved-search binding reference job scope ${input.savedSearch.conditionIdentity.jobScope} does not match ${existing.searchKeyword}`);
  }

  const adapter = dependencies.resolveAdapter();
  if (!adapter.openSavedSearch) {
    throw new Error('Boss saved-search binding is unavailable because the native saved-search action is not registered');
  }
  const estimatedTimeoutMs = adapter.estimateSearchTimeoutMs?.({
    source: 'saved',
    conditions: [],
    includeViewedCandidates: false,
  });
  const deadline = Date.now() + Math.max(
    dependencies.searchPageTimeoutMs,
    typeof estimatedTimeoutMs === 'number' && Number.isFinite(estimatedTimeoutMs)
      ? Math.max(1, estimatedTimeoutMs)
      : 0,
  );
  let lease: { release: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  try {
    session = await dependencies.openSession();
    lease = await dependencies.acquireSearchLease();
    await adapter.openSavedSearch(session.page, input.savedSearch, {
      deadline,
      includeViewedCandidates: false,
      sortPolicy: 'match-priority',
    });
    const previousRevision = existing.revision ?? 1;
    const updated = await store.applyJobConfigPatch('boss', jobKey, previousRevision, {
      searchSource: 'saved',
      pageKeyword: input.savedSearch.expectedKeyword,
      conditions: [],
      applicationFilterInput: null,
      conditionSetRef: null,
      selectedFieldsFingerprint: null,
      savedSearch: input.savedSearch,
    });
    const summary: BossSavedSearchBindingSummary = {
      mode: 'boss-saved-search-binding',
      platform: 'boss',
      jobKey,
      savedSearch: input.savedSearch,
      previousRevision,
      revision: updated.revision ?? previousRevision + 1,
      verifiedAt: dependencies.now().toISOString(),
      candidateSideEffects: false,
    };
    dependencies.report(summary);
    return summary;
  } finally {
    try {
      await lease?.release();
    } finally {
      if (session) await dependencies.closeSession(session);
    }
  }
}
