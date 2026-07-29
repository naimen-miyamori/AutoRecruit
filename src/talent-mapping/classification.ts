import { createHash } from 'node:crypto';

import type {
  MappingCandidateObservation,
  MappingCandidateView,
  MappingClassificationEvidence,
  MappingClassificationField,
  MappingClassificationReview,
  MappingClassificationSuggestion,
  MappingNormalizedCandidateFields,
  TalentMappingPlan,
} from '../types/talent-mapping.js';

export interface MappingClassificationPromptItem {
  ref: string;
  currentCompany?: string;
  currentTitle?: string;
  location?: string;
}

export interface MappingClassificationPromptCandidate {
  ref: string;
  candidate: MappingCandidateView;
  observation: MappingCandidateObservation;
  evidence: MappingClassificationEvidence[];
  promptItem: MappingClassificationPromptItem;
}

interface RawModelSuggestion {
  ref?: unknown;
  companyKey?: unknown;
  roleKey?: unknown;
  level?: unknown;
  location?: unknown;
  rationale?: unknown;
  evidenceFields?: unknown;
}

export interface ValidatedModelClassificationSuggestion {
  ref: string;
  proposed: MappingNormalizedCandidateFields;
  rationale: string;
  evidenceFields: MappingClassificationEvidence['field'][];
}

function latestObservationByCandidate(
  observations: readonly MappingCandidateObservation[],
): Map<string, MappingCandidateObservation> {
  const latest = new Map<string, MappingCandidateObservation>();
  for (const observation of observations) {
    const current = latest.get(observation.platformCandidateKey);
    if (!current
      || current.observedAt.localeCompare(observation.observedAt) < 0
      || (current.observedAt === observation.observedAt
        && current.observationId.localeCompare(observation.observationId) < 0)) {
      latest.set(observation.platformCandidateKey, observation);
    }
  }
  return latest;
}

function unclassifiedFields(candidate: MappingCandidateView): MappingClassificationField[] {
  return (['companyKey', 'roleKey', 'level', 'location'] as const)
    .filter((field) => !candidate[field]);
}

export function buildMappingClassificationPromptCandidates(input: {
  candidates: readonly MappingCandidateView[];
  observations: readonly MappingCandidateObservation[];
  limit: number;
}): MappingClassificationPromptCandidate[] {
  const latest = latestObservationByCandidate(input.observations);
  return input.candidates.flatMap((candidate, index) => {
    if (unclassifiedFields(candidate).length === 0) return [];
    const observation = latest.get(candidate.platformCandidateKey);
    if (!observation) return [];
    const locationEvidence = observation.normalized.location;
    const evidence: MappingClassificationEvidence[] = [
      observation.currentCompany
        ? { field: 'currentCompany' as const, rawValue: observation.currentCompany.slice(0, 240), observationId: observation.observationId }
        : undefined,
      observation.currentTitle
        ? { field: 'currentTitle' as const, rawValue: observation.currentTitle.slice(0, 240), observationId: observation.observationId }
        : undefined,
      locationEvidence
        ? { field: 'location' as const, rawValue: locationEvidence.slice(0, 240), observationId: observation.observationId }
        : undefined,
    ].filter((item): item is MappingClassificationEvidence => item !== undefined);
    if (evidence.length === 0) return [];
    const ref = `item-${index + 1}`;
    return [{
      ref,
      candidate,
      observation,
      evidence,
      promptItem: {
        ref,
        currentCompany: observation.currentCompany,
        currentTitle: observation.currentTitle,
        location: locationEvidence,
      },
    }];
  }).slice(0, input.limit);
}

function extractJsonObject(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Talent Mapping classification model did not return a JSON object');
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Talent Mapping classification model response must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function validateMappingClassificationResponse(input: {
  rawText: string;
  plan: TalentMappingPlan;
  candidates: readonly MappingClassificationPromptCandidate[];
}): ValidatedModelClassificationSuggestion[] {
  const payload = extractJsonObject(input.rawText);
  if (!Array.isArray(payload.suggestions)) {
    throw new Error('Talent Mapping classification model response must contain suggestions[]');
  }
  const candidateByRef = new Map(input.candidates.map((candidate) => [candidate.ref, candidate]));
  const companyKeys = new Set(input.plan.taxonomy.targetCompanies.map((company) => company.companyKey));
  const roleKeys = new Set(input.plan.taxonomy.roleFamilies.map((role) => role.roleKey));
  const levels = new Set(input.plan.taxonomy.levels);
  const locations = new Set(input.plan.objective.locations);

  return (payload.suggestions as RawModelSuggestion[]).flatMap((raw) => {
    if (typeof raw.ref !== 'string') return [];
    const candidate = candidateByRef.get(raw.ref);
    if (!candidate) return [];
    const availableEvidenceFields = new Set(candidate.evidence.map((item) => item.field));
    const evidenceFields = Array.isArray(raw.evidenceFields)
      ? raw.evidenceFields.filter((field): field is MappingClassificationEvidence['field'] =>
        (field === 'currentCompany' || field === 'currentTitle' || field === 'location')
        && availableEvidenceFields.has(field),
      )
      : [];
    if (evidenceFields.length === 0) return [];
    const claimedEvidenceFields = new Set(evidenceFields);
    const missing = new Set(unclassifiedFields(candidate.candidate));
    const proposed: MappingNormalizedCandidateFields = {};
    if (missing.has('companyKey')
      && claimedEvidenceFields.has('currentCompany')
      && typeof raw.companyKey === 'string'
      && companyKeys.has(raw.companyKey)) proposed.companyKey = raw.companyKey;
    if (missing.has('roleKey')
      && claimedEvidenceFields.has('currentTitle')
      && typeof raw.roleKey === 'string'
      && roleKeys.has(raw.roleKey)) proposed.roleKey = raw.roleKey;
    if (missing.has('level')
      && claimedEvidenceFields.has('currentTitle')
      && typeof raw.level === 'string'
      && levels.has(raw.level)) proposed.level = raw.level;
    if (missing.has('location')
      && claimedEvidenceFields.has('location')
      && typeof raw.location === 'string'
      && locations.has(raw.location)) proposed.location = raw.location;
    if (Object.keys(proposed).length === 0) return [];
    return [{
      ref: raw.ref,
      proposed,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 500) : '',
      evidenceFields,
    }];
  });
}

