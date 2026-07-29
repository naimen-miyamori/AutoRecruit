import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserSession } from '../browser/session.js';
import type { PlatformAdapter } from '../platforms/types.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import {
  runTalentMappingWorkflow,
  TalentMappingWorkflowError,
} from '../talent-mapping/workflow.js';
import { buildMappingRunContract } from '../talent-mapping/run-contract.js';
import type { CandidateListItem } from '../types/job.js';
import type {
  CandidateResultBatch,
  MappingEnrichmentPolicy,
  MappingSlice,
  TalentMappingCorePlatform,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

interface MockPageState {
  keyword?: string;
  batchIndex: number;
  preparationCount?: number;
}

function makePage(platform: TalentMappingCorePlatform): Page {
  return {
    platform,
    waitForTimeout: async () => undefined,
    bringToFront: async () => undefined,
    close: async () => undefined,
  } as unknown as Page;
}

function makeSession(platform: TalentMappingCorePlatform, page: Page): BrowserSession {
  return {
    browser: {} as BrowserSession['browser'],
    context: {} as BrowserContext,
    page,
    platform,
  };
}

function candidate(candidateId: string, overrides: Partial<CandidateListItem> = {}): CandidateListItem {
  return {
    candidateId,
    name: `候选人-${candidateId}`,
    currentCompany: '示例公司',
    currentTitle: '运营经理',
    cardText: '上海',
    ...overrides,
  };
}

function batch(
  platform: TalentMappingCorePlatform,
  keyword: string,
  batchIndex: number,
  candidates: CandidateListItem[],
  endReached: boolean,
  terminalEvidence: CandidateResultBatch['terminalEvidence'] = endReached ? 'explicit-pagination-end' : 'not-terminal',
): CandidateResultBatch {
  return {
    candidates,
    batchIdentity: `${platform}:${keyword}:${batchIndex}`,
    batchNumber: batchIndex + 1,
    endReached,
    terminalEvidence,
  };
}

function platformPlan(keyword: string) {
  return {
    searchSource: 'direct' as const,
    searchPlanFile: `/tmp/${keyword}.json`,
    searchPlan: { keyword, conditions: [] },
  };
}

function makeSlices(sliceIds: string[], platforms: TalentMappingCorePlatform[]): MappingSlice[] {
  return sliceIds.map((sliceId) => ({
    sliceId,
    label: sliceId,
    platformPlans: Object.fromEntries(platforms.map((platform) => [platform, platformPlan(`${sliceId}-${platform}`)])),
  }));
}

function makePlan(input: {
  slices?: MappingSlice[];
  coverage?: Partial<TalentMappingPlan['coverage']>;
  enrichment?: MappingEnrichmentPolicy;
} = {}): TalentMappingPlan {
  return {
    version: 1,
    mappingKey: 'workflow-test',
    name: '工作流脱敏测试',
    objective: { roleFamilies: ['运营'], locations: ['上海'] },
    taxonomy: {
      targetCompanies: [{ companyKey: 'sample', displayName: '示例公司', aliases: [], tier: 'A' }],
      roleFamilies: [{ roleKey: 'operations', displayName: '运营', titleAliases: ['运营经理'] }],
      levels: ['经理'],
    },
    slices: input.slices ?? makeSlices(['slice-1'], ['51job']),
    coverage: {
      maxBatchesPerSlice: 5,
      maxCandidatesPerSlice: 50,
      sliceTimeoutMs: 30000,
      ...input.coverage,
    },
    enrichment: input.enrichment ?? { mode: 'card-only' },
  };
}

function makeAdapter(input: {
  platform: TalentMappingCorePlatform;
  calls: string[];
  state: WeakMap<Page, MockPageState>;
  batchesByKeyword: Record<string, CandidateResultBatch[]>;
  detailBatchesByKeyword?: Record<string, CandidateResultBatch[]>;
  resultTotalByKeyword?: Record<string, number>;
  failPrepareForKeyword?: string;
  failDetailCandidateIds?: Set<string>;
}): PlatformAdapter {
  const readBatch = async (page: Page): Promise<CandidateResultBatch> => {
    const state = input.state.get(page)!;
    const keyword = state.keyword ?? '';
    const values = state.preparationCount && state.preparationCount > 1
      ? input.detailBatchesByKeyword?.[keyword] ?? input.batchesByKeyword[keyword] ?? []
      : input.batchesByKeyword[keyword] ?? [];
    return values[state.batchIndex] ?? batch(input.platform, state.keyword ?? 'unknown', state.batchIndex, [], true);
  };
  return {
    platform: input.platform,
    displayName: input.platform,
    subscribeSearchUrl: 'https://example.com/search',
    loginUrl: 'https://example.com/login',
    storageStateFileName: `storage-state.${input.platform}.json`,
    openLoginPage: async () => undefined,
    openAuthenticatedHome: async (page) => page,
    assertAuthenticated: async () => undefined,
    openSubscribeSearch: async (page, keyword) => {
      input.calls.push(`prepare:${keyword}`);
      const preparationCount = (input.state.get(page)?.preparationCount ?? 0) + 1;
      input.state.set(page, { keyword, batchIndex: 0, preparationCount });
      return page;
    },
    prepareSearchConditionPage: async (page, keyword) => {
      input.calls.push(`prepare:${keyword}`);
      if (input.failPrepareForKeyword === keyword) {
        throw new Error(`prepare failed:${keyword}`);
      }
      const preparationCount = (input.state.get(page)?.preparationCount ?? 0) + 1;
      input.state.set(page, { keyword, batchIndex: 0, preparationCount });
      return page;
    },
    readSearchConditionResultTotal: async (page) => {
      const state = input.state.get(page)!;
      const resultTotal = input.resultTotalByKeyword?.[state.keyword ?? ''] ?? (input.batchesByKeyword[state.keyword ?? ''] ?? [])
        .flatMap((value) => value.candidates)
        .length;
      input.calls.push(`total:${state.keyword}`);
      return { resultTotal, resultTotalSource: 'page' };
    },
    extractCandidateList: async (page) => ({ candidates: (await readBatch(page)).candidates }),
    readCurrentCandidateBatch: async (page) => {
      const value = await readBatch(page);
      input.calls.push(`read:${value.batchIdentity}`);
      return value;
    },
    advanceToNextCandidateBatch: async (page, advanceInput) => {
      const current = await readBatch(page);
      assert.equal(advanceInput.expectedCurrentBatchIdentity, current.batchIdentity);
      const state = input.state.get(page)!;
      state.batchIndex += 1;
      const next = await readBatch(page);
      input.calls.push(`advance:${current.batchIdentity}->${next.batchIdentity}`);
      return { status: 'advanced', batch: next };
    },
    openResumeDetail: async (_context, page) => page,
    parseResumeDetail: async (_page, item) => ({
      candidateId: item.candidateId,
      regions: [],
      pr: [],
      workExperiences: [],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    }),
    readCandidateProfileDetail: async (_context, page, item) => {
      input.calls.push(`detail:${input.platform}:${item.candidateId}`);
      if (input.failDetailCandidateIds?.has(item.candidateId)) {
        throw new Error(`detail failed:${item.candidateId}`);
      }
      return {
        resume: {
          candidateId: item.candidateId,
          name: item.name,
          regions: [],
          pr: [],
          workExperiences: [],
          projectExperiences: [],
          educationExperiences: [],
          skill: [],
          certificates: [],
        },
        rawText: `detail:${item.candidateId}`,
        detailPage: page,
      };
    },
    closeResumeDetail: async () => undefined,
  };
}

async function withWorkflowEnvironment<T>(
  plan: TalentMappingPlan,
  build: (input: {
    store: TalentMappingStore;
    calls: string[];
    state: WeakMap<Page, MockPageState>;
    pages: Map<TalentMappingCorePlatform, Page>;
    adapters: Map<TalentMappingCorePlatform, PlatformAdapter>;
    dataDir: string;
  }) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-mapping-workflow-'));
  const calls: string[] = [];
  const state = new WeakMap<Page, MockPageState>();
  const pages = new Map<TalentMappingCorePlatform, Page>();
  const adapters = new Map<TalentMappingCorePlatform, PlatformAdapter>();
  const store = new TalentMappingStore({
    dataDir,
    now: () => new Date('2026-07-28T04:00:00.000Z'),
  });
  try {
    return await build({ store, calls, state, pages, adapters, dataDir });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function dependencies(input: {
  adapters: Map<TalentMappingCorePlatform, PlatformAdapter>;
  pages: Map<TalentMappingCorePlatform, Page>;
  calls: string[];
}) {
  return {
    getAdapter: (platform: TalentMappingCorePlatform) => input.adapters.get(platform)!,
    openSession: async (platform: TalentMappingCorePlatform) => {
      input.calls.push(`session:${platform}`);
      return makeSession(platform, input.pages.get(platform)!);
    },
    closeSession: async (session: BrowserSession) => {
      input.calls.push(`close:${session.platform}`);
    },
    waitActionPace: async () => undefined,
    now: () => new Date('2026-07-28T04:00:00.000Z'),
  };
}

describe('Talent Mapping workflow', () => {
  it('runs slice outer/platform inner in the exact public order and scans multiple batches', async () => {
    const platforms = ['51job', 'liepin', 'zhilian'] as const;
    const plan = makePlan({ slices: makeSlices(['slice-1', 'slice-2'], [...platforms]) });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      for (const platform of platforms) {
        const page = makePage(platform);
        pages.set(platform, page);
        state.set(page, { batchIndex: 0 });
        const batchesByKeyword: Record<string, CandidateResultBatch[]> = {};
        for (const slice of plan.slices) {
          const keyword = `${slice.sliceId}-${platform}`;
          batchesByKeyword[keyword] = platform === '51job' && slice.sliceId === 'slice-1'
            ? [
              batch(platform, keyword, 0, [candidate('candidate-1')], false),
              batch(platform, keyword, 1, [candidate('candidate-2')], true),
            ]
            : [batch(platform, keyword, 0, [candidate(`${slice.sliceId}-${platform}`)], true)];
        }
        adapters.set(platform, makeAdapter({ platform, calls, state, batchesByKeyword }));
      }

      const summary = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: 'all',
        stage: 'scan',
        confirmedDetailOpen: false,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed');
      assert.equal(summary.uniquePlatformProfiles, 7);
      assert.deepStrictEqual(calls.filter((call) => call.startsWith('prepare:')), [
        'prepare:slice-1-51job',
        'prepare:slice-1-liepin',
        'prepare:slice-1-zhilian',
        'prepare:slice-2-51job',
        'prepare:slice-2-liepin',
        'prepare:slice-2-zhilian',
      ]);
      const run = await store.readRun(plan.mappingKey, summary.runId);
      assert.equal(run?.sliceRuns[0].scannedBatches, 2);
      assert.equal(run?.sliceRuns[0].terminationReason, 'end-reached');
    });
  });

  it('marks bounded stops as completed-with-gaps and preserves observations', async () => {
    const plan = makePlan({ coverage: { maxBatchesPerSlice: 1 } });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: { [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1')], false)] },
      }));
      const summary = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'scan',
        confirmedDetailOpen: false,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed-with-gaps');
      assert.equal(summary.cappedSlices, 1);
      assert.equal((await store.readCandidateObservations(plan.mappingKey)).length, 1);
      assert.equal((await store.readRun(plan.mappingKey, summary.runId))?.sliceRuns[0].terminationReason, 'batch-limit');
    });
  });

  it('rejects an empty initial batch when the platform reported positive results', async () => {
    const plan = makePlan();
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [], true, 'explicit-empty-result')],
        },
        resultTotalByKeyword: { [keyword]: 3 },
      }));

      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: '51job',
          stage: 'scan',
          confirmedDetailOpen: false,
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError
          && /reported 3 Mapping results but returned an empty initial candidate batch/.test(error.message),
      );
    });
  });

  it('never marks a scan complete when its candidate cap is reached on a terminal batch', async () => {
    const plan = makePlan({ coverage: { maxCandidatesPerSlice: 1 } });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1')], true)],
        },
      }));

      const summary = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'scan',
        confirmedDetailOpen: false,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed-with-gaps');
      assert.equal(summary.cappedSlices, 1);
      assert.equal((await store.readRun(plan.mappingKey, summary.runId))?.sliceRuns[0].terminationReason, 'candidate-limit');
    });
  });

  it('fails fast by slice/platform and retains a failed run plus completed checkpoints', async () => {
    const platforms = ['51job', 'liepin', 'zhilian'] as const;
    const plan = makePlan({ slices: makeSlices(['slice-1', 'slice-2'], [...platforms]) });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      for (const platform of platforms) {
        const page = makePage(platform);
        pages.set(platform, page);
        state.set(page, { batchIndex: 0 });
        const batchesByKeyword = Object.fromEntries(plan.slices.map((slice) => {
          const keyword = `${slice.sliceId}-${platform}`;
          return [keyword, [batch(platform, keyword, 0, [candidate(`${slice.sliceId}-${platform}`)], true)]];
        }));
        adapters.set(platform, makeAdapter({
          platform,
          calls,
          state,
          batchesByKeyword,
          failPrepareForKeyword: platform === 'liepin' ? 'slice-1-liepin' : undefined,
        }));
      }

      let thrown: TalentMappingWorkflowError | undefined;
      try {
        await runTalentMappingWorkflow({
          plan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: 'all',
          stage: 'scan',
          confirmedDetailOpen: false,
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        });
      } catch (error) {
        assert.ok(error instanceof TalentMappingWorkflowError);
        thrown = error;
      }
      assert.equal(thrown?.summary.status, 'failed');
      assert.equal(calls.includes('prepare:slice-1-zhilian'), false);
      assert.equal(calls.includes('prepare:slice-2-51job'), false);
      assert.equal((await store.readCandidateObservations(plan.mappingKey)).length, 1);
      const run = await store.readRun(plan.mappingKey, thrown!.summary.runId);
      assert.equal(run?.sliceRuns.length, 2);
      assert.equal(run?.sliceRuns[1].status, 'failed');
    });
  });

  it('requires current-run confirmation and selects targeted detail deterministically without delivery hooks', async () => {
    const plan = makePlan({
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 1 },
      },
    });
    await assert.rejects(
      () => runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'all',
        confirmedDetailOpen: false,
      }),
      /requires --mapping-confirm-detail-open true/i,
    );

    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters, dataDir }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [
            candidate('candidate-1'),
            candidate('candidate-2'),
            candidate('candidate-3', { currentCompany: '非目标公司' }),
          ], true)],
        },
      }));
      const summary = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'all',
        confirmedDetailOpen: true,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed');
      assert.deepStrictEqual(calls.filter((call) => call.startsWith('detail:')), ['detail:51job:candidate-1']);
      assert.equal(summary.enrichedProfiles, 1);
      assert.equal(summary.detailOpenSideEffect, 'may-mark-viewed');
      assert.equal((await store.readProfileObservations(plan.mappingKey))[0].selectionReason.some((value) => value.startsWith('platform-rank:')), true);
      assert.deepStrictEqual(await fs.readdir(dataDir), ['talent-mapping']);
      const mappingFiles = await fs.readdir(path.join(dataDir, 'talent-mapping'), { recursive: true });
      assert.equal(mappingFiles.some((entry) => /(^|\/)jd\.json$|seen-ids\.json$|answer-logs\.jsonl$|(^|\/)scores\//.test(entry)), false);
    });
  });

  it('records a detail gap when the current card conflicts with the selected identity evidence', async () => {
    const plan = makePlan({
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1')], true)],
        },
        detailBatchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1', { currentTitle: '门店经理' })], true)],
        },
      }));

      const summary = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'all',
        confirmedDetailOpen: true,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed-with-gaps');
      assert.equal(summary.failedProfiles, 1);
      assert.equal(summary.enrichedProfiles, 0);
      assert.equal(calls.some((call) => call.startsWith('detail:')), false);
      assert.equal((await store.readProfileObservations(plan.mappingKey)).length, 0);
    });
  });

  it('records allowed profile gaps, but rejects full-detail before opening anything when a hard cap is exceeded', async () => {
    const targetedPlan = makePlan({
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 2 },
      },
    });
    await withWorkflowEnvironment(targetedPlan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: { [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1'), candidate('candidate-2')], true)] },
        failDetailCandidateIds: new Set(['candidate-1']),
      }));
      const summary = await runTalentMappingWorkflow({
        plan: targetedPlan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'all',
        confirmedDetailOpen: true,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      assert.equal(summary.status, 'completed-with-gaps');
      assert.equal(summary.enrichedProfiles, 1);
      assert.equal(summary.failedProfiles, 1);
      assert.deepStrictEqual(calls.filter((call) => call.startsWith('detail:')), [
        'detail:51job:candidate-1',
        'detail:51job:candidate-2',
      ]);
    });

    const incompleteFullPlan = makePlan({
      coverage: { maxBatchesPerSlice: 1 },
      enrichment: {
        mode: 'full-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(incompleteFullPlan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: { [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1')], false)] },
      }));
      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan: incompleteFullPlan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: '51job',
          stage: 'all',
          confirmedDetailOpen: true,
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError && /source scan did not reach an explicit end/.test(error.message),
      );
      assert.equal(calls.some((call) => call.startsWith('detail:')), false);
    });

    const fullPlan = makePlan({
      enrichment: {
        mode: 'full-detail',
        maxProfilesPerSlice: 1,
        maxProfilesTotal: 1,
        selection: { samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(fullPlan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: { [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1'), candidate('candidate-2')], true)] },
      }));
      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan: fullPlan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: '51job',
          stage: 'all',
          confirmedDetailOpen: true,
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError && /full-detail refused/.test(error.message),
      );
      assert.equal(calls.some((call) => call.startsWith('detail:')), false);
    });
  });

  it('rejects enrich when the source scan does not cover every selected slice and platform', async () => {
    const platforms = ['51job', 'liepin', 'zhilian'] as const;
    const plan = makePlan({
      slices: makeSlices(['slice-1'], [...platforms]),
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(plan, async ({ store, calls, pages, adapters }) => {
      const observedAt = '2026-07-28T04:00:00.000Z';
      const sourceContract = buildMappingRunContract({
        plan,
        runId: 'single-platform-scan',
        platformSelection: '51job',
        capturedAt: observedAt,
      });
      await store.saveRunContract(sourceContract);
      await store.saveRun({
        runId: 'single-platform-scan',
        mappingKey: plan.mappingKey,
        mappingName: plan.name,
        stage: 'scan',
        platformSelection: '51job',
        planHash: sourceContract.planHash,
        scanContractHash: sourceContract.scanContractHash,
        scopeFingerprint: sourceContract.scopeFingerprint,
        contractStatus: 'verified',
        planSnapshotPath: 'runs/contracts/single-platform-scan.json',
        status: 'completed',
        detailOpenConfirmed: false,
        detailOpenSideEffect: 'none',
        startedAt: observedAt,
        finishedAt: observedAt,
        sliceRuns: [{
          runId: 'single-platform-scan',
          mappingKey: plan.mappingKey,
          sliceId: 'slice-1',
          platform: '51job',
          status: 'completed',
          reportedResultTotal: 0,
          reportedResultTotalSource: 'page',
          scannedBatches: 0,
          observedCards: 0,
          uniquePlatformProfiles: 0,
          eligibleForDetail: 0,
          enrichedProfiles: 0,
          failedProfiles: [],
          terminationReason: 'empty-result',
          startedAt: observedAt,
          finishedAt: observedAt,
        }],
      });
      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: 'all',
          stage: 'enrich',
          confirmedDetailOpen: true,
          sourceScanRunId: 'single-platform-scan',
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError && /does not cover selected slice\/platform slice-1\/liepin/.test(error.message),
      );
      assert.deepStrictEqual(calls, []);
    });
  });

  it('rejects strict enrichment from a legacy scan without an immutable contract', async () => {
    const plan = makePlan({
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(plan, async ({ store, calls, pages, adapters }) => {
      const observedAt = '2026-07-28T04:00:00.000Z';
      await store.saveRun({
        runId: 'legacy-scan',
        mappingKey: plan.mappingKey,
        mappingName: plan.name,
        stage: 'scan',
        platformSelection: '51job',
        status: 'completed',
        detailOpenConfirmed: false,
        detailOpenSideEffect: 'none',
        startedAt: observedAt,
        finishedAt: observedAt,
        sliceRuns: [],
      });
      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: '51job',
          stage: 'enrich',
          confirmedDetailOpen: true,
          sourceScanRunId: 'legacy-scan',
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError
          && /legacy-unverifiable/.test(error.message),
      );
    });
  });

  it('refuses to enrich a scan after its search or taxonomy contract has changed', async () => {
    const plan = makePlan({
      enrichment: {
        mode: 'targeted-detail',
        maxProfilesPerSlice: 5,
        maxProfilesTotal: 5,
        selection: { targetCompanyTiers: ['A'], samplePerMatrixCell: 1 },
      },
    });
    await withWorkflowEnvironment(plan, async ({ store, calls, state, pages, adapters }) => {
      const page = makePage('51job');
      pages.set('51job', page);
      state.set(page, { batchIndex: 0 });
      const keyword = 'slice-1-51job';
      adapters.set('51job', makeAdapter({
        platform: '51job',
        calls,
        state,
        batchesByKeyword: {
          [keyword]: [batch('51job', keyword, 0, [candidate('candidate-1')], true)],
        },
      }));
      const scan = await runTalentMappingWorkflow({
        plan,
        planFilePath: '/tmp/mapping.json',
        platformSelection: '51job',
        stage: 'scan',
        confirmedDetailOpen: false,
        store,
        dependencies: dependencies({ adapters, pages, calls }),
      });
      const driftedPlan: TalentMappingPlan = {
        ...plan,
        taxonomy: {
          ...plan.taxonomy,
          targetCompanies: plan.taxonomy.targetCompanies.map((company) => ({
            ...company,
            aliases: [...company.aliases, '已变化的公司别名'],
          })),
        },
      };
      await assert.rejects(
        () => runTalentMappingWorkflow({
          plan: driftedPlan,
          planFilePath: '/tmp/mapping.json',
          platformSelection: '51job',
          stage: 'enrich',
          confirmedDetailOpen: true,
          sourceScanRunId: scan.runId,
          store,
          dependencies: dependencies({ adapters, pages, calls }),
        }),
        (error: unknown) => error instanceof TalentMappingWorkflowError
          && /different scan contract/.test(error.message),
      );
      assert.equal(calls.some((call) => call.startsWith('detail:')), false);
    });
  });
});
