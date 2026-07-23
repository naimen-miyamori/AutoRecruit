import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { BossChatOperationResult, BossGreetResult, BossJobSyncRun, BossTalentSearchResult } from '../types/boss.js';
import * as indexModule from '../index.js';

const originalEnsureSession = indexModule.ensureAuthenticatedBrowserSessionRef.fn;
const originalCloseSession = indexModule.closeBrowserSessionRef.fn;
const originalTalentSearch = indexModule.runBossTalentSearchRef.fn;
const originalGreet = indexModule.greetBossTalentCandidateRef.fn;
const originalChatOperation = indexModule.executeBossChatOperationRef.fn;
const originalJobSync = indexModule.syncBossPositionsRef.fn;

function mockSession(): void {
  indexModule.ensureAuthenticatedBrowserSessionRef.fn = async () => ({ page: {} } as never);
  indexModule.closeBrowserSessionRef.fn = async () => undefined;
}

afterEach(() => {
  indexModule.ensureAuthenticatedBrowserSessionRef.fn = originalEnsureSession;
  indexModule.closeBrowserSessionRef.fn = originalCloseSession;
  indexModule.runBossTalentSearchRef.fn = originalTalentSearch;
  indexModule.greetBossTalentCandidateRef.fn = originalGreet;
  indexModule.executeBossChatOperationRef.fn = originalChatOperation;
  indexModule.syncBossPositionsRef.fn = originalJobSync;
});

describe('Boss standalone CLI modes', () => {
  it('passes deep-search requirements through without triggering match by default', async () => {
    mockSession();
    let captured: unknown;
    const output: BossTalentSearchResult = {
      platform: 'boss', source: 'deep-search', matched: false, candidates: [],
    };
    indexModule.runBossTalentSearchRef.fn = async (_page, input) => {
      captured = input;
      return output;
    };
    assert.equal(await indexModule.main([
      '--platform', 'boss',
      '--boss-talent-source', 'deep-search',
      '--boss-job-id', 'job-1',
      '--boss-expected-job-name', '物业电工',
      '--boss-core-requirements-json', '["高低压证"]',
    ]), output);
    assert.deepStrictEqual(captured, {
      mode: 'boss-talent-search', platform: 'boss', source: 'deep-search', bossJobId: 'job-1',
      expectedJobName: '物业电工', coreRequirements: ['高低压证'], bonusRequirements: undefined,
      triggerMatch: false, confirmed: false,
    });
  });

  it('parses guarded greet and atomic chat mutations', async () => {
    mockSession();
    let greetInput: unknown;
    const greetOutput: BossGreetResult = {
      platform: 'boss', candidateId: 'candidate-1', jobName: '物业电工', source: 'recommend',
      greeted: true, alreadyContacted: false, completedAt: '2026-07-23T00:00:00.000Z',
    };
    indexModule.greetBossTalentCandidateRef.fn = async (_page, input) => {
      greetInput = input;
      return greetOutput;
    };
    await indexModule.main([
      '--platform', 'boss', '--boss-greet-source', 'recommend',
      '--boss-greet-candidate-id', 'candidate-1', '--boss-expected-candidate-name', '候选人甲',
      '--boss-expected-job-name', '物业电工', '--boss-confirmed', 'true',
    ]);
    assert.equal((greetInput as { confirmed: boolean }).confirmed, true);

    let operationInput: unknown;
    const operationOutput: BossChatOperationResult = {
      platform: 'boss', action: 'send-text', conversationId: 'conversation-1',
      changed: true, completedAt: '2026-07-23T00:00:00.000Z',
    };
    indexModule.executeBossChatOperationRef.fn = async (_page, input) => {
      operationInput = input;
      return operationOutput;
    };
    await indexModule.main([
      '--platform', 'boss', '--boss-chat-operation', 'send-text',
      '--boss-conversation-id', 'conversation-1', '--boss-chat-text', '你好',
      '--boss-intent-id', 'intent-1', '--boss-confirmed', 'true',
    ]);
    assert.deepStrictEqual(operationInput, {
      mode: 'boss-chat-operation', platform: 'boss', action: 'send-text',
      conversationId: 'conversation-1', expectedCandidateName: undefined, expectedJobName: undefined,
      text: '你好', remark: undefined, intentId: 'intent-1', unreadOnly: false, confirmed: true,
    });
  });

  it('parses a schedulable Boss job sync without adding Boss to platform all', async () => {
    mockSession();
    let syncInput: unknown;
    const output: BossJobSyncRun = {
      platform: 'boss', syncedAt: '2026-07-23T00:00:00.000Z', positions: [], items: [],
      created: 0, updated: 0, unchanged: 0, failed: 0,
    };
    indexModule.syncBossPositionsRef.fn = async (_page, input) => {
      syncInput = input;
      return output;
    };
    await indexModule.main([
      '--platform', 'boss', '--boss-job-sync', 'true', '--boss-job-ids', 'job-1,job-2',
      '--boss-include-closed-jobs', 'false',
    ]);
    assert.deepStrictEqual(syncInput, {
      mode: 'boss-job-sync', platform: 'boss', bossJobIds: ['job-1', 'job-2'], includeClosed: false,
    });
    await assert.rejects(() => indexModule.main([
      '--platform', 'all', '--boss-job-sync', 'true',
    ]), /only be used with --platform boss/);
  });
});