export function createMappingClassificationSuggestion(input: {
  mappingKey: string;
  promptCandidate: MappingClassificationPromptCandidate;
  modelSuggestion: ValidatedModelClassificationSuggestion;
  model: string;
  createdAt: string;
}): MappingClassificationSuggestion {
  const evidence = input.promptCandidate.evidence.filter((item) =>
    input.modelSuggestion.evidenceFields.includes(item.field),
  );
  const suggestionId = createHash('sha256').update(JSON.stringify({
    mappingKey: input.mappingKey,
    platformCandidateKey: input.promptCandidate.candidate.platformCandidateKey,
    sourceObservationId: input.promptCandidate.observation.observationId,
    proposed: input.modelSuggestion.proposed,
    promptVersion: 1,
  })).digest('hex');
  return {
    suggestionId,
    mappingKey: input.mappingKey,
    platformCandidateKey: input.promptCandidate.candidate.platformCandidateKey,
    sourceObservationId: input.promptCandidate.observation.observationId,
    createdAt: input.createdAt,
    model: input.model,
    promptVersion: 1,
    proposed: input.modelSuggestion.proposed,
    rationale: input.modelSuggestion.rationale,
    evidence,
  };
}

export function applyAcceptedMappingClassifications(input: {
  candidates: readonly MappingCandidateView[];
  suggestions: readonly MappingClassificationSuggestion[];
  reviews: readonly MappingClassificationReview[];
}): MappingCandidateView[] {
  const suggestionById = new Map(input.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]));
  const acceptedByCandidate = new Map<string, Array<{ suggestion: MappingClassificationSuggestion; review: MappingClassificationReview }>>();
  for (const review of effectiveAcceptedMappingClassificationReviews(input.reviews)) {
    const suggestion = suggestionById.get(review.suggestionId);
    if (!suggestion || suggestion.platformCandidateKey !== review.platformCandidateKey) continue;
    const values = acceptedByCandidate.get(review.platformCandidateKey) ?? [];
    values.push({ suggestion, review });
    acceptedByCandidate.set(review.platformCandidateKey, values);
  }

  return input.candidates.map((candidate) => {
    const accepted = (acceptedByCandidate.get(candidate.platformCandidateKey) ?? [])
      .sort((left, right) => left.review.reviewedAt.localeCompare(right.review.reviewedAt));
    if (accepted.length === 0) return candidate;
    const next = { ...candidate };
    const fields = new Set<MappingClassificationField>();
    for (const { suggestion } of accepted) {
      for (const field of ['companyKey', 'roleKey', 'level', 'location'] as const) {
        if (!next[field] && suggestion.proposed[field]) {
          next[field] = suggestion.proposed[field];
          fields.add(field);
        }
      }
    }
    if (fields.size === 0) return candidate;
    const latestReview = accepted.at(-1)!.review;
    next.manualClassification = {
      fields: [...fields],
      suggestionIds: accepted.map(({ suggestion }) => suggestion.suggestionId),
      reviewedAt: latestReview.reviewedAt,
      reviewedBy: latestReview.reviewedBy,
    };
    return next;
  });
}

function reviewVersionKey(review: MappingClassificationReview): string {
  return review.reviewKey || `${review.mappingKey}\u001f${review.suggestionId}`;
}

function compareReviewVersion(left: MappingClassificationReview, right: MappingClassificationReview): number {
  return (left.reviewVersion ?? 0) - (right.reviewVersion ?? 0)
    || left.reviewedAt.localeCompare(right.reviewedAt)
    || left.reviewId.localeCompare(right.reviewId);
}

/**
 * Reviews are append-only audit events. The latest event for each suggestion is
 * authoritative; accepted reviews superseded by another effective review are
 * intentionally excluded from all derived facts.
 */
export function effectiveAcceptedMappingClassificationReviews(
  reviews: readonly MappingClassificationReview[],
): MappingClassificationReview[] {
  const latestByKey = new Map<string, MappingClassificationReview>();
  for (const review of reviews) {
    const key = reviewVersionKey(review);
    const current = latestByKey.get(key);
    if (!current || compareReviewVersion(current, review) < 0) {
      latestByKey.set(key, review);
    }
  }
  const currentReviews = [...latestByKey.values()];
  const superseded = new Set(
    currentReviews.flatMap((review) => review.supersedesReviewId ? [review.supersedesReviewId] : []),
  );
  return currentReviews
    .filter((review) => review.decision === 'accepted' && !superseded.has(review.reviewId))
    .sort(compareReviewVersion);
}
