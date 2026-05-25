import { CandidateResume, EducationExperience, WorkExperience } from '../types/job.js';

export interface WorkExperienceSummary {
  company?: string;
  title?: string;
  start?: string;
  end?: string;
  duration?: string;
}

export interface EducationExperienceSummary {
  school?: string;
  degree?: string;
  major?: string;
  start?: string;
  end?: string;
}

export interface ResumeValidationSummary {
  name?: string;
  age?: number;
  regions: string[];
  education?: string;
  workExperiences: WorkExperienceSummary[];
  educationExperiences: EducationExperienceSummary[];
  skillCount: number;
  skillSummary: string[];
}

export interface ResumeFieldDiff<T> {
  legacy: T;
  crawl4ai: T;
}

export interface ResumeValidationDiff {
  name?: ResumeFieldDiff<string | undefined>;
  age?: ResumeFieldDiff<number | undefined>;
  regions?: ResumeFieldDiff<string[]>;
  education?: ResumeFieldDiff<string | undefined>;
  workExperiences?: ResumeFieldDiff<WorkExperienceSummary[]>;
  educationExperiences?: ResumeFieldDiff<EducationExperienceSummary[]>;
  skillCount?: ResumeFieldDiff<number>;
  skillSummary?: ResumeFieldDiff<string[]>;
}

function summarizeWorkExperience(experience?: WorkExperience): WorkExperienceSummary {
  return {
    company: experience?.company,
    title: experience?.title,
    start: experience?.start,
    end: experience?.end,
    duration: experience?.duration,
  };
}

function summarizeEducationExperience(experience?: EducationExperience): EducationExperienceSummary {
  return {
    school: experience?.school,
    degree: experience?.degree,
    major: experience?.major,
    start: experience?.start,
    end: experience?.end,
  };
}

function sortStrings(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

export function summarizeResume(resume: CandidateResume): ResumeValidationSummary {
  return {
    name: resume.name,
    age: resume.age,
    regions: sortStrings(resume.regions),
    education: resume.education,
    workExperiences: [
      summarizeWorkExperience(resume.workExperiences[0]),
      summarizeWorkExperience(resume.workExperiences[1]),
    ],
    educationExperiences: [summarizeEducationExperience(resume.educationExperiences[0])],
    skillCount: resume.skill.length,
    skillSummary: sortStrings(
      resume.skill.map((entry) => JSON.stringify(entry, Object.keys(entry).sort())),
    ),
  };
}

function isSameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffResumeSummaries(
  legacy: ResumeValidationSummary,
  crawl4ai: ResumeValidationSummary,
): ResumeValidationDiff | null {
  const diff: ResumeValidationDiff = {};

  if (!isSameJson(legacy.name, crawl4ai.name)) {
    diff.name = { legacy: legacy.name, crawl4ai: crawl4ai.name };
  }

  if (!isSameJson(legacy.age, crawl4ai.age)) {
    diff.age = { legacy: legacy.age, crawl4ai: crawl4ai.age };
  }

  if (!isSameJson(legacy.regions, crawl4ai.regions)) {
    diff.regions = { legacy: legacy.regions, crawl4ai: crawl4ai.regions };
  }

  if (!isSameJson(legacy.education, crawl4ai.education)) {
    diff.education = { legacy: legacy.education, crawl4ai: crawl4ai.education };
  }

  if (!isSameJson(legacy.workExperiences, crawl4ai.workExperiences)) {
    diff.workExperiences = { legacy: legacy.workExperiences, crawl4ai: crawl4ai.workExperiences };
  }

  if (!isSameJson(legacy.educationExperiences, crawl4ai.educationExperiences)) {
    diff.educationExperiences = {
      legacy: legacy.educationExperiences,
      crawl4ai: crawl4ai.educationExperiences,
    };
  }

  if (!isSameJson(legacy.skillCount, crawl4ai.skillCount)) {
    diff.skillCount = { legacy: legacy.skillCount, crawl4ai: crawl4ai.skillCount };
  }

  if (!isSameJson(legacy.skillSummary, crawl4ai.skillSummary)) {
    diff.skillSummary = { legacy: legacy.skillSummary, crawl4ai: crawl4ai.skillSummary };
  }

  return Object.keys(diff).length > 0 ? diff : null;
}
