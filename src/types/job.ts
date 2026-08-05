import type { SupportedPlatform } from '../platforms/types.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';

export interface SalaryRange {
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
  raw?: string;
}

export interface AgeRange {
  min?: number;
  max?: number;
  raw?: string;
}

export interface NormalizedJob {
  title: string;
  location?: string;
  department?: string;
  salaryRange?: SalaryRange;
  ageRange?: AgeRange;
  education?: string;
  majors: string[];
  languageRequirements: string[];
  responsibilities: string[];
  hardRequirements: string[];
  preferredRequirements: string[];
  experienceYearsMin?: number;
  regionPreferences: string[];
  industryTags: string[];
}

export interface ReportDeliveryOptions {
  recipientEmail?: string;
  ccEmails?: string[];
}

export type JobSearchSource = 'saved' | 'direct';

/** Canonical hydrated condition identity for a platform-native saved search. */
export interface SavedSearchConditionIdentity {
  jobScope: string;
  city?: string;
  cityOptions?: string[];
  company?: string;
  inline: Record<string, string[]>;
  more: Record<string, string>;
  toggles: Record<string, boolean>;
}

/**
 * Complete business identity of a native saved search.  A Boss saved search
 * is not addressable by name alone; the condition identity and its derived
 * fingerprint are required before normal capture may reuse it.
 */
export interface SavedSearchReference {
  version: 1;
  platform: SupportedPlatform;
  name: string;
  nativeId?: string;
  expectedKeyword: string;
  conditionIdentity: SavedSearchConditionIdentity;
  conditionFingerprint: string;
  selectedFieldsFingerprint?: string;
}

export type SearchSortPolicy = 'platform-default' | 'match-priority';

export interface BossForwardingSettings {
  mode: 'colleague' | 'email';
  recipient: string;
  /**
   * Copy recipients used only by Boss email resume forwarding. The live Boss
   * dialog has no native CC field, so each address receives an independent
   * second forwarding action after the primary recipient.
   */
  ccEmails?: string[];
}

/**
 * Boss screening is expressed as positive model requirements. A requirement
 * is a negative routing match only when the model explicitly says the full
 * structured resume does not satisfy it. This avoids treating a generic
 * keyword as proof of a domain-specific capability.
 */
export interface BossModelRequirement {
  id: string;
  enabled: boolean;
  kind: 'modelRequirement';
  requirement: string;
  criteria: string[];
  insufficientEvidence: string[];
  label?: string;
}

export type BossModelRequirementOutcome = 'satisfied' | 'missing' | 'unknown';

export interface BossModelRequirementEvaluation {
  requirementId: string;
  outcome: BossModelRequirementOutcome;
  evidence: string[];
  missingCriteria: string[];
  reason: string;
}

/**
 * The policy rejects when any enabled model requirement is missing. Secondary
 * settings stay optional at the type level so an explicitly disabled saved
 * policy can retain partial delivery configuration; enabled execution
 * validates all required delivery targets before opening a browser.
 */
export interface BossScreeningSettings {
  enabled: boolean;
  policyVersion: 2;
  decisionMode: 'reject-on-any-missing';
  requirements: BossModelRequirement[];
  secondaryDelivery?: ReportDeliveryOptions & {
    recipientEmail: string;
  };
}

/**
 * Platform-neutral post-score result routing policy.  Unlike the historical
 * Boss screening settings this policy has no forwarding target: downstream
 * platforms only classify/report candidates, while native forwarding remains
 * owned by the Boss adapter.
 */
export interface PostScoreRoutingSettings {
  enabled: boolean;
  policyVersion: 2;
  decisionMode: 'reject-on-any-missing';
  requirements: BossModelRequirement[];
  secondaryDelivery?: ReportDeliveryOptions & {
    recipientEmail: string;
  };
}

/** Portable policy-only shape accepted by all capture platforms. */
export interface PostScoreRoutingPolicyFile {
  version: 2;
  decisionMode: 'reject-on-any-missing';
  requirements: BossModelRequirement[];
}

/** The portable JSON shape accepted by --boss-screening-policy-file. */
export interface BossScreeningPolicyFile {
  version: 2;
  decisionMode: 'reject-on-any-missing';
  requirements: BossModelRequirement[];
}

