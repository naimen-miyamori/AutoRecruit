import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  readBossConversationList,
  readBossVisibleMessages,
} from '../platforms/boss/actions/conversation-read-actions.js';
import { sendBossDirectText } from '../platforms/boss/actions/conversation-mutation-actions.js';

describe('Boss conversation actions', () => {
  it('reads stable conversation identity and typed visible messages', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="user-list"><div class="geek-item" data-id="conversation-1" data-job-id="job-9">
          <span class="figure"><span class="badge-count">2</span></span>
          <span class="geek-name">候选人甲</span><span class="source-job">物业电工</span>
        </div></div>
        <div class="chat-message-list">
          <div class="message-item" data-message-id="m1"><span class="text-content">您好</span></div>
          <div class="message-item item-myself" data-message-id="m2"><span class="text-content">请发简历</span></div>
        </div>
      `);
      const conversations = await readBossConversationList(page);
      assert.deepStrictEqual(conversations.map(({ conversationId, bossJobId, unreadCount }) => ({ conversationId, bossJobId, unreadCount })), [
        { conversationId: 'conversation-1', bossJobId: 'job-9', unreadCount: 2 },
      ]);
      assert.deepStrictEqual((await readBossVisibleMessages(page)).map(({ sender, content }) => ({ sender, content })), [
        { sender: 'candidate', content: '您好' },
        { sender: 'recruiter', content: '请发简历' },
      ]);
    } finally {
      await browser.close();
    }
  });

  it('sends direct text sequentially and refuses to overwrite a draft', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalActionMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalActionMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    const originalTypingMin = config.playwright.bossTypingDelayMinMs;
    const originalTypingMax = config.playwright.bossTypingDelayMaxMs;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    config.playwright.bossTypingDelayMinMs = 0;
    config.playwright.bossTypingDelayMaxMs = 0;
    try {
      await page.setContent(`
        <div class="chat-message-list"></div>
        <div class="conversation-editor">
          <div id="boss-chat-editor-input" contenteditable="true" style="width:200px;height:30px"></div>
          <button class="submit" style="width:80px;height:30px">发送</button>
        </div>
        <script>
          document.querySelector('.submit').addEventListener('click', () => {
            const editor = document.querySelector('#boss-chat-editor-input');
            const item = document.createElement('div');
            item.className = 'message-item item-myself';
            item.innerHTML = '<span class="text-content"></span>';
            item.querySelector('.text-content').textContent = editor.innerText;
            document.querySelector('.chat-message-list').appendChild(item);
            editor.innerText = '';
          });
        </script>
      `);
      await sendBossDirectText(page, '你好');
      assert.equal(await page.locator('.text-content').textContent(), '你好');
      await page.locator('#boss-chat-editor-input').evaluate((element) => { element.textContent = '已有草稿'; });
      await assert.rejects(() => sendBossDirectText(page, '新消息'), /existing draft/);
      assert.equal(await page.locator('#boss-chat-editor-input').textContent(), '已有草稿');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalActionMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalActionMax;
      config.playwright.bossTypingDelayMinMs = originalTypingMin;
      config.playwright.bossTypingDelayMaxMs = originalTypingMax;
      await browser.close();
    }
  });
});
