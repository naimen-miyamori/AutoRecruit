import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';

import type { PlatformAdapter } from '../platforms/types.js';
import { runSearchSubscriptionWorkflow } from '../search/search-subscription.js';
import {
  buildSubscriptionManagementEvidence,
  hashSubscriptionMutationValue,
  SubscriptionMutationAttemptStore,
} from '../search/subscription-mutation-store.js';

function adapterWithSave(save: PlatformAdapter['saveSearchCondition']): PlatformAdapter {
  return {
    platform: '51job', displayName: '51job', subscribeSearchUrl: '', loginUrl: '', storageStateFileName: '',
    openLoginPage: async () => undefined,
    openAuthenticatedHome: async (page) => page,
    assertAuthenticated: async () => undefined,
    openSubscribeSearch: async (page) => page,
    prepareSearchConditionPage: async (page) => page,
    readSearchConditionResultTotal: async () => ({ resultTotal: 0, resultTotalSource: 'page' }),
    saveSearchCondition: save,
    extractCandidateList: async () => ({ candidates: [] }),
    openResumeDetail: async (_context: BrowserContext, page: Page) => page,
    parseResumeDetail: async () => ({
      candidateId: 'candidate', regions: [], pr: [], workExperiences: [], projectExperiences: [],
      educationExperiences: [], skill: [], certificates: [],
    }),
  };
}

describe('subscription mutation attempts', () => {
  it('persists dispatching before an ambiguous result and blocks automatic redispatch', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mutation-ambiguous-'));
    const store = new SubscriptionMutationAttemptStore({ dataDir });
    let clicks = 0;
    const adapter = adapterWithSave(async () => {
      clicks += 1;
    });
    const execute = () => runSearchSubscriptionWorkflow(adapter, {} as Page, {
      keyword: '铝镁合金', savedSearchName: '铝镁合金', conditions: [],
    }, { save: true, mutationAttempts: store });

    await assert.rejects(execute, /ambiguous.*Reconcile/i);
    assert.equal(clicks, 1);
    await assert.rejects(execute, /reconcile it before another save attempt/i);
    assert.equal(clicks, 1);
  });

  it('reconciles an ambiguous attempt with exact evidence without another click', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mutation-reconcile-'));
    const store = new SubscriptionMutationAttemptStore({ dataDir });
    const conditionFingerprint = hashSubscriptionMutationValue({ version: 1, keyword: '铝镁合金', conditions: [] });
    let attempt = await store.prepare({
      platform: '51job', savedSearchName: '铝镁合金', expectedKeyword: '铝镁合金', conditionFingerprint,
    });
    attempt = await store.markDispatching(attempt);
    attempt = await store.markAmbiguous(attempt, 'process stopped after click');
    const evidence = buildSubscriptionManagementEvidence({
      platform: '51job', savedSearchName: '铝镁合金', expectedKeyword: '铝镁合金', conditionFingerprint,
      postcondition: 'saved-and-verified', verifiedAt: '2026-08-11T00:00:00.000Z',
    });
    const reconciled = await store.reconcile(attempt.attemptId, evidence);
    assert.equal(reconciled.status, 'confirmed');
    assert.equal(reconciled.evidence?.evidenceHash, evidence.evidenceHash);
  });

  it('creates no attempt for a no-save subscription run', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mutation-readonly-'));
    const store = new SubscriptionMutationAttemptStore({ dataDir });
    let saveCalls = 0;
    const summary = await runSearchSubscriptionWorkflow(adapterWithSave(async () => {
      saveCalls += 1;
    }), {} as Page, { keyword: '铝镁合金', conditions: [] }, { save: false, mutationAttempts: store });
    assert.equal(summary.saved, false);
    assert.equal(saveCalls, 0);
    await assert.rejects(fs.access(path.join(dataDir, 'maintenance', 'subscription-mutations')));
  });
});
