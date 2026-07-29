import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';

let previewServer: PreviewServer;
let browser: Browser;
let baseUrl: string;

before(async () => {
  previewServer = await preview({
    configFile: path.resolve('frontend/vite.config.ts'),
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  const address = previewServer.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await previewServer?.close();
});

function dashboardHealth(): Record<string, unknown> {
  return {
    generatedAt: '2026-07-25T00:00:00.000Z',
    dataAnomalies: [],
    platformRuns: [],
    candidateFunnels: [],
    sessions: [],
    filters: [],
    tasks: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  };
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let body: unknown = {};

    if (request.method() === 'POST' && pathname === '/api/tasks/boss-talent-search') {
      body = { taskId: 'task-talent-1', kind: 'boss-talent-search', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/tasks/boss-greet') {
      body = { taskId: 'task-greet-1', kind: 'boss-greet', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/tasks/talent-mapping') {
      body = { taskId: 'task-mapping-1', kind: 'talent-mapping', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/talent-mappings/mapping-1/classification-suggestions/generate') {
      body = { taskId: 'task-classification-1', kind: 'talent-mapping-classification', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/talent-mappings/mapping-1/entity-links') {
      body = { entityId: 'entity-1', platformCandidateKeys: ['51job:candidate-1', 'liepin:candidate-2'], confirmedAt: '2026-07-28T00:02:00.000Z', confirmedBy: '审核员', evidence: '人工核对' };
    } else if (pathname === '/api/tasks/task-talent-1') {
      body = {
        taskId: 'task-talent-1',
        kind: 'boss-talent-search',
        status: 'succeeded',
        output: {
          platform: 'boss',
          source: 'deep-search',
          matched: false,
          form: {
            bossJobId: 'boss-job-1',
            jobName: '门店店长',
            coreRequirements: ['零售管理'],
            bonusRequirements: [],
            remainingMatchCount: 2,
            matchButtonEnabled: true,
          },
          candidates: [{
            candidateId: 'candidate-1',
            name: '候选人甲',
            summary: '五年零售门店管理经验',
            contactState: 'greet',
            source: 'deep-search',
            searchResultIndex: 0,
          }],
        },
      };
    } else if (pathname === '/api/tasks') {
      body = { tasks: [] };
    } else if (pathname === '/api/dashboard/health') {
      body = dashboardHealth();
    } else if (pathname === '/api/jobs') {
      body = { jobs: [] };
    } else if (pathname === '/api/talent-mappings') {
      body = {
        mappings: [{
          mappingKey: 'mapping-1',
          name: '示例人才地图',
          objective: { roleFamilies: ['区域运营'], locations: ['上海'] },
          enrichmentMode: 'targeted-detail',
          sliceCount: 1,
          platforms: ['51job'],
          candidateCount: 2,
          enrichedCandidateCount: 0,
          unclassifiedCandidateCount: 0,
          companyMatrixRowCount: 1,
          activeEntityLinkCount: 0,
          confirmedEntityCount: 2,
          pendingClassificationSuggestionCount: 0,
          runCount: 1,
          latestRun: { runId: 'scan-run-1', stage: 'scan', status: 'completed', platformSelection: '51job', startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T00:01:00.000Z', detailOpenSideEffect: 'none', gapCount: 0 },
          createdAt: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:01:00.000Z',
        }],
      };
    } else if (pathname === '/api/talent-mappings/mapping-1') {
      body = {
        project: {
          version: 1,
          mappingKey: 'mapping-1',
          name: '示例人才地图',
          objective: { roleFamilies: ['区域运营'], locations: ['上海'] },
          taxonomy: { targetCompanies: [], roleFamilies: [], levels: [] },
          slices: [],
          coverage: { maxBatchesPerSlice: 3, maxCandidatesPerSlice: 50, sliceTimeoutMs: 120000 },
          enrichment: { mode: 'targeted-detail', maxProfilesPerSlice: 2, maxProfilesTotal: 2, selection: { samplePerMatrixCell: 2 } },
          sourceFilePath: '/fixtures/mapping-1.json',
          createdAt: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:01:00.000Z',
        },
        summary: {
          mappingKey: 'mapping-1', name: '示例人才地图', objective: { roleFamilies: ['区域运营'], locations: ['上海'] }, enrichmentMode: 'targeted-detail', sliceCount: 1, platforms: ['51job'], candidateCount: 2, enrichedCandidateCount: 0, unclassifiedCandidateCount: 0, companyMatrixRowCount: 1, activeEntityLinkCount: 0, confirmedEntityCount: 2, pendingClassificationSuggestionCount: 0, runCount: 1,
          latestRun: { runId: 'scan-run-1', stage: 'scan', status: 'completed', platformSelection: '51job', startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T00:01:00.000Z', detailOpenSideEffect: 'none', gapCount: 0 },
          createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:01:00.000Z',
        },
        detailSelection: { available: true, sourceScanRunId: 'scan-run-1', platformSelection: '51job', candidateCount: 2, candidatesByPlatform: { '51job': 2 }, candidatesBySlice: [{ sliceId: 'slice-1', platform: '51job', candidateCount: 2 }] },
        identityPolicy: { platformScoped: true, crossPlatformAutoMerge: false, humanConfirmedLinking: true },
      };
    } else if (pathname === '/api/talent-mappings/mapping-1/runs') {
      body = { runs: [] };
    } else if (pathname === '/api/talent-mappings/mapping-1/candidates') {
      body = { candidates: [{ platform: '51job', platformCandidateKey: '51job:candidate-1', candidateId: 'candidate-1', name: '候选人甲', currentCompany: '示例公司', currentTitle: '区域经理', firstObservedAt: '2026-07-28T00:00:00.000Z', lastObservedAt: '2026-07-28T00:01:00.000Z', sourceSliceIds: ['slice-1'], observationCount: 1, detailStatus: 'not-enriched' }, { platform: 'liepin', platformCandidateKey: 'liepin:candidate-2', candidateId: 'candidate-2', name: '候选人甲', currentCompany: '示例公司', currentTitle: '区域经理', firstObservedAt: '2026-07-28T00:00:00.000Z', lastObservedAt: '2026-07-28T00:01:00.000Z', sourceSliceIds: ['slice-1'], observationCount: 1, detailStatus: 'not-enriched' }] };
    } else if (pathname === '/api/talent-mappings/mapping-1/companies') {
      body = { companies: [] };
    } else if (pathname === '/api/talent-mappings/mapping-1/coverage') {
      body = { coverage: [] };
    } else if (pathname === '/api/talent-mappings/mapping-1/changes') {
      body = { changes: { status: 'insufficient-runs', mappingKey: 'mapping-1', compareRunId: 'scan-run-1', generatedAt: '2026-07-28T00:01:00.000Z', newProfiles: [], notObservedProfiles: [], changedProfiles: [], unchangedProfiles: 0, caveat: '本轮未再次观察不能解释为离职。' } };
    } else if (pathname === '/api/talent-mappings/mapping-1/entity-links') {
      body = { entityLinks: { platformProfileCount: 2, confirmedEntityCount: 2, activeLinks: [], revokedLinks: [], suggestions: [{ suggestionId: 'link-suggestion-1', platformCandidateKeys: ['51job:candidate-1', 'liepin:candidate-2'], evidence: ['姓名完全一致', '当前公司一致', '当前岗位一致'] }] } };
    } else if (pathname === '/api/talent-mappings/mapping-1/classification-suggestions') {
      body = { suggestions: [] };
    } else if (pathname === '/api/schedules') {
      body = { schedules: [] };
    } else if (pathname === '/api/boss/positions') {
      body = { positions: [] };
    } else if (pathname === '/api/boss/job-sync/runs') {
      body = { runs: [] };
    } else if (pathname === '/api/boss/chat-reviews') {
      body = { runs: [] };
    } else if (pathname === '/api/boss/chat-receipts') {
      body = { receipts: [] };
    } else if (pathname === '/api/ops/filter-catalogs') {
      body = { catalogs: [] };
    } else if (pathname === '/api/health') {
      body = { status: 'ok', service: 'autorecruit-console-api' };
    }

    await route.fulfill({
      status: request.method() === 'POST' ? 202 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

describe('frontend client', () => {
  it('renders every top-level route without viewport overflow or console errors', async () => {
    const routes = ['/', '/tasks', '/jobs', '/talent-mappings', '/boss', '/automation', '/knowledge', '/assistant', '/settings', '/run'];
    for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await mockApi(page);

      for (const route of routes) {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
        await page.locator('h1').waitFor({ state: 'visible' });
        const layout = await page.evaluate(`({
          bodyWidth: document.body.scrollWidth,
          viewportWidth: window.innerWidth,
          heading: document.querySelector('h1')?.textContent ?? ''
        })`) as { bodyWidth: number; viewportWidth: number; heading: string };
        assert.ok(layout.heading, `${route} should render a page heading`);
        assert.ok(layout.bodyWidth <= layout.viewportWidth, `${route} overflows at ${viewport.width}px: ${layout.bodyWidth}px`);
      }

      assert.deepStrictEqual(consoleErrors, []);
      await page.close();
    }
  });

  it('submits the exact reviewed intent ID for a confirmed Boss greet', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/boss`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: '人才发现', exact: true }).click();
    await page.getByRole('button', { name: '深度搜索', exact: true }).click();
    await page.getByLabel('核心要求（逗号分隔）', { exact: true }).fill('零售管理');
    await page.getByRole('button', { name: '只读查看', exact: true }).click();
    const candidate = page.getByRole('button', { name: /候选人甲/ });
    await candidate.waitFor({ state: 'visible' });
    await candidate.click();
    await page.getByRole('button', { name: '单人打招呼', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    const reviewedIntentId = (await dialog.locator('.mono').allTextContents())
      .find((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
    assert.ok(reviewedIntentId, 'confirmation dialog should display the actual intent ID');

    const confirm = dialog.getByRole('button', { name: '确认打招呼', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await dialog.getByRole('checkbox').check();
    assert.equal(await confirm.isEnabled(), true);

    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/boss-greet');
    await confirm.click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.equal(payload.confirmed, true);
    assert.equal(payload.intentId, reviewedIntentId);
    assert.equal(payload.candidateId, 'candidate-1');
    await page.close();
  });

  it('submits the exact Mapping detail count and current-run confirmation through the shared task endpoint', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/talent-mappings/mapping-1`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: '详情补全（2）', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    const dialogText = await dialog.textContent();
    assert.ok(dialogText);
    assert.match(dialogText, /打开 2 位候选人详情/);
    assert.match(dialogText, /可能改变平台“已查看”状态/);
    assert.match(dialogText, /scan-run-1/);

    const confirm = dialog.getByRole('button', { name: '确认打开详情', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await dialog.getByRole('checkbox').check();
    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/talent-mapping');
    await confirm.click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.deepStrictEqual(payload, {
      platform: '51job',
      talentMappingFile: '/fixtures/mapping-1.json',
      mappingStage: 'enrich',
      mappingRunId: 'scan-run-1',
      confirmedDetailOpen: true,
    });
    await page.close();
  });

  it('requires human evidence for Mapping entity links and queues redacted classification suggestions', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/talent-mappings/mapping-1`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: '实体关联', exact: true }).click();
    await page.getByLabel('审核人', { exact: true }).fill('审核员');
    await page.getByLabel('确认依据', { exact: true }).fill('人工核对');
    await page.getByRole('button', { name: '确认同一实体', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').check();
    const entityRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/talent-mappings/mapping-1/entity-links');
    await dialog.getByRole('button', { name: '确认关联', exact: true }).click();
    assert.deepStrictEqual((await entityRequest).postDataJSON(), {
      platformCandidateKeys: ['51job:candidate-1', 'liepin:candidate-2'],
      confirmedBy: '审核员',
      evidence: '人工核对',
    });

    await page.getByRole('button', { name: '历次变化', exact: true }).click();
    await page.getByText('至少需要两次成功扫描', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '分类审核', exact: true }).click();
    const classificationRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/talent-mappings/mapping-1/classification-suggestions/generate');
    await page.getByRole('button', { name: '生成最多 25 条建议', exact: true }).click();
    assert.deepStrictEqual((await classificationRequest).postDataJSON(), { limit: 25 });
    await page.getByText(/分类建议任务已入队/).waitFor({ state: 'visible' });
    await page.close();
  });

  it('creates only a scan-stage Talent Mapping schedule from the automation page', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/automation`, { waitUntil: 'networkidle' });

    await page.getByLabel('计划名称', { exact: true }).fill('每日人才市场扫描');
    await page.locator('label').filter({ hasText: '任务类型' }).locator('select').selectOption('talent-mapping');
    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('all');
    await page.locator('label').filter({ hasText: 'card-only Mapping 计划文件' }).locator('input').fill('/fixtures/mapping-card-only.json');
    const submitted = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/schedules');
    await page.getByRole('button', { name: '创建暂停计划', exact: true }).click();
    const payload = (await submitted).postDataJSON() as {
      enabled: boolean;
      tasks: Array<{ kind: string; input: Record<string, unknown> }>;
    };
    assert.equal(payload.enabled, false);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0]?.kind, 'talent-mapping');
    assert.deepStrictEqual(payload.tasks[0]?.input, {
      platform: 'all',
      talentMappingFile: '/fixtures/mapping-card-only.json',
      mappingStage: 'scan',
    });
    await page.close();
  });
});
