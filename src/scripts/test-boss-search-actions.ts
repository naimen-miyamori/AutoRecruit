import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { config } from '../config.js';
import {
  applyBossViewedCandidatePolicy,
  applyBossSearchCondition,
  assertBossSearchFilterStateRestorable,
  discoverBossSearchFilters,
  extractBossCandidateList,
  openBossDirectSearch,
  openBossResumeDetail,
  openBossSubscribeSearch,
  prepareBossSearchConditionPage,
  resetBossSearchFilters,
  snapshotBossSearchFilterState,
} from '../platforms/boss/actions/search-actions.js';

type SearchFixtureOptions = {
  body: string;
};

async function createSearchFixture(options: SearchFixtureOptions): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.route('https://www.zhipin.com/web/chat/search', async (route) => {
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><iframe name="searchFrame" src="https://www.zhipin.com/web/frame/search/"></iframe></body></html>',
    });
  });
  await page.route('https://www.zhipin.com/web/frame/search/', async (route) => {
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: options.body });
  });
  await page.route('https://www.zhipin.com/web/frame/c-resume/', async (route) => {
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><canvas id="resume" width="320" height="480"></canvas></body></html>',
    });
  });
  await page.goto('https://www.zhipin.com/web/chat/search');
  return { browser, page };
}

function searchBody(content: string): string {
  return `<!doctype html><html><body>
    <div class="search-job-list-C"><span class="search-current-job">不限职位</span></div>
    <input class="search-input" value="测试关键词" />
    <script>
      function openResume() {
        parent.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap active" data-type="boss-dialog"><button class="boss-popup__close" onclick="this.parentElement.remove()"></button><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe></div>');
      }
    </script>
    ${content}
  </body></html>`;
}

