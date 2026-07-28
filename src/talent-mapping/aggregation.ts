import type {
  MappingCandidateObservation,
  MappingCandidateView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingDerivedViews,
  MappingProfileObservation,
  MappingSliceRun,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

function compareObserved(
  left: { observedAt: string },
  right: { observedAt: string },
): number {
  return left.observedAt.localeCompare(right.observedAt);
}

export function buildMappingCandidateViews(
  observations: readonly MappingCandidateObservation[],
  profileObservations: readonly MappingProfileObservation[],
): MappingCandidateView[] {
  const observationsByCandidate = new Map<string, MappingCandidateObservation[]>();
  for (const observation of observations) {
    const values = observationsByCandidate.get(observation.platformCandidateKey) ?? [];
    values.push(observation);
    observationsByCandidate.set(observation.platformCandidateKey, values);
  }

  const latestProfileByCandidate = new Map<string, MappingProfileObservation>();
  for (const profile of profileObservations) {
    const current = latestProfileByCandidate.get(profile.platformCandidateKey);
    if (!current || compareObserved(current, profile) < 0) {
      latestProfileByCandidate.set(profile.platformCandidateKey, profile);
    }
  }

  return [...observationsByCandidate.entries()].map<MappingCandidateView>(([platformCandidateKey, candidateObservations]) => {
    const ordered = [...candidateObservations].sort(compareObserved);
    const first = ordered[0];
    const latest = ordered.at(-1)!;
    const profile = latestProfileByCandidate.get(platformCandidateKey);
    return {
      platform: latest.platform,
      platformCandidateKey,
      candidateId: latest.candidateId,
      name: latest.name,
      currentCompany: latest.currentCompany,
      currentTitle: latest.currentTitle,
      companyKey: latest.normalized.companyKey,
      roleKey: latest.normalized.roleKey,
      level: latest.normalized.level,
      location: latest.normalized.location,
      firstObservedAt: first.observedAt,
      lastObservedAt: latest.observedAt,
      sourceSliceIds: [...new Set(ordered.map((observation) => observation.sliceId))].sort(),
      observationCount: ordered.length,
      detailStatus: profile ? 'enriched' as const : 'not-enriched' as const,
      latestProfileObservedAt: profile?.observedAt,
      resume: profile?.resume,
    };
  }).sort((left, right) =>
    left.platform.localeCompare(right.platform)
    || left.candidateId.localeCompare(right.candidateId),
  );
}

export function buildCompanyRoleMatrix(
  plan: Pick<TalentMappingPlan, 'taxonomy'>,
  candidates: readonly MappingCandidateView[],
): MappingCompanyRoleMatrixRow[] {
  const companyByKey = new Map(plan.taxonomy.targetCompanies.map((company) => [company.companyKey, company]));
  const roleByKey = new Map(plan.taxonomy.roleFamilies.map((role) => [role.roleKey, role]));
  const grouped = new Map<string, { row: MappingCompanyRoleMatrixRow; candidateKeys: Set<string>; enrichedKeys: Set<string>; unclassifiedKeys: Set<string> }>();

  for (const candidate of candidates) {
    const companyKey = candidate.companyKey ?? 'unclassified';
    const roleKey = candidate.roleKey ?? 'unclassified';
    const level = candidate.level ?? '待归类';
    const location = candidate.location ?? '待归类';
    const company = companyByKey.get(companyKey);
    const role = roleByKey.get(roleKey);
    const groupKey = [companyKey, roleKey, level, location, candidate.platform].join('\u001f');
    const group = grouped.get(groupKey) ?? {
      row: {
        companyKey,
        companyDisplayName: company?.displayName ?? candidate.currentCompany ?? '待归类',
        companyTier: company?.tier,
        roleKey,
        roleDisplayName: role?.displayName ?? candidate.currentTitle ?? '待归类',
        level,
        location,
        platform: candidate.platform,
        platformProfiles: 0,
        enrichedProfiles: 0,
        unclassifiedProfiles: 0,
      },
      candidateKeys: new Set<string>(),
      enrichedKeys: new Set<string>(),
      unclassifiedKeys: new Set<string>(),
    };

    group.candidateKeys.add(candidate.platformCandidateKey);
    if (candidate.detailStatus === 'enriched') {
      group.enrichedKeys.add(candidate.platformCandidateKey);
    }
    if (!candidate.companyKey || !candidate.roleKey || !candidate.level || !candidate.location) {
      group.unclassifiedKeys.add(candidate.platformCandidateKey);
    }
    grouped.set(groupKey, group);
  }

  return [...grouped.values()].map(({ row, candidateKeys, enrichedKeys, unclassifiedKeys }) => ({
    ...row,
    platformProfiles: candidateKeys.size,
    enrichedProfiles: enrichedKeys.size,
    unclassifiedProfiles: unclassifiedKeys.size,
  })).sort((left, right) =>
    left.companyKey.localeCompare(right.companyKey)
    || left.roleKey.localeCompare(right.roleKey)
    || left.level.localeCompare(right.level)
    || left.location.localeCompare(right.location)
    || left.platform.localeCompare(right.platform),
  );
}

export function toMappingCoverageView(run: MappingSliceRun): MappingCoverageViewRow {
  const cardCoverageKnown = run.reportedResultTotal !== undefined && run.reportedResultTotal > 0;
  const detailCoverageKnown = run.eligibleForDetail > 0;
  const capped = run.terminationReason === 'batch-limit'
    || run.terminationReason === 'candidate-limit'
    || run.terminationReason === 'deadline';

  return {
    ...run,
    cardCoverage: cardCoverageKnown
      ? Math.min(1, run.uniquePlatformProfiles / run.reportedResultTotal!)
      : undefined,
    cardCoverageStatus: cardCoverageKnown ? 'known' : 'unknown',
    detailCoverage: detailCoverageKnown
      ? run.enrichedProfiles / run.eligibleForDetail
      : undefined,
    detailCoverageStatus: detailCoverageKnown ? 'known' : 'zero-eligible',
    coverageStatus: run.status === 'failed' || run.terminationReason === 'failed'
      ? 'failed'
      : capped
        ? 'capped'
        : 'complete',
  };
}

export function buildLatestCoverageView(
  sliceRuns: readonly MappingSliceRun[],
): MappingCoverageViewRow[] {
  const latestBySlicePlatform = new Map<string, MappingSliceRun>();
  for (const run of sliceRuns) {
    const key = `${run.sliceId}\u001f${run.platform}`;
    const current = latestBySlicePlatform.get(key);
    if (!current || current.finishedAt.localeCompare(run.finishedAt) < 0) {
      latestBySlicePlatform.set(key, run);
    }
  }

  return [...latestBySlicePlatform.values()]
    .map(toMappingCoverageView)
    .sort((left, right) => left.sliceId.localeCompare(right.sliceId) || left.platform.localeCompare(right.platform));
}

export function buildTalentMappingDerivedViews(input: {
  plan: TalentMappingPlan;
  observations: readonly MappingCandidateObservation[];
  profileObservations: readonly MappingProfileObservation[];
  sliceRuns: readonly MappingSliceRun[];
  generatedAt?: string;
}): MappingDerivedViews {
  const candidates = buildMappingCandidateViews(input.observations, input.profileObservations);
  return {
    candidates,
    companies: buildCompanyRoleMatrix(input.plan, candidates),
    coverage: buildLatestCoverageView(input.sliceRuns),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}
