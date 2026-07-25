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
    const routes = ['/', '/tasks', '/jobs', '/boss', '/automation', '/knowledge', '/assistant', '/settings', '/run'];
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
});
