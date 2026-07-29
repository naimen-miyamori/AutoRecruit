import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TalentMappingPlan, TalentMappingRunSummary } from '../types/talent-mapping.js';

async function loadIndexModule(): Promise<typeof import('../index.js')> {
  const scriptPath = fileURLToPath(new URL('../index.ts', import.meta.url));
  return import(`${pathToFileURL(scriptPath).href}?talentMappingCliTest=${Date.now()}-${Math.random()}`);
}

const plan: TalentMappingPlan = {
  version: 1,
  mappingKey: 'cli-test',
  name: 'CLI 脱敏测试',
  objective: { roleFamilies: ['运营'], locations: ['上海'] },
  taxonomy: {
    targetCompanies: [],
    roleFamilies: [{ roleKey: 'operations', displayName: '运营', titleAliases: ['运营经理'] }],
    levels: ['经理'],
  },
  slices: [],
  coverage: { maxBatchesPerSlice: 1, maxCandidatesPerSlice: 10, sliceTimeoutMs: 30000 },
  enrichment: {
    mode: 'targeted-detail',
    maxProfilesPerSlice: 2,
    maxProfilesTotal: 2,
    selection: { samplePerMatrixCell: 1 },
  },
};

const summary: TalentMappingRunSummary = {
  mode: 'talent-mapping',
  mappingKey: plan.mappingKey,
  runId: 'run-cli',
  stage: 'all',
  status: 'completed',
  platformSelection: 'all',
  observedCards: 3,
  uniquePlatformProfiles: 3,
  enrichedProfiles: 1,
  failedProfiles: 0,
  cappedSlices: 0,
  exportDir: '/tmp/exports',
  runPath: '/tmp/run.json',
  detailOpenSideEffect: 'may-mark-viewed',
};

async function silenceConsole<T>(operation: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

describe('Talent Mapping CLI isolation', () => {
  it('dispatches only through the Mapping parser/workflow and forwards explicit detail confirmation', async () => {
    const indexModule = await loadIndexModule();
    const calls: unknown[] = [];
    indexModule.loadTalentMappingPlanFileRef.fn = async (filePath, options) => {
      calls.push({ type: 'plan', filePath, options });
      return plan;
    };
    indexModule.runTalentMappingWorkflowRef.fn = async (input) => {
      calls.push({ type: 'workflow', input });
      return summary;
    };

    const forbidden = () => {
      throw new Error('ordinary capture dependency must not run');
    };
    indexModule.parseJobDescriptionRef.fn = forbidden as never;
    indexModule.ensureAuthenticatedBrowserSessionRef.fn = forbidden as never;
    indexModule.scoreResumeAgainstJobRef.fn = forbidden as never;
    indexModule.exportJobResultsRef.fn = forbidden as never;
    indexModule.sendJobReportRef.fn = forbidden as never;
    indexModule.runSearchSubscriptionWorkflowRef.fn = forbidden as never;

    const result = await silenceConsole(() => indexModule.main([
      '--platform', 'all',
      '--talent-mapping-file', './mapping/retail.json',
      '--mapping-stage', 'all',
      '--mapping-confirm-detail-open', 'true',
    ]));

    assert.deepStrictEqual(result, summary);
    assert.equal(calls.length, 2);
    assert.deepStrictEqual(calls[0], {
      type: 'plan',
      filePath: path.resolve('./mapping/retail.json'),
      options: { platformSelection: 'all' },
    });
    assert.deepStrictEqual(calls[1], {
      type: 'workflow',
      input: {
        plan,
        planFilePath: path.resolve('./mapping/retail.json'),
        platformSelection: 'all',
        stage: 'all',
        confirmedDetailOpen: true,
        sourceScanRunId: undefined,
      },
    });
  });

  it('requires an explicit stage and confines run IDs/confirmation to the matching stages', async () => {
    const indexModule = await loadIndexModule();
    await assert.rejects(
      () => indexModule.main(['--platform', '51job', '--talent-mapping-file', './mapping.json']),
      /requires explicit --mapping-stage/i,
    );
    await assert.rejects(
      () => indexModule.main([
        '--platform', '51job', '--talent-mapping-file', './mapping.json', '--mapping-stage', 'scan',
        '--mapping-confirm-detail-open', 'false',
      ]),
      /valid only with --mapping-stage enrich or all/i,
    );
    await assert.rejects(
      () => indexModule.main([
        '--platform', '51job', '--talent-mapping-file', './mapping.json', '--mapping-stage', 'all',
        '--mapping-run-id', 'run-old',
      ]),
      /valid only with --mapping-stage enrich/i,
    );
    await assert.rejects(
      () => indexModule.main(['--platform', '51job', '--mapping-stage', 'scan']),
      /require --talent-mapping-file/i,
    );
  });

  it('rejects Boss and every ordinary capture/delivery mode flag before Mapping execution', async () => {
    const incompatibleCases: string[][] = [
      ['--jobs-file', './jobs.json'],
      ['--keyword', '运营经理'],
      ['--jd', '岗位描述'],
      ['--jd-file', './jd.txt'],
      ['--email', 'ops@example.com'],
      ['--cc', 'audit@example.com'],
      ['--include-viewed', 'true'],
      ['--search-source', 'direct'],
      ['--application-filter-input-file', './filters.json'],
      ['--search-subscription-file', './subscription.json'],
      ['--jd-question', '岗位要求是什么'],
    ];

    for (const incompatible of incompatibleCases) {
      const indexModule = await loadIndexModule();
      await assert.rejects(
        () => indexModule.main([
          '--platform', 'all',
          '--talent-mapping-file', './mapping.json',
          '--mapping-stage', 'scan',
          ...incompatible,
        ]),
        /cannot be combined/i,
      );
    }

    const indexModule = await loadIndexModule();
    await assert.rejects(
      () => indexModule.main([
        '--platform', 'boss',
        '--talent-mapping-file', './mapping.json',
        '--mapping-stage', 'scan',
      ]),
      /Boss is outside the Talent Mapping product boundary/i,
    );
  });
});
