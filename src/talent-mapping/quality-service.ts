import { randomUUID } from 'node:crypto';

import { exportTalentMapping } from './export.js';
import { buildMappingRunChangeReport } from './change-report.js';
import { effectiveAcceptedMappingClassificationReviews } from './classification.js';
import {
  activeMappingEntityLinks,
  buildMappingEntityLinkSuggestions,
  countConfirmedMappingEntities,
} from './entity-links.js';
import { TalentMappingStore } from './store.js';
import type {
  MappingCandidateObservation,
  MappingClassificationReview,
  MappingClassificationSuggestionView,
  MappingEntityLink,
  MappingEntityLinkReviewView,
  MappingRunChangeReport,
  TalentMappingProject,
} from '../types/talent-mapping.js';

export interface TalentMappingQualityServiceOptions {
  dataDir?: string;
  store?: TalentMappingStore;
  now?: () => Date;
}

export class TalentMappingConflictError extends Error {
  constructor(message: string, readonly latest?: unknown) {
    super(message);
    this.name = 'TalentMappingConflictError';
  }
}

function requiredText(value: unknown, label: string, maxLength = 1000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim().slice(0, maxLength);
}

function candidateKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('platformCandidateKeys must contain at least two non-empty strings');
  }
  const normalized = [...new Set(value.map((item) => (item as string).trim()))].sort();
  if (normalized.length < 2) {
    throw new Error('platformCandidateKeys must contain at least two distinct candidates');
  }
  return normalized;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSuggestionStillValid(project: TalentMappingProject, suggestion: MappingClassificationSuggestionView): void {
  const companyKeys = new Set(project.taxonomy.targetCompanies.map((company) => company.companyKey));
  const roleKeys = new Set(project.taxonomy.roleFamilies.map((role) => role.roleKey));
  const levels = new Set(project.taxonomy.levels);
  const locations = new Set(project.objective.locations);
  if (suggestion.proposed.companyKey && !companyKeys.has(suggestion.proposed.companyKey)) throw new Error('Classification suggestion companyKey is no longer declared by the Mapping plan');
  if (suggestion.proposed.roleKey && !roleKeys.has(suggestion.proposed.roleKey)) throw new Error('Classification suggestion roleKey is no longer declared by the Mapping plan');
  if (suggestion.proposed.level && !levels.has(suggestion.proposed.level)) throw new Error('Classification suggestion level is no longer declared by the Mapping plan');
  if (suggestion.proposed.location && !locations.has(suggestion.proposed.location)) throw new Error('Classification suggestion location is no longer declared by the Mapping plan');
  if (suggestion.evidence.length === 0) throw new Error('Classification suggestion has no source evidence');
  const evidenceFields = new Set(suggestion.evidence.map((evidence) => evidence.field));
  if (suggestion.proposed.companyKey && !evidenceFields.has('currentCompany')) throw new Error('Classification suggestion companyKey requires currentCompany evidence');
  if ((suggestion.proposed.roleKey || suggestion.proposed.level) && !evidenceFields.has('currentTitle')) throw new Error('Classification suggestion roleKey/level requires currentTitle evidence');
  if (suggestion.proposed.location && !evidenceFields.has('location')) throw new Error('Classification suggestion location requires location evidence');
}

function expectedEvidenceValue(
  observation: MappingCandidateObservation,
  field: MappingClassificationSuggestionView['evidence'][number]['field'],
): string | undefined {
  if (field === 'currentCompany') return observation.currentCompany?.slice(0, 240);
  if (field === 'currentTitle') return observation.currentTitle?.slice(0, 240);
  return observation.normalized.location?.slice(0, 240);
}

export class TalentMappingQualityService {
  private readonly store: TalentMappingStore;
  private readonly now: () => Date;
  private readonly mappingLocks = new Map<string, Promise<void>>();

  constructor(options: TalentMappingQualityServiceOptions = {}) {
    this.store = options.store ?? new TalentMappingStore({ dataDir: options.dataDir });
    this.now = options.now ?? (() => new Date());
  }

  async getEntityLinkReview(mappingKey: string): Promise<MappingEntityLinkReviewView> {
    await this.requireProject(mappingKey);
    const [candidates, links] = await Promise.all([
      this.store.readCandidateView(mappingKey),
      this.store.readEntityLinks(mappingKey),
    ]);
    const activeLinks = activeMappingEntityLinks(links);
    return {
      platformProfileCount: candidates.length,
      confirmedEntityCount: countConfirmedMappingEntities(candidates.length, links),
      activeLinks,
      revokedLinks: links.filter((link) => Boolean(link.revokedAt)),
      suggestions: buildMappingEntityLinkSuggestions(candidates, links),
    };
  }

