import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  executeBossChatOperation,
  readBossConversationList,
  readBossVisibleMessages,
} from '../platforms/boss-operations.js';
import type { BossChatOperationInput, BossChatOperationResult } from '../types/boss.js';

describe('Boss atomic chat operations', () => {
  let tempDir = '';
  const originalDataDir = config.dataDir;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-boss-operations-'));
    (config as { dataDir: string }).dataDir = tempDir;
  });

  after(async () => {
    (config as { dataDir: string }).dataDir = originalDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('extracts exact conversation, candidate, and Boss job IDs', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="user-list">
          <div class="geek-item" data-id="conversation-1" data-job-id="job-9">
            <span class="figure"><span class="badge-count">2</span></span>
            <span class="geek-name">候选人甲</span><span class="source-job">物业电工</span>
          </div>
        </div>
        <div class="chat-message-list">
          <div class="message-item" data-message-id="m1"><span class="text-content">您好</span></div>
          <div class="message-item item-myself" data-message-id="m2"><span class="text-content">您好，请发简历</span></div>
        </div>
      `);
      assert.deepStrictEqual(await readBossConversationList(page), [{
        conversationId: 'conversation-1',
        candidateId: undefined,
        candidateName: '候选人甲',
        jobName: '物业电工',
        bossJobId: 'job-9',
        unreadCount: 2,
        hasUnreadBadge: true,
      }]);
      const messages = await readBossVisibleMessages(page);
      assert.deepStrictEqual(messages.map(({ messageId, sender, content }) => ({ messageId, sender, content })), [
        { messageId: 'm1', sender: 'candidate', content: '您好' },
        { messageId: 'm2', sender: 'recruiter', content: '您好，请发简历' },
      ]);
    } finally {
      await browser.close();
    }
  });

  it('requires confirmation and an idempotency intent for mutations', async () => {
    await assert.rejects(() => executeBossChatOperation({} as never, {
      platform: 'boss',
      action: 'send-text',
      conversationId: 'conversation-1',
      text: '你好',
      intentId: 'intent-1',
    }), /confirmed=true/);
    await assert.rejects(() => executeBossChatOperation({} as never, {
      platform: 'boss',
      action: 'mark-not-fit',
      conversationId: 'conversation-1',
      confirmed: true,
    }), /intentId/);
  });

  it('returns a stored receipt without repeating a live mutation', async () => {
    const input: BossChatOperationInput = {
      platform: 'boss',
      action: 'send-text',
      conversationId: 'conversation-1',
      text: '你好',
      expectedCandidateName: '候选人甲',
      expectedJobName: '物业电工',
      intentId: 'stable-intent',
      confirmed: true,
    };
    const digest = createHash('sha256').update(input.intentId!).digest('hex');
    const receiptPath = path.join(tempDir, 'boss', 'chat-operations', 'runs', `${digest}.json`);
    const result: BossChatOperationResult = {
      platform: 'boss',
      action: 'send-text',
      conversationId: 'conversation-1',
      changed: true,
      completedAt: '2026-07-23T00:00:00.000Z',
      receiptPath,
    };
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, `${JSON.stringify({ input, result })}\n`, 'utf8');
    assert.deepStrictEqual(await executeBossChatOperation({} as never, input), result);
  });
});
