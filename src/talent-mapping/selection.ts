import type { CandidateListItem } from '../types/job.js';
import type {
  MappingCandidateObservation,
  MappingSlice,
  MappingSliceRun,
  TalentMappingCorePlatform,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

export interface SelectedMappingCandidate {
  observation: MappingCandidateObservation;
  candidate: CandidateListItem;
  selectionReason: string[];
}

function observationRank(observation: MappingCandidateObservation): number {
  return observation.globalRank
    ?? ((observation.batchNumber ?? Number.MAX_SAFE_INTEGER) * 100000 + observation.rankInBatch);
}

export function deduplicateMappingCandidateObservations(
  observations: readonly MappingCandidateObservation[],
): MappingCandidateObservation[] {
  const byCandidate = new Map<string, MappingCandidateObservation>();
  for (const observation of observations) {
    const current = byCandidate.get(observation.platformCandidateKey);
    if (!current
      || observationRank(observation) < observationRank(current)
      || (observationRank(observation) === observationRank(current)
        && observation.candidateId.localeCompare(current.candidateId) < 0)) {
      byCandidate.set(observation.platformCandidateKey, observation);
    }
  }
  return [...byCandidate.values()];
}

function selectionPriority(value: string | undefined, configured: readonly string[] | undefined): number {
  if (!configured || configured.length === 0) return 0;
  const index = value === undefined ? -1 : configured.indexOf(value);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function matrixCell(observation: MappingCandidateObservation): string {
  return [
    observation.normalized.companyKey ?? 'unclassified',
    observation.normalized.roleKey ?? 'unclassified',
    observation.normalized.level ?? 'unclassified',
    observation.normalized.location ?? 'unclassified',
  ].join('\u001f');
}

function selectTargetedCandidates(
  plan: TalentMappingPlan,
  observations: readonly MappingCandidateObservation[],
): SelectedMappingCandidate[] {
  if (plan.enrichment.mode !== 'targeted-detail') {
    return [];
  }
  const selection = plan.enrichment.selection;
  const companyByKey = new Map(plan.taxonomy.targetCompanies.map((company) => [company.companyKey, company]));
  const filtered = deduplicateMappingCandidateObservations(observations).filter((observation) => {
    const companyTier = observation.normalized.companyKey
      ? companyByKey.get(observation.normalized.companyKey)?.tier
      : undefined;
    return (!selection.targetCompanyTiers?.length || (companyTier && selection.targetCompanyTiers.includes(companyTier)))
      && (!selection.roleKeys?.length || (observation.normalized.roleKey && selection.roleKeys.includes(observation.normalized.roleKey)))
      && (!selection.levels?.length || (observation.normalized.level && selection.levels.includes(observation.normalized.level)))
      && (!selection.locations?.length || (observation.normalized.location && selection.locations.includes(observation.normalized.location)));
  }).sort((left, right) => {
    const leftCompanyTier = left.normalized.companyKey ? companyByKey.get(left.normalized.companyKey)?.tier : undefined;
    const rightCompanyTier = right.normalized.companyKey ? companyByKey.get(right.normalized.companyKey)?.tier : undefined;
    return selectionPriority(leftCompanyTier, selection.targetCompanyTiers)
      - selectionPriority(rightCompanyTier, selection.targetCompanyTiers)
      || selectionPriority(left.normalized.roleKey, selection.roleKeys)
      - selectionPriority(right.normalized.roleKey, selection.roleKeys)
      || selectionPriority(left.normalized.level, selection.levels)
      - selectionPriority(right.normalized.level, selection.levels)
      || selectionPriority(left.normalized.location, selection.locations)
      - selectionPriority(right.normalized.location, selection.locations)
      || observationRank(left) - observationRank(right)
      || left.candidateId.localeCompare(right.candidateId);
  });

  const cellCounts = new Map<string, number>();
  const selected: SelectedMappingCandidate[] = [];
  for (const observation of filtered) {
    const cell = matrixCell(observation);
    const count = cellCounts.get(cell) ?? 0;
    if (count >= selection.samplePerMatrixCell) {
      continue;
    }
    cellCounts.set(cell, count + 1);
    const companyTier = observation.normalized.companyKey
      ? companyByKey.get(observation.normalized.companyKey)?.tier
      : undefined;
    selected.push({
      observation,
      candidate: {
        candidateId: observation.candidateId,
        name: observation.name,
        currentCompany: observation.currentCompany,
        currentTitle: observation.currentTitle,
        cardText: observation.cardText,
        searchResultIndex: observation.globalRank !== undefined ? observation.globalRank - 1 : undefined,
      },
      selectionReason: [
        companyTier ? `target-company-tier:${companyTier}` : 'company-tier:unclassified',
        `matrix-cell:${cell.replace(/\u001f/g, '|')}`,
        `platform-rank:${observationRank(observation)}`,
        `stable-candidate-id:${observation.candidateId}`,
      ],
    });
    if (selected.length >= plan.enrichment.maxProfilesPerSlice) {
      break;
    }
  }
  return selected;
}

function selectFullDetailCandidates(
  plan: TalentMappingPlan,
  observations: readonly MappingCandidateObservation[],
  sourceSliceRun: MappingSliceRun | undefined,
): SelectedMappingCandidate[] {
  if (plan.enrichment.mode !== 'full-detail') {
    return [];
  }
  if (!sourceSliceRun
    || (sourceSliceRun.terminationReason !== 'end-reached'
      && sourceSliceRun.terminationReason !== 'empty-result')) {
    throw new Error(
      `full-detail refused for ${observations[0]?.sliceId ?? sourceSliceRun?.sliceId ?? 'slice'} `
      + `${observations[0]?.platform ?? sourceSliceRun?.platform ?? 'platform'}: source scan did not reach an explicit end`,
    );
  }
  const candidates = deduplicateMappingCandidateObservations(observations)
    .sort((left, right) => observationRank(left) - observationRank(right)
      || left.candidateId.localeCompare(right.candidateId));
  if ((sourceSliceRun?.reportedResultTotal ?? candidates.length) > plan.enrichment.maxProfilesPerSlice
    || candidates.length > plan.enrichment.maxProfilesPerSlice) {
    throw new Error(
      `full-detail refused for ${observations[0]?.sliceId ?? sourceSliceRun?.sliceId ?? 'slice'} `
      + `${observations[0]?.platform ?? sourceSliceRun?.platform ?? 'platform'}: result set exceeds maxProfilesPerSlice=${plan.enrichment.maxProfilesPerSlice}`,
    );
  }
  return candidates.map((observation) => ({
    observation,
    candidate: {
      candidateId: observation.candidateId,
      name: observation.name,
      currentCompany: observation.currentCompany,
      currentTitle: observation.currentTitle,
      cardText: observation.cardText,
      searchResultIndex: observation.globalRank !== undefined ? observation.globalRank - 1 : undefined,
    },
    selectionReason: [
      'full-detail:within-hard-limit',
      `platform-rank:${observationRank(observation)}`,
      `stable-candidate-id:${observation.candidateId}`,
    ],
  }));
}

export function buildTalentMappingDetailSelections(input: {
  plan: TalentMappingPlan;
  observations: readonly MappingCandidateObservation[];
  sourceSliceRuns: readonly MappingSliceRun[];
  slices: readonly MappingSlice[];
  platforms: readonly TalentMappingCorePlatform[];
}): Map<string, SelectedMappingCandidate[]> {
  if (input.plan.enrichment.mode === 'card-only') {
    return new Map();
  }
  const sourceRunBySlicePlatform = new Map(input.sourceSliceRuns.map((run) => [`${run.sliceId}\u001f${run.platform}`, run]));
  const selectedBySlicePlatform = new Map<string, SelectedMappingCandidate[]>();
  const globallySelected = new Set<string>();
  let total = 0;

  for (const slice of input.slices) {
    for (const platform of input.platforms) {
      const key = `${slice.sliceId}\u001f${platform}`;
      const observations = input.observations.filter((observation) =>
        observation.sliceId === slice.sliceId && observation.platform === platform,
      );
      let candidates = input.plan.enrichment.mode === 'targeted-detail'
        ? selectTargetedCandidates(input.plan, observations)
        : selectFullDetailCandidates(input.plan, observations, sourceRunBySlicePlatform.get(key));
      candidates = candidates.filter((candidate) => !globallySelected.has(candidate.observation.platformCandidateKey));

      if (input.plan.enrichment.mode === 'full-detail'
        && total + candidates.length > input.plan.enrichment.maxProfilesTotal) {
        throw new Error(`full-detail refused: selected profiles exceed maxProfilesTotal=${input.plan.enrichment.maxProfilesTotal}`);
      }
      const remainingTotal = input.plan.enrichment.maxProfilesTotal - total;
      candidates = candidates.slice(0, Math.max(0, remainingTotal));
      for (const candidate of candidates) {
        globallySelected.add(candidate.observation.platformCandidateKey);
      }
      total += candidates.length;
      selectedBySlicePlatform.set(key, candidates);
    }
  }
  return selectedBySlicePlatform;
}

export function countTalentMappingDetailSelections(
  selections: ReadonlyMap<string, readonly SelectedMappingCandidate[]>,
): number {
  return [...selections.values()].reduce((sum, candidates) => sum + candidates.length, 0);
}
