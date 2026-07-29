import type { SupportedPlatform } from '../platforms/types.js';
import type { CandidateResume, SearchConditionPlan } from './job.js';

export const TALENT_MAPPING_CORE_PLATFORMS = ['51job', 'liepin', 'zhilian'] as const;

export type TalentMappingCorePlatform = (typeof TALENT_MAPPING_CORE_PLATFORMS)[number];
export type TalentMappingPlatformSelection = TalentMappingCorePlatform | 'all';
export type TalentMappingStage = 'scan' | 'enrich' | 'all';
export type MappingEnrichmentMode = 'card-only' | 'targeted-detail' | 'full-detail';

export interface MappingObjective {
  roleFamilies: string[];
  locations: string[];
  notes?: string;
}

export interface MappingTargetCompany {
  companyKey: string;
  displayName: string;
  aliases: string[];
  tier: string;
}

export interface MappingRoleFamily {
  roleKey: string;
  displayName: string;
  titleAliases: string[];
}

export interface MappingTaxonomy {
  targetCompanies: MappingTargetCompany[];
  roleFamilies: MappingRoleFamily[];
  levels: string[];
}

export interface MappingEnabledPlatformPlan {
  disabled?: false;
  searchSource: 'saved' | 'direct';
  searchPlanFile: string;
  searchPlan: SearchConditionPlan;
}

export interface MappingDisabledPlatformPlan {
  disabled: true;
  reason: string;
}

export type MappingPlatformPlan = MappingEnabledPlatformPlan | MappingDisabledPlatformPlan;

export interface MappingSlice {
  sliceId: string;
  label: string;
  platformPlans: Partial<Record<TalentMappingCorePlatform, MappingPlatformPlan>>;
}

export interface MappingCoverageLimits {
  maxBatchesPerSlice: number;
  maxCandidatesPerSlice: number;
  sliceTimeoutMs: number;
}

export interface MappingDetailSelectionPolicy {
  targetCompanyTiers?: string[];
  roleKeys?: string[];
  levels?: string[];
  locations?: string[];
  samplePerMatrixCell: number;
}

export interface MappingCardOnlyEnrichmentPolicy {
  mode: 'card-only';
}

export interface MappingDetailEnrichmentPolicy {
  mode: 'targeted-detail' | 'full-detail';
  maxProfilesPerSlice: number;
  maxProfilesTotal: number;
  selection: MappingDetailSelectionPolicy;
}

export type MappingEnrichmentPolicy = MappingCardOnlyEnrichmentPolicy | MappingDetailEnrichmentPolicy;

export interface TalentMappingPlan {
  version: 1;
  mappingKey: string;
  name: string;
  objective: MappingObjective;
  taxonomy: MappingTaxonomy;
  slices: MappingSlice[];
  coverage: MappingCoverageLimits;
  enrichment: MappingEnrichmentPolicy;
}

export interface TalentMappingProject extends TalentMappingPlan {
  sourceFilePath: string;
  createdAt: string;
  updatedAt: string;
}

export type MappingEvidenceSource = 'card' | 'resume-detail' | 'annotation';
export type MappingEvidenceConfidence = 'confirmed' | 'unclassified';

export interface MappingFieldEvidence {
  field: 'company' | 'role' | 'level' | 'location' | 'name' | 'card-text' | 'resume';
  source: MappingEvidenceSource;
  rawValue?: string;
  ruleId?: string;
  confidence: MappingEvidenceConfidence;
}

export interface MappingNormalizedCandidateFields {
  companyKey?: string;
  roleKey?: string;
  level?: string;
  location?: string;
}

export interface MappingCandidateObservation {
  observationId: string;
  runId: string;
  mappingKey: string;
  sliceId: string;
  platform: TalentMappingCorePlatform;
  platformCandidateKey: string;
  candidateId: string;
  observedAt: string;
  batchIdentity: string;
  batchNumber?: number;
  rankInBatch: number;
  globalRank?: number;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  cardText?: string;
  normalized: MappingNormalizedCandidateFields;
  evidence: MappingFieldEvidence[];
}