/**
 * Immutable Boss delivery/screening settings resolved at an HTTP or scheduler
 * queue boundary. Empty CC arrays are intentional and mean "send no CC";
 * omitted forwarding/screening objects mean those capabilities were absent in
 * the confirmed snapshot and must not be inherited later at execution time.
 */
export interface BossCaptureSettingsSnapshot {
  /** Delivery contract version; distinct from the screening policy version. */
  version: 3;
  resolvedAt: string;
  sourceJobKey?: string;
  primaryForwarding?: BossForwardingSettings & { ccEmails: string[] };
  primaryDelivery: {
    recipientEmail?: string;
    ccEmails: string[];
  };
  screening?: BossScreeningSettings;
  settingsHash: string;
}

/**
 * Explicit, field-level changes requested for a Boss capture.  Undefined
 * means that the caller did not ask to change the persisted value; null (or
 * an empty array) is an intentional clear.  The distinction is important for
 * queued tasks because a stale full JobRecord must never recreate a cleared
 * CC list.
 */
export interface BossCaptureCanonicalPatch {
  recipientEmail?: string | null;
  ccEmails?: string[];
  bossForwarding?: BossForwardingSettings | null;
  bossScreening?: BossScreeningSettings | null;
  postScoreRouting?: PostScoreRoutingSettings | null;
  searchSource?: JobSearchSource;
  pageKeyword?: string | null;
  applicationFilterInput?: Record<string, unknown> | null;
  conditions?: SearchCondition[];
  conditionSetRef?: SearchConditionSetReference | null;
  selectedFieldsFingerprint?: string | null;
  savedSearch?: SavedSearchReference | null;
}

/** Field-level JobRecord patch applied with a source revision/CAS check. */
export type JobConfigPatch = BossCaptureCanonicalPatch;

/**
 * Immutable server-side facts captured before a Boss task enters the queue.
 * `BossCaptureSettingsSnapshot` remains the CLI-compatible delivery payload;
 * this wrapper additionally pins the job identity, complete search plan and
 * source revision so the execution stage cannot silently consult a newer job
 * record.  It is never accepted from a public HTTP/assistant request.
 */
export interface BossCaptureTaskSnapshot {
  /** Delivery/search task contract version. */
  version: 4;
  resolvedAt: string;
  sourceJobKey: string;
  sourceJobRevision?: number;
  sourceJobsFile?: string;
  sourceItemIndex?: number;
  jobIdentity: {
    bossJobId?: string;
    expectedJobName: string;
  };
  searchPlan: {
    source: JobSearchSource;
    pageKeyword: string;
    keywordSource: string;
    conditionSetRef?: SearchConditionSetReference;
    selectedFieldsFingerprint?: string;
    savedSearch?: SavedSearchReference;
    sortPolicy?: SearchSortPolicy;
    applicationFilterInput?: Record<string, unknown>;
    conditions: SearchCondition[];
  };
  deliveryAndScreening: {
    primaryForwarding?: BossForwardingSettings & { ccEmails: string[] };
    primaryDelivery: {
      recipientEmail?: string;
      ccEmails: string[];
    };
    screening?: BossScreeningSettings;
  };
  canonicalPatch?: BossCaptureCanonicalPatch;
  /** SHA-256 of the canonical snapshot excluding this field. */
  snapshotHash: string;
}

export type BossRoutingClassification = 'qualified' | 'review' | 'rejected';
export type BossRoutingAudience = 'primary' | 'secondary';

export interface BossRoutingDecision {
  classification: BossRoutingClassification;
  audience: BossRoutingAudience;
  matchedRequirementIds: string[];
  unknownRequirementIds: string[];
  reason: string;
}

export type BossForwardingStatus = 'pending' | 'sending' | 'sent' | 'retryable-failed' | 'uncertain' | 'superseded';

/** Normalized SMTP failure phase; provider-specific raw error fields never leave the mailer. */
export type SmtpFailurePhase = 'connect' | 'auth' | 'envelope' | 'data' | 'unknown';
export type SmtpRetrySafety = 'known-not-sent' | 'uncertain';
export type SmtpRetryDisposition = 'immediate-once' | 'deferred-once' | 'none';

