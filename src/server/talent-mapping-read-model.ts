import {
  TALENT_MAPPING_CORE_PLATFORMS,
  type MappingCandidateView,
  type MappingClassificationReview,
  type MappingClassificationSuggestion,
  type MappingCompanyRoleMatrixRow,
  type MappingCoverageViewRow,
  type MappingEntityLink,
  type MappingRunRecord,
  type TalentMappingCorePlatform,
  type TalentMappingPlatformSelection,
  type TalentMappingProject,
} from '../types/talent-mapping.js';
import {
  buildTalentMappingDetailSelections,
  countTalentMappingDetailSelections,
} from '../talent-mapping/selection.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import { activeMappingEntityLinks, countConfirmedMappingEntities } from '../talent-mapping/entity-links.js';

interface TalentMappingReadModelOptions {
  dataDir?: string;
}

export interface TalentMappingRunReference {
  runId: string;
  stage: MappingRunRecord['stage'];
  status: MappingRunRecord['status'];
  platformSelection: MappingRunRecord['platformSelection'];
  startedAt: string;
  finishedAt: string;
  detailOpenSideEffect: MappingRunRecord['detailOpenSideEffect'];
  gapCount: number;
}

export interface TalentMappingProjectSummary {
  mappingKey: string;
  name: string;
  objective: TalentMappingProject['objective'];
  enrichmentMode: TalentMappingProject['enrichment']['mode'];
  sliceCount: number;
  platforms: TalentMappingCorePlatform[];
  candidateCount: number;
  enrichedCandidateCount: number;
  unclassifiedCandidateCount: number;
  companyMatrixRowCount: number;
  activeEntityLinkCount: number;
  confirmedEntityCount: number;
  pendingClassificationSuggestionCount: number;
  runCount: number;
  latestRun?: TalentMappingRunReference;
  createdAt: string;
  updatedAt: string;
}

export interface TalentMappingDetailSelectionPreview {
  available: boolean;
  sourceScanRunId?: string;
  platformSelection?: TalentMappingPlatformSelection;
  candidateCount: number;
  candidatesByPlatform: Partial<Record<TalentMappingCorePlatform, number>>;
  candidatesBySlice: Array<{
    sliceId: string;
    platform: TalentMappingCorePlatform;
    candidateCount: number;
  }>;
  blockedReason?: string;
}

export interface TalentMappingProjectDetail {
  project: TalentMappingProject;
  summary: TalentMappingProjectSummary;
  detailSelection: TalentMappingDetailSelectionPreview;
  identityPolicy: {
    platformScoped: true;
    crossPlatformAutoMerge: false;
    humanConfirmedLinking: true;
  };
}

function selectedPlatforms(selection: TalentMappingPlatformSelection): TalentMappingCorePlatform[] {
  return selection === 'all' ? [...TALENT_MAPPING_CORE_PLATFORMS] : [selection];
}

function enabledProjectPlatforms(project: TalentMappingProject): TalentMappingCorePlatform[] {
  return TALENT_MAPPING_CORE_PLATFORMS.filter((platform) => project.slices.some((slice) => {
    const platformPlan = slice.platformPlans[platform];
    return platformPlan && platformPlan.disabled !== true;
  }));
}

function isGapRun(run: MappingRunRecord['sliceRuns'][number]): boolean {
  return run.status !== 'completed'
    || run.failedProfiles.length > 0
    || run.terminationReason === 'batch-limit'
    || run.terminationReason === 'candidate-limit'
    || run.terminationReason === 'deadline';
}

function toRunReference(run: MappingRunRecord): TalentMappingRunReference {
  return {
    runId: run.runId,
    stage: run.stage,
    status: run.status,
    platformSelection: run.platformSelection,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    detailOpenSideEffect: run.detailOpenSideEffect,
    gapCount: run.sliceRuns.filter(isGapRun).length,
  };
}

function isUnclassified(candidate: MappingCandidateView): boolean {
  return !candidate.companyKey || !candidate.roleKey || !candidate.level || !candidate.location;
}

function buildSummary(input: {
  project: TalentMappingProject;
  runs: readonly MappingRunRecord[];
  candidates: readonly MappingCandidateView[];
  companies: readonly MappingCompanyRoleMatrixRow[];
  entityLinks: readonly MappingEntityLink[];
  classificationSuggestions: readonly MappingClassificationSuggestion[];
  classificationReviews: readonly MappingClassificationReview[];
}): TalentMappingProjectSummary {
  const activeLinks = activeMappingEntityLinks(input.entityLinks);
  const reviewedSuggestionIds = new Set(input.classificationReviews.map((review) => review.suggestionId));
  return {
    mappingKey: input.project.mappingKey,
    name: input.project.name,
    objective: input.project.objective,
    enrichmentMode: input.project.enrichment.mode,
    sliceCount: input.project.slices.length,
    platforms: enabledProjectPlatforms(input.project),
    candidateCount: input.candidates.length,
    enrichedCandidateCount: input.candidates.filter((candidate) => candidate.detailStatus === 'enriched').length,
    unclassifiedCandidateCount: input.candidates.filter(isUnclassified).length,
    companyMatrixRowCount: input.companies.length,
    activeEntityLinkCount: activeLinks.length,
    confirmedEntityCount: countConfirmedMappingEntities(input.candidates.length, input.entityLinks),
    pendingClassificationSuggestionCount: input.classificationSuggestions.filter((suggestion) => !reviewedSuggestionIds.has(suggestion.suggestionId)).length,
    runCount: input.runs.length,
    latestRun: input.runs[0] ? toRunReference(input.runs[0]) : undefined,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
  };
}

