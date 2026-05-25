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
  name?: string;
  age?: number;
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
