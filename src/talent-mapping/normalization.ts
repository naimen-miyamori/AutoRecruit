import { createHash } from 'node:crypto';
import type { CandidateListItem } from '../types/job.js';
import type {
  MappingCandidateObservation,
  MappingFieldEvidence,
  MappingNormalizedCandidateFields,
  MappingTaxonomy,
  TalentMappingCorePlatform,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

function compact(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function comparisonKey(value: string | undefined): string {
  return compact(value)
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s·•・,，.。()（）\[\]【】_-]+/g, '');
}

function containsOrderedCharacters(value: string, expected: string): boolean {
  let expectedIndex = 0;
  for (const character of value) {
    if (character === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) {
        return true;
      }
    }
  }
  return false;
}

function confirmedEvidence(
  field: MappingFieldEvidence['field'],
  rawValue: string,
  ruleId: string,
): MappingFieldEvidence {
  return {
    field,
    source: 'card',
    rawValue,
    ruleId,
    confidence: 'confirmed',
  };
}

function unclassifiedEvidence(
  field: MappingFieldEvidence['field'],
  rawValue: string,
): MappingFieldEvidence {
  return {
    field,
    source: 'card',
    rawValue,
    confidence: 'unclassified',
  };
}

function classifyCompany(
  rawCompany: string | undefined,
  taxonomy: MappingTaxonomy,
): { companyKey?: string; evidence?: MappingFieldEvidence } {
  const rawKey = comparisonKey(rawCompany);
  if (!rawKey) {
    return {};
  }

  for (const company of taxonomy.targetCompanies) {
    const labels = [company.displayName, ...company.aliases];
    const matchedLabel = labels.find((label) => comparisonKey(label) === rawKey);
    if (matchedLabel) {
      return {
        companyKey: company.companyKey,
        evidence: confirmedEvidence('company', compact(rawCompany), `company:${company.companyKey}:${comparisonKey(matchedLabel)}`),
      };
    }
  }

  return { evidence: unclassifiedEvidence('company', compact(rawCompany)) };
}

function classifyRole(
  rawTitle: string | undefined,
  taxonomy: MappingTaxonomy,
): { roleKey?: string; evidence?: MappingFieldEvidence } {
  const titleKey = comparisonKey(rawTitle);
  if (!titleKey) {
    return {};
  }

  const matches = taxonomy.roleFamilies.flatMap((role) =>
    role.titleAliases
      .map((alias) => ({ role, alias, aliasKey: comparisonKey(alias) }))
      .filter(({ aliasKey }) => aliasKey && titleKey.includes(aliasKey)),
  ).sort((left, right) => right.aliasKey.length - left.aliasKey.length || left.role.roleKey.localeCompare(right.role.roleKey));
  const match = matches[0];
  if (!match) {
    return { evidence: unclassifiedEvidence('role', compact(rawTitle)) };
  }

  return {
    roleKey: match.role.roleKey,
    evidence: confirmedEvidence('role', compact(rawTitle), `role:${match.role.roleKey}:${match.aliasKey}`),
  };
}

function classifyLevel(
  rawTitle: string | undefined,
  taxonomy: MappingTaxonomy,
): { level?: string; evidence?: MappingFieldEvidence } {
  const titleKey = comparisonKey(rawTitle);
  if (!titleKey) {
    return {};
  }

  const titleWithoutRole = taxonomy.roleFamilies
    .flatMap((role) => role.titleAliases)
    .map(comparisonKey)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((value, alias) => value.replace(alias, ''), titleKey);
  const level = [...taxonomy.levels]
    .sort((left, right) => comparisonKey(right).length - comparisonKey(left).length || left.localeCompare(right))
    .find((item) => {
      const levelKey = comparisonKey(item);
      return titleKey.includes(levelKey)
        || titleWithoutRole.includes(levelKey)
        || containsOrderedCharacters(titleKey, levelKey);
    });
  return level
    ? {
      level,
      evidence: confirmedEvidence('level', compact(rawTitle), `level:${comparisonKey(level)}`),
    }
    : { evidence: unclassifiedEvidence('level', compact(rawTitle)) };
}