export class TalentMappingReadModel {
  private readonly store: TalentMappingStore;

  constructor(options: TalentMappingReadModelOptions = {}) {
    this.store = new TalentMappingStore({ dataDir: options.dataDir });
  }

  async listProjects(): Promise<TalentMappingProjectSummary[]> {
    const projects = await this.store.listProjects();
    return Promise.all(projects.map(async (project) => {
      const [runs, candidates, companies, entityLinks, classificationSuggestions, classificationReviews] = await Promise.all([
        this.store.listRuns(project.mappingKey),
        this.store.readCandidateView(project.mappingKey),
        this.store.readCompanyView(project.mappingKey),
        this.store.readEntityLinks(project.mappingKey),
        this.store.readClassificationSuggestions(project.mappingKey),
        this.store.readClassificationReviews(project.mappingKey),
      ]);
      return buildSummary({ project, runs, candidates, companies, entityLinks, classificationSuggestions, classificationReviews });
    }));
  }

  async getProject(mappingKey: string): Promise<TalentMappingProjectDetail | undefined> {
    const project = await this.store.readProject(mappingKey);
    if (!project) return undefined;

    const [runs, candidates, companies, entityLinks, classificationSuggestions, classificationReviews] = await Promise.all([
      this.store.listRuns(mappingKey),
      this.store.readCandidateView(mappingKey),
      this.store.readCompanyView(mappingKey),
      this.store.readEntityLinks(mappingKey),
      this.store.readClassificationSuggestions(mappingKey),
      this.store.readClassificationReviews(mappingKey),
    ]);
    return {
      project,
      summary: buildSummary({ project, runs, candidates, companies, entityLinks, classificationSuggestions, classificationReviews }),
      detailSelection: await this.buildDetailSelectionPreview(project, runs),
      identityPolicy: {
        platformScoped: true,
        crossPlatformAutoMerge: false,
        humanConfirmedLinking: true,
      },
    };
  }

  async listRuns(mappingKey: string): Promise<MappingRunRecord[]> {
    await this.assertProjectExists(mappingKey);
    return this.store.listRuns(mappingKey);
  }

  async listCandidates(mappingKey: string): Promise<MappingCandidateView[]> {
    await this.assertProjectExists(mappingKey);
    return this.store.readCandidateView(mappingKey);
  }

  async listCompanies(mappingKey: string): Promise<MappingCompanyRoleMatrixRow[]> {
    await this.assertProjectExists(mappingKey);
    return this.store.readCompanyView(mappingKey);
  }

  async getCoverage(mappingKey: string): Promise<MappingCoverageViewRow[]> {
    await this.assertProjectExists(mappingKey);
    return this.store.readCoverageView(mappingKey);
  }

  private async assertProjectExists(mappingKey: string): Promise<void> {
    if (!await this.store.readProject(mappingKey)) {
      throw new Error(`Talent Mapping project not found: ${mappingKey}`);
    }
  }

  private async buildDetailSelectionPreview(
    project: TalentMappingProject,
    runs: readonly MappingRunRecord[],
  ): Promise<TalentMappingDetailSelectionPreview> {
    if (project.enrichment.mode === 'card-only') {
      return {
        available: false,
        candidateCount: 0,
        candidatesByPlatform: {},
        candidatesBySlice: [],
        blockedReason: 'card-only 项目不执行详情补全',
      };
    }

    const sourceRun = runs.find((run) =>
      run.status !== 'failed' && (run.stage === 'scan' || run.stage === 'all'),
    );
    if (!sourceRun) {
      return {
        available: false,
        candidateCount: 0,
        candidatesByPlatform: {},
        candidatesBySlice: [],
        blockedReason: '尚无可用于详情补全的成功扫描运行',
      };
    }

    const observations = (await this.store.readCandidateObservations(project.mappingKey))
      .filter((observation) => observation.runId === sourceRun.runId);
    try {
      const selections = buildTalentMappingDetailSelections({
        plan: project,
        observations,
        sourceSliceRuns: sourceRun.sliceRuns,
        slices: project.slices,
        platforms: selectedPlatforms(sourceRun.platformSelection),
      });
      const candidatesByPlatform: Partial<Record<TalentMappingCorePlatform, number>> = {};
      const candidatesBySlice = [...selections.entries()].map(([key, candidates]) => {
        const [sliceId, platformValue] = key.split('\u001f');
        const platform = platformValue as TalentMappingCorePlatform;
        candidatesByPlatform[platform] = (candidatesByPlatform[platform] ?? 0) + candidates.length;
        return { sliceId: sliceId!, platform, candidateCount: candidates.length };
      });
      const candidateCount = countTalentMappingDetailSelections(selections);
      return {
        available: candidateCount > 0,
        sourceScanRunId: sourceRun.runId,
        platformSelection: sourceRun.platformSelection,
        candidateCount,
        candidatesByPlatform,
        candidatesBySlice,
        blockedReason: candidateCount === 0 ? '当前扫描运行没有符合详情选择规则的候选人' : undefined,
      };
    } catch (error) {
      return {
        available: false,
        sourceScanRunId: sourceRun.runId,
        platformSelection: sourceRun.platformSelection,
        candidateCount: 0,
        candidatesByPlatform: {},
        candidatesBySlice: [],
        blockedReason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
