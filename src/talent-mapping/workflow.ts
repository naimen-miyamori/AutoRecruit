import type { Page } from 'playwright';
import { closeBrowserSession, ensureAuthenticatedBrowserSession, type BrowserSession } from '../browser/session.js';
import { waitPlatformActionPace } from '../browser/pacing.js';
import { config } from '../config.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { PlatformAdapter } from '../platforms/types.js';
import { applySearchConditions } from '../search/search-subscription.js';
import type { CandidateListItem } from '../types/job.js';
import {
  TALENT_MAPPING_CORE_PLATFORMS,
  type MappingCandidateObservation,
  type MappingProfileObservation,
  type MappingRunRecord,
  type MappingSlice,
  type MappingSliceRun,
  type MappingSliceRunStatus,
  type MappingTerminationReason,
  type TalentMappingCorePlatform,
  type TalentMappingPlan,
  type TalentMappingPlatformSelection,
  type TalentMappingRunSummary,
  type TalentMappingStage,
} from '../types/talent-mapping.js';
import { exportTalentMapping } from './export.js';
import {
  buildMappingProfileObservationId,
  createMappingCandidateObservation,
} from './normalization.js';
import { buildMappingRunContract } from './run-contract.js';
import { isMappingPlatformPlanEnabled } from './plan.js';
import {
  buildTalentMappingDetailSelections,
  deduplicateMappingCandidateObservations,
  type SelectedMappingCandidate,
} from './selection.js';
import { TalentMappingStore } from './store.js';

interface WorkflowDependencies {
  getAdapter(platform: TalentMappingCorePlatform): PlatformAdapter;
  openSession(platform: TalentMappingCorePlatform): Promise<BrowserSession>;
  closeSession(session: BrowserSession): Promise<void>;
  waitActionPace(page: Page, platform: TalentMappingCorePlatform): Promise<void>;
  now(): Date;
}

export interface RunTalentMappingWorkflowInput {
  plan: TalentMappingPlan;
  planFilePath: string;
  platformSelection: TalentMappingPlatformSelection;
  stage: TalentMappingStage;
  confirmedDetailOpen: boolean;
  sourceScanRunId?: string;
  store?: TalentMappingStore;
  dependencies?: Partial<WorkflowDependencies>;
}

interface PreparedMappingSearch {
  page: Page;
  resultTotal: number;
  resultTotalSource: 'page' | 'api';
}

interface SlicePhaseResult {
  run: MappingSliceRun;
  fatalError?: Error;
}

export class TalentMappingWorkflowError extends Error {
  readonly summary: TalentMappingRunSummary;

  constructor(message: string, summary: TalentMappingRunSummary, cause?: unknown) {
    super(message, { cause });
    this.name = 'TalentMappingWorkflowError';
    this.summary = summary;
  }
}

const defaultDependencies: WorkflowDependencies = {
  getAdapter: getPlatformAdapter,
  openSession: ensureAuthenticatedBrowserSession,
  closeSession: closeBrowserSession,
  waitActionPace: waitPlatformActionPace,
  now: () => new Date(),
};

