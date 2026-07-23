import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  greetBossTalentCandidate,
  readBossDeepSearchCandidates,
  readBossDeepSearchForm,
  readBossRecommendationCandidates,
  runBossTalentSearch,
  synchronizeBossDeepSearchRequirements,
  triggerBossDeepSearchMatch,
} from '../platforms/boss-talent.js';

describe('Boss talent discovery', () => {
  it('parses recommendation candidates using stable Boss IDs instead of visible indexes', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="geek-card-list">
          <div class="geek-card-item" data-geek-id="geek-100">
            <span class="geek-name">候选人甲</span>
            <span class="work-info">5年 前端开发</span>
            <span class="edu-info">本科</span>
            <span class="recommend-reason">技能匹配</span>
            <button class="geek-chat">打招呼</button>
          </div>
          <div class="geek-card-item" data-geek-id="geek-200">
            <span class="geek-name">候选人乙</span>
            <button class="geek-chat">继续沟通</button>
          </div>
        </div>
      `);

      const candidates = await readBossRecommendationCandidates(page);
      assert.deepStrictEqual(candidates.map((candidate) => ({
        id: candidate.candidateId,
        state: candidate.contactState,
        source: candidate.source,
        index: candidate.searchResultIndex,
      })), [
        { id: 'geek-100', state: 'greet', source: 'recommend', index: 0 },
        { id: 'geek-200', state: 'continue-chat', source: 'recommend', index: 1 },
      ]);
      assert.equal(candidates[0]?.recommendationReason, '技能匹配');
    } finally {
      await browser.close();
    }
  });

  it('reads native deep-search core requirements, bonus items, quota, and latest 20 cards', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      const cards = Array.from({ length: 22 }, (_, index) => `
        <div class="geek-card-item" data-expect="candidate-${index}">
          <span class="geek-name">候选人${index}</span><button class="geek-chat">打招呼</button>
        </div>`).join('');
      await page.setContent(`
        <div class="ai-form-left">
          <div class="job-select" data-job-id="job-42"><span class="selected">高级前端工程师</span></div>
          <div class="form-content">
            <h3 class="form-content-title-h3">核心要求</h3>
            <div class="form-content-list-item"><span class="form-content-word">TypeScript</span></div>
            <div class="form-content-list-item"><span class="form-content-word">5年经验</span></div>
          </div>
          <div class="form-content">
            <h3 class="form-content-title-h3">加分项</h3>
            <div class="form-content-list-item"><span class="form-content-word">有招聘系统经验</span></div>
          </div>
        </div>
        <div class="ai-form-match-footer">
          <span class="ai-form-match-footer-text-count">剩余 3 次</span>
          <button class="btn-ai-match-v2">立即匹配</button>
        </div>
        <div class="geek-card-list">${cards}</div>
      `);

      assert.deepStrictEqual(await readBossDeepSearchForm(page), {
        bossJobId: 'job-42',
        jobName: '高级前端工程师',
        coreRequirements: ['TypeScript', '5年经验'],
        bonusRequirements: ['有招聘系统经验'],
        remainingMatchCount: 3,
        matchButtonEnabled: true,
      });
      const candidates = await readBossDeepSearchCandidates(page);
      assert.equal(candidates.length, 20);
      assert.equal(candidates[0]?.candidateId, 'candidate-2');
      assert.equal(candidates.at(-1)?.candidateId, 'candidate-21');
    } finally {
      await browser.close();
    }
  });

  it('requires explicit confirmation before a greet action', async () => {
    await assert.rejects(() => greetBossTalentCandidate({} as never, {
      platform: 'boss',
      source: 'deep-search',
      candidateId: 'candidate-1',
      expectedCandidateName: '候选人甲',
      expectedJobName: '高级前端工程师',
      confirmed: false,
    }), /confirmed=true/);
  });

  it('synchronizes deep-search requirement text exactly before matching', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    try {
      await page.setContent(`
        <div class="ai-form-left">
          <div class="job-select" data-job-id="job-42"><span class="selected">高级前端工程师</span></div>
          <div class="form-content"><h3 class="form-content-title-h3">核心要求</h3>
            <div class="form-content-list-item"><span class="form-content-word">旧核心要求</span><span class="auto-resize-textarea-wrapper"><input value="旧核心要求" /></span></div>
          </div>
          <div class="form-content"><h3 class="form-content-title-h3">加分项</h3>
            <div class="form-content-list-item"><span class="form-content-word">旧加分项</span><span class="auto-resize-textarea-wrapper"><input value="旧加分项" /></span></div>
          </div>
        </div>
        <div class="ai-form-match-footer"><span class="ai-form-match-footer-text-count">剩余 1 次</span><button class="btn-ai-match-v2" onclick="document.querySelector('.geek-card-item').style.display='block'">立即匹配</button></div>
        <div class="geek-card-list"><div class="geek-card-item" data-geek-id="candidate-new" style="display:none"><span class="geek-name">候选人新</span><button class="geek-chat">打招呼</button></div></div>
      `);
      const form = await synchronizeBossDeepSearchRequirements(page, {
        coreRequirements: ['TypeScript'],
        bonusRequirements: ['招聘系统经验'],
      });
      assert.deepStrictEqual(form.coreRequirements, ['TypeScript']);
      assert.deepStrictEqual(form.bonusRequirements, ['招聘系统经验']);
      const candidates = await triggerBossDeepSearchMatch(page);
      assert.equal(candidates[0]?.candidateId, 'candidate-new');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('requires confirmation before consuming an immediate-match quota', async () => {
    await assert.rejects(() => runBossTalentSearch({} as never, {
      platform: 'boss',
      source: 'deep-search',
      triggerMatch: true,
      confirmed: false,
    }), /immediate match requires confirmed=true/);
  });
});
