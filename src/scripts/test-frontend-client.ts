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
    bossRejectionEmails: {
      outboxCount: 4,
      pending: 0,
      sending: 1,
      sent: 1,
      retryableFailed: 0,
      retryExhausted: 1,
      uncertain: 1,
      superseded: 0,
    },
  };
}

async function mockApi(page: Page, options: { assistantValidationGate?: Promise<void> } = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let body: unknown = {};

    if (request.method() === 'POST' && pathname === '/api/tasks/boss-talent-search') {
      body = { taskId: 'task-talent-1', kind: 'boss-talent-search', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/assistant/chat') {
      const payload = request.postDataJSON() as { messages?: Array<{ role?: string; content?: string }> };
      const latestUserMessage = [...(payload.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '';
      body = latestUserMessage.includes('订阅搜索和订阅管理')
        ? {
          message: {
            role: 'assistant',
            content: 'assistant-mode-ambiguous: 请明确选择一个模式。',
            createdAt: '2026-08-05T00:01:00.000Z',
          },
          clarificationQuestions: ['请明确选择“订阅搜索”“直接搜索”或“订阅管理”中的一个模式。'],
        }
        : {
          message: {
            role: 'assistant',
            content: '已识别为订阅搜索，请核对模式和岗位身份。',
            createdAt: '2026-08-05T00:00:00.000Z',
          },
          draft: {
            modeId: 'capture.subscription-search',
            modeLabel: '订阅搜索',
            effectSummary: '使用平台已保存的订阅入口，可能打开候选详情并执行岗位已配置的评分、转发或邮件流程。',
            kind: 'resume-capture',
            input: {
              platform: 'boss',
              keyword: '全铝箱包设计',
              searchSource: 'saved',
            },
            missingFields: [],
            warnings: ['风险：Boss 普通抓取会打开候选详情，并可能复用岗位已保存的转发、报告邮件和模型分流配置。'],
            argvPreview: ['--search-source', 'saved'],
          },
          clarificationQuestions: [],
        };
    } else if (request.method() === 'POST' && pathname === '/api/assistant/validate') {
      await options.assistantValidationGate;
      const payload = request.postDataJSON() as { draft?: unknown };
      body = {
        message: {
          role: 'assistant',
          content: '旧草稿已重新校验。',
          createdAt: '2026-08-05T00:00:30.000Z',
        },
        draft: payload.draft,
        clarificationQuestions: [],
      };
    } else if (request.method() === 'POST' && pathname === '/api/assistant/confirm') {
      body = { task: { taskId: 'task-assistant-capture-1' }, kind: 'resume-capture' };
    } else if (request.method() === 'POST' && pathname === '/api/tasks/resume-capture') {
      body = { taskId: 'task-capture-1', kind: 'resume-capture', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/tasks/boss-greet') {
      body = { taskId: 'task-greet-1', kind: 'boss-greet', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/tasks/talent-mapping') {
      body = { taskId: 'task-mapping-1', kind: 'talent-mapping', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/talent-mappings/mapping-1/classification-suggestions/generate') {
      body = { taskId: 'task-classification-1', kind: 'talent-mapping-classification', status: 'queued' };
    } else if (request.method() === 'POST' && pathname === '/api/talent-mappings/mapping-1/entity-links') {
      body = { entityId: 'entity-1', platformCandidateKeys: ['51job:candidate-1', 'liepin:candidate-2'], confirmedAt: '2026-07-28T00:02:00.000Z', confirmedBy: '审核员', evidence: '人工核对' };
    } else if (pathname === '/api/tasks/task-capture-1') {
      body = {
        taskId: 'task-capture-1',
        kind: 'resume-capture',
        status: 'succeeded',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        logs: [],
        input: {
          platform: 'boss',
          keyword: '全铝箱包设计',
          bossSecondaryEmail: 'secondary@example.com',
          bossSecondaryCc: ['audit@example.com'],
        },
        output: {
          jobKey: 'boss-job-1',
          totalCandidates: 5,
          capturedCandidates: 5,
          scoredCandidates: 4,
          failedCandidates: 1,
          resultPath: 'data/boss/jobs/boss-job-1/runs/run.json',
          bossRouting: {
            enabled: true,
            qualifiedCandidateIds: ['qualified-1'],
            reviewCandidateIds: ['review-1'],
            rejectedCandidateIds: ['rejected-1', 'rejected-2'],
            pendingScoreCandidateIds: ['pending-score-1'],
            scoreFailureStatusCounts: { 'connection-timeout@initializing': 1 },
            forwardingStatusCounts: { sent: 2 },
            rejectionEmailStatusCounts: { sent: 1, uncertain: 1 },
          },
          rejectionEmails: {
            eligible: 2,
            pending: 0,
            sending: 0,
            sent: 1,
            retryableFailed: 0,
            uncertain: 1,
            superseded: 0,
            failedCandidateIds: ['rejected-2'],
            deliveryTargets: [{
              recipientEmail: 'secondary@example.com',
              ccEmails: ['audit@example.com'],
            }],
          },
        },
      };
    } else if (pathname === '/api/tasks/task-capture-inherited') {
      body = {
        taskId: 'task-capture-inherited',
        kind: 'resume-capture',
        status: 'succeeded',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        logs: [],
        input: {
          platform: 'boss',
          keyword: '全铝箱包设计',
          bossCaptureTaskSnapshot: {
            version: 4,
            deliveryAndScreening: {
              screening: {
                secondaryDelivery: {
                  recipientEmail: 'snapshot-secondary@example.com',
                  ccEmails: ['snapshot-audit@example.com'],
                },
              },
            },
          },
        },
        output: {
          jobKey: 'boss-job-inherited',
          totalCandidates: 1,
          capturedCandidates: 0,
          scoredCandidates: 0,
          failedCandidates: 1,
          bossRouting: {
            enabled: true,
            qualifiedCandidateIds: [],
            reviewCandidateIds: [],
            rejectedCandidateIds: ['rejected-sending'],
            forwardingStatusCounts: {},
            rejectionEmailStatusCounts: { sending: 1 },
          },
          rejectionEmails: {
            eligible: 1,
            pending: 0,
            sending: 1,
            sent: 0,
            retryableFailed: 0,
            uncertain: 0,
            superseded: 0,
            failedCandidateIds: ['rejected-sending'],
          },
        },
      };
    } else if (pathname === '/api/tasks/task-capture-batch') {
      body = {
        taskId: 'task-capture-batch',
        kind: 'resume-capture',
        status: 'succeeded',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        logs: [],
        input: { platform: 'all', includeBoss: true, jobsFile: './jobs.json' },
        output: [{
          platform: 'boss',
          keyword: '全铝箱包设计',
          summary: {
            jobKey: 'boss-job-batch',
            totalCandidates: 1,
            capturedCandidates: 1,
            scoredCandidates: 1,
            failedCandidates: 0,
            bossRouting: {
              enabled: true,
              qualifiedCandidateIds: [],
              reviewCandidateIds: [],
              rejectedCandidateIds: ['batch-rejected'],
              forwardingStatusCounts: {},
              rejectionEmailStatusCounts: { sent: 1 },
            },
            rejectionEmails: {
              eligible: 1,
              pending: 0,
              sending: 0,
              sent: 1,
              retryableFailed: 0,
              uncertain: 0,
              superseded: 0,
              failedCandidateIds: [],
              deliveryTargets: [{
                recipientEmail: 'batch-secondary@example.com',
                ccEmails: ['batch-audit@example.com'],
              }],
            },
          },
        }],
      };
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
    } else if (pathname === '/api/tasks/task-subscription-1') {
      body = {
        taskId: 'task-subscription-1',
        kind: 'search-subscription',
        status: 'succeeded',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        logs: [],
        output: {
          platform: 'boss',
          keyword: '铝镁合金 拉杆箱',
          resultTotal: 4,
          resultTotalSource: 'page',
          saveRequested: true,
          saved: true,
          allConditionsApplied: true,
          conditionStatusCounts: { applied: 2, skipped: 0, failed: 0 },
          saveOutcome: 'renamed',
          sortPolicy: 'match-priority',
          savedSearch: {
            name: '铝镁合金',
            nativeId: 'subscription-1',
            expectedKeyword: '铝镁合金 拉杆箱',
            conditionIdentity: { jobScope: '全铝箱包设计' },
            conditionFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      };
    } else if (pathname === '/api/tasks/task-subscription-failed') {
      body = {
        taskId: 'task-subscription-failed',
        kind: 'search-subscription',
        status: 'failed',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        error: 'Search subscription stopped at boss: Boss subscription failed',
        logs: [],
        output: {
          mode: 'search-subscription',
          status: 'failed',
          completedPlatforms: ['51job', 'liepin', 'zhilian'],
          stoppedPlatform: 'boss',
          error: 'Boss subscription failed',
          results: [{
            platform: '51job',
            keyword: '铝镁合金 拉杆箱',
            resultTotal: 8,
            resultTotalSource: 'page',
            saveRequested: true,
            saved: true,
            allConditionsApplied: true,
            conditionStatusCounts: { applied: 0, skipped: 0, failed: 0 },
            saveOutcome: 'saved',
          }],
        },
      };
    } else if (pathname === '/api/tasks') {
      body = { tasks: [] };
    } else if (pathname === '/api/dashboard/health') {
      body = dashboardHealth();
    } else if (pathname === '/api/jobs/boss/boss-job-1') {
      body = {
        platform: 'boss',
        jobKey: 'boss-job-1',
        searchKeyword: '全铝箱包设计',
        title: '全铝箱包设计',
        runCount: 0,
        candidateCount: 0,
        scoreCount: 0,
        artifacts: [],
        jobRecord: {
          jobKey: 'boss-job-1',
          platform: 'boss',
          searchKeyword: '全铝箱包设计',
          createdAt: '2026-07-30T00:00:00.000Z',
          rawText: '职位说明',
          normalizedJob: { title: '全铝箱包设计', majors: [], languageRequirements: [], responsibilities: [], hardRequirements: [], preferredRequirements: [], regionPreferences: [], industryTags: [] },
          searchSettings: {
            source: 'direct',
            conditions: [],
            conditionSetRef: { conditionSetId: 'scs-boss-1', platform: 'boss', revision: 1 },
          },
        },
      };
    } else if (pathname === '/api/ops/search-condition-sets/scs-boss-1') {
      body = {
        conditionSet: {
          conditionSetId: 'scs-boss-1', platform: 'boss', revision: 1, name: '全铝箱包设计筛选', defaultKeyword: '铝',
          status: 'active', fieldCount: 5, createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z', applicationFilterInput: {},
        },
        revisions: [],
        compatibility: { status: 'compatible' },
      };
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
      body = { changes: { status: 'insufficient', mappingKey: 'mapping-1', compareRunId: 'scan-run-1', generatedAt: '2026-07-28T00:01:00.000Z', comparisonReasons: ['至少需要两次成功的 scan/all 运行。'], newProfiles: [], notObservedProfiles: [], changedProfiles: [], unchangedProfiles: 0, caveat: '本轮未再次观察不能解释为离职。' } };
    } else if (pathname === '/api/talent-mappings/mapping-1/entity-links') {
      body = { entityLinks: { platformProfileCount: 2, confirmedEntityCount: 2, activeLinks: [], revokedLinks: [], suggestions: [{ suggestionId: 'link-suggestion-1', platformCandidateKeys: ['51job:candidate-1', 'liepin:candidate-2'], evidence: ['姓名完全一致', '当前公司一致', '当前岗位一致'] }] } };
    } else if (pathname === '/api/talent-mappings/mapping-1/classification-suggestions') {
      body = { suggestions: [] };
    } else if (pathname === '/api/schedules') {
      body = { schedules: [] };
    } else if (pathname === '/api/boss/positions') {
      body = { positions: [{ bossJobId: 'boss-job-1', name: '全铝箱包设计', status: 'open', jobKey: 'boss-job-1' }] };
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

  it('shows assistant mode facts and keeps derived search fields out of editing', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/assistant`, { waitUntil: 'networkidle' });

    await page.getByPlaceholder('例如：只读列出 Boss 未读会话').fill('运行全铝箱包设计的订阅搜索');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('订阅搜索 · 类型：resume-capture', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(/使用平台已保存的订阅入口/).waitFor({ state: 'visible' });
    assert.equal(await page.getByLabel('searchSource', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('argvPreview', { exact: true }).count(), 0);

    const confirmButton = page.getByRole('button', { name: '确认', exact: true });
    assert.equal(await confirmButton.isDisabled(), true);
    await page.getByLabel('我已核对目标身份和外部操作风险', { exact: true }).check();
    const confirmRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/assistant/confirm');
    await confirmButton.click();
    const payload = (await confirmRequest).postDataJSON() as { draft?: { modeId?: string; input?: Record<string, unknown> }; riskAccepted?: boolean };
    assert.equal(payload.draft?.modeId, 'capture.subscription-search');
    assert.equal(payload.draft?.input?.searchSource, 'saved');
    assert.equal(payload.riskAccepted, true);
    await page.getByText(/任务已创建：/).waitFor({ state: 'visible' });
    await page.close();
  });

  it('invalidates the previous executable draft when the latest mode request needs clarification', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/assistant`, { waitUntil: 'networkidle' });

    const composer = page.getByPlaceholder('例如：只读列出 Boss 未读会话');
    await composer.fill('运行全铝箱包设计的订阅搜索');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('订阅搜索 · 类型：resume-capture', { exact: true }).waitFor({ state: 'visible' });

    await composer.fill('改成订阅搜索和订阅管理');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText(/assistant-mode-ambiguous/).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: '确认', exact: true }).count(), 0);
    await page.getByText('草稿将在这里显示并允许人工核对。', { exact: true }).waitFor({ state: 'visible' });
    await page.close();
  });

  it('does not resurrect an invalidated draft when an older validation response arrives late', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    await mockApi(page, { assistantValidationGate: validationGate });
    await page.goto(`${baseUrl}/assistant`, { waitUntil: 'networkidle' });

    const composer = page.getByPlaceholder('例如：只读列出 Boss 未读会话');
    await composer.fill('运行全铝箱包设计的订阅搜索');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('订阅搜索 · 类型：resume-capture', { exact: true }).waitFor({ state: 'visible' });

    const validationRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/assistant/validate');
    await page.getByRole('button', { name: '重新校验', exact: true }).click();
    await validationRequest;

    await composer.fill('改成订阅搜索和订阅管理');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText(/assistant-mode-ambiguous/).waitFor({ state: 'visible' });

    const validationResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assistant/validate');
    releaseValidation();
    await validationResponse;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    assert.equal(await page.getByRole('button', { name: '确认', exact: true }).count(), 0);
    await page.getByText('草稿将在这里显示并允许人工核对。', { exact: true }).waitFor({ state: 'visible' });
    await page.close();
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

  it('submits an explicit Boss opt-in only for all-platform capture', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });

    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('all');
    const includeBoss = page.getByLabel('包含 Boss 直聘·直猎邦 Pro', { exact: true });
    await includeBoss.waitFor({ state: 'visible' });
    const searchSource = page.locator('label').filter({ hasText: /^搜索来源/ }).locator('select');
    assert.equal(await searchSource.locator('option[value="saved"]').textContent(), '订阅搜索');
    await includeBoss.check();
    await page.getByLabel('岗位名称', { exact: true }).fill('物业电工');
    await page.getByLabel('JD 文本', { exact: true }).fill('负责物业电气维修');

    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/resume-capture');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.equal(payload.platform, 'all');
    assert.equal(payload.includeBoss, true);
    assert.equal(payload.keyword, '物业电工');
    await page.close();
  });

  it('submits Boss as an explicit fourth stage for search-subscription with separate side-effect copy', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: '订阅管理', exact: true }).click();
    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('all');
    const includeBoss = page.getByLabel('订阅管理包含 Boss 第 4 阶段', { exact: true });
    await includeBoss.check();
    await page.getByLabel('订阅文件', { exact: true }).fill('./subscription.json');
    await page.getByLabel('订阅名称', { exact: true }).fill('铝镁合金');
    await page.getByLabel('保存平台订阅', { exact: true }).check();
    await page.getByText(/只选择或保存平台原生订阅/).waitFor({ state: 'visible' });

    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/search-subscription');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.equal(payload.platform, 'all');
    assert.equal(payload.includeBoss, true);
    assert.equal(payload.searchSubscriptionFile, './subscription.json');
    assert.equal(payload.saveSearchSubscription, true);
    assert.equal(payload.searchSubscriptionName, '铝镁合金');
    await page.close();
  });

  it('shows native subscription outcome, reference identity, and sort policy in task details', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/tasks/task-subscription-1`, { waitUntil: 'networkidle' });
    await page.getByText(/名称：铝镁合金/).waitFor({ state: 'visible' });
    const body = await page.locator('body').innerText();
    assert.match(body, /renamed/);
    assert.match(body, /match-priority/);
    assert.match(body, /Boss 原生订阅引用/);
    assert.match(body, /不会抓取候选/);
    await page.close();
  });

  it('shows Boss rejection email targets, counts, and uncertain delivery warning', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/tasks/task-capture-1`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    assert.match(body, /否定简历邮件/);
    assert.match(body, /secondary@example.com/);
    assert.match(body, /audit@example.com/);
    assert.match(body, /应发份数\s*2/);
    assert.match(body, /已发送\s*1/);
    assert.match(body, /评分未决\s*1/);
    assert.match(body, /connection-timeout@initializing: 1/);
    assert.match(body, /不会转发或发送否定邮件/);
    assert.doesNotMatch(body, /pending-score-1/);
    assert.match(body, /结果不确定\s*1/);
    assert.match(body, /系统不会自动重发/);
    assert.match(body, /rejected-2/);
    await page.close();
  });

  it('shows inherited snapshot targets, sending state, and wrapped batch Boss output', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/tasks/task-capture-inherited`, { waitUntil: 'networkidle' });
    let body = await page.locator('body').innerText();
    assert.match(body, /snapshot-secondary@example.com/);
    assert.match(body, /snapshot-audit@example.com/);
    assert.match(body, /发送中断待核对\s*1/);
    assert.match(body, /停留在 sending/);

    await page.goto(`${baseUrl}/tasks/task-capture-batch`, { waitUntil: 'networkidle' });
    body = await page.locator('body').innerText();
    assert.match(body, /boss · 全铝箱包设计/);
    assert.match(body, /batch-secondary@example.com/);
    assert.match(body, /batch-audit@example.com/);
    assert.match(body, /已发送\s*1/);
    await page.close();
  });

  it('shows sending and uncertain Boss rejection emails as dashboard alerts', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    assert.match(body, /1 封停留在 sending/);
    assert.match(body, /1 封结果不确定/);
    assert.match(body, /1 封自动重试已用尽/);
    assert.match(body, /发送中\s*1/);
    assert.match(body, /自动重试已用尽\s*1/);
    await page.close();
  });

  it('shows completed platforms and the stop platform for a failed all-platform subscription', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/tasks/task-subscription-failed`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    assert.match(body, /订阅管理在 boss 停止/);
    assert.match(body, /51job → liepin → zhilian/);
    assert.match(body, /Boss subscription failed/);
    assert.match(body, /已保存 · saved/);
    await page.close();
  });

  it('submits Boss post-score screening with primary forwarding and rejection email targets', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });

    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('boss');
    await page.getByLabel('岗位名称', { exact: true }).fill('物业电工');
    await page.getByLabel('JD 文本', { exact: true }).fill('负责物业电气维修');
    const screeningSwitch = page.getByLabel('启用 Boss 评分后模型要求分流', { exact: true });
    await screeningSwitch.check();
    assert.equal(await screeningSwitch.isChecked(), true);
    await page.getByText(/需复核者转发给主受众/).waitFor({ state: 'visible' });
    assert.match(await page.locator('body').innerText(), /明确否定简历逐份邮件/);
    await page.getByLabel('模型要求策略文件（可选，留空复用岗位已保存策略）', { exact: true }).fill('./boss-model-requirements.json');
    await page.getByLabel(/^(主)?报告邮箱$/).fill('primary@example.com');
    const bossScreeningFields = page.locator('.form-grid');
    await bossScreeningFields.locator('label').filter({ hasText: '否定简历副收件人' }).locator('input').fill('secondary@example.com');
    await bossScreeningFields.locator('label').filter({ hasText: '否定简历邮件抄送' }).locator('input').fill('audit@example.com');

    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/resume-capture');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.equal(payload.platform, 'boss');
    assert.equal(payload.bossScreeningEnabled, true);
    assert.equal(payload.bossScreeningPolicyFile, './boss-model-requirements.json');
    assert.equal(payload.email, 'primary@example.com');
    assert.equal(payload.bossSecondaryEmail, 'secondary@example.com');
    assert.deepStrictEqual(payload.bossSecondaryCc, ['audit@example.com']);
    await page.close();
  });

  it('keeps Boss screening inherit, enable, and disable as distinct request intents', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });
    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('boss');
    await page.getByLabel('岗位名称', { exact: true }).fill('物业电工');
    await page.getByLabel('JD 文本', { exact: true }).fill('负责物业电气维修');
    const screeningChoice = page.locator('label').filter({ hasText: 'Boss 评分后模型要求分流' }).locator('select').first();
    await screeningChoice.selectOption('disabled');

    const disabledSubmitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/resume-capture');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const disabledPayload = (await disabledSubmitted).postDataJSON() as Record<string, unknown>;
    assert.equal(disabledPayload.bossScreeningEnabled, false);
    await page.close();

    const inheritedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(inheritedPage);
    await inheritedPage.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });
    await inheritedPage.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('boss');
    await inheritedPage.getByLabel('岗位名称', { exact: true }).fill('物业电工');
    await inheritedPage.getByLabel('JD 文本', { exact: true }).fill('负责物业电气维修');
    const inheritedSubmitted = inheritedPage.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/resume-capture');
    await inheritedPage.getByRole('button', { name: '提交任务', exact: true }).click();
    const inheritedPayload = (await inheritedSubmitted).postDataJSON() as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(inheritedPayload, 'bossScreeningEnabled'), false);
    await inheritedPage.close();
  });

  it('keeps the selected Boss job identity separate from its page search keyword', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(page);
    await page.goto(`${baseUrl}/run`, { waitUntil: 'networkidle' });

    await page.locator('label').filter({ hasText: /^平台/ }).first().locator('select').selectOption('boss');
    await page.locator('label').filter({ hasText: 'Boss 已同步岗位' }).locator('select').selectOption('boss-job-1');
    await page.getByText(/条件集默认搜索词：铝；已保存条件集：scs-boss-1@1/).waitFor({ state: 'visible' });
    assert.equal(await page.getByLabel('岗位名称', { exact: true }).inputValue(), '全铝箱包设计');
    await page.getByLabel('Boss 页面搜索词（可选覆盖）', { exact: true }).fill('铝制行李箱');

    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks/resume-capture');
    await page.getByRole('button', { name: '提交任务', exact: true }).click();
    const payload = (await submitted).postDataJSON() as Record<string, unknown>;
    assert.equal(payload.keyword, '全铝箱包设计');
    assert.equal(payload.bossJobId, 'boss-job-1');
    assert.equal(payload.bossSearchKeyword, '铝制行李箱');
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