/** De-identified SMTP evidence safe for outbox/audit persistence. */
export interface SmtpFailureEvidence {
  phase: SmtpFailurePhase;
  retrySafety: SmtpRetrySafety;
  retryDisposition: SmtpRetryDisposition;
  code?: string;
  command?: string;
  responseCode?: number;
}

export interface BossForwardingDeliveryState {
  role: 'recipient' | 'cc';
  recipient: string;
  status: BossForwardingStatus;
  attemptedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface BossForwardingState {
  status: BossForwardingStatus;
  mode: BossForwardingSettings['mode'];
  recipient: string;
  ccEmails?: string[];
  /** Per-recipient receipts prevent a successful primary send from being repeated when a copy send fails. */
  deliveries?: BossForwardingDeliveryState[];
  attemptedAt?: string;
  completedAt?: string;
  error?: string;
}

/**
 * Immutable routing decision written before the external Boss forwarding
 * mutation. It intentionally remains separate from the score artifact.
 */
export interface BossCandidateRoutingArtifact {
  /** Stable id used for idempotent recovery of a routing decision. */
  routingDecisionId?: string;
  candidateId: string;
  fetchedAt: string;
  scoredAt?: string;
  decidedAt: string;
  policyHash: string;
  scoreStatus: CandidateScoreArtifact['status'];
  scoreError?: string;
  classification: BossRoutingClassification;
  audience: BossRoutingAudience;
  requirementEvaluations: BossModelRequirementEvaluation[];
  matchedRequirementIds: string[];
  unknownRequirementIds: string[];
  reason: string;
  /** New runs identify which external delivery owns this decision. */
  deliveryKind?: 'boss-forwarding' | 'rejection-email';
  /** Present for legacy and non-rejected Boss forwarding decisions. */
  forwarding?: BossForwardingState;
}

/** Candidate-level SMTP delivery for an explicit Boss rejection. */
export interface BossRejectionEmailOutboxEntry {
  version: 1;
  deliveryId: string;
  candidateId: string;
  routingDecisionId: string;
  routingArtifact: BossCandidateRoutingArtifact;
  policyHash: string;
  recipientEmail: string;
  ccEmails: string[];
  messageId: string;
  subject: string;
  markdown: string;
  contentHash: string;
  status: BossForwardingStatus;
  createdAt: string;
  updatedAt: string;
  /** Set only after the verified Boss detail lifecycle has closed. */
  detailClosedAt?: string;
  attemptedAt?: string;
  completedAt?: string;
  error?: string;
  /** Persisted SMTP attempt slots, reserved immediately before each call; preflight failures stay at zero. */
  attemptCount?: number;
  /** True after the second proven-not-sent attempt; ordinary recovery must stop. */
  retryExhausted?: boolean;
  /** First proven-not-sent failure that authorized the one bounded retry. */
  retryAuthorization?: SmtpFailureEvidence & {
    failedAttempt: 1;
    occurredAt: string;
    summary: string;
  };
  /** Most recent normalized failure, omitted from successful terminal presentation. */
  lastSmtpFailure?: SmtpFailureEvidence & {
    occurredAt: string;
    summary: string;
  };
}

/** Immutable, platform-neutral routing decision written after score/evaluation. */
export interface CandidateRoutingArtifact {
  /** Stable id used for idempotent recovery of a routing decision. */
  routingDecisionId?: string;
  candidateId: string;
  fetchedAt: string;
  scoredAt?: string;
  decidedAt: string;
  policyHash: string;
  scoreStatus: CandidateScoreArtifact['status'];
  scoreError?: string;
  classification: BossRoutingClassification;
  audience: BossRoutingAudience;
  requirementEvaluations: BossModelRequirementEvaluation[];
  matchedRequirementIds: string[];
  unknownRequirementIds: string[];
  reason: string;
}

/** Current, mutable forwarding state used for recovery without rewriting history. */
export interface BossForwardingOutboxEntry {
  candidateId: string;
  /**
   * Identifies which capture lifecycle owns this immutable target set.  Older
   * outbox files omit the field and are treated as post-score screening
   * entries by the compatibility reader.
   */
  workflow?: 'pre-capture' | 'post-score';
  /** Deterministic immutable decision identity for post-score recovery. */
  routingDecisionId?: string;
  /**
   * The decision payload required to rebuild a missing routing artifact after
   * an interruption between outbox and artifact writes. It intentionally
   * excludes mutable forwarding delivery status.
   */
  routingFacts?: {
    candidateId: string;
    fetchedAt: string;
    scoredAt?: string;
    decidedAt: string;
    policyHash: string;
    scoreStatus: CandidateScoreArtifact['status'];
    scoreError?: string;
    classification: BossRoutingClassification;
    audience: BossRoutingAudience;
    requirementEvaluations: BossModelRequirementEvaluation[];
    matchedRequirementIds: string[];
    unknownRequirementIds: string[];
    reason: string;
  };
  policyHash: string;
  classification: BossRoutingClassification;
  audience: BossRoutingAudience;
  createdAt: string;
  updatedAt: string;
  forwarding: BossForwardingState;
}

/**
 * Durable hand-off between a saved/seen Boss resume and its first routing
 * decision. File presence means scoring has not yet produced a durable outbox;
 * it is removed once that outbox exists.
 */
export interface BossScreeningWorkItem {
  candidateId: string;
  /** Policy hash captured before model work; absent only on pre-v2 legacy work items. */
  policyHash?: string;
  createdAt: string;
  updatedAt: string;
  /** Number of persisted scoring attempts; absent on legacy work items. */
  scoreAttemptCount?: number;
  /** Last technical/model failure while no immutable routing decision exists. */
  lastScoreFailure?: {
    failedAt: string;
    error: string;
    diagnostic?: CodexSessionFailureDiagnostic;
  };
}

/** Durable hand-off for generic platforms before score/routing completes. */
export interface PostScoreRoutingWorkItem {
  candidateId: string;
  policyHash?: string;
  createdAt: string;
  updatedAt: string;
  scoreAttemptCount?: number;
  lastScoreFailure?: {
    failedAt: string;
    error: string;
    diagnostic?: CodexSessionFailureDiagnostic;
  };
}

export interface BossAutomationSettings {
  forwarding?: BossForwardingSettings;
  summaryDelivery?: {
    recipientEmail: string;
    ccEmails?: string[];
  };
}

export type SearchCondition =
  | { kind: 'keyword'; value: string }
  | {
    kind: 'applicationFilter';
    fieldId: string;
    label: string;
    fieldKind: 'singleSelect' | 'multiSelect' | 'toggle' | 'textInput' | 'salaryRange' | 'numberRange';
    value: unknown;
    values?: Array<{
      value: string;
      pathLabels?: string[];
      ambiguous?: boolean;
    }>;
  }
  | { kind: 'resumeFreshness'; value: string }
  | { kind: 'location'; field?: string; values: string[] }
  | { kind: 'industry'; field?: string; values: string[] }
  | { kind: 'function'; field?: string; values: string[] }
  | { kind: 'education'; value: string }
  | { kind: 'experience'; minYears?: number; maxYears?: number }
  | { kind: 'age'; min?: number; max?: number }
  | { kind: string; [key: string]: unknown };

export interface SearchConditionPlan {
  keyword: string;
  savedSearchName?: string;
  conditions: SearchCondition[];
}

export interface SearchConditionPlanExecutionResult {
  page: import('playwright').Page;
  conditionResults: SearchConditionApplyResult[];
  resultTotal: number;
  resultTotalSource: 'page' | 'api';
}

export interface SearchConditionSaveResult {
  outcome: 'already-saved' | 'saved' | 'renamed';
  savedSearch: SavedSearchReference;
}

export interface SearchConditionApplyResult {
  platform: SupportedPlatform;
  condition: SearchCondition;
  status: 'applied' | 'skipped' | 'failed';
  message?: string;
}

export interface SearchSubscriptionSummary {
  platform: SupportedPlatform;
  keyword: string;
  savedSearchName?: string;
  resultTotal: number;
  resultTotalSource: 'page' | 'api';
  saveRequested: boolean;
  saved: boolean;
  allConditionsApplied: boolean;
  conditionStatusCounts: Record<SearchConditionApplyResult['status'], number>;
  conditionResults: SearchConditionApplyResult[];
  savedSearch?: SavedSearchReference;
  saveOutcome?: SearchConditionSaveResult['outcome'];
  sortPolicy?: SearchSortPolicy;
}

/** Structured evidence retained when an all-platform subscription run stops. */
export interface SearchSubscriptionFailureSummary {
  mode: 'search-subscription';
  status: 'failed';
  completedPlatforms: SupportedPlatform[];
  stoppedPlatform: SupportedPlatform;
  results: SearchSubscriptionSummary[];
  error: string;
}

export function parseEmailList(value?: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const emails = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return emails;
}

export function resolveReportDelivery(
  stored: ReportDeliveryOptions = {},
  overrides: ReportDeliveryOptions = {},
): ReportDeliveryOptions {
  return {
    recipientEmail: overrides.recipientEmail ?? stored.recipientEmail,
    ccEmails: overrides.ccEmails === undefined ? stored.ccEmails : overrides.ccEmails,
  };
}

export interface JobRecord {
  jobKey: string;
  platform: SupportedPlatform;
  /** Monotonic revision for field-level configuration CAS. Legacy records normalize to 1. */
  revision?: number;
  searchKeyword: string;
  recipientEmail?: string;
  ccEmails?: string[];
  searchSettings?: {
    source: JobSearchSource;
    /**
     * The query used on the platform search page. It is deliberately separate
     * from searchKeyword, which remains the job's stable display/lookup value.
     */
    pageKeyword?: string;
    applicationFilterInput?: Record<string, unknown>;
    conditions: SearchCondition[];
    /** Fixed source revision when direct-search filters came from a reusable condition set. */
    conditionSetRef?: SearchConditionSetReference;
    /** Catalog evidence captured while resolving the fixed condition-set revision. */
    resolution?: {
      selectedFieldsFingerprint: string;
    };
    /** Complete native subscription identity required when source is saved. */
    savedSearch?: SavedSearchReference;
    /** Runtime ordering overlay; never included in savedSearch.conditionFingerprint. */
    sortPolicy?: SearchSortPolicy;
  };
  bossForwarding?: BossForwardingSettings;
  /** Optional Boss-only post-score negative-condition routing policy. */
  bossScreening?: BossScreeningSettings;
  /** Optional platform-neutral post-score routing policy. */
  postScoreRouting?: PostScoreRoutingSettings;
  bossPosition?: {
    bossJobId: string;
    status: 'open' | 'pending' | 'closed' | 'unknown';
    syncedAt: string;
    sourceHash: string;
    normalization?: {
      kind: 'boss-page-rules';
      version: number;
    };
  };
  rawText: string;
  normalizedJob: NormalizedJob;
  createdAt: string;
}

export interface CandidateListItem {
  candidateId: string;
  resumeUrl?: string;
  name?: string;
  currentCompany?: string;
  currentTitle?: string;
  cardText?: string;
  sourceText?: string;
  searchResultIndex?: number;
}

export interface WorkExperience {
  company?: string;
  title?: string;
  industry?: string;
  start?: string;
  end?: string;
  duration?: string;
  details: string[];
}

export interface ResumeDomWorkNode {
  text: string;
  top: number;
  left: number;
  depth: number;
  tagName: string;
  className?: string;
  parentClassName?: string;
}

export interface ResumeDomSnapshot {
  workLines: string[];
  workBlocks?: string[][];
  workNodes?: ResumeDomWorkNode[];
}

export interface ResumePageEvidenceFrame {
  url: string;
  name: string;
  title: string;
  bodyLength: number;
  bodyPreview: string;
  htmlLength: number;
  markers: string[];
}

export interface ResumePageEvidence {
  url: string;
  title: string;
  bodyPreview: string;
  bodyLength: number;
  htmlLength: number;
  markers: string[];
  frames?: ResumePageEvidenceFrame[];
}

export interface ProjectExperience {
  name?: string;
  company?: string;
  start?: string;
  end?: string;
  duration?: string;
  details: string[];
}

export interface EducationExperience {
  school?: string;
  degree?: string;
  major?: string;
  start?: string;
  end?: string;
  details: string[];
}

export interface LanguageSkill {
  english?: string;
  'english level'?: string;
}

export interface CandidateResume {
  candidateId: string;
  resumeUrl?: string;
  candidateShareUrl?: string;
  name?: string;
  age?: number;
  nativePlace?: string;
  education?: string;
  regions: string[];
  pr: string[];
  workExperiences: WorkExperience[];
  projectExperiences: ProjectExperience[];
  educationExperiences: EducationExperience[];
  skill: LanguageSkill[];
  certificates: string[];
}

export type CaptureFailureStage = 'detail-open' | 'identity-verify' | 'forward' | 'parse' | 'persist';
export type ProcessingFailureStage = 'score' | 'routing' | 'forward' | 'rejection-email';

export interface RunCaptureFailure {
  candidateId: string;
  stage: CaptureFailureStage;
  detailVerified: boolean;
  error: string;
}

export interface RunProcessingFailure {
  candidateId: string;
  stage: ProcessingFailureStage;
  error: string;
  diagnostic?: CodexSessionFailureDiagnostic;
}

export type BossSeenViewSyncFailureStage = 'card-resolve' | 'detail-open' | 'identity-verify' | 'detail-close';

export interface BossSeenViewSyncFailure {
  candidateId: string;
  stage: BossSeenViewSyncFailureStage;
  detailOpened: boolean;
  detailIdentityVerified: boolean;
  detailClosed: boolean;
  error: string;
}

/** Lightweight audit of the first-twenty history-card open/verify/close pass. */
export interface BossSeenViewSyncResult {
  /** All already-seen IDs in the bounded card window, including active work. */
  eligibleCandidateIds: string[];
  /** Seen IDs that required a dedicated view-only action this run. */
  attemptedCandidateIds: string[];
  /** View-only IDs whose detail identity was verified and dialog was closed. */
  completedCandidateIds: string[];
  /** Seen IDs whose normal retry/capture lifecycle already opened and closed detail. */
  coveredByProcessingCandidateIds: string[];
  failures: BossSeenViewSyncFailure[];
}

export interface RunResult {
  jobKey: string;
  platform: SupportedPlatform;
  fetchedAt: string;
  totalCandidates: number;
  /** Version 2 writes capturedCandidateIds; absent means a legacy run file. */
  runResultVersion?: 2;
  /**
   * Legacy v1 field. New v2 runs intentionally omit it because the old name
   * described list/detail attempts rather than successfully captured resumes.
   */
  newCandidateIds?: string[];
  /** IDs whose detail identity was verified and whose resume was persisted. */
  capturedCandidateIds?: string[];
  /** Number of candidates sent through the capture/detail path in this run. */
  captureAttemptCount?: number;
  /** Number of detail opens, including history-view actions and forwarding-only recovery retries. */
  detailAttemptCount?: number;
  captureFailures?: RunCaptureFailure[];
  processingFailures?: RunProcessingFailure[];
  /** Boss-only first-twenty history-card view synchronisation audit. */
  bossSeenViewSync?: BossSeenViewSyncResult;
  scoredCandidates: string[];
  failedCandidates: Array<{
    candidateId: string;
    error: string;
    diagnostic?: CodexSessionFailureDiagnostic;
  }>;
  /** Lightweight Boss-only routing index for one enabled screening run. */
  bossRouting?: {
    enabled: true;
    policyHash: string;
    /** Immutable report destinations captured for this run. */
    reportDelivery?: Partial<Record<BossRoutingAudience, ReportDeliveryOptions>>;
    delivery?: Partial<Record<BossRoutingAudience, ReportDeliveryOptions>>;
    qualifiedCandidateIds: string[];
    reviewCandidateIds: string[];
    rejectedCandidateIds: string[];
    /** Captured resumes that still have no immutable routing decision. */
    pendingScoreCandidateIds?: string[];
    /** De-identified `kind@phase` counts for pending Codex failures. */
    scoreFailureStatusCounts?: Record<string, number>;
    forwardingStatusCounts: Record<string, number>;
    rejectionEmailStatusCounts?: Record<string, number>;
    /** Actual rejection-email sendMail calls made during this run. */
    rejectionEmailSmtpAttemptCount?: number;
    rejectionEmailRetryExhaustedCount?: number;
  };
  /** Lightweight routing index for non-Boss post-score routing runs. */
  postScoreRouting?: {
    enabled: true;
    policyHash: string;
    reportDelivery?: Partial<Record<BossRoutingAudience, ReportDeliveryOptions>>;
    qualifiedCandidateIds: string[];
    reviewCandidateIds: string[];
    rejectedCandidateIds: string[];
    pendingScoreCandidateIds?: string[];
    scoreFailureStatusCounts?: Record<string, number>;
  };
  /** Lightweight evidence of the search that produced this run. */
  searchExecution?: {
    source: JobSearchSource;
    pageKeyword: string;
    keywordSource: 'run-override' | 'stored-setting' | 'condition-set-default' | 'legacy-job-keyword';
    conditionSetRef?: SearchConditionSetReference;
    selectedFieldsFingerprint?: string;
    includeViewedCandidates: boolean;
    savedSearch?: SavedSearchReference;
    sortPolicy?: SearchSortPolicy;
  };
}

export function getRunCapturedCandidateIds(run: Pick<RunResult, 'runResultVersion' | 'capturedCandidateIds' | 'newCandidateIds'>): string[] {
  return run.runResultVersion === 2
    ? run.capturedCandidateIds ?? []
    : [];
}

/** Legacy v1 IDs are attempts only and must never be counted as captured. */
export function getRunLegacyAttemptIds(run: Pick<RunResult, 'runResultVersion' | 'newCandidateIds'>): string[] {
  return run.runResultVersion === 2 ? [] : [...new Set(run.newCandidateIds ?? [])];
}

export interface ScoreDimension {
  score: number;
  reason: string;
}

export interface DimensionScores {
  education: ScoreDimension;
  language: ScoreDimension;
  experience: ScoreDimension;
  industryMatch: ScoreDimension;
  regionMatch: ScoreDimension;
  responsibilityMatch: ScoreDimension;
}

export interface CandidateScore {
  totalScore: number;
  dimensionScores: DimensionScores;
  risks: string[];
  summary: string;
}

export type BossChatReviewStatus =
  | 'skipped_missing_jd'
  | 'skipped_missing_forwarding_config'
  | 'skipped_unsupported_hard_requirements'
  | 'skipped_previously_reviewed'
  | 'follow_up_reply'
  | 'awaiting_clarification'
  | 'not_matched'
  | 'forwarded'
  | 'failed';

export type BossChatMatchMode = 'score-threshold' | 'all-hard-requirements';

export type BossPreviousChatBasis =
  | 'boss-both-talked'
  | 'visible-recruiter-message'
  | 'visible-message-history'
  | 'none';

export interface BossPreviousChatAssessment {
  previouslyChatted: boolean;
  basis: BossPreviousChatBasis;
  visibleMessageCount: number;
  unreadCountAtOpen: number;
}

export type BossCandidateReplyType =
  | 'text'
  | 'image'
  | 'resume'
  | 'attachment'
  | 'voice'
  | 'video'
  | 'other';

export interface BossCandidateReply {
  messageId?: string;
  sentAt?: string;
  type: BossCandidateReplyType;
  content: string;
}

export interface BossHardRequirementCriterion {
  key: 'age' | 'high_voltage_certificate' | 'low_voltage_certificate' | 'property_electrician_experience' | 'company_tenure' | 'shanghai_origin';
  label: string;
  met: boolean;
  evidence: string[];
  reason: string;
}

export interface BossHardRequirementEvaluation {
  allMet: boolean;
  criteria: BossHardRequirementCriterion[];
  rejectionReasons: string[];
  clarification?: {
    criterionKey: 'shanghai_origin';
    question: string;
    evidence: string[];
    reason: string;
  };
}

export interface BossChatReviewItem {
  conversationId: string;
  candidateId?: string;
  candidateName?: string;
  jobName: string;
  bossJobId?: string;
  jobKey: string;
  unreadCount: number;
  status: BossChatReviewStatus;
  score?: CandidateScore;
  hardRequirementEvaluation?: BossHardRequirementEvaluation;
  previousChat?: BossPreviousChatAssessment;
  newCandidateReplies?: BossCandidateReply[];
  matched?: boolean;
  chatMessageSent?: boolean;
  clarificationQuestionSent?: boolean;
  phoneExchangeRequested?: boolean;
  forwarded?: boolean;
  error?: string;
}

export interface BossChatReviewRun {
  platform: 'boss';
  reviewedAt: string;
  scoreThreshold: number;
  matchMode: BossChatMatchMode;
  replyToUnqualifiedCandidates?: boolean;
  unreadConversations: number;
  reviewedConversations: number;
  matchedCandidates: number;
  chatMessagesSent: number;
  phoneExchangeRequests: number;
  forwardedCandidates: number;
  skippedConversations: number;
  failedConversations: number;
  previouslyChattedConversations?: number;
  firstContactConversations?: number;
  followUpConversations?: number;
  newReplyMessages?: number;
  items: BossChatReviewItem[];
}

export interface CandidateScoreInputSummary {
  candidateId: string;
  candidateName?: string;
  age?: number;
  education?: string;
  regions: string[];
  previousEmployers: string[];
  currentOrRecentTitles: string[];
  industries: string[];
  totalYearsText?: string;
  workHistory: Array<{
    company?: string;
    title?: string;
    industry?: string;
    start?: string;
    end?: string;
    duration?: string;
    details: string[];
  }>;
  projects: Array<{
    name?: string;
    company?: string;
    start?: string;
    end?: string;
    duration?: string;
    details: string[];
  }>;
  educationHistory: Array<{
    school?: string;
    degree?: string;
    major?: string;
    start?: string;
    end?: string;
    details: string[];
  }>;
  languages: string[];
  certificates: string[];
}

export interface CandidateScoreArtifactBase {
  candidateId: string;
  candidateShareUrl?: string;
  model: string;
  scoredAt: string;
  /** Boss screening records the exact canonical resume input used for model evaluation. */
  resumeInputHash?: string;
}

export type CodexSessionPhase =
  | 'process-starting'
  | 'initializing'
  | 'thread-starting'
  | 'turn-starting'
  | 'turn-running'
  | 'completed';

export type CodexSessionFailureKind =
  | 'connection-timeout'
  | 'process-error'
  | 'process-exit'
  | 'turn-interrupted'
  | 'request-error'
  | 'protocol-error'
  | 'policy-violation'
  | 'turn-failed'
  | 'empty-output';

/** Safe operational metadata only; never contains prompt, output, or candidate text. */
export interface CodexSessionFailureDiagnostic {
  provider: 'codex-session';
  kind: CodexSessionFailureKind;
  phase: CodexSessionPhase;
  retryable: boolean;
  firstOutputObserved: boolean;
  elapsedMs: number;
  occurredAt: string;
  lastProtocolActivityAt?: string;
}

export interface CandidateScoreSuccessArtifact extends CandidateScoreArtifactBase {
  status: 'success';
  score: CandidateScore;
}

export interface CandidateScoreFailureArtifact extends CandidateScoreArtifactBase {
  status: 'failed';
  error: string;
  diagnostic?: CodexSessionFailureDiagnostic;
}

export type CandidateScoreArtifact = CandidateScoreSuccessArtifact | CandidateScoreFailureArtifact;

export interface JobResultsMarkdownSummary {
  candidateCount: number;
  successCount: number;
  failureCount: number;
}

export interface JobResultsMarkdownCandidate {
  candidateId: string;
  candidateShareUrl?: string;
  status: CandidateScoreArtifact['status'];
  model: string;
  scoredAt: string;
  totalScore?: number;
  dimensionScores?: DimensionScores;
  summary?: string;
  risks?: string[];
  error?: string;
}

export interface JobResultsMarkdownExport {
  jobKey: string;
  platform: SupportedPlatform;
  jobTitle: string;
  searchKeyword: string;
  generatedAt: string;
  summary: JobResultsMarkdownSummary;
  candidates: JobResultsMarkdownCandidate[];
}
