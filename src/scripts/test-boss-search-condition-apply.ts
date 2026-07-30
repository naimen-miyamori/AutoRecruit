import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BrowserSession } from '../browser/session.js';
import type { SearchCondition } from '../types/job.js';
import {
  acquireBossSearchConditionSetApplyLock,
  applyBossDirectSearchRef,
  applyBossSearchConditionSetWorkflow,
  BossSearchConditionSetApplyError,
  closeBrowserSessionRef,
  ensureAuthenticatedBrowserSessionRef,
  resetBossSearchFiltersRef,
} from '../platforms/boss/search-condition-set-apply.js';
import { estimateBossDirectSearchTimeoutMs } from '../platforms/boss/actions/search-actions.js';
import { parseArgs } from './apply-boss-search-condition-set.js';

const originalEnsureSession = ensureAuthenticatedBrowserSessionRef.fn;
const originalCloseSession = closeBrowserSessionRef.fn;
const originalApplyDirect = applyBossDirectSearchRef.fn;
const originalReset = resetBossSearchFiltersRef.fn;

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-condition-apply-'));
});

afterEach(async () => {
  ensureAuthenticatedBrowserSessionRef.fn = originalEnsureSession;
  closeBrowserSessionRef.fn = originalCloseSession;
  applyBossDirectSearchRef.fn = originalApplyDirect;
  resetBossSearchFiltersRef.fn = originalReset;
  await fs.rm(tempDir, { recursive: true, force: true });
});

const reference = {
  conditionSetId: 'scs-boss-condition-apply-test',
  platform: 'boss' as const,
  revision: 1,
};

const educationCondition: SearchCondition = {
  kind: 'applicationFilter',
  fieldId: 'education',
  label: '学历要求',
  fieldKind: 'singleSelect',
  value: '本科及以上',
};

function resolvedConditionSet(input: {
  conditions?: SearchCondition[];
  defaultKeyword?: string;
} = {}) {
  const conditions = input.conditions ?? [educationCondition];
  return {
    reference,
    revision: {
      ...reference,
      schemaVersion: 1,
      name: 'Boss 条件集测试',
      defaultKeyword: input.defaultKeyword ?? '铝',
      applicationFilterInput: { education: '本科及以上' },
      compiledConditions: conditions,
      catalogEvidence: { capturedAt: '2026-07-30T00:00:00.000Z', selectedFieldsFingerprint: 'test' },
      status: 'active',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    },
    applicationFilterInput: { education: '本科及以上' },
    conditions,
    catalogEvidence: { capturedAt: '2026-07-30T00:00:00.000Z', selectedFieldsFingerprint: 'test' },
    catalogChanged: false,
  } as const;
}

function installSuccessfulRun(options: { verified?: boolean } = {}): {
  directCalls: Array<{ keyword: string; conditions: SearchCondition[]; includeViewedCandidates?: boolean }>;
  getCloseCount: () => number;
} {
  const directCalls: Array<{ keyword: string; conditions: SearchCondition[]; includeViewedCandidates?: boolean }> = [];
  let closeCount = 0;
  const session = { page: {} } as BrowserSession;
  ensureAuthenticatedBrowserSessionRef.fn = async () => session;
  closeBrowserSessionRef.fn = async () => {
    closeCount += 1;
  };
  applyBossDirectSearchRef.fn = async (_page, keyword, conditions, searchOptions) => {
    directCalls.push({ keyword, conditions, includeViewedCandidates: searchOptions?.includeViewedCandidates });
    return {
      page: {} as never,
      verification: {
        keyword,
        conditions: [
          { fieldId: 'keyword', expected: keyword, actual: keyword, verified: options.verified ?? true, evidence: 'keyword-input' as const },
          { fieldId: 'education', expected: '本科及以上', actual: '本科及以上', verified: true, evidence: 'selected-option' as const },
        ],
        conditionsVerified: options.verified === false ? 1 : 2,
        resultTotal: 15,
        resultTotalSource: 'page' as const,
      },
    };
  };
  return { directCalls, getCloseCount: () => closeCount };
}