  async confirmEntityLink(mappingKey: string, payload: unknown): Promise<MappingEntityLink> {
    const item = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const keys = candidateKeys(item.platformCandidateKeys);
    const confirmedBy = requiredText(item.confirmedBy, 'confirmedBy', 120);
    const evidence = requiredText(item.evidence, 'evidence', 1000);
    return this.withMappingLock(mappingKey, async () => {
      await this.requireProject(mappingKey);
      const [candidates, links] = await Promise.all([
        this.store.readCandidateView(mappingKey),
        this.store.readEntityLinks(mappingKey),
      ]);
      const candidateByKey = new Map(candidates.map((candidate) => [candidate.platformCandidateKey, candidate]));
      const selected = keys.map((key) => {
        const candidate = candidateByKey.get(key);
        if (!candidate) throw new Error(`Talent Mapping candidate not found: ${key}`);
        return candidate;
      });
      if (new Set(selected.map((candidate) => candidate.platform)).size < 2) {
        throw new Error('A Mapping entity link must contain candidates from at least two platforms');
      }
      const activeLinks = activeMappingEntityLinks(links);
      const existingSame = activeLinks.find((link) => sameKeys([...link.platformCandidateKeys].sort(), keys));
      if (existingSame) return existingSame;
      const conflicting = activeLinks.find((link) => link.platformCandidateKeys.some((key) => keys.includes(key)));
      if (conflicting) {
        throw new TalentMappingConflictError(`One or more candidates already belong to entity ${conflicting.entityId}`, conflicting);
      }

      const link: MappingEntityLink = {
        entityId: randomUUID(),
        platformCandidateKeys: keys,
        confirmedAt: this.now().toISOString(),
        confirmedBy,
        evidence,
      };
      await this.store.saveEntityLinks(mappingKey, [...links, link]);
      await this.refreshArtifacts(mappingKey);
      return link;
    });
  }

  async revokeEntityLink(mappingKey: string, entityId: string, payload: unknown): Promise<MappingEntityLink> {
    const item = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const revokedBy = requiredText(item.revokedBy, 'revokedBy', 120);
    const revocationReason = requiredText(item.reason, 'reason', 1000);
    return this.withMappingLock(mappingKey, async () => {
      await this.requireProject(mappingKey);
      const links = await this.store.readEntityLinks(mappingKey);
      const index = links.findIndex((link) => link.entityId === entityId);
      if (index < 0) throw new Error(`Talent Mapping entity link not found: ${entityId}`);
      if (links[index]!.revokedAt) return links[index]!;
      const revoked: MappingEntityLink = {
        ...links[index]!,
        revokedAt: this.now().toISOString(),
        revokedBy,
        revocationReason,
      };
      const updated = [...links];
      updated[index] = revoked;
      await this.store.saveEntityLinks(mappingKey, updated);
      await this.refreshArtifacts(mappingKey);
      return revoked;
    });
  }