export interface MappingProfileObservation {
  profileObservationId: string;
  runId: string;
  mappingKey: string;
  sliceId: string;
  platform: TalentMappingCorePlatform;
  platformCandidateKey: string;
  candidateId: string;
  observedAt: string;
  resume: CandidateResume;
  source: 'resume-detail';
  detailOpenSideEffect: 'may-mark-viewed';
  selectionReason: string[];
  rawSnapshotPath?: string;
}

export type MappingTerminationReason =
  | 'end-reached'
  | 'empty-result'
  | 'batch-limit'
  | 'candidate-limit'
  | 'deadline'
  | 'failed';

export type MappingSliceRunStatus = 'completed' | 'completed-with-gaps' | 'failed';

export interface MappingFailedProfile {
  candidateId: string;
  error: string;
}

export interface MappingSliceRun {
  runId: string;
  mappingKey: string;
  sliceId: string;
  platform: TalentMappingCorePlatform;
  status: MappingSliceRunStatus;
  reportedResultTotal?: number;
  reportedResultTotalSource?: 'page' | 'api';
  scannedBatches: number;
  observedCards: number;
  uniquePlatformProfiles: number;
  eligibleForDetail: number;
  enrichedProfiles: number;
  failedProfiles: MappingFailedProfile[];
  terminationReason: MappingTerminationReason;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface MappingRunRecord {
  runId: string;
  mappingKey: string;
  mappingName: string;
  stage: TalentMappingStage;
  platformSelection: TalentMappingPlatformSelection;
  sourceScanRunId?: string;
  status: MappingSliceRunStatus;
  detailOpenConfirmed: boolean;
  detailOpenSideEffect: 'none' | 'may-mark-viewed';
  startedAt: string;
  finishedAt: string;
  sliceRuns: MappingSliceRun[];
  exportDir?: string;
  error?: string;
}

export interface MappingBatchCheckpoint {
  runId: string;
  mappingKey: string;
  sliceId: string;
  platform: TalentMappingCorePlatform;
  batchIdentity: string;
  batchNumber?: number;
  observedCards: number;
  savedAt: string;
}

export interface MappingCandidateView {
  platform: TalentMappingCorePlatform;
  platformCandidateKey: string;
  candidateId: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  companyKey?: string;
  roleKey?: string;
  level?: string;
  location?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  sourceSliceIds: string[];
  observationCount: number;
  detailStatus: 'not-enriched' | 'enriched';
  latestProfileObservedAt?: string;
  resume?: CandidateResume;
  entityId?: string;
  manualClassification?: {
    fields: MappingClassificationField[];
    suggestionIds: string[];
    reviewedAt: string;
    reviewedBy: string;
  };
}

export interface MappingCompanyRoleMatrixRow {
  companyKey: string;
  companyDisplayName: string;
  companyTier?: string;
  roleKey: string;
  roleDisplayName: string;
  level: string;
  location: string;
  platform: TalentMappingCorePlatform;
  platformProfiles: number;
  enrichedProfiles: number;
  unclassifiedProfiles: number;
}

export interface MappingCoverageViewRow extends MappingSliceRun {
  cardCoverage?: number;
  cardCoverageStatus: 'known' | 'unknown';
  detailCoverage?: number;
  detailCoverageStatus: 'known' | 'zero-eligible';
  coverageStatus: 'complete' | 'capped' | 'failed';
}

export interface MappingDerivedViews {
  candidates: MappingCandidateView[];
  companies: MappingCompanyRoleMatrixRow[];
  coverage: MappingCoverageViewRow[];
  changes: MappingRunChangeReport;
  generatedAt: string;
}

export interface TalentMappingRunSummary {
  mode: 'talent-mapping';
  mappingKey: string;
  runId: string;
  stage: TalentMappingStage;
  status: MappingSliceRunStatus;
  platformSelection: TalentMappingPlatformSelection;
  observedCards: number;
  uniquePlatformProfiles: number;
  enrichedProfiles: number;
  failedProfiles: number;
  cappedSlices: number;
  exportDir: string;
  runPath: string;
  detailOpenSideEffect: 'none' | 'may-mark-viewed';
}

export interface CandidateResultBatch {
  candidates: import('./job.js').CandidateListItem[];
  batchIdentity: string;
  batchNumber?: number;
  endReached: boolean;
}

export interface AdvanceCandidateBatchInput {
  expectedCurrentBatchIdentity: string;
  deadline: number;
}

export type AdvanceCandidateBatchResult =
  | { status: 'advanced'; batch: CandidateResultBatch }
  | { status: 'end-reached' };

export interface CandidateProfileDetailResult {
  resume: CandidateResume;
  rawText?: string;
  detailPage: import('playwright').Page;
}

export interface MappingAnnotation {
  annotationId: string;
  mappingKey: string;
  platformCandidateKey?: string;
  createdAt: string;
  source: string;
  note: string;
}

export interface MappingEntityLink {
  entityId: string;
  platformCandidateKeys: string[];
  confirmedAt: string;
  confirmedBy: string;
  evidence: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
}

export interface MappingEntityLinkSuggestion {
  suggestionId: string;
  platformCandidateKeys: [string, string];
  evidence: string[];
}

export interface MappingEntityLinkReviewView {
  platformProfileCount: number;
  confirmedEntityCount: number;
  activeLinks: MappingEntityLink[];
  revokedLinks: MappingEntityLink[];
  suggestions: MappingEntityLinkSuggestion[];
}

export type MappingClassificationField = 'companyKey' | 'roleKey' | 'level' | 'location';

export interface MappingClassificationEvidence {
  field: 'currentCompany' | 'currentTitle' | 'location';
  rawValue: string;
  observationId: string;
}

export interface MappingClassificationSuggestion {
  suggestionId: string;
  mappingKey: string;
  platformCandidateKey: string;
  sourceObservationId: string;
  createdAt: string;
  model: string;
  promptVersion: 1;
  proposed: MappingNormalizedCandidateFields;
  rationale: string;
  evidence: MappingClassificationEvidence[];
}

export interface MappingClassificationReview {
  reviewId: string;
  mappingKey: string;
  suggestionId: string;
  platformCandidateKey: string;
  decision: 'accepted' | 'rejected';
  reviewedAt: string;
  reviewedBy: string;
  note?: string;
}

export interface MappingClassificationSuggestionView extends MappingClassificationSuggestion {
  review?: MappingClassificationReview;
}

export interface TalentMappingClassificationRunSummary {
  mode: 'talent-mapping-classification';
  mappingKey: string;
  model: string;
  consideredCandidates: number;
  generatedSuggestions: number;
  skippedCandidates: number;
  suggestionIds: string[];
}

export type MappingComparableField =
  | 'name'
  | 'currentCompany'
  | 'currentTitle'
  | 'companyKey'
  | 'roleKey'
  | 'level'
  | 'location';

export interface MappingRunCandidateSnapshot {
  platform: TalentMappingCorePlatform;
  platformCandidateKey: string;
  candidateId: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  companyKey?: string;
  roleKey?: string;
  level?: string;
  location?: string;
  observedAt: string;
}

export interface MappingRunFieldChange {
  field: MappingComparableField;
  previousValue?: string;
  currentValue?: string;
  previousEvidence: MappingFieldEvidence[];
  currentEvidence: MappingFieldEvidence[];
}

export interface MappingRunCandidateChange {
  platformCandidateKey: string;
  platform: TalentMappingCorePlatform;
  candidateId: string;
  fields: MappingRunFieldChange[];
}

export interface MappingRunChangeReport {
  status: 'ready' | 'insufficient-runs';
  mappingKey: string;
  baseRunId?: string;
  compareRunId?: string;
  generatedAt: string;
  newProfiles: MappingRunCandidateSnapshot[];
  notObservedProfiles: MappingRunCandidateSnapshot[];
  changedProfiles: MappingRunCandidateChange[];
  unchangedProfiles: number;
  caveat: string;
}

export function isTalentMappingCorePlatform(platform: SupportedPlatform): platform is TalentMappingCorePlatform {
  return (TALENT_MAPPING_CORE_PLATFORMS as readonly string[]).includes(platform);
}