function classifyLocation(
  candidate: CandidateListItem,
  locations: readonly string[],
): { location?: string; evidence?: MappingFieldEvidence } {
  const source = compact([candidate.cardText, candidate.sourceText].filter(Boolean).join(' '));
  const sourceKey = comparisonKey(source);
  if (!sourceKey) {
    return {};
  }

  const location = [...locations]
    .sort((left, right) => comparisonKey(right).length - comparisonKey(left).length || left.localeCompare(right))
    .find((item) => sourceKey.includes(comparisonKey(item)));
  return location
    ? {
      location,
      evidence: confirmedEvidence('location', source, `location:${comparisonKey(location)}`),
    }
    : { evidence: unclassifiedEvidence('location', source) };
}

export function buildPlatformCandidateKey(
  platform: TalentMappingCorePlatform,
  candidateId: string,
): string {
  return `${platform}:${candidateId}`;
}

export function buildMappingObservationId(input: {
  runId: string;
  platform: TalentMappingCorePlatform;
  sliceId: string;
  batchIdentity: string;
  candidateId: string;
}): string {
  return createHash('sha256')
    .update([input.runId, input.platform, input.sliceId, input.batchIdentity, input.candidateId].join('\u001f'))
    .digest('hex');
}

export function buildMappingProfileObservationId(input: {
  runId: string;
  platform: TalentMappingCorePlatform;
  candidateId: string;
}): string {
  return createHash('sha256')
    .update([input.runId, input.platform, input.candidateId, 'resume-detail'].join('\u001f'))
    .digest('hex');
}

export function normalizeMappingCandidate(
  candidate: CandidateListItem,
  plan: Pick<TalentMappingPlan, 'taxonomy' | 'objective'>,
): { normalized: MappingNormalizedCandidateFields; evidence: MappingFieldEvidence[] } {
  const company = classifyCompany(candidate.currentCompany, plan.taxonomy);
  const role = classifyRole(candidate.currentTitle, plan.taxonomy);
  const level = classifyLevel(candidate.currentTitle, plan.taxonomy);
  const location = classifyLocation(candidate, plan.objective.locations);
  const evidence = [company.evidence, role.evidence, level.evidence, location.evidence].filter(
    (item): item is MappingFieldEvidence => item !== undefined,
  );

  if (candidate.name) {
    evidence.push(confirmedEvidence('name', compact(candidate.name), 'card:name'));
  }
  if (candidate.cardText) {
    evidence.push(confirmedEvidence('card-text', compact(candidate.cardText), 'card:text'));
  }

  return {
    normalized: {
      companyKey: company.companyKey,
      roleKey: role.roleKey,
      level: level.level,
      location: location.location,
    },
    evidence,
  };
}

export function createMappingCandidateObservation(input: {
  candidate: CandidateListItem;
  plan: TalentMappingPlan;
  runId: string;
  sliceId: string;
  platform: TalentMappingCorePlatform;
  observedAt: string;
  batchIdentity: string;
  batchNumber?: number;
  rankInBatch: number;
  globalRank?: number;
}): MappingCandidateObservation {
  const candidateId = compact(input.candidate.candidateId);
  if (!candidateId) {
    throw new Error('Talent Mapping candidate observation requires a stable candidateId');
  }
  if (!Number.isInteger(input.rankInBatch) || input.rankInBatch < 1) {
    throw new Error('Talent Mapping rankInBatch must be a positive integer');
  }

  const normalized = normalizeMappingCandidate(input.candidate, input.plan);
  return {
    observationId: buildMappingObservationId({
      runId: input.runId,
      platform: input.platform,
      sliceId: input.sliceId,
      batchIdentity: input.batchIdentity,
      candidateId,
    }),
    runId: input.runId,
    mappingKey: input.plan.mappingKey,
    sliceId: input.sliceId,
    platform: input.platform,
    platformCandidateKey: buildPlatformCandidateKey(input.platform, candidateId),
    candidateId,
    observedAt: input.observedAt,
    batchIdentity: input.batchIdentity,
    batchNumber: input.batchNumber,
    rankInBatch: input.rankInBatch,
    globalRank: input.globalRank,
    name: compact(input.candidate.name) || undefined,
    currentCompany: compact(input.candidate.currentCompany) || undefined,
    currentTitle: compact(input.candidate.currentTitle) || undefined,
    cardText: compact(input.candidate.cardText ?? input.candidate.sourceText) || undefined,
    ...normalized,
  };
}
