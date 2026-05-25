import { Page } from 'playwright';
import { CandidateListItem, CandidateResume, ResumeDomSnapshot } from '../types/job.js';
import { RawPageSource } from './page-source.js';

export interface CandidateListExtractionResult {
  candidates: CandidateListItem[];
  source?: RawPageSource;
}

export interface ResumeExtractionResult {
  resume: CandidateResume;
  domSnapshot?: ResumeDomSnapshot;
  source?: RawPageSource;
}

export interface CandidateListExtractor {
  extractCandidateListFromPage: (page: Page) => Promise<CandidateListExtractionResult>;
  extractCandidateListFromSource: (source: RawPageSource) => Promise<CandidateListExtractionResult>;
}

export interface ResumeExtractor {
  extractResumeFromPage: (page: Page, candidate: CandidateListItem) => Promise<ResumeExtractionResult>;
  extractResumeFromSource: (
    source: RawPageSource,
    candidate: CandidateListItem,
    domSnapshot?: ResumeDomSnapshot,
  ) => Promise<ResumeExtractionResult>;
}

export interface ExtractionBoundary extends CandidateListExtractor, ResumeExtractor {}

export function buildResumeSourceFromSnapshot(
  snapshotContent: string,
  resumeUrl = '',
  fetchedAt = new Date().toISOString(),
): RawPageSource {
  return {
    url: resumeUrl,
    title: '',
    html: '',
    visibleText: snapshotContent,
    fetchedAt,
  };
}

function hasMeaningfulWorkExperience(experience: CandidateResume['workExperiences'][number]): boolean {
  return Boolean(
    experience.company?.trim()
      || experience.title?.trim()
      || experience.industry?.trim()
      || experience.start?.trim()
      || experience.end?.trim()
      || experience.duration?.trim()
      || experience.details.some((detail) => detail.trim()),
  );
}

function hasMeaningfulEducationExperience(experience: CandidateResume['educationExperiences'][number]): boolean {
  return Boolean(
    experience.school?.trim()
      || experience.degree?.trim()
      || experience.major?.trim()
      || experience.start?.trim()
      || experience.end?.trim()
      || experience.details.some((detail) => detail.trim()),
  );
}

function hasMeaningfulResumeData(resume: CandidateResume): boolean {
  return Boolean(
    resume.name?.trim()
      || resume.workExperiences.some((experience) => hasMeaningfulWorkExperience(experience))
      || resume.educationExperiences.some((experience) => hasMeaningfulEducationExperience(experience)),
  );
}

export function validateCandidateListExtraction(result: CandidateListExtractionResult): CandidateListExtractionResult {
  const invalidCandidate = result.candidates.find((candidate) => !candidate.candidateId?.trim());
  if (invalidCandidate) {
    throw new Error('Candidate list extraction produced a candidate without candidateId.');
  }

  return result;
}

export function validateResumeExtraction(result: ResumeExtractionResult): ResumeExtractionResult {
  if (!result.resume.candidateId?.trim()) {
    throw new Error('Resume extraction produced no candidateId.');
  }

  if (!hasMeaningfulResumeData(result.resume)) {
    throw new Error('Resume extraction produced no meaningful resume data.');
  }

  return result;
}