describe('Boss search-condition-set apply workflow', () => {
  it('uses a fixed revision/default keyword, verifies once, and leaves no capture side effect', async () => {
    const run = installSuccessfulRun();
    let resolveCalls = 0;
    const summary = await applyBossSearchConditionSetWorkflow({
      reference,
      service: {
        resolve: async () => {
          resolveCalls += 1;
          return resolvedConditionSet();
        },
      },
      lockFilePath: path.join(tempDir, 'apply.lock'),
    });

    assert.equal(resolveCalls, 1);
    assert.equal(run.directCalls.length, 1);
    assert.deepEqual(run.directCalls[0], {
      keyword: '铝', conditions: [educationCondition], includeViewedCandidates: false,
    });
    assert.equal(summary.status, 'applied');
    assert.equal(summary.conditionSet, `${reference.conditionSetId}@1`);
    assert.equal(summary.conditionsVerified, 1);
    assert.equal(summary.resultTotal, 15);
    assert.equal(run.getCloseCount(), 1);
    await assert.rejects(fs.access(path.join(tempDir, 'apply.lock')));
  });

  it('rejects a conflicting viewed policy before opening a browser', async () => {
    let sessionCalls = 0;
    ensureAuthenticatedBrowserSessionRef.fn = async () => {
      sessionCalls += 1;
      return { page: {} } as BrowserSession;
    };
    await assert.rejects(
      () => applyBossSearchConditionSetWorkflow({
        reference,
        service: {
          resolve: async () => resolvedConditionSet({
            conditions: [{
              kind: 'applicationFilter', fieldId: 'filter_recent_viewed', label: '过滤近14天查看', fieldKind: 'toggle', value: false,
            }],
          }),
        },
        lockFilePath: path.join(tempDir, 'apply.lock'),
      }),
      (error: unknown) => error instanceof BossSearchConditionSetApplyError
        && error.phase === 'resolve'
        && /conflicts with recent-viewed-policy exclude/.test(error.message),
    );
    assert.equal(sessionCalls, 0);
  });

  it('reports verify failure and resets the page with the remaining deadline', async () => {
    installSuccessfulRun({ verified: false });
    let resetCalls = 0;
    resetBossSearchFiltersRef.fn = async () => {
      resetCalls += 1;
    };
    await assert.rejects(
      () => applyBossSearchConditionSetWorkflow({
        reference,
        service: { resolve: async () => resolvedConditionSet() },
        lockFilePath: path.join(tempDir, 'apply.lock'),
      }),
      (error: unknown) => error instanceof BossSearchConditionSetApplyError
        && error.phase === 'verify'
        && error.recoveredBaseline
        && !error.partialStatePossible,
    );
    assert.equal(resetCalls, 1);
    await assert.rejects(fs.access(path.join(tempDir, 'apply.lock')));
  });

  it('honors an already-aborted signal before resolving or acquiring a lock', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    let resolveCalls = 0;
    await assert.rejects(
      () => applyBossSearchConditionSetWorkflow({
        reference,
        signal: controller.signal,
        service: { resolve: async () => { resolveCalls += 1; return resolvedConditionSet(); } },
        lockFilePath: path.join(tempDir, 'apply.lock'),
      }),
      (error: unknown) => error instanceof BossSearchConditionSetApplyError && error.phase === 'resolve',
    );
    assert.equal(resolveCalls, 0);
    await assert.rejects(fs.access(path.join(tempDir, 'apply.lock')));
  });

  it('rejects a second live run and releases the token-owned lock', async () => {
    const filePath = path.join(tempDir, 'apply.lock');
    const first = await acquireBossSearchConditionSetApplyLock(filePath);
    await assert.rejects(
      () => acquireBossSearchConditionSetApplyLock(filePath),
      /already active/,
    );
    await first.release();
    const next = await acquireBossSearchConditionSetApplyLock(filePath);
    await next.release();
    await assert.rejects(fs.access(filePath));
  });

  it('parses only the Boss apply-only arguments and computes a bounded direct budget', () => {
    assert.deepEqual(parseArgs([
      '--condition-set', 'scs-boss-condition-apply-test@1', '--keyword', ' 铝 ', '--recent-viewed-policy', 'include',
    ]), {
      reference,
      keyword: '铝',
      recentViewedPolicy: 'include',
    });
    assert.throws(() => parseArgs(['--condition-set', 'scs-boss-condition-apply-test@1', '--include-viewed', 'true']), /Unsupported/);
    const timeout = estimateBossDirectSearchTimeoutMs({
      conditions: [educationCondition, educationCondition, educationCondition, educationCondition, educationCondition],
      includeViewedCandidates: false,
    });
    assert.ok(timeout > 30_000);
    assert.ok(timeout <= 120_000);
  });
});
