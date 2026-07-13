import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import {
  bossQualifiedCandidateChatMessage,
  bossUnqualifiedCandidateChatMessage,
  collectBossUnreadConversations,
  contactBossQualifiedCandidate,
  contactBossUnqualifiedCandidate,
  parseBossChatResumeSnapshot,
} from '../platforms/boss-chat.js';
import { evaluatePropertyElectricianHardRequirements } from '../scoring/boss-chat-hard-requirements.js';
import { renderBossChatSummaryMarkdown } from '../reporting/boss-chat-summary.js';
import type { BossChatReviewRun, CandidateResume } from '../types/job.js';

describe('Boss auto-chat resume parsing', () => {
  it('recovers a failed visible conversation after its unread badge disappears', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="user-list">
          <div class="geek-item" data-id="conversation-failed">
            <div class="figure"></div>
            <span class="geek-name">候选人甲</span>
            <span class="source-job">物业电工</span>
          </div>
          <div class="geek-item" data-id="conversation-read">
            <div class="figure"></div>
            <span class="geek-name">候选人乙</span>
            <span class="source-job">物业电工</span>
          </div>
        </div>
      `);

      const conversations = await collectBossUnreadConversations(page, [{
        conversationId: 'conversation-failed',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 2,
      }]);

      assert.deepStrictEqual(conversations, [{
        conversationId: 'conversation-failed',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 2,
      }]);
    } finally {
      await browser.close();
    }
  });

  it('maps the current conversation summary into the shared resume contract', () => {
    const resume = parseBossChatResumeSnapshot({
      conversationId: '675451673-0',
      candidateId: 'encrypted-expect-id',
      candidateName: '候选人甲',
      jobName: '物业电工',
      ageDesc: '48岁',
      education: '高中',
      city: '上海',
      currentCompany: '示例物业',
      currentTitle: '综合维修工',
      workExperiences: [{
        timeDesc: '2019.11-2022.10',
        company: '示例物业',
        positionName: '综合维修工',
      }],
      educationExperiences: [{
        timeDesc: '1995-1998',
        school: '示例中学',
        degree: '高中',
      }],
    }, 'https://www.zhipin.com/web/chat/index');

    assert.equal(resume.candidateId, 'encrypted-expect-id');
    assert.equal(resume.name, '候选人甲');
    assert.equal(resume.age, 48);
    assert.equal(resume.education, '高中');
    assert.deepStrictEqual(resume.regions, ['上海']);
    assert.deepStrictEqual(resume.workExperiences[0], {
      company: '示例物业',
      title: '综合维修工',
      start: '2019.11',
      end: '2022.10',
      details: [],
    });
    assert.deepStrictEqual(resume.educationExperiences[0], {
      school: '示例中学',
      degree: '高中',
      major: undefined,
      start: '1995',
      end: '1998',
      details: [],
    });
  });

  it('uses current company and title when the conversation has no work list', () => {
    const resume = parseBossChatResumeSnapshot({
      conversationId: 'conversation-id',
      candidateId: 'candidate-id',
      jobName: '物业电工',
      currentCompany: '示例工程',
      currentTitle: '电工',
      workExperiences: [],
      educationExperiences: [],
    }, 'https://www.zhipin.com/web/chat/index');

    assert.deepStrictEqual(resume.workExperiences, [{
      company: '示例工程',
      title: '电工',
      details: [],
    }]);
  });
});

describe('Boss candidate contact actions', () => {
  it('sends matched and unmatched common phrases and requests phone only for matched candidates', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="chat-message-list"></div>
        <div class="toolbar-box-left">
          <div class="operate-icon-item" id="phrase-trigger" style="width:32px;height:32px">
            <div class="toolbar-icon changyongyu" style="width:24px;height:24px">常</div>
            <div class="phrase-content" style="display:none;width:700px;height:80px">
              <ul>
                <li style="display:block;width:680px;height:30px" title="${bossQualifiedCandidateChatMessage}">${bossQualifiedCandidateChatMessage}<span class="phrase-send">发送</span></li>
                <li style="display:block;width:680px;height:30px" title="${bossUnqualifiedCandidateChatMessage}">${bossUnqualifiedCandidateChatMessage}<span class="phrase-send">发送</span></li>
              </ul>
            </div>
          </div>
        </div>
        <div class="conversation-editor">
          <div id="boss-chat-editor-input" contenteditable="true"></div>
          <div class="submit">发送</div>
        </div>
        <div class="operate-exchange-left">
          <div class="operate-icon-item" id="phone-item">
            <span class="operate-btn disabled">换电话</span>
            <div class="exchange-tooltip" style="display:none">
              <span class="boss-btn-primary">确定</span>
            </div>
          </div>
        </div>
      `);
      await page.evaluate(() => {
        const messageList = document.querySelector('.chat-message-list')!;
        const editor = document.querySelector<HTMLElement>('#boss-chat-editor-input')!;
        const submit = document.querySelector<HTMLElement>('.submit')!;
        const phraseTrigger = document.querySelector<HTMLElement>('#phrase-trigger')!;
        const phraseContent = phraseTrigger.querySelector<HTMLElement>('.phrase-content')!;
        const phoneItem = document.querySelector<HTMLElement>('#phone-item')!;
        const phoneButton = phoneItem.querySelector<HTMLElement>('.operate-btn')!;
        const tooltip = phoneItem.querySelector<HTMLElement>('.exchange-tooltip')!;
        const confirm = tooltip.querySelector<HTMLElement>('.boss-btn-primary')!;
        const conversation = { requestPhone: 0, phone: null, bothTalked: false };
        (phoneItem as HTMLElement & { __vue__?: unknown }).__vue__ = {
          $options: { name: 'ExchangePhone' },
          conversation$: conversation,
          isExchangePhoneBlueMsg: false,
        };
        phraseTrigger.addEventListener('click', (event) => {
          if ((event.target as Element).closest('li')) {
            return;
          }
          phraseContent.style.display = 'block';
        });
        phraseContent.querySelectorAll('li').forEach((item) => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            editor.innerText = item.getAttribute('title') ?? '';
            phraseContent.style.display = 'none';
          });
        });
        submit.addEventListener('click', () => {
          const message = editor.innerText.trim();
          const item = document.createElement('div');
          item.className = 'message-item';
          item.innerHTML = `<span class="text-content"></span>`;
          item.querySelector('.text-content')!.textContent = message;
          messageList.appendChild(item);
          editor.innerText = '';
          conversation.bothTalked = true;
          phoneButton.classList.remove('disabled');
        });
        phoneButton.addEventListener('click', () => {
          tooltip.style.display = 'block';
        });
        confirm.addEventListener('click', () => {
          conversation.requestPhone = 1;
          tooltip.style.display = 'none';
        });
      });

      const first = await contactBossQualifiedCandidate(page);
      const second = await contactBossQualifiedCandidate(page);
      const unmatchedFirst = await contactBossUnqualifiedCandidate(page);
      const unmatchedSecond = await contactBossUnqualifiedCandidate(page);

      assert.deepStrictEqual(first, {
        messageSent: true,
        messageAlreadyPresent: false,
        phoneExchangeRequested: true,
        phoneExchangeAlreadyRequested: false,
      });
      assert.deepStrictEqual(second, {
        messageSent: true,
        messageAlreadyPresent: true,
        phoneExchangeRequested: true,
        phoneExchangeAlreadyRequested: true,
      });
      assert.deepStrictEqual(unmatchedFirst, {
        messageSent: true,
        messageAlreadyPresent: false,
      });
      assert.deepStrictEqual(unmatchedSecond, {
        messageSent: true,
        messageAlreadyPresent: true,
      });
      assert.equal(await page.locator('.chat-message-list .message-item').count(), 2);
      assert.deepStrictEqual(
        await page.locator('.chat-message-list .message-item .text-content').allTextContents(),
        [bossQualifiedCandidateChatMessage, bossUnqualifiedCandidateChatMessage],
      );
    } finally {
      await browser.close();
    }
  });
});