function selectedPlatforms(selection: TalentMappingPlatformSelection): TalentMappingCorePlatform[] {
  return selection === 'all' ? [...TALENT_MAPPING_CORE_PLATFORMS] : [selection];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function runStatus(sliceRuns: readonly MappingSliceRun[], fatalError?: Error): MappingSliceRunStatus {
  if (fatalError || sliceRuns.some((sliceRun) => sliceRun.status === 'failed')) {
    return 'failed';
  }
  return sliceRuns.some((sliceRun) => sliceRun.status === 'completed-with-gaps')
    ? 'completed-with-gaps'
    : 'completed';
}

function terminationStatus(reason: MappingTerminationReason): MappingSliceRunStatus {
  if (reason === 'failed') return 'failed';
  if (reason === 'batch-limit' || reason === 'candidate-limit' || reason === 'deadline') {
    return 'completed-with-gaps';
  }
  return 'completed';
}

function assertCandidateBatchTerminalContract(batch: {
  endReached: boolean;
  terminalEvidence: 'explicit-empty-result' | 'explicit-pagination-end' | 'not-terminal';
}, platform: TalentMappingCorePlatform): void {
  const terminalByEvidence = batch.terminalEvidence !== 'not-terminal';
  if (batch.endReached !== terminalByEvidence) {
    throw new Error(
      `${platform} Mapping candidate batch returned inconsistent terminal state: `
      + `endReached=${String(batch.endReached)}, terminalEvidence=${batch.terminalEvidence}`,
    );
  }
}

function normalizeIdentityValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function assertSelectedCandidateCardIdentity(
  selected: SelectedMappingCandidate,
  current: CandidateListItem,
  platform: TalentMappingCorePlatform,
): void {
  if (current.candidateId !== selected.candidate.candidateId) {
    throw new Error(
      `${platform} selected candidate identity mismatch: expected ${selected.candidate.candidateId}, got ${current.candidateId}`,
    );
  }
  const fields: Array<keyof Pick<CandidateListItem, 'name' | 'currentCompany' | 'currentTitle'>> = [
    'name',
    'currentCompany',
    'currentTitle',
  ];
  for (const field of fields) {
    const expected = selected.candidate[field];
    if (!expected) continue;
    const actual = current[field];
    if (!actual) {
      throw new Error(
        `${platform} selected candidate ${current.candidateId} no longer exposes expected ${field} evidence before detail open`,
      );
    }
    if (normalizeIdentityValue(actual) !== normalizeIdentityValue(expected)) {
      throw new Error(
        `${platform} selected candidate ${current.candidateId} ${field} changed before detail open: expected ${expected}, got ${actual}`,
      );
    }
  }
}

function assertWorkflowInput(input: RunTalentMappingWorkflowInput): void {
  const detailStage = input.stage === 'enrich' || input.stage === 'all';
  if (input.stage === 'enrich' && input.plan.enrichment.mode === 'card-only') {
    throw new Error('--mapping-stage enrich is invalid for a card-only Talent Mapping plan');
  }
  if (detailStage && input.plan.enrichment.mode !== 'card-only' && !input.confirmedDetailOpen) {
    throw new Error('Talent Mapping detail enrichment requires --mapping-confirm-detail-open true for this run');
  }
  if (input.sourceScanRunId && input.stage !== 'enrich') {
    throw new Error('--mapping-run-id is valid only with --mapping-stage enrich');
  }
}

async function prepareMappingSearch(
  adapter: PlatformAdapter,
  page: Page,
  slice: MappingSlice,
  platform: TalentMappingCorePlatform,
  deadline: number,
): Promise<PreparedMappingSearch> {
  const platformPlan = slice.platformPlans[platform];
  if (!isMappingPlatformPlanEnabled(platformPlan)) {
    throw new Error(`Talent Mapping slice ${slice.sliceId} has no enabled ${platform} search plan`);
  }
  if (!adapter.readSearchConditionResultTotal) {
    throw new Error(`Platform ${platform} does not support Mapping result-total reads`);
  }

  const options = { deadline, includeViewedCandidates: true };
  let searchPage: Page;
  if (platformPlan.searchSource === 'direct') {
    if (!adapter.prepareSearchConditionPage) {
      throw new Error(`Platform ${platform} does not support direct Mapping search preparation`);
    }
    searchPage = await adapter.prepareSearchConditionPage(page, platformPlan.searchPlan.keyword, options);
    const conditionResults = await applySearchConditions(adapter, searchPage, platformPlan.searchPlan.conditions);
    const incomplete = conditionResults.filter((result) => result.status !== 'applied');
    if (incomplete.length > 0) {
      throw new Error(
        `Talent Mapping slice ${slice.sliceId} ${platform} refused candidate reads because direct conditions were not fully applied: `
        + incomplete.map((result) => `${result.condition.kind}:${result.status}`).join(', '),
      );
    }
  } else {
    searchPage = await adapter.openSubscribeSearch(page, platformPlan.searchPlan.keyword, options);
  }

  const total = await adapter.readSearchConditionResultTotal(searchPage, options);
  return {
    page: searchPage,
    resultTotal: total.resultTotal,
    resultTotalSource: total.resultTotalSource,
  };
}

async function scanSlicePlatform(input: {
  plan: TalentMappingPlan;
  runId: string;
  slice: MappingSlice;
  platform: TalentMappingCorePlatform;
  adapter: PlatformAdapter;
  session: BrowserSession;
  store: TalentMappingStore;
  now: () => Date;
}): Promise<SlicePhaseResult> {
  const startedAt = input.now().toISOString();
  const deadline = Date.now() + input.plan.coverage.sliceTimeoutMs;
  let scannedBatches = 0;
  let observedCards = 0;
  const uniqueCandidateIds = new Set<string>();
  let reportedResultTotal: number | undefined;
  let reportedResultTotalSource: 'page' | 'api' | undefined;
  let terminationReason: MappingTerminationReason = 'failed';

  try {
    if (!input.adapter.readCurrentCandidateBatch || !input.adapter.advanceToNextCandidateBatch) {
      throw new Error(`Platform ${input.platform} does not implement Talent Mapping candidate batch actions`);
    }
    const prepared = await prepareMappingSearch(
      input.adapter,
      input.session.page,
      input.slice,
      input.platform,
      deadline,
    );
    input.session.page = prepared.page;
    reportedResultTotal = prepared.resultTotal;
    reportedResultTotalSource = prepared.resultTotalSource;
    if (reportedResultTotal === 0) {
      terminationReason = 'empty-result';
    } else {
      let batch = await input.adapter.readCurrentCandidateBatch(prepared.page, { deadline });
      assertCandidateBatchTerminalContract(batch, input.platform);
      if (batch.candidates.length === 0) {
        throw new Error(
          `${input.platform} reported ${reportedResultTotal} Mapping results but returned an empty initial candidate batch `
          + `(${batch.terminalEvidence}); refusing to treat it as a completed scan`,
        );
      }

      while (true) {
        scannedBatches += 1;
        const observedAt = input.now().toISOString();
        for (let index = 0; index < batch.candidates.length; index += 1) {
          const candidate = batch.candidates[index];
          const isNewCandidate = !uniqueCandidateIds.has(candidate.candidateId);
          if (isNewCandidate && uniqueCandidateIds.size >= input.plan.coverage.maxCandidatesPerSlice) {
            break;
          }
          uniqueCandidateIds.add(candidate.candidateId);
          const observation = createMappingCandidateObservation({
            candidate,
            plan: input.plan,
            runId: input.runId,
            sliceId: input.slice.sliceId,
            platform: input.platform,
            observedAt,
            batchIdentity: batch.batchIdentity,
            batchNumber: batch.batchNumber,
            rankInBatch: index + 1,
            globalRank: candidate.searchResultIndex !== undefined
              ? candidate.searchResultIndex + 1
              : observedCards + index + 1,
          });
          await input.store.appendCandidateObservation(observation);
          observedCards += 1;
        }

        await input.store.saveCheckpoint({
          runId: input.runId,
          mappingKey: input.plan.mappingKey,
          sliceId: input.slice.sliceId,
          platform: input.platform,
          batchIdentity: batch.batchIdentity,
          batchNumber: batch.batchNumber,
          observedCards,
          savedAt: input.now().toISOString(),
        });

        if (uniqueCandidateIds.size >= input.plan.coverage.maxCandidatesPerSlice) {
          terminationReason = 'candidate-limit';
          break;
        }
        if (scannedBatches >= input.plan.coverage.maxBatchesPerSlice) {
          terminationReason = 'batch-limit';
          break;
        }
        if (Date.now() >= deadline) {
          terminationReason = 'deadline';
          break;
        }
        if (batch.endReached) {
          terminationReason = batch.terminalEvidence === 'explicit-empty-result' && uniqueCandidateIds.size === 0
            ? 'empty-result'
            : 'end-reached';
          break;
        }

        const advanced = await input.adapter.advanceToNextCandidateBatch(prepared.page, {
          expectedCurrentBatchIdentity: batch.batchIdentity,
          deadline,
        });
        if (advanced.status === 'end-reached') {
          if (advanced.terminalEvidence !== 'explicit-pagination-end') {
            throw new Error(`${input.platform} advanced to an unverified Mapping candidate batch terminal state`);
          }
          terminationReason = 'end-reached';
          break;
        }
        assertCandidateBatchTerminalContract(advanced.batch, input.platform);
        batch = advanced.batch;
      }
    }

    return {
      run: {
        runId: input.runId,
        mappingKey: input.plan.mappingKey,
        sliceId: input.slice.sliceId,
        platform: input.platform,
        status: terminationStatus(terminationReason),
        reportedResultTotal,
        reportedResultTotalSource,
        scannedBatches,
        observedCards,
        uniquePlatformProfiles: uniqueCandidateIds.size,
        eligibleForDetail: 0,
        enrichedProfiles: 0,
        failedProfiles: [],
        terminationReason,
        startedAt,
        finishedAt: input.now().toISOString(),
      },
    };
  } catch (error) {
    const fatalError = asError(error);
    return {
      run: {
        runId: input.runId,
        mappingKey: input.plan.mappingKey,
        sliceId: input.slice.sliceId,
        platform: input.platform,
        status: 'failed',
        reportedResultTotal,
        reportedResultTotalSource,
        scannedBatches,
        observedCards,
        uniquePlatformProfiles: uniqueCandidateIds.size,
        eligibleForDetail: 0,
        enrichedProfiles: 0,
        failedProfiles: [],
        terminationReason: 'failed',
        startedAt,
        finishedAt: input.now().toISOString(),
        error: fatalError.message,
      },
      fatalError,
    };
  }
}

async function closeSuccessfulDetail(input: {
  adapter: PlatformAdapter;
  session: BrowserSession;
  searchPage: Page;
  detailPage: Page;
  candidate: CandidateListItem;
  platform: TalentMappingCorePlatform;
  deadline: number;
  dependencies: WorkflowDependencies;
}): Promise<void> {
  const maxPace = config.playwright.actionDelayMaxMsByPlatform[input.platform];
  if (input.deadline - Date.now() <= maxPace) {
    throw new Error(`${input.platform} detail cleanup deadline cannot accommodate the required pacing interval`);
  }
  await input.dependencies.waitActionPace(input.detailPage, input.platform);
  if (input.adapter.closeResumeDetail) {
    await input.adapter.closeResumeDetail(input.searchPage, input.detailPage, input.candidate);
  } else if (input.detailPage !== input.searchPage) {
    await input.detailPage.close();
    await input.searchPage.bringToFront().catch(() => undefined);
  }
  input.session.page = input.searchPage;
}

async function enrichSlicePlatform(input: {
  plan: TalentMappingPlan;
  runId: string;
  slice: MappingSlice;
  platform: TalentMappingCorePlatform;
  adapter: PlatformAdapter;
  session?: BrowserSession;
  store: TalentMappingStore;
  dependencies: WorkflowDependencies;
  selected: readonly SelectedMappingCandidate[];
  baseRun?: MappingSliceRun;
}): Promise<SlicePhaseResult> {
  const startedAt = input.dependencies.now().toISOString();
  const baseRun: MappingSliceRun = input.baseRun
    ? { ...input.baseRun, runId: input.runId, startedAt, finishedAt: startedAt }
    : {
      runId: input.runId,
      mappingKey: input.plan.mappingKey,
      sliceId: input.slice.sliceId,
      platform: input.platform,
      status: 'completed',
      scannedBatches: 0,
      observedCards: 0,
      uniquePlatformProfiles: 0,
      eligibleForDetail: 0,
      enrichedProfiles: 0,
      failedProfiles: [],
      terminationReason: 'end-reached',
      startedAt,
      finishedAt: startedAt,
    };
  const failedProfiles = [...baseRun.failedProfiles];
  let enrichedProfiles = 0;
  const eligibleForDetail = input.selected.length;

  if (input.selected.length === 0) {
    return {
      run: {
        ...baseRun,
        eligibleForDetail: 0,
        enrichedProfiles: 0,
        finishedAt: input.dependencies.now().toISOString(),
      },
    };
  }

  try {
    const session = input.session;
    if (!session) {
      throw new Error(`Platform ${input.platform} session is required for selected detail enrichment`);
    }
    if (!input.adapter.readCandidateProfileDetail
      || !input.adapter.readCurrentCandidateBatch
      || !input.adapter.advanceToNextCandidateBatch) {
      throw new Error(`Platform ${input.platform} does not implement Talent Mapping read-only detail actions`);
    }
    const searchDeadline = Date.now() + input.plan.coverage.sliceTimeoutMs;
    const prepared = await prepareMappingSearch(
      input.adapter,
      session.page,
      input.slice,
      input.platform,
      searchDeadline,
    );
    session.page = prepared.page;
    const pending = new Map(input.selected.map((selected) => [selected.candidate.candidateId, selected]));
    let batch = await input.adapter.readCurrentCandidateBatch(prepared.page, { deadline: searchDeadline });
    let traversedBatches = 0;

    while (true) {
      traversedBatches += 1;
      for (const batchCandidate of batch.candidates) {
        const selected = pending.get(batchCandidate.candidateId);
        if (!selected) continue;
        const candidate = batchCandidate;
        const detailDeadline = Date.now()
          + config.playwright.resumeDetailTimeoutMs
          + config.playwright.actionDelayMaxMsByPlatform[input.platform] * 2;
        try {
          assertSelectedCandidateCardIdentity(selected, candidate, input.platform);
          const detail = await input.adapter.readCandidateProfileDetail(
            session.context,
            prepared.page,
            candidate,
            { deadline: detailDeadline },
          );
          if (detail.resume.candidateId !== candidate.candidateId) {
            throw new Error(
              `${input.platform} candidate profile identity mismatch after detail open: `
              + `expected ${candidate.candidateId}, got ${detail.resume.candidateId}`,
            );
          }
          const profileObservation: MappingProfileObservation = {
            profileObservationId: buildMappingProfileObservationId({
              runId: input.runId,
              platform: input.platform,
              candidateId: candidate.candidateId,
            }),
            runId: input.runId,
            mappingKey: input.plan.mappingKey,
            sliceId: input.slice.sliceId,
            platform: input.platform,
            platformCandidateKey: selected.observation.platformCandidateKey,
            candidateId: candidate.candidateId,
            observedAt: input.dependencies.now().toISOString(),
            resume: detail.resume,
            source: 'resume-detail',
            detailOpenSideEffect: 'may-mark-viewed',
            selectionReason: selected.selectionReason,
          };
          await input.store.appendProfileObservation(profileObservation, { rawText: detail.rawText });
          enrichedProfiles += 1;
          pending.delete(candidate.candidateId);
          await closeSuccessfulDetail({
            adapter: input.adapter,
            session,
            searchPage: prepared.page,
            detailPage: detail.detailPage,
            candidate,
            platform: input.platform,
            deadline: detailDeadline,
            dependencies: input.dependencies,
          });
        } catch (error) {
          const failure = { candidateId: candidate.candidateId, error: messageOf(error) };
          failedProfiles.push(failure);
          pending.delete(candidate.candidateId);
          if (input.platform === 'liepin') {
            throw new Error(`Liepin candidate ${candidate.candidateId} detail enrichment failed; stopping and preserving the detail page: ${failure.error}`);
          }
          await input.adapter.closeResumeDetail?.(prepared.page, prepared.page, candidate).catch(() => undefined);
        }
      }

      if (pending.size === 0) break;
      if (batch.endReached || traversedBatches >= input.plan.coverage.maxBatchesPerSlice || Date.now() >= searchDeadline) {
        break;
      }
      const advanced = await input.adapter.advanceToNextCandidateBatch(prepared.page, {
        expectedCurrentBatchIdentity: batch.batchIdentity,
        deadline: searchDeadline,
      });
      if (advanced.status === 'end-reached') break;
      batch = advanced.batch;
    }

    for (const selected of pending.values()) {
      failedProfiles.push({
        candidateId: selected.candidate.candidateId,
        error: 'Selected candidate was not found in the current bounded search result batches',
      });
    }
    const status: MappingSliceRunStatus = failedProfiles.length > 0 || baseRun.status === 'completed-with-gaps'
      ? 'completed-with-gaps'
      : baseRun.status;
    return {
      run: {
        ...baseRun,
        status,
        eligibleForDetail,
        enrichedProfiles,
        failedProfiles,
        finishedAt: input.dependencies.now().toISOString(),
      },
    };
  } catch (error) {
    const fatalError = asError(error);
    return {
      run: {
        ...baseRun,
        status: 'failed',
        eligibleForDetail,
        enrichedProfiles,
        failedProfiles,
        terminationReason: 'failed',
        finishedAt: input.dependencies.now().toISOString(),
        error: fatalError.message,
      },
      fatalError,
    };
  }
}

async function resolveSourceRun(
  store: TalentMappingStore,
  plan: TalentMappingPlan,
  sourceScanRunId?: string,
): Promise<MappingRunRecord> {
  if (sourceScanRunId) {
    const run = await store.readRun(plan.mappingKey, sourceScanRunId);
    if (!run) throw new Error(`Talent Mapping scan run not found: ${sourceScanRunId}`);
    if (run.status === 'failed') throw new Error(`Talent Mapping scan run ${sourceScanRunId} failed and cannot be enriched`);
    if (run.stage !== 'scan' && run.stage !== 'all') {
      throw new Error(`Talent Mapping run ${sourceScanRunId} is ${run.stage}, not a scan source`);
    }
    return run;
  }
  const run = (await store.listRuns(plan.mappingKey)).find((candidate) =>
    candidate.status !== 'failed' && (candidate.stage === 'scan' || candidate.stage === 'all'),
  );
  if (!run) {
    throw new Error('Talent Mapping enrich requires --mapping-run-id or a prior successful scan run');
  }
  return run;
}

function assertSourceRunCoversSelection(input: {
  sourceRun: MappingRunRecord;
  slices: readonly MappingSlice[];
  platforms: readonly TalentMappingCorePlatform[];
}): void {
  for (const slice of input.slices) {
    for (const platform of input.platforms) {
      if (!isMappingPlatformPlanEnabled(slice.platformPlans[platform])) continue;
      if (!input.sourceRun.sliceRuns.some((run) => run.sliceId === slice.sliceId && run.platform === platform)) {
        throw new Error(
          `Talent Mapping scan run ${input.sourceRun.runId} does not cover selected slice/platform ${slice.sliceId}/${platform}`,
        );
      }
    }
  }
}

async function finalizeRun(input: {
  plan: TalentMappingPlan;
  store: TalentMappingStore;
  run: MappingRunRecord;
  sourceObservations: readonly MappingCandidateObservation[];
}): Promise<TalentMappingRunSummary> {
  const exportDir = input.store.getLatestExportDir(input.plan.mappingKey);
  const initialRun = { ...input.run, exportDir };
  const runPath = await input.store.saveRun(initialRun);
  const views = await input.store.rebuildDerivedViews(input.plan.mappingKey);
  await exportTalentMapping({
    plan: input.plan,
    run: initialRun,
    views,
    exportDir,
    entityLinks: await input.store.readEntityLinks(input.plan.mappingKey),
  });
  await input.store.saveRun(initialRun);
  return {
    mode: 'talent-mapping',
    mappingKey: input.plan.mappingKey,
    runId: input.run.runId,
    stage: input.run.stage,
    status: input.run.status,
    platformSelection: input.run.platformSelection,
    observedCards: input.run.sliceRuns.reduce((sum, sliceRun) => sum + sliceRun.observedCards, 0),
    uniquePlatformProfiles: new Set(input.sourceObservations.map((observation) => observation.platformCandidateKey)).size,
    enrichedProfiles: input.run.sliceRuns.reduce((sum, sliceRun) => sum + sliceRun.enrichedProfiles, 0),
    failedProfiles: input.run.sliceRuns.reduce((sum, sliceRun) => sum + sliceRun.failedProfiles.length, 0),
    cappedSlices: input.run.sliceRuns.filter((sliceRun) =>
      sliceRun.terminationReason === 'batch-limit'
      || sliceRun.terminationReason === 'candidate-limit'
      || sliceRun.terminationReason === 'deadline',
    ).length,
    exportDir,
    runPath,
    detailOpenSideEffect: input.run.detailOpenSideEffect,
  };
}

export async function runTalentMappingWorkflow(
  input: RunTalentMappingWorkflowInput,
): Promise<TalentMappingRunSummary> {
  assertWorkflowInput(input);
  const dependencies: WorkflowDependencies = { ...defaultDependencies, ...input.dependencies };
  const store = input.store ?? new TalentMappingStore();
  await store.saveProject(input.plan, input.planFilePath);
  const runId = store.createRunId();
  const startedAt = dependencies.now().toISOString();
  const runContract = buildMappingRunContract({
    plan: input.plan,
    runId,
    platformSelection: input.platformSelection,
    capturedAt: startedAt,
  });
  await store.saveRunContract(runContract);
  const platforms = selectedPlatforms(input.platformSelection);
  const sessions = new Map<TalentMappingCorePlatform, BrowserSession>();
  const sliceRuns: MappingSliceRun[] = [];
  let sourceObservations: MappingCandidateObservation[] = [];
  let sourceRun: MappingRunRecord | undefined;
  let executionPlan = input.plan;
  let fatalError: Error | undefined;

  const getSession = async (platform: TalentMappingCorePlatform): Promise<BrowserSession> => {
    const existing = sessions.get(platform);
    if (existing) return existing;
    const session = await dependencies.openSession(platform);
    sessions.set(platform, session);
    return session;
  };

  try {
    if (input.stage === 'scan' || input.stage === 'all') {
      for (const slice of input.plan.slices) {
        for (const platform of platforms) {
          if (!isMappingPlatformPlanEnabled(slice.platformPlans[platform])) continue;
          const result = await scanSlicePlatform({
            plan: input.plan,
            runId,
            slice,
            platform,
            adapter: dependencies.getAdapter(platform),
            session: await getSession(platform),
            store,
            now: dependencies.now,
          });
          sliceRuns.push(result.run);
          if (result.fatalError) throw result.fatalError;
        }
      }
      sourceObservations = (await store.readCandidateObservations(input.plan.mappingKey))
        .filter((observation) => observation.runId === runId);
    }

    if (input.stage === 'enrich') {
      sourceRun = await resolveSourceRun(store, input.plan, input.sourceScanRunId);
      const sourceContract = await store.readRunContract(input.plan.mappingKey, sourceRun.runId);
      if (!sourceContract
        || sourceRun.contractStatus !== 'verified'
        || !sourceRun.scanContractHash
        || sourceRun.scanContractHash !== sourceContract.scanContractHash) {
        throw new Error(
          `Talent Mapping scan run ${sourceRun.runId} is legacy-unverifiable and cannot be used for strict detail enrichment; run a new scan first`,
        );
      }
      if (sourceContract.scanContractHash !== runContract.scanContractHash) {
        throw new Error(
          `Talent Mapping scan run ${sourceRun.runId} uses a different scan contract; run a new scan before enrichment`,
        );
      }
      executionPlan = {
        ...sourceContract.plan,
        enrichment: input.plan.enrichment,
      };
      assertSourceRunCoversSelection({ sourceRun, slices: executionPlan.slices, platforms });
      sourceObservations = (await store.readCandidateObservations(input.plan.mappingKey))
        .filter((observation) => observation.runId === sourceRun!.runId);
    }

    if ((input.stage === 'enrich' || input.stage === 'all') && executionPlan.enrichment.mode !== 'card-only') {
      const sourceSliceRuns = sourceRun?.sliceRuns ?? sliceRuns;
      const selections = buildTalentMappingDetailSelections({
        plan: executionPlan,
        observations: sourceObservations,
        sourceSliceRuns,
        slices: executionPlan.slices,
        platforms,
      });
      for (const slice of executionPlan.slices) {
        for (const platform of platforms) {
          if (!isMappingPlatformPlanEnabled(slice.platformPlans[platform])) continue;
          const key = `${slice.sliceId}\u001f${platform}`;
          const selected = selections.get(key) ?? [];
          const baseRun = sourceSliceRuns.find((run) => run.sliceId === slice.sliceId && run.platform === platform);
          const result = await enrichSlicePlatform({
            plan: executionPlan,
            runId,
            slice,
            platform,
            adapter: dependencies.getAdapter(platform),
            session: selected.length > 0 ? await getSession(platform) : undefined,
            store,
            dependencies,
            selected,
            baseRun,
          });
          const existingIndex = sliceRuns.findIndex((run) => run.sliceId === slice.sliceId && run.platform === platform);
          if (existingIndex >= 0) {
            sliceRuns[existingIndex] = result.run;
          } else {
            sliceRuns.push(result.run);
          }
          if (result.fatalError) throw result.fatalError;
        }
      }
    }
  } catch (error) {
    fatalError = asError(error);
  } finally {
    await Promise.all([...sessions.values()].map((session) => dependencies.closeSession(session).catch(() => undefined)));
  }

  const finishedAt = dependencies.now().toISOString();
  if (sourceObservations.length === 0) {
    const sourceRunId = sourceRun?.runId ?? runId;
    sourceObservations = (await store.readCandidateObservations(input.plan.mappingKey))
      .filter((observation) => observation.runId === sourceRunId);
  }
  const detailStage = (input.stage === 'enrich' || input.stage === 'all') && executionPlan.enrichment.mode !== 'card-only';
  const run: MappingRunRecord = {
    runId,
    mappingKey: input.plan.mappingKey,
    mappingName: input.plan.name,
    stage: input.stage,
    platformSelection: input.platformSelection,
    sourceScanRunId: sourceRun?.runId,
    planHash: runContract.planHash,
    scanContractHash: runContract.scanContractHash,
    scopeFingerprint: runContract.scopeFingerprint,
    contractStatus: 'verified',
    planSnapshotPath: `runs/contracts/${runId}.json`,
    status: runStatus(sliceRuns, fatalError),
    detailOpenConfirmed: detailStage && input.confirmedDetailOpen,
    detailOpenSideEffect: detailStage ? 'may-mark-viewed' : 'none',
    startedAt,
    finishedAt,
    sliceRuns,
    error: fatalError?.message,
  };
  const summary = await finalizeRun({ plan: executionPlan, store, run, sourceObservations });
  if (fatalError) {
    throw new TalentMappingWorkflowError(
      `Talent Mapping run ${runId} failed: ${fatalError.message}`,
      summary,
      fatalError,
    );
  }
  return summary;
}

export const talentMappingWorkflowTestExports = {
  buildSelections: buildTalentMappingDetailSelections,
  deduplicateCandidateObservations: deduplicateMappingCandidateObservations,
  prepareMappingSearch,
};
