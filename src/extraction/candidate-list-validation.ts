import { CandidateListItem } from '../types/job.js';

export interface CandidateListCandidateSummary {
  candidateId: string;
  name: string | null;
  resumeUrl: string | null;
  currentCompany: string | null;
  currentTitle: string | null;
}

export interface CandidateListSummary {
  count: number;
  candidateIds: string[];
  candidatesById: Record<string, CandidateListCandidateSummary>;
}

export interface CandidateListFieldDiff {
  candidateId: string;
  field: 'name' | 'resumeUrl' | 'currentCompany' | 'currentTitle';
  legacy: string | null;
  source: string | null;
}

export interface CandidateListDiff {
  count?: {
    legacy: number;
    source: number;
  };
  missingFromSource?: string[];
  addedBySource?: string[];
  fieldDiffs?: CandidateListFieldDiff[];
}

function normalizeValue(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

export function summarizeCandidateList(candidates: CandidateListItem[]): CandidateListSummary {
  const sorted = [...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId, 'zh-Hans-CN'));

  return {
    count: sorted.length,
    candidateIds: sorted.map((candidate) => candidate.candidateId),
    candidatesById: Object.fromEntries(sorted.map((candidate) => [candidate.candidateId, {
      candidateId: candidate.candidateId,
      name: normalizeValue(candidate.name),
      resumeUrl: normalizeValue(candidate.resumeUrl),
      currentCompany: normalizeValue(candidate.currentCompany),
      currentTitle: normalizeValue(candidate.currentTitle),
    }])),
  };
}

export function diffCandidateListSummaries(legacy: CandidateListSummary, source: CandidateListSummary): CandidateListDiff | null {
  const sourceIds = new Set(source.candidateIds);
  const legacyIds = new Set(legacy.candidateIds);
  const missingFromSource = legacy.candidateIds.filter((candidateId) => !sourceIds.has(candidateId));
  const addedBySource = source.candidateIds.filter((candidateId) => !legacyIds.has(candidateId));
  const sharedIds = legacy.candidateIds.filter((candidateId) => sourceIds.has(candidateId));
  const fieldDiffs = sharedIds.flatMap((candidateId) => {
    const legacyCandidate = legacy.candidatesById[candidateId];
    const sourceCandidate = source.candidatesById[candidateId];

    return (['name', 'resumeUrl', 'currentCompany', 'currentTitle'] as const)
      .filter((field) => legacyCandidate[field] !== sourceCandidate[field])
      .map((field) => ({
        candidateId,
        field,
        legacy: legacyCandidate[field],
        source: sourceCandidate[field],
      }));
  });

  if (legacy.count === source.count && missingFromSource.length === 0 && addedBySource.length === 0 && fieldDiffs.length === 0) {
    return null;
  }

  return {
    count: legacy.count === source.count ? undefined : { legacy: legacy.count, source: source.count },
    missingFromSource: missingFromSource.length > 0 ? missingFromSource : undefined,
    addedBySource: addedBySource.length > 0 ? addedBySource : undefined,
    fieldDiffs: fieldDiffs.length > 0 ? fieldDiffs : undefined,
  };
}