  async listClassificationSuggestions(mappingKey: string): Promise<MappingClassificationSuggestionView[]> {
    await this.requireProject(mappingKey);
    const [suggestions, reviews] = await Promise.all([
      this.store.readClassificationSuggestions(mappingKey),
      this.store.readClassificationReviews(mappingKey),
    ]);
    const reviewsBySuggestion = new Map<string, MappingClassificationReview[]>();
    for (const review of reviews) {
      const values = reviewsBySuggestion.get(review.suggestionId) ?? [];
      values.push(review);
      reviewsBySuggestion.set(review.suggestionId, values);
    }
    return suggestions
      .map((suggestion) => {
        const history = (reviewsBySuggestion.get(suggestion.suggestionId) ?? [])
          .sort((left, right) => (right.reviewVersion ?? 0) - (left.reviewVersion ?? 0)
            || right.reviewedAt.localeCompare(left.reviewedAt)
            || right.reviewId.localeCompare(left.reviewId));
        return { ...suggestion, review: history[0], reviewHistory: history };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async reviewClassificationSuggestion(
    mappingKey: string,
    suggestionId: string,
    payload: unknown,
  ): Promise<MappingClassificationReview> {
    const item = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (item.decision !== 'accepted' && item.decision !== 'rejected') {
      throw new Error('decision must be accepted or rejected');
    }
    const decision = item.decision;
    const reviewedBy = requiredText(item.reviewedBy, 'reviewedBy', 120);
    const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim().slice(0, 1000) : undefined;
    const supersedeReviewId = typeof item.supersedeReviewId === 'string' && item.supersedeReviewId.trim()
      ? item.supersedeReviewId.trim()
      : undefined;
    return this.withMappingLock(mappingKey, async () => {
      const project = await this.requireProject(mappingKey);
      const [suggestions, reviews, observations, candidates] = await Promise.all([
        this.store.readClassificationSuggestions(mappingKey),
        this.store.readClassificationReviews(mappingKey),
        this.store.readCandidateObservations(mappingKey),
        this.store.readCandidateView(mappingKey),
      ]);
      const suggestion = suggestions.find((candidate) => candidate.suggestionId === suggestionId);
      if (!suggestion) throw new Error(`Talent Mapping classification suggestion not found: ${suggestionId}`);
      const reviewKey = `${mappingKey}\u001f${suggestionId}`;
      const previous = reviews
        .filter((review) => (review.reviewKey || `${review.mappingKey}\u001f${review.suggestionId}`) === reviewKey)
        .sort((left, right) => (right.reviewVersion ?? 0) - (left.reviewVersion ?? 0)
          || right.reviewedAt.localeCompare(left.reviewedAt)
          || right.reviewId.localeCompare(left.reviewId))[0];
      if (previous) {
        if (previous.decision === decision && previous.supersedesReviewId === supersedeReviewId) {
          return previous;
        }
        throw new TalentMappingConflictError(
          `Classification suggestion ${suggestionId} was already reviewed; reload the latest review before changing it`,
          previous,
        );
      }

      if (decision === 'accepted') {
        assertSuggestionStillValid(project, suggestion);
        const sourceObservation = observations.find((observation) => observation.observationId === suggestion.sourceObservationId);
        if (!sourceObservation || sourceObservation.platformCandidateKey !== suggestion.platformCandidateKey) {
          throw new Error('Classification suggestion source observation is missing or belongs to another candidate');
        }
        if (suggestion.evidence.some((evidence) => evidence.observationId !== sourceObservation.observationId)) {
          throw new Error('Classification suggestion evidence does not match its source observation');
        }
        if (suggestion.evidence.some((evidence) =>
          evidence.rawValue !== expectedEvidenceValue(sourceObservation, evidence.field))) {
          throw new Error('Classification suggestion evidence value does not match its source observation');
        }
        const latestObservation = observations
          .filter((observation) => observation.platformCandidateKey === suggestion.platformCandidateKey)
          .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];
        if (latestObservation?.observationId !== sourceObservation.observationId) {
          throw new Error('Classification suggestion is stale; generate a new suggestion from the latest observation');
        }
        const candidate = candidates.find((candidate) => candidate.platformCandidateKey === suggestion.platformCandidateKey);
        if (!candidate) throw new Error(`Talent Mapping candidate not found: ${suggestion.platformCandidateKey}`);
        const proposedFields = Object.entries(suggestion.proposed)
          .filter((entry): entry is [keyof typeof suggestion.proposed, string] => Boolean(entry[1]));
        const effectiveReviews = effectiveAcceptedMappingClassificationReviews(reviews);
        const suggestionById = new Map(suggestions.map((item) => [item.suggestionId, item]));
        const conflicts = effectiveReviews.filter((review) => {
          if (review.platformCandidateKey !== suggestion.platformCandidateKey) return false;
          const activeSuggestion = suggestionById.get(review.suggestionId);
          return proposedFields.some(([field]) => Boolean(activeSuggestion?.proposed[field]));
        });
        if (conflicts.length > 0 && !conflicts.every((review) => review.reviewId === supersedeReviewId)) {
          throw new TalentMappingConflictError(
            `Classification fields already have an accepted review (${conflicts.map((review) => review.reviewId).join(', ')}); reload or provide its review ID to supersede`,
            conflicts,
          );
        }
        const supersededSuggestion = supersedeReviewId
          ? suggestionById.get(conflicts.find((review) => review.reviewId === supersedeReviewId)?.suggestionId ?? '')
          : undefined;
        const fillsUnclassifiedOrSupersededField = proposedFields.some(([field]) =>
          !candidate[field as keyof typeof candidate] || Boolean(supersededSuggestion?.proposed[field]),
        );
        if (!fillsUnclassifiedOrSupersededField) {
          throw new Error('Classification suggestion no longer fills any unclassified field');
        }
      }

      const review: MappingClassificationReview = {
        reviewId: randomUUID(),
        reviewKey,
        reviewVersion: 1,
        mappingKey,
        suggestionId,
        platformCandidateKey: suggestion.platformCandidateKey,
        decision,
        reviewedAt: this.now().toISOString(),
        reviewedBy,
        note,
        supersedesReviewId: supersedeReviewId,
      };
      await this.store.appendClassificationReview(review);
      await this.refreshArtifacts(mappingKey);
      return review;
    });
  }

  async revokeClassificationSuggestion(
    mappingKey: string,
    suggestionId: string,
    payload: unknown,
  ): Promise<MappingClassificationReview> {
    const item = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const reviewedBy = requiredText(item.reviewedBy, 'reviewedBy', 120);
    const note = requiredText(item.reason, 'reason', 1000);
    return this.withMappingLock(mappingKey, async () => {
      await this.requireProject(mappingKey);
      const [suggestions, reviews] = await Promise.all([
        this.store.readClassificationSuggestions(mappingKey),
        this.store.readClassificationReviews(mappingKey),
      ]);
      const suggestion = suggestions.find((candidate) => candidate.suggestionId === suggestionId);
      if (!suggestion) throw new Error(`Talent Mapping classification suggestion not found: ${suggestionId}`);
      const reviewKey = `${mappingKey}\u001f${suggestionId}`;
      const current = reviews
        .filter((review) => (review.reviewKey || `${review.mappingKey}\u001f${review.suggestionId}`) === reviewKey)
        .sort((left, right) => (right.reviewVersion ?? 0) - (left.reviewVersion ?? 0)
          || right.reviewedAt.localeCompare(left.reviewedAt)
          || right.reviewId.localeCompare(left.reviewId))[0];
      if (!current || current.decision !== 'accepted') {
        if (current?.decision === 'revoked') return current;
        throw new TalentMappingConflictError(`Classification suggestion ${suggestionId} has no active accepted review to revoke`, current);
      }
      const review: MappingClassificationReview = {
        reviewId: randomUUID(),
        reviewKey,
        reviewVersion: (current.reviewVersion ?? 0) + 1,
        mappingKey,
        suggestionId,
        platformCandidateKey: suggestion.platformCandidateKey,
        decision: 'revoked',
        reviewedAt: this.now().toISOString(),
        reviewedBy,
        note,
        supersedesReviewId: current.supersedesReviewId,
        revokesReviewId: current.reviewId,
      };
      await this.store.appendClassificationReview(review);
      await this.refreshArtifacts(mappingKey);
      return review;
    });
  }

  async getChangeReport(
    mappingKey: string,
    options: { baseRunId?: string; compareRunId?: string } = {},
  ): Promise<MappingRunChangeReport> {
    await this.requireProject(mappingKey);
    const [runs, observations] = await Promise.all([
      this.store.listRuns(mappingKey),
      this.store.readCandidateObservations(mappingKey),
    ]);
    return buildMappingRunChangeReport({
      mappingKey,
      runs,
      observations,
      baseRunId: options.baseRunId,
      compareRunId: options.compareRunId,
      generatedAt: this.now().toISOString(),
    });
  }

  async refreshArtifacts(mappingKey: string): Promise<void> {
    const project = await this.requireProject(mappingKey);
    const [views, runs, links] = await Promise.all([
      this.store.rebuildDerivedViews(mappingKey),
      this.store.listRuns(mappingKey),
      this.store.readEntityLinks(mappingKey),
    ]);
    const latestRun = runs[0];
    if (!latestRun) return;
    await exportTalentMapping({
      plan: project,
      run: latestRun,
      views,
      entityLinks: links,
      exportDir: this.store.getLatestExportDir(mappingKey),
      generatedAt: this.now().toISOString(),
    });
  }

  private async requireProject(mappingKey: string): Promise<TalentMappingProject> {
    const project = await this.store.readProject(mappingKey);
    if (!project) throw new Error(`Talent Mapping project not found: ${mappingKey}`);
    return project;
  }

  private async withMappingLock<T>(mappingKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mappingLocks.get(mappingKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.mappingLocks.set(mappingKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mappingLocks.get(mappingKey) === queued) {
        this.mappingLocks.delete(mappingKey);
      }
    }
  }
}