describe('Boss property electrician hard requirements', () => {
  function buildResume(overrides: Partial<CandidateResume> = {}): CandidateResume {
    return {
      candidateId: 'candidate-qualified',
      name: '候选人甲',
      age: 46,
      regions: ['上海'],
      pr: [],
      workExperiences: [{
        company: '示例物业管理有限公司',
        title: '物业电工',
        start: '2020.01',
        end: '2022.01',
        details: ['负责楼宇配电维修'],
      }],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: ['高压电工操作证', '低压电工操作证'],
      ...overrides,
    };
  }

  it('matches only when every hard requirement has explicit evidence', () => {
    const evaluation = evaluatePropertyElectricianHardRequirements(buildResume());

    assert.equal(evaluation.allMet, true);
    assert.equal(evaluation.criteria.length, 5);
    assert.ok(evaluation.criteria.every((criterion) => criterion.met));
    assert.deepStrictEqual(evaluation.rejectionReasons, []);
  });

  it('treats missing evidence and age 47 as not qualified', () => {
    const evaluation = evaluatePropertyElectricianHardRequirements(buildResume({
      age: 47,
      certificates: ['低压电工操作证'],
      workExperiences: [{
        company: '示例制造有限公司',
        title: '维修工',
        start: '2024.01',
        end: '2024.12',
        details: [],
      }],
    }));

    assert.equal(evaluation.allMet, false);
    assert.equal(evaluation.criteria.find((criterion) => criterion.key === 'age')?.met, false);
    assert.equal(evaluation.criteria.find((criterion) => criterion.key === 'high_voltage_certificate')?.met, false);
    assert.equal(evaluation.criteria.find((criterion) => criterion.key === 'property_electrician_experience')?.met, false);
    assert.equal(evaluation.criteria.find((criterion) => criterion.key === 'company_tenure')?.met, false);
    assert.equal(evaluation.rejectionReasons.length, 4);
  });

  it('renders matched and rejected candidate names, ids, and reasons in the summary', () => {
    const qualified = evaluatePropertyElectricianHardRequirements(buildResume());
    const rejected = evaluatePropertyElectricianHardRequirements(buildResume({
      candidateId: 'candidate-rejected',
      name: '候选人乙',
      age: 48,
      certificates: [],
      workExperiences: [],
    }));
    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt: '2026-07-12T00:00:00.000Z',
      scoreThreshold: 70,
      matchMode: 'all-hard-requirements',
      unreadConversations: 2,
      reviewedConversations: 2,
      matchedCandidates: 1,
      chatMessagesSent: 1,
      phoneExchangeRequests: 1,
      forwardedCandidates: 1,
      skippedConversations: 0,
      failedConversations: 0,
      items: [{
        conversationId: 'conversation-qualified',
        candidateId: 'candidate-qualified',
        candidateName: '候选人甲',
        jobName: '物业电工',
        jobKey: '物业电工',
        unreadCount: 1,
        status: 'forwarded',
        matched: true,
        chatMessageSent: true,
        phoneExchangeRequested: true,
        forwarded: true,
        hardRequirementEvaluation: qualified,
      }, {
        conversationId: 'conversation-rejected',
        candidateId: 'candidate-rejected',
        candidateName: '候选人乙',
        jobName: '物业电工',
        jobKey: '物业电工',
        unreadCount: 1,
        status: 'not_matched',
        matched: false,
        chatMessageSent: true,
        forwarded: false,
        hardRequirementEvaluation: rejected,
      }],
    };
    const markdown = renderBossChatSummaryMarkdown(run);

    assert.match(markdown, /候选人甲（ID: candidate-qualified）/);
    assert.match(markdown, /候选人乙（ID: candidate-rejected）/);
    assert.match(markdown, /年龄为48岁，不满足小于47岁/);
    assert.match(markdown, /简历未发现明确的高压电工证证据/);
    assert.match(markdown, /不合适常用语已发送/);
  });

  it('renders a contact failure without hiding successful forwarding', () => {
    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt: '2026-07-12T00:00:00.000Z',
      scoreThreshold: 70,
      matchMode: 'all-hard-requirements',
      unreadConversations: 1,
      reviewedConversations: 1,
      matchedCandidates: 1,
      chatMessagesSent: 0,
      phoneExchangeRequests: 0,
      forwardedCandidates: 1,
      skippedConversations: 0,
      failedConversations: 1,
      items: [{
        conversationId: 'conversation-contact-failure',
        candidateId: 'candidate-contact-failure',
        candidateName: '候选人甲',
        jobName: '物业电工',
        jobKey: '物业电工',
        unreadCount: 1,
        status: 'failed',
        matched: true,
        forwarded: true,
        error: '换电话确认失败',
      }],
    };

    assert.match(
      renderBossChatSummaryMarkdown(run),
      /已转发，但联系动作未完成：换电话确认失败/,
    );
  });
});
