import type { SupportedPlatform } from '../platforms/types.js';

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

export interface BossForwardingSettings {
  mode: 'colleague' | 'email';
  recipient: string;
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
    fieldKind: 'singleSelect' | 'textInput' | 'salaryRange' | 'numberRange';
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
  searchKeyword: string;
  recipientEmail?: string;
  ccEmails?: string[];
  searchSettings?: {
    source: JobSearchSource;
    applicationFilterInput?: Record<string, unknown>;
    conditions: SearchCondition[];
  };
  bossForwarding?: BossForwardingSettings;
  bossPosition?: {
    bossJobId: string;
    status: 'open' | 'pending' | 'closed' | 'unknown';
    syncedAt: string;
    sourceHash: string;
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

export interface RunResult {
  jobKey: string;
  platform: SupportedPlatform;
  fetchedAt: string;
  totalCandidates: number;
  newCandidateIds: string[];
  scoredCandidates: string[];
  failedCandidates: Array<{
    candidateId: string;
    error: string;
  }>;
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
}

export interface CandidateScoreSuccessArtifact extends CandidateScoreArtifactBase {
  status: 'success';
  score: CandidateScore;
}

export interface CandidateScoreFailureArtifact extends CandidateScoreArtifactBase {
  status: 'failed';
  error: string;
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
