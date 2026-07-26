import type {
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  WorkExperience,
} from '../../../types/job.js';

const resumeSectionTitles = [
  '求职意向',
  '工作经历',
  '项目经历',
  '项目经验',
  '教育经历',
  '教育背景',
  '技能',
  '语言能力',
  '证书',
  '个人优势',
  '自我评价',
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function splitResumeLines(value: string): string[] {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim()
    .split('\n')
    .map(normalizeText)
    .filter(Boolean);
}

function collectSection(lines: string[], startTitles: string[], stopTitles: string[]): string[] {
  const startIndex = lines.findIndex((line) => startTitles.includes(line));
  if (startIndex === -1) {
    return [];
  }

  const section: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (stopTitles.includes(line)) {
      break;
    }
    section.push(line);
  }
  return section;
}

function parseWorkExperiences(
  lines: string[],
  fallbackCompany?: string,
  fallbackTitle?: string,
): WorkExperience[] {
  const workLines = collectSection(
    lines,
    ['工作经历'],
    ['项目经历', '项目经验', '教育经历', '教育背景', '技能', '语言能力', '证书', '个人优势', '自我评价'],
  );
  if (workLines.length === 0 && (fallbackCompany || fallbackTitle)) {
    return [{ company: fallbackCompany, title: fallbackTitle, details: [] }];
  }
  return workLines.length > 0
    ? [{
      company: fallbackCompany,
      title: fallbackTitle,
      details: workLines.filter((line) => !resumeSectionTitles.includes(line)),
    }]
    : [];
}

function parseEducationExperiences(
  lines: string[],
  fallbackEducation?: string,
): EducationExperience[] {
  const educationLines = collectSection(
    lines,
    ['教育经历', '教育背景'],
    ['技能', '语言能力', '证书', '个人优势', '自我评价'],
  );
  if (educationLines.length === 0) {
    return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
  }
  return [{
    degree: fallbackEducation,
    details: educationLines.filter((line) => !resumeSectionTitles.includes(line)),
  }];
}

export function parseZhilianResumeText(
  bodyRawText: string,
  candidate: CandidateListItem,
  pageUrl: string,
  candidateShareUrl?: string,
): CandidateResume {
  const lines = splitResumeLines(bodyRawText);
  const education = lines.find((line) => /博士|硕士|本科|大专|中专|高中/.test(line));
  const regionLine = lines.find((line) => /期望城市|现居住地|所在地|工作地点|居住地/.test(line));
  const company = candidate.currentCompany
    ?? lines.find((line) => /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line));
  const title = candidate.currentTitle
    ?? lines.find((line) => /工程师|经理|主管|顾问|销售|总监|专员|运营|设计师|分析师|店长|讲师/.test(line));

  return {
    candidateId: candidate.candidateId,
    resumeUrl: candidate.resumeUrl ?? pageUrl,
    candidateShareUrl,
    name: candidate.name
      ?? lines.find((line) => /^[一-龥A-Za-z·]{2,20}$/.test(line) && !/简历|男|女|本科|硕士|博士|大专|中专/.test(line)),
    education,
    regions: regionLine ? [regionLine] : [],
    pr: [],
    workExperiences: parseWorkExperiences(lines, company, title),
    projectExperiences: [],
    educationExperiences: parseEducationExperiences(lines, education),
    skill: [],
    certificates: collectSection(lines, ['证书'], ['个人优势', '自我评价'])
      .filter((line) => !resumeSectionTitles.includes(line)),
  };
}
