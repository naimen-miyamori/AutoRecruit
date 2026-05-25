import {
  CandidateResume,
  CandidateScoreInputSummary,
  EducationExperience,
  NormalizedJob,
  ProjectExperience,
  WorkExperience,
} from '../types/job.js';

function cleanText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    result.push(cleaned);
  }

  return result;
}

function compactDetails(details: string[] | undefined, limit = 3): string[] {
  if (!details || details.length === 0) {
    return [];
  }

  return uniqueNonEmpty(details).slice(0, limit);
}

function summarizeWorkExperience(work: WorkExperience): CandidateScoreInputSummary['workHistory'][number] {
  return {
    company: cleanText(work.company),
    title: cleanText(work.title),
    industry: cleanText(work.industry),
    start: cleanText(work.start),
    end: cleanText(work.end),
    duration: cleanText(work.duration),
    details: compactDetails(work.details),
  };
}

function summarizeProject(project: ProjectExperience): CandidateScoreInputSummary['projects'][number] {
  return {
    name: cleanText(project.name),
    company: cleanText(project.company),
    start: cleanText(project.start),
    end: cleanText(project.end),
    duration: cleanText(project.duration),
    details: compactDetails(project.details),
  };
}

function summarizeEducation(education: EducationExperience): CandidateScoreInputSummary['educationHistory'][number] {
  return {
    school: cleanText(education.school),
    degree: cleanText(education.degree),
    major: cleanText(education.major),
    start: cleanText(education.start),
    end: cleanText(education.end),
    details: compactDetails(education.details, 2),
  };
}

function formatRange(min?: number, max?: number, suffix = ''): string | undefined {
  if (typeof min !== 'number' && typeof max !== 'number') {
    return undefined;
  }

  if (typeof min === 'number' && typeof max === 'number') {
    return `${min}-${max}${suffix}`;
  }

  if (typeof min === 'number') {
    return `${min}+${suffix}`;
  }

  return `<=${max}${suffix}`;
}

function buildJobSummary(job: NormalizedJob) {
  return {
    title: cleanText(job.title) ?? '',
    location: cleanText(job.location),
    department: cleanText(job.department),
    education: cleanText(job.education),
    experienceYearsMin: job.experienceYearsMin,
    salaryRange: cleanText(job.salaryRange?.raw) ?? formatRange(job.salaryRange?.min, job.salaryRange?.max),
    ageRange: cleanText(job.ageRange?.raw) ?? formatRange(job.ageRange?.min, job.ageRange?.max, '岁'),
    majors: uniqueNonEmpty(job.majors),
    languageRequirements: uniqueNonEmpty(job.languageRequirements),
    responsibilities: uniqueNonEmpty(job.responsibilities),
    hardRequirements: uniqueNonEmpty(job.hardRequirements),
    preferredRequirements: uniqueNonEmpty(job.preferredRequirements),
    regionPreferences: uniqueNonEmpty(job.regionPreferences),
    industryTags: uniqueNonEmpty(job.industryTags),
  };
}

export function buildScoreInputSummary(
  _job: NormalizedJob,
  resume: CandidateResume,
): CandidateScoreInputSummary {
  const workHistory = resume.workExperiences.map(summarizeWorkExperience);

  return {
    candidateId: resume.candidateId,
    candidateName: cleanText(resume.name),
    age: resume.age,
    education: cleanText(resume.education),
    regions: uniqueNonEmpty(resume.regions),
    previousEmployers: uniqueNonEmpty(workHistory.map((work) => work.company)),
    currentOrRecentTitles: uniqueNonEmpty(workHistory.map((work) => work.title)).slice(0, 5),
    industries: uniqueNonEmpty(workHistory.map((work) => work.industry)),
    totalYearsText: cleanText(resume.pr.join(' / ')),
    workHistory,
    projects: resume.projectExperiences.map(summarizeProject),
    educationHistory: resume.educationExperiences.map(summarizeEducation),
    languages: uniqueNonEmpty(
      resume.skill.flatMap((entry) => Object.values(entry).map((value) => cleanText(value))).filter(Boolean),
    ) as string[],
    certificates: uniqueNonEmpty(resume.certificates),
  };
}

export function buildScorePrompt(job: NormalizedJob, resume: CandidateResume): string {
  const payload = {
    task: 'Score candidate-job fit against the provided hiring criteria.',
    requirements: [
      'Return JSON only. Do not wrap in markdown or add commentary.',
      'Use only evidence present in the job and resume input. Do not infer missing facts.',
      'summary must be a short factual paragraph.',
      'For each dimension score, return an object with integer score (0-100) and concise factual reason.',
      'Each reason must be 1-2 short sentences, evidence-only, and specific to that dimension.',
      'Do not mention the score number, do not use hedging or recommendations, and do not repeat summary/risk wording.',
      'dimensionScores must include education, language, experience, industryMatch, regionMatch, responsibilityMatch.',
      'totalScore must be a 0-100 integer reflecting the overall fit.',
    ],
    outputSchema: {
      totalScore: 'number',
      dimensionScores: {
        education: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, education evidence only)',
        },
        language: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, language evidence only)',
        },
        experience: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, experience evidence only)',
        },
        industryMatch: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, industry evidence only)',
        },
        regionMatch: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, region evidence only)',
        },
        responsibilityMatch: {
          score: 'number',
          reason: 'string (1-2 short factual sentences, responsibility evidence only)',
        },
      },
      risks: ['string'],
      summary: 'string',
    },
    input: {
      job: buildJobSummary(job),
      candidate: buildScoreInputSummary(job, resume),
    },
  };

  return JSON.stringify(payload, null, 2);
}