function recentViewedSearchBody(options: { refreshOnChange?: boolean } = {}): string {
  const refreshOnChange = options.refreshOnChange !== false;
  return searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetSearch()">清空筛选</span>
    <label class="high_search_checkbox" ka="search_change_view_resume" style="display:block;width:200px;height:24px"><input type="checkbox">过滤近14天查看</label>
    <label class="high_search_checkbox" ka="search_change_exchange_resume" style="display:block;width:240px;height:24px"><input type="checkbox">近30天未和同事交换简历</label>
    <section id="boss-results" data-boss-search-result-version="0"><div class="geek-info-card">candidate card</div></section>
    <script>
      window.__recentViewedChanges = 0;
      window.__recentViewedResetCalls = 0;
      const recentViewedInput = document.querySelector('.high_search_checkbox[ka="search_change_view_resume"] input');
      function refreshResults() {
        const results = document.querySelector('#boss-results');
        results.dataset.bossSearchResultVersion = String(Number(results.dataset.bossSearchResultVersion || '0') + 1);
        results.innerHTML = '<div class="geek-info-card">candidate card</div>';
      }
      recentViewedInput.addEventListener('change', () => {
        window.__recentViewedChanges += 1;
        ${refreshOnChange ? 'refreshResults();' : ''}
      });
      function resetSearch() {
        window.__recentViewedResetCalls += 1;
        recentViewedInput.checked = false;
        refreshResults();
      }
    </script>`);
}

describe('Boss normal-search actions', () => {
  it('maps the public viewed switch to the recent-viewed checkbox and proves a refresh without requiring card-count changes', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const deadline = Date.now() + 10_000;
      const defaultResult = await applyBossViewedCandidatePolicy(page, false, deadline);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.deepEqual(defaultResult, { desiredChecked: true, changed: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);
      assert.equal(await frame.locator('.geek-info-card').count(), 1);
      assert.equal(await frame.locator('#boss-results').getAttribute('data-boss-search-result-version'), '1');

      const includeResult = await applyBossViewedCandidatePolicy(page, true, deadline);
      assert.deepEqual(includeResult, { desiredChecked: false, changed: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.locator('.geek-info-card').count(), 1);
      assert.equal(await frame.locator('#boss-results').getAttribute('data-boss-search-result-version'), '2');

      const idempotentResult = await applyBossViewedCandidatePolicy(page, true, deadline);
      assert.deepEqual(idempotentResult, { desiredChecked: false, changed: false });
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('refuses a recent-viewed toggle when no post-click result refresh can be observed', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody({ refreshOnChange: false }) });
    try {
      await assert.rejects(
        () => applyBossViewedCandidatePolicy(page, false, Date.now() + 750),
        /no new search-result refresh was observed/i,
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('keeps standalone search-condition preparation isolated from the ordinary-capture viewed policy', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    try {
      const deadline = Date.now() + 10_000;
      await prepareBossSearchConditionPage(page, '测试关键词', { deadline, includeViewedCandidates: false });
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 0);

      await openBossSubscribeSearch(page, '测试关键词', { deadline, includeViewedCandidates: false });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);

      await openBossSubscribeSearch(page, '测试关键词', { deadline, includeViewedCandidates: true });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies the viewed policy after direct-search reset, deduplicates an agreeing condition, and rejects conflicts before page mutation', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({ body: recentViewedSearchBody() });
    const agreeingCondition = {
      kind: 'applicationFilter' as const,
      fieldId: 'filter_recent_viewed',
      label: '过滤近14天查看',
      fieldKind: 'toggle' as const,
      value: true,
    };
    try {
      const deadline = Date.now() + 10_000;
      await assert.rejects(
        () => openBossDirectSearch(page, '测试关键词', [{ ...agreeingCondition, value: false }], {
          deadline,
          includeViewedCandidates: false,
        }),
        /conflicts with --include-viewed false/i,
      );
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedResetCalls), 0);

      await openBossDirectSearch(page, '测试关键词', [agreeingCondition], {
        deadline,
        includeViewedCandidates: false,
      });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), true);
      assert.equal(await frame.evaluate(() => (window as unknown as Record<string, number>).__recentViewedChanges), 1);

      await openBossDirectSearch(page, '测试关键词', [], {
        deadline,
        includeViewedCandidates: true,
      });
      assert.equal(await frame.locator('.high_search_checkbox[ka="search_change_view_resume"] input').isChecked(), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('clears a residual city summary after the page reset clears its city checkmarks', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetSearch()">清空筛选</span>
        <div class="city-wrap"><div class="city" onclick="openCity()">广东</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li onclick="selectNational(this)"><div class="city-checkbox status0"></div>全国</li><li><div class="city-checkbox status1"></div>广东</li></ul><button onclick="confirmCity()">确认</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div>
        <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox">过滤近14天查看</label><label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label><div class="geek-info-card">candidate card</div>
        <script>
          function openCity() { document.querySelector('.city-box').style.display = 'block'; }
          function selectNational(item) { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); item.querySelector('.city-checkbox').className = 'city-checkbox status1'; document.querySelector('.city-wrap .city').textContent = '全国'; }
          function confirmCity() { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); document.querySelector('.city-box').style.display = 'none'; }
          function resetSearch() { document.querySelectorAll('.city-checkbox').forEach((checkbox) => { checkbox.className = 'city-checkbox status0'; }); document.querySelectorAll('.high_search_checkbox input').forEach((input) => { input.checked = false; }); }
        </script>`),
    });
    try {
      await resetBossSearchFilters(page, Date.now() + 10_000);
      const state = await snapshotBossSearchFilterState(page, Date.now() + 10_000);
      assert.equal(state.city, '');
      assert.deepEqual(state.cityOptions, []);
      assert.equal(state.toggles.filter_recent_viewed, false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('discovers city, job scope, and token-dialog filters as typed controls', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="city-wrap"><div class="city">城市</div><div class="city-box"><ul class="dropdown-province"><li data-value="a"><div class="city-checkbox status0"></div>甲</li></ul></div></div>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><div class="ui-dropmenu-list"><ul><li class="active" data-value="search_select_job">不限职位</li><li data-value="search_select_job">职位B</li></ul></div></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 6 ? 'onclick="document.querySelector(\'.major-dialog\').style.display=\'block\'"' : ''}><div class="major-input-ui">${index === 6 ? '专业' : '筛选' + index}</div></div>`).join('')}</div>
        <div class="major-dialog dialog-wrap" style="display:none"><input class="ipt"><ul><li data-value="major-a">测试专业</li></ul><button>取消</button><button>确定</button></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, { keyword: '', deadline: Date.now() + 10_000 });
      assert.equal(catalog.filters.find((item) => item.key === 'boss-city')?.options?.length, 1);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-job-scope')?.options?.length, 2);
      assert.deepEqual(catalog.filters.find((item) => item.key === 'boss-job-scope')?.options?.map((option) => option.value), ['不限职位', '职位B']);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-major')?.options?.length, 1);
      assert.equal(catalog.filters.some((item) => item.key === 'boss-qualification'), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('limits segmented discovery to the requested expandable filter without consuming its deadline on other panels', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 4 ? 'onclick="this.querySelector(\'.dropdown-menu\').style.display=\'block\'"' : ''}><span class="defalut-select">${index === 4 ? '求职状态' : '筛选' + index}</span>${index === 4 ? '<ul class="dropdown-menu" style="display:none"><li>不限</li><li>在职</li><li>离职</li></ul>' : ''}</div>`).join('')}</div>
        <div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, {
        keyword: '',
        deadline: Date.now() + 10_000,
        filterKeys: ['boss-job-status'],
      });
      assert.equal(catalog.filters.find((item) => item.key === 'boss-job-status')?.options?.length, 3);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-city')?.options, undefined);
      assert.equal(catalog.filters.find((item) => item.key === 'boss-major')?.options, undefined);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('publishes semantic custom-slider boundaries instead of Boss internal indexes', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider"><input type="hidden" value="1,7"></div></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider"><input type="hidden" value="1,12"></div></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const catalog = await discoverBossSearchFilters(page, { keyword: '', deadline: Date.now() + 10_000 });
      const education = catalog.filters.find((filter) => filter.key === 'boss-education');
      const workYears = catalog.filters.find((filter) => filter.key === 'boss-work-years');
      const educationOptions = education?.options?.find((option) => option.label === '自定义')?.inputSpec?.fields[0]?.options;
      const workYearsOptions = workYears?.options?.find((option) => option.label === '自定义')?.inputSpec?.fields[0]?.options;
      assert.deepEqual(educationOptions, ['中专/中技', '高中', '大专', '本科', '硕士', '博士']);
      assert.equal(workYearsOptions?.at(-1), '10年以上');
      assert.equal(workYearsOptions?.includes('12'), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('rejects unsupported entry filters before a live verifier can reset the page', () => {
    const baseline = {
      keyword: '测试关键词', jobScope: '不限职位', jobScopeIndex: 0, city: '', company: '',
      inline: { education: ['不限'], school_nature: ['不限'], work_years: ['不限'], age: ['不限'] },
      more: {},
      toggles: { filter_recent_viewed: false, no_colleague_resume_exchange: false },
    };
    assert.doesNotThrow(() => assertBossSearchFilterStateRestorable(baseline));
    assert.throws(
      () => assertBossSearchFilterStateRestorable({ ...baseline, company: 'existing-filter' }),
      /cannot safely restore a pre-existing city or company filter/i,
    );
  });

  it('applies exact school-nature sets and toggles, then resets the reusable search page', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params" onclick="resetFilters()">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active" onclick="selectSingle(this, '.degree-ui')">不限</span><span class="degree-item" onclick="selectSingle(this, '.degree-ui')">本科及以上</span></div>
        <div class="school-ui"><span class="degree-item active" onclick="resetSchool()">不限</span><label><input type="checkbox" onchange="syncSchool()"><span class="checkbox-text">统招本科</span></label><label><input type="checkbox" onchange="syncSchool()"><span class="checkbox-text">985院校</span></label></div>
        <div class="experience-select"><span class="exp-item active" onclick="selectSingle(this, '.experience-select')">不限</span><span class="exp-item" onclick="selectSingle(this, '.experience-select')">1-3年</span></div>
        <div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container"><div class="filter-2-item"><span class="ipt">性别</span></div><div class="filter-2-item"><div class="salary-container"><span class="double-select-gray-inner-flip">薪资区间</span></div></div><div class="filter-2-item"><span class="ipt">牛人活跃度</span></div><div class="filter-2-item"><span class="ipt">跳槽频率</span></div><div class="filter-2-item"><span class="defalut-select">求职状态</span></div><div class="filter-2-item"><span class="defalut-select">牛人职位要求</span></div><div class="filter-2-item"><span class="major-input-ui">专业</span></div></div>
        <label class="high_search_checkbox" ka="search_change_view_resume"><input type="checkbox">过滤近14天查看</label>
        <label class="high_search_checkbox" ka="search_change_exchange_resume"><input type="checkbox">近30天未和同事交换简历</label>
        <div class="geek-info-card">candidate card</div>
        <script>
          function selectSingle(target, root) { document.querySelectorAll(root + ' .active').forEach((item) => item.classList.remove('active')); target.classList.add('active'); }
          function resetSchool() { document.querySelectorAll('.school-ui input').forEach((input) => { input.checked = false; }); document.querySelector('.school-ui .degree-item').classList.add('active'); }
          function syncSchool() { document.querySelector('.school-ui .degree-item').classList.toggle('active', ![...document.querySelectorAll('.school-ui input')].some((input) => input.checked)); }
          function resetFilters() { selectSingle(document.querySelector('.degree-ui .degree-item'), '.degree-ui'); selectSingle(document.querySelector('.experience-select .exp-item'), '.experience-select'); document.querySelector('.age-select .age-item').classList.add('active'); resetSchool(); document.querySelectorAll('.high_search_checkbox input').forEach((input) => { input.checked = false; }); }
        </script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const schoolResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'school_nature', label: '院校要求', fieldKind: 'multiSelect', value: ['统招本科', '985院校'],
      }, deadline);
      assert.equal(schoolResult.status, 'applied');
      const toggleResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'filter_recent_viewed', label: '过滤近14天查看', fieldKind: 'toggle', value: true,
      }, deadline);
      assert.equal(toggleResult.status, 'applied');

      const selectedState = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(selectedState.inline.school_nature, ['统招本科', '985院校']);
      assert.equal(selectedState.toggles.filter_recent_viewed, true);

      await resetBossSearchFilters(page, deadline);
      const baseline = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(baseline.inline.school_nature, ['不限']);
      assert.equal(baseline.toggles.filter_recent_viewed, false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies a custom education slider range through paced pointer dragging', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.degree-select-custom-slider .ui-slider');
          const input = slider.querySelector('input');
          const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')];
          let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); handles[0].style.left = ((values[0] - 1) / 6 * (rect.width - 12)) + 'px'; handles[1].style.left = ((values[1] - 1) / 6 * (rect.width - 12)) + 'px'; });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '2', max: '5' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.degree-ui input[type="hidden"]').inputValue(), '2,5');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('applies a custom work-years slider range from within its scoped container', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div>
        <div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,12"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div>
        <div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.experience-select .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(12, Math.floor(((event.clientX - rect.left) / rect.width) * 11) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'work_years', label: '经验要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '2', max: '5' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.experience-select input[type="hidden"]').inputValue(), '2,5');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('maps semantic education and work-years boundaries to the Boss slider values and visible ranges', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content"></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div>
        <div class="experience-select"><span class="exp-item active">不限</span><span class="custom">自定义</span><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,12"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div><div class="experience-select-custom-content"></div></div>
        <div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          function wireSlider(rootSelector, maximum, labels, outputSelector) {
            const root = document.querySelector(rootSelector); const slider = root.querySelector('.ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
            const render = () => { const values = input.value.split(',').map(Number); root.querySelector(outputSelector).textContent = labels[values[0]] + '-' + labels[values[1]]; };
            handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
            document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(maximum, Math.floor(((event.clientX - rect.left) / rect.width) * (maximum - 1)) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); render(); });
            document.addEventListener('mouseup', () => { activeHandle = -1; });
          }
          wireSlider('.degree-ui', 7, ['', '不限', '初中及以下', '高中', '大专', '本科', '硕士', '博士'], '.degree-select-custom-content');
          wireSlider('.experience-select', 12, ['', '在校/应届', '1年', '2年', '3年', '4年', '5年', '6年', '7年', '8年', '9年', '10年', '10年以上'], '.experience-select-custom-content');
        </script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const education = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }, deadline);
      const experience = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'work_years', label: '经验要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '10年以上', max: '10年以上' } },
      }, deadline);
      assert.equal(education.status, 'applied', education.message);
      assert.equal(experience.status, 'applied', experience.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.degree-ui input[type="hidden"]').inputValue(), '4,7');
      assert.equal(await frame.locator('.degree-select-custom-content').innerText(), '大专-博士');
      assert.equal(await frame.locator('.experience-select input[type="hidden"]').inputValue(), '12,12');
      assert.equal(await frame.locator('.experience-select-custom-content').innerText(), '10年以上-10年以上');
      const state = await snapshotBossSearchFilterState(page, deadline);
      assert.deepEqual(state.inline.education, ['custom:大专-博士']);
      assert.deepEqual(state.inline.work_years, ['custom:10年以上-10年以上']);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('fails a custom slider when its visible range disagrees with the requested semantic boundary', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content">高中-博士</div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          const slider = document.querySelector('.degree-ui .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }, Date.now() + 10_000);
      assert.equal(result.status, 'failed');
      assert.match(result.message ?? '', /visible value did not match 大专-博士/);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('keeps a semantic custom range in the final direct-search postcondition', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="city-wrap"><div class="city" onclick="document.querySelector('.city-box').style.display='block'">城市</div><div class="city-box" style="display:none"><ul class="dropdown-province"><li data-value="guangdong" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>广东</li><li data-value="zhaoqing" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>肇庆</li></ul><button>清除</button><button onclick="confirmCity()">确认</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span><span class="degree-select-custom-label">自定义</span><div class="degree-select-custom-slider"><div class="ui-slider ui-slider-range custom-slider-disabled" style="position:relative;width:600px;height:20px"><input type="hidden" value="1,7"><div class="ui-slider-button-wrap" style="position:absolute;left:0;width:12px;height:20px"></div><div class="ui-slider-button-wrap" style="position:absolute;left:588px;width:12px;height:20px"></div></div></div><div class="degree-select-custom-content"></div></div>
        <div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>
          function toggleCity(item) { const checkbox = item.querySelector('.city-checkbox'); checkbox.classList.toggle('status0'); checkbox.classList.toggle('status1'); }
          function confirmCity() { const selected = [...document.querySelectorAll('.dropdown-province > li')].find((item) => item.querySelector('.city-checkbox').classList.contains('status1')); document.querySelector('.city-wrap .city').textContent = selected ? selected.textContent.trim() : '城市'; document.querySelector('.city-box').style.display = 'none'; }
          document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelector('.city-box').style.display = 'none'; });
          const slider = document.querySelector('.degree-ui .ui-slider'); const input = slider.querySelector('input'); const handles = [...slider.querySelectorAll('.ui-slider-button-wrap')]; let activeHandle = -1;
          handles.forEach((handle, index) => handle.addEventListener('mousedown', () => { activeHandle = index; slider.classList.remove('custom-slider-disabled'); }));
          document.addEventListener('mousemove', (event) => { if (activeHandle < 0) return; const rect = slider.getBoundingClientRect(); const value = Math.max(1, Math.min(7, Math.floor(((event.clientX - rect.left) / rect.width) * 6) + 1)); const values = input.value.split(',').map(Number); if (activeHandle === 0) values[0] = Math.min(value, values[1]); else values[1] = Math.max(value, values[0]); input.value = values.join(','); document.querySelector('.degree-select-custom-content').textContent = ['', '不限', '中专/中技', '高中', '大专', '本科', '硕士', '博士'][values[0]] + '-' + ['', '不限', '中专/中技', '高中', '大专', '本科', '硕士', '博士'][values[1]]; });
          document.addEventListener('mouseup', () => { activeHandle = -1; });
        </script>`),
    });
    try {
      await openBossDirectSearch(page, '测试关键词', [{
        kind: 'applicationFilter', fieldId: 'city', label: '城市', fieldKind: 'multiSelect', value: ['广东'],
      }, {
        kind: 'applicationFilter', fieldId: 'education', label: '学历要求', fieldKind: 'singleSelect',
        value: { label: '自定义', input: { min: '大专', max: '博士' } },
      }], { deadline: Date.now() + 10_000 });
      const state = await snapshotBossSearchFilterState(page, Date.now() + 10_000);
      assert.deepEqual(state.inline.education, ['custom:大专-博士']);
      assert.equal(await page.frame({ name: 'searchFrame' })?.locator('.city-box').isVisible(), false);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects the exact Boss city option set and confirms the panel', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="city-wrap"><div class="city">城市</div><div class="city-box"><ul class="dropdown-province"><li data-value="a" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>甲</li><li data-value="b" onclick="toggleCity(this)"><div class="city-checkbox status0"></div>乙</li></ul><button>取消</button><button>确定</button></div></div>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>function toggleCity(item) { const checkbox = item.querySelector('.city-checkbox'); checkbox.classList.toggle('status0'); checkbox.classList.toggle('status1'); }</script>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'city', label: '城市', fieldKind: 'multiSelect', value: ['a', 'b'],
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.city-checkbox.status1').count(), 2);
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects a job scope by value and applies company text through the shared condition action', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><div class="ui-dropmenu-list"><ul><li class="active" data-value="all" onclick="selectJob(this)">不限职位</li><li data-value="job-b" onclick="selectJob(this)">职位B</li></ul></div></div></div>
        <input class="input-text" placeholder="多个公司用空格隔开"><div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>function selectJob(item) { document.querySelectorAll('.ui-dropmenu-list li').forEach((entry) => entry.classList.remove('active')); item.classList.add('active'); document.querySelector('.search-current-job').textContent = item.textContent; }</script>`),
    });
    try {
      const deadline = Date.now() + 10_000;
      const jobResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'job_scope', label: '职位范围', fieldKind: 'singleSelect', value: 'job-b',
      }, deadline);
      assert.equal(jobResult.status, 'applied', jobResult.message);
      const companyResult = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'company', label: '公司', fieldKind: 'textInput', value: ['甲公司', '乙公司'],
      }, deadline);
      assert.equal(companyResult.status, 'applied', companyResult.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.search-current-job').first().innerText(), '职位B');
      assert.equal(await frame.locator('input.input-text').inputValue(), '甲公司 乙公司');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('accepts the exact active job-scope option when the display label remains stale', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: `<!doctype html><html><body>
        <div class="search-job-list-C"><div class="ui-dropmenu"><div class="ui-dropmenu-label"><span class="search-current-job">不限职位</span></div><ul class="ui-dropmenu-list"><li class="active" data-value="all" onclick="selectJob(this)">不限职位</li><li data-value="target" onclick="selectJob(this)">职位B</li></ul></div></div>
        <input class="search-input" value="测试关键词" /><div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div><div class="more-filter-container"></div><div class="geek-info-card">candidate card</div>
        <script>function selectJob(item) { document.querySelectorAll('.ui-dropmenu-list li').forEach((entry) => entry.classList.remove('active')); item.classList.add('active'); }</script>
      </body></html>`,
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'job_scope', label: '职位范围', fieldKind: 'singleSelect', value: 'target',
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.ui-dropmenu-list li.active').first().getAttribute('data-value'), 'target');
      assert.equal(await frame.locator('.search-current-job').innerText(), '不限职位');
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('selects an exact major dialog entry and confirms the dialog', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody(`<span class="reset-btn" ka="search_reset_search_params">清空筛选</span>
        <div class="degree-ui"><span class="degree-item active">不限</span></div><div class="school-ui"><span class="degree-item active">不限</span></div><div class="experience-select"><span class="exp-item active">不限</span></div><div class="age-select"><span class="age-item active">不限</span></div>
        <div class="more-filter-container">${Array.from({ length: 7 }, (_, index) => `<div class="filter-2-item" ${index === 6 ? 'onclick="document.querySelector(\'.major-dialog\').style.display=\'block\'"' : ''}><div class="major-input-ui">${index === 6 ? '专业' : '筛选' + index}</div></div>`).join('')}</div>
        <div class="major-dialog dialog-wrap" style="display:none"><input class="ipt" placeholder="请输入专业名称"><ul><li onclick="this.classList.add('selected')">测试专业</li></ul><button>取消</button><button onclick="this.closest('.major-dialog').style.display='none'">确定</button></div><div class="geek-info-card">candidate card</div>`),
    });
    try {
      const result = await applyBossSearchCondition(page, {
        kind: 'applicationFilter', fieldId: 'major', label: '专业', fieldKind: 'textInput', value: '测试专业',
      }, Date.now() + 10_000);
      assert.equal(result.status, 'applied', result.message);
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.equal(await frame.locator('.major-dialog li.selected').count(), 1);
      await assert.rejects(() => frame.locator('.major-dialog').waitFor({ state: 'visible', timeout: 50 }));
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });

  it('returns an explicit empty result instead of treating it as a failed extraction', async () => {
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>暂无相关人才</p>') });
    try {
      const frame = page.frame({ name: 'searchFrame' });
      assert.ok(frame);
      assert.match(await frame.locator('body').innerText(), /暂无相关人才/);
      const result = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.deepEqual(result.candidates, []);
    } finally {
      await browser.close();
    }
  });

  it('refuses to treat an unresolved search iframe as an empty result', async () => {
    const originalTimeout = config.playwright.searchPageTimeoutMs;
    config.playwright.searchPageTimeoutMs = 50;
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>正在加载</p>') });
    try {
      await assert.rejects(
        () => extractBossCandidateList(page),
        /Timeout|timeout/i,
      );
    } finally {
      config.playwright.searchPageTimeoutMs = originalTimeout;
      await browser.close();
    }
  });

  it('fails when the page reports a Boss data-loading error', async () => {
    const { browser, page } = await createSearchFixture({ body: searchBody('<p>数据加载异常</p>') });
    try {
      await assert.rejects(
        () => extractBossCandidateList(page, { deadline: Date.now() + 3_000 }),
        /Boss search reported a data-loading error/,
      );
    } finally {
      await browser.close();
    }
  });

  it('opens a detail only for the exact stable Boss candidate identity', async () => {
    const originalMin = config.playwright.actionDelayMinMsByPlatform.boss;
    const originalMax = config.playwright.actionDelayMaxMsByPlatform.boss;
    config.playwright.actionDelayMinMsByPlatform.boss = 0;
    config.playwright.actionDelayMaxMsByPlatform.boss = 0;
    const { browser, page } = await createSearchFixture({
      body: searchBody('<div class="geek-info-card"><a ka="search_click_open_resume" data-expect="boss-candidate-1" href="#resume" onclick="openResume(); return false"><div class="geek-info-detail" style="display:block;width:120px;height:80px">候选人甲</div></a></div>'),
    });
    try {
      const { candidates } = await extractBossCandidateList(page, { deadline: Date.now() + 3_000 });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.candidateId, 'boss-candidate-1');

      await openBossResumeDetail(page.context(), page, candidates[0]!);
      assert.equal(await page.locator('.dialog-wrap.active[data-type="boss-dialog"]').count(), 1);

      await assert.rejects(
        () => openBossResumeDetail(page.context(), page, { candidateId: 'missing-candidate' }),
        /Could not uniquely find Boss candidate card for missing-candidate; matched 0/,
      );
      await assert.rejects(
        () => openBossResumeDetail(page.context(), page, { candidateId: 'boss-card-unstable' }),
        /card has no stable Boss identity/,
      );
    } finally {
      config.playwright.actionDelayMinMsByPlatform.boss = originalMin;
      config.playwright.actionDelayMaxMsByPlatform.boss = originalMax;
      await browser.close();
    }
  });
});
