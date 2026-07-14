import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Page } from 'playwright';
import {
  bossQualifiedCandidateChatMessage,
  bossShanghaiOriginQuestionMessage,
  bossUnqualifiedCandidateChatMessage,
  assessBossPreviousChat,
  collectBossUnreadConversations,
  contactBossQualifiedCandidate,
  contactBossShanghaiOriginCandidate,
  contactBossUnqualifiedCandidate,
  openBossChatPage,
  openBossUnreadConversation,
  parseBossChatResumeSnapshot,
} from '../platforms/boss-chat.js';
import { parseBossResumeData } from '../platforms/boss-adapter.js';
import { evaluatePropertyElectricianHardRequirements } from '../scoring/boss-chat-hard-requirements.js';
import { renderBossChatSummaryMarkdown } from '../reporting/boss-chat-summary.js';
import type { BossChatReviewRun, CandidateResume } from '../types/job.js';

describe('Boss auto-chat resume parsing', () => {
  it('reloads the Boss chat page before reading unread conversations', async () => {
    const events: string[] = [];
    let reloadCalls = 0;
    const unreadTab = {
      waitFor: async () => { events.push('unread-tab-ready'); },
      getAttribute: async () => 'active',
      click: async () => { events.push('unread-tab-clicked'); },
    };
    const page = {
      url: () => 'https://www.zhipin.com/web/chat/index',
      reload: async () => { reloadCalls += 1; },
      locator: (selector: string) => {
        if (selector === '.chat-message-filter-left span') {
          return {
            filter: () => ({ first: () => unreadTab }),
          };
        }
        if (selector === '.user-list') {
          return {
            first: () => ({
              waitFor: async () => { events.push('user-list-ready'); },
            }),
          };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      },
    } as unknown as Page;

    assert.equal(await openBossChatPage(page), page);
    assert.equal(reloadCalls, 1);
    assert.deepStrictEqual(events, ['unread-tab-ready', 'user-list-ready']);
  });

  it('classifies prior chat from Boss state and visible message history', () => {
    assert.deepStrictEqual(assessBossPreviousChat({
      bothTalked: true,
      hasVisibleRecruiterMessage: false,
      visibleMessageCount: 1,
      unreadCount: 1,
    }), {
      previouslyChatted: true,
      basis: 'boss-both-talked',
      visibleMessageCount: 1,
      unreadCountAtOpen: 1,
    });
    assert.equal(assessBossPreviousChat({
      bothTalked: false,
      hasVisibleRecruiterMessage: true,
      visibleMessageCount: 1,
      unreadCount: 1,
    }).basis, 'visible-recruiter-message');
    assert.equal(assessBossPreviousChat({
      bothTalked: false,
      hasVisibleRecruiterMessage: false,
      visibleMessageCount: 3,
      unreadCount: 2,
    }).basis, 'visible-message-history');
    assert.deepStrictEqual(assessBossPreviousChat({
      bothTalked: false,
      hasVisibleRecruiterMessage: false,
      visibleMessageCount: 2,
      unreadCount: 2,
    }), {
      previouslyChatted: false,
      basis: 'none',
      visibleMessageCount: 2,
      unreadCountAtOpen: 2,
    });
  });

  it('assesses prior chat after opening a red-dot conversation', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="user-list">
          <div class="geek-item" data-id="conversation-history">
            <span class="geek-name">候选人甲</span>
            <span class="source-job">物业电工</span>
          </div>
        </div>
        <div class="chat-conversation"></div>
        <div class="base-info-single-container"></div>
        <div class="chat-message-list">
          <div class="message-item item-myself"><span class="text-content">之前发送的消息</span></div>
          <div class="message-item"><span class="text-content">本次未读消息</span></div>
        </div>
      `);
      await page.evaluate(() => {
        type VueElement = HTMLElement & { __vue__?: unknown };
        (document.querySelector('.chat-conversation') as VueElement).__vue__ = {
          currentData$: {
            uniqueId: 'conversation-history',
            expectId: 'candidate-history',
            name: '候选人甲',
            jobName: '物业电工',
            bothTalked: false,
          },
        };
        (document.querySelector('.base-info-single-container') as VueElement).__vue__ = {
          conversation$: {
            uniqueId: 'conversation-history',
            expectId: 'candidate-history',
            name: '候选人甲',
            toPosition: '物业电工',
            ageDesc: '46岁',
            bothTalked: false,
            workExpList: [],
            eduExpList: [],
          },
        };
      });

      const opened = await openBossUnreadConversation(page, {
        conversationId: 'conversation-history',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 1,
      });

      assert.deepStrictEqual(opened.previousChat, {
        previouslyChatted: true,
        basis: 'visible-recruiter-message',
        visibleMessageCount: 2,
        unreadCountAtOpen: 1,
      });
      assert.deepStrictEqual(opened.newCandidateReplies, [{
        type: 'text',
        content: '本次未读消息',
      }]);
    } finally {
      await browser.close();
    }
  });

  it('ignores Boss conversation chrome when assessing a first-contact conversation', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="user-list">
          <div class="geek-item" data-id="conversation-first-contact">
            <span class="geek-name">候选人甲</span>
            <span class="source-job">物业电工</span>
          </div>
        </div>
        <div class="chat-conversation"></div>
        <div class="base-info-single-container"></div>
        <div class="chat-message-list">
          <div id="position-card" class="message-item"><span class="text-content">08:40 7月14日 沟通的职位-物业电工</span></div>
          <div id="candidate-greeting" class="message-item"><span class="text-content">我对物业电工很感兴趣，希望可以深聊，谢谢！</span></div>
          <div id="quick-reply" class="message-item"><span class="text-content">快速回复 你好，可以交换信息，进一步聊下。</span></div>
          <div id="recontact-tip" class="message-item"><span class="text-content">该牛人近30天内未与您沟通过，首次回聊该牛人消息需消耗回聊次数。选择不合适时不消耗次数</span></div>
        </div>
      `);
      await page.evaluate(() => {
        type VueElement = HTMLElement & { __vue__?: unknown };
        (document.querySelector('.chat-conversation') as VueElement).__vue__ = {
          currentData$: {
            uniqueId: 'conversation-first-contact',
            expectId: 'candidate-first-contact',
            name: '候选人甲',
            jobName: '物业电工',
            bothTalked: false,
          },
        };
        (document.querySelector('.base-info-single-container') as VueElement).__vue__ = {
          conversation$: {
            uniqueId: 'conversation-first-contact',
            expectId: 'candidate-first-contact',
            name: '候选人甲',
            toPosition: '物业电工',
            ageDesc: '46岁',
            bothTalked: false,
            workExpList: [],
            eduExpList: [],
          },
        };
        (document.querySelector('#position-card') as VueElement).__vue__ = {
          message$: { messageId: 'position-card', messageType: 3, type: 'resume', isSelf: false, templateId: 3 },
        };
        (document.querySelector('#candidate-greeting') as VueElement).__vue__ = {
          message$: { messageId: 'candidate-greeting', messageType: 3, type: 'text', isSelf: false, templateId: 1 },
        };
        (document.querySelector('#quick-reply') as VueElement).__vue__ = {
          message$: { messageId: 'quick-reply', messageType: 4, type: 'listCard', isSelf: false, templateId: 6 },
        };
        (document.querySelector('#recontact-tip') as VueElement).__vue__ = {
          message$: { messageId: 'recontact-tip', messageType: 4, type: 'text', isSelf: false, templateId: 3 },
        };
      });

      const opened = await openBossUnreadConversation(page, {
        conversationId: 'conversation-first-contact',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 1,
      });

      assert.deepStrictEqual(opened.previousChat, {
        previouslyChatted: false,
        basis: 'none',
        visibleMessageCount: 1,
        unreadCountAtOpen: 1,
      });
      assert.deepStrictEqual(opened.newCandidateReplies, [{
        messageId: 'candidate-greeting',
        type: 'text',
        content: '我对物业电工很感兴趣，希望可以深聊，谢谢！',
      }]);
      assert.equal(opened.newCandidateRepliesError, undefined);
    } finally {
      await browser.close();
    }
  });

  it('extracts only the latest unread candidate messages with Vue sender priority and non-text placeholders', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="user-list">
          <div class="geek-item" data-id="conversation-replies">
            <span class="geek-name">候选人甲</span>
            <span class="source-job">物业电工</span>
          </div>
        </div>
        <div class="chat-conversation"></div>
        <div class="base-info-single-container"></div>
        <div class="chat-message-list">
          <div class="message-item item-friend"><span class="text-content">较早的候选人消息</span></div>
          <div class="message-item item-myself"><span class="text-content">招聘方历史话术</span></div>
          <div class="message-item system-notice"><span class="text-content">昨天 10:30</span></div>
          <div id="new-text" class="message-item item-myself"><span class="text-content"> 可以\n 今天   下午面试 </span></div>
          <div id="new-image" class="message-item"><img alt="证书照片" /></div>
          <div id="new-attachment" class="message-item attachment-message"><span class="file-name">电工证.pdf</span></div>
        </div>
      `);
      await page.evaluate(() => {
        type VueElement = HTMLElement & { __vue__?: unknown };
        (document.querySelector('.chat-conversation') as VueElement).__vue__ = {
          currentData$: {
            uniqueId: 'conversation-replies',
            expectId: 'candidate-replies',
            name: '候选人甲',
            jobName: '物业电工',
            bothTalked: true,
          },
        };
        (document.querySelector('.base-info-single-container') as VueElement).__vue__ = {
          conversation$: {
            uniqueId: 'conversation-replies',
            expectId: 'candidate-replies',
            name: '候选人甲',
            toPosition: '物业电工',
            ageDesc: '46岁',
            workExpList: [],
            eduExpList: [],
          },
        };
        (document.querySelector('#new-text') as VueElement).__vue__ = {
          message$: {
            senderType: 'candidate',
            messageId: 'message-text',
            sendTime: '2026-07-14 15:01',
            messageType: 'text',
          },
        };
        (document.querySelector('#new-image') as VueElement).__vue__ = {
          message$: {
            fromGeek: true,
            msgId: 'message-image',
            messageType: 'image',
          },
        };
        (document.querySelector('#new-attachment') as VueElement).__vue__ = {
          message$: {
            senderRole: 'geek',
            mid: 'message-attachment',
            contentType: 'attachment',
          },
        };
      });

      const opened = await openBossUnreadConversation(page, {
        conversationId: 'conversation-replies',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 3,
        hasUnreadBadge: true,
      });

      assert.equal(opened.previousChat.previouslyChatted, true);
      assert.deepStrictEqual(opened.newCandidateReplies, [{
        messageId: 'message-text',
        sentAt: '2026-07-14 15:01',
        type: 'text',
        content: '可以 今天 下午面试',
      }, {
        messageId: 'message-image',
        type: 'image',
        content: '[图片] 证书照片',
      }, {
        messageId: 'message-attachment',
        type: 'attachment',
        content: '[附件] 电工证.pdf',
      }]);
      assert.equal(opened.newCandidateRepliesError, undefined);

      const unreliable = await openBossUnreadConversation(page, {
        conversationId: 'conversation-replies',
        candidateName: '候选人甲',
        jobName: '物业电工',
        unreadCount: 5,
        hasUnreadBadge: true,
      });
      assert.equal(unreliable.newCandidateReplies, undefined);
      assert.match(unreliable.newCandidateRepliesError ?? '', /extract 5 unread Boss candidate message\(s\): found 4/);
    } finally {
      await browser.close();
    }
  });

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
        hasUnreadBadge: false,
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
      nativePlace: '上海',
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
    assert.equal(resume.nativePlace, '上海');
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

  it('parses explicit native place from Boss resume detail data', () => {
    const resume = parseBossResumeData({
      geekBaseInfo: {
        name: '候选人甲',
        ageDesc: '46岁',
        hometown: { name: '上海' },
      },
      geekEduExpList: [{
        school: '上海电机学院',
        degreeName: '大专',
      }],
    }, {
      url: () => 'https://www.zhipin.com/web/chat/index',
    } as Page, {
      candidateId: 'candidate-native-place',
    });

    assert.equal(resume.nativePlace, '上海');
    assert.equal(resume.educationExperiences[0]?.school, '上海电机学院');
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
            const selections = JSON.parse(document.body.dataset.phraseSelections ?? '[]') as string[];
            selections.push(item.getAttribute('title') ?? '');
            document.body.dataset.phraseSelections = JSON.stringify(selections);
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
      const clarificationFirst = await contactBossShanghaiOriginCandidate(page);
      const clarificationSecond = await contactBossShanghaiOriginCandidate(page);
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
      assert.deepStrictEqual(clarificationFirst, {
        messageSent: true,
        messageAlreadyPresent: false,
      });
      assert.deepStrictEqual(clarificationSecond, {
        messageSent: true,
        messageAlreadyPresent: true,
      });
      assert.deepStrictEqual(unmatchedFirst, {
        messageSent: true,
        messageAlreadyPresent: false,
      });
      assert.deepStrictEqual(unmatchedSecond, {
        messageSent: true,
        messageAlreadyPresent: true,
      });
      assert.equal(await page.locator('.chat-message-list .message-item').count(), 3);
      assert.deepStrictEqual(
        await page.locator('.chat-message-list .message-item .text-content').allTextContents(),
        [bossQualifiedCandidateChatMessage, bossShanghaiOriginQuestionMessage, bossUnqualifiedCandidateChatMessage],
      );
      assert.deepStrictEqual(
        JSON.parse(await page.locator('body').getAttribute('data-phrase-selections') ?? '[]'),
        [bossQualifiedCandidateChatMessage, bossUnqualifiedCandidateChatMessage],
      );
    } finally {
      await browser.close();
    }
  });

  it('does not overwrite an existing editor draft when typing the Shanghai-origin question', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.setContent(`
        <div class="chat-message-list"></div>
        <div class="toolbar-box-left">
          <div class="operate-icon-item">
            <div class="toolbar-icon changyongyu">常</div>
            <div class="phrase-content" style="display:none">
              <ul><li title="${bossQualifiedCandidateChatMessage}">${bossQualifiedCandidateChatMessage}</li></ul>
            </div>
          </div>
        </div>
        <div class="conversation-editor">
          <div id="boss-chat-editor-input" contenteditable="true">已有草稿</div>
          <div class="submit">发送</div>
        </div>
      `);

      await assert.rejects(
        () => contactBossShanghaiOriginCandidate(page),
        /editor contains unexpected text before typing a message: 已有草稿/,
      );
      assert.equal(await page.locator('#boss-chat-editor-input').textContent(), '已有草稿');
      assert.equal(await page.locator('.chat-message-list .message-item').count(), 0);
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
      nativePlace: '上海',
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
    assert.equal(evaluation.criteria.length, 6);
    assert.ok(evaluation.criteria.every((criterion) => criterion.met));
    assert.deepStrictEqual(evaluation.rejectionReasons, []);
  });

  it('accepts one combined high-low voltage electrician certificate for both voltage requirements', () => {
    const evaluation = evaluatePropertyElectricianHardRequirements(buildResume({
      certificates: ['高低压电工证'],
    }));

    assert.equal(evaluation.allMet, true);
    assert.deepStrictEqual(
      evaluation.criteria
        .filter((criterion) => criterion.key === 'high_voltage_certificate' || criterion.key === 'low_voltage_certificate')
        .map((criterion) => ({ key: criterion.key, met: criterion.met, evidence: criterion.evidence })),
      [{
        key: 'high_voltage_certificate',
        met: true,
        evidence: ['高低压电工证'],
      }, {
        key: 'low_voltage_certificate',
        met: true,
        evidence: ['高低压电工证'],
      }],
    );
  });

  it('requests Shanghai-origin clarification only from an otherwise qualified Shanghai-school candidate', () => {
    const evaluation = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: undefined,
      regions: ['上海'],
      educationExperiences: [{
        school: '上海电机学院',
        degree: '大专',
        details: [],
      }],
    }));

    assert.equal(evaluation.allMet, false);
    assert.equal(evaluation.criteria.find((criterion) => criterion.key === 'shanghai_origin')?.met, false);
    assert.deepStrictEqual(evaluation.clarification, {
      criterionKey: 'shanghai_origin',
      question: bossShanghaiOriginQuestionMessage,
      evidence: ['上海电机学院 | 大专'],
      reason: '简历未明确是否为上海人，但发现上海就读线索，需要发送“是上海人吗？”确认',
    });
  });

  it('does not ask about Shanghai origin when another requirement fails or native place is explicitly elsewhere', () => {
    const otherwiseRejected = evaluatePropertyElectricianHardRequirements(buildResume({
      age: 47,
      nativePlace: undefined,
      educationExperiences: [{ school: '同济大学', details: [] }],
    }));
    const explicitlyElsewhere = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: '江苏',
      educationExperiences: [{ school: '复旦大学', details: [] }],
    }));
    const explicitlyNotShanghai = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: undefined,
      pr: ['本人不是上海人，目前在上海工作'],
      educationExperiences: [{ school: '上海电机学院', details: [] }],
    }));

    assert.equal(otherwiseRejected.clarification, undefined);
    assert.equal(explicitlyElsewhere.clarification, undefined);
    assert.equal(explicitlyNotShanghai.allMet, false);
    assert.equal(explicitlyNotShanghai.clarification, undefined);
    assert.match(
      explicitlyElsewhere.criteria.find((criterion) => criterion.key === 'shanghai_origin')?.reason ?? '',
      /籍贯为江苏/,
    );
  });

  it('accepts explicit Shanghai-origin text instead of expected-city evidence', () => {
    const expectedCityOnly = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: undefined,
      regions: ['上海'],
    }));
    const explicitProfileText = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: undefined,
      regions: [],
      pr: ['本人是上海人，熟悉本地物业项目'],
    }));

    assert.equal(expectedCityOnly.allMet, false);
    assert.equal(expectedCityOnly.clarification, undefined);
    assert.equal(explicitProfileText.allMet, true);
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
      previouslyChattedConversations: 0,
      firstContactConversations: 2,
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
        previousChat: {
          previouslyChatted: false,
          basis: 'none',
          visibleMessageCount: 1,
          unreadCountAtOpen: 1,
        },
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
        previousChat: {
          previouslyChatted: false,
          basis: 'none',
          visibleMessageCount: 1,
          unreadCountAtOpen: 1,
        },
        hardRequirementEvaluation: rejected,
      }],
    };
    const markdown = renderBossChatSummaryMarkdown(run);

    assert.match(markdown, /候选人甲（ID: candidate-qualified）/);
    assert.match(markdown, /候选人乙（ID: candidate-rejected）/);
    assert.match(markdown, /年龄为48岁，不满足小于47岁/);
    assert.match(markdown, /简历未发现明确的高压电工证证据/);
    assert.match(markdown, /不合适常用语已发送/);
    assert.match(markdown, /此前已聊过: 0/);
    assert.match(markdown, /此前未聊过: 2/);
    assert.match(markdown, /候选人甲（ID: candidate-qualified），此前未聊过/);
    assert.match(markdown, /候选人乙（ID: candidate-rejected），此前未聊过/);
  });

  it('renders Shanghai-origin clarification separately from rejection contact', () => {
    const evaluation = evaluatePropertyElectricianHardRequirements(buildResume({
      nativePlace: undefined,
      educationExperiences: [{ school: '上海电机学院', details: [] }],
    }));
    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt: '2026-07-13T00:00:00.000Z',
      scoreThreshold: 70,
      matchMode: 'all-hard-requirements',
      unreadConversations: 1,
      reviewedConversations: 1,
      matchedCandidates: 0,
      chatMessagesSent: 1,
      phoneExchangeRequests: 0,
      forwardedCandidates: 0,
      skippedConversations: 0,
      failedConversations: 0,
      items: [{
        conversationId: 'conversation-clarification',
        candidateId: 'candidate-clarification',
        candidateName: '候选人待确认',
        jobName: '物业电工',
        jobKey: '物业电工',
        unreadCount: 1,
        status: 'awaiting_clarification',
        clarificationQuestionSent: true,
        chatMessageSent: true,
        forwarded: false,
        previousChat: {
          previouslyChatted: false,
          basis: 'none',
          visibleMessageCount: 1,
          unreadCountAtOpen: 1,
        },
        hardRequirementEvaluation: evaluation,
      }],
    };

    const markdown = renderBossChatSummaryMarkdown(run);
    assert.match(markdown, /等待上海籍确认: 1/);
    assert.match(markdown, /上海籍确认消息已发送，等待回复/);
    assert.doesNotMatch(markdown, /不合适常用语已发送/);
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

  it('renders follow-up replies safely and supports historical runs without new counters', () => {
    const run: BossChatReviewRun = {
      platform: 'boss',
      reviewedAt: '2026-07-14T00:00:00.000Z',
      scoreThreshold: 70,
      matchMode: 'all-hard-requirements',
      unreadConversations: 1,
      reviewedConversations: 1,
      matchedCandidates: 0,
      chatMessagesSent: 0,
      phoneExchangeRequests: 0,
      forwardedCandidates: 0,
      skippedConversations: 0,
      failedConversations: 0,
      items: [{
        conversationId: 'conversation-follow-up',
        candidateId: 'candidate-follow-up',
        candidateName: '候选人*甲*',
        jobName: '物业电工',
        jobKey: '物业电工',
        unreadCount: 2,
        status: 'follow_up_reply',
        previousChat: {
          previouslyChatted: true,
          basis: 'boss-both-talked',
          visibleMessageCount: 4,
          unreadCountAtOpen: 2,
        },
        newCandidateReplies: [{
          messageId: 'message-1',
          type: 'text',
          content: '可以\n*周三*面试',
        }, {
          type: 'image',
          content: '[图片]',
        }],
      }],
    };

    const markdown = renderBossChatSummaryMarkdown(run);
    assert.match(markdown, /跟进回复会话: 1/);
    assert.match(markdown, /新回复消息: 2/);
    assert.match(markdown, /已聊过候选人的新回复/);
    assert.match(markdown, /候选人\\\*甲\\\*/);
    assert.match(markdown, /可以 \\\*周三\\\*面试/);
    assert.match(markdown, /\[图片\]/);
    assert.doesNotMatch(markdown, /## 不符合或等待确认的候选人[\s\S]*candidate-follow-up/);
  });
});
