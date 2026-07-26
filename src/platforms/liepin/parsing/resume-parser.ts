import type {
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  ProjectExperience,
  WorkExperience,
} from '../../../types/job.js';

const lineBreakToken = '__AUTORECRUIT_LINE_BREAK__';
const sectionTitles = ['工作经历', '项目经历', '项目经验', '教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势'];

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePreservingLines(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, lineBreakToken)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(new RegExp(`${lineBreakToken}+`, 'g'), lineBreakToken)
    .trim();
}

function splitNormalizedLines(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n|__AUTORECRUIT_LINE_BREAK__/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function isLikelyPersonName(line: string): boolean {
  return /^[一-龥A-Za-z·]{2,20}$/.test(line)
    && !/猎聘|简历|男|女|本科|硕士|博士|大专|中专|现居住地|期望城市|工作地点/.test(line);
}

function isLikelyCompany(line: string): boolean {
  return /公司|集团|科技|咨询|贸易|有限|股份|工业|制造|信息|电子|商贸/.test(line);
}

function isLikelyTitle(line: string): boolean {
  return /工程师|经理|主管|顾问|销售|总监|专员|招商主管|总经理|主任|业务员|运营|设计师|分析师|店长|讲师/.test(line);
}

function isLikelyEducation(line: string): boolean {
  return /博士|硕士|本科|大专|中专|高中/.test(line);
}

function isLikelyRegion(line: string): boolean {
  return /期望城市|意向城市|所在地|现居住地|工作地点|居住地/.test(line);
}

function isSectionTitle(line: string): boolean {
  return sectionTitles.includes(line);
}

function isTimeRangeLine(line: string): boolean {
  return /(\d{4}(?:[./-]\d{2})?)\s*[-~至]\s*(至今|\d{4}(?:[./-]\d{2})?)/.test(line);
}

function normalizeTimeRange(line: string): string {
  const match = line.match(/(\d{4}(?:[./-]\d{2})?)\s*[-~至]\s*(至今|\d{4}(?:[./-]\d{2})?)/);
  if (!match) {
    return line;
  }

  return `${match[1]}-${match[2]}`;
}

function isNoiseLine(line: string): boolean {
  return /^(猎聘|在线简历|简历|举报|下载简历|立即沟通|沟通|打招呼|登录后可查看)/.test(line);
}

function extractCandidateIdFromText(text: string): string | undefined {
  const patterns = [
    /resume(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /candidate(?:Id|ID|id)[=:\/"'&?]+(\d{5,})/i,
    /data-(?:resume-id|candidate-id|id)="?(\d{5,})/i,
    /(?:resume|candidate)[_-]?id\D{0,8}(\d{5,})/i,
    /\/(\d{5,})(?:\?.*)?$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
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

function trimTrailingSectionNoise(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (!isNoiseLine(last) && !isSectionTitle(last)) {
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

function parseWorkExperiences(lines: string[], fallbackCompany?: string, fallbackTitle?: string): WorkExperience[] {
  const workLines = trimTrailingSectionNoise(collectSection(lines, ['工作经历'], ['项目经历', '项目经验', '教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势']));
  const experiences: WorkExperience[] = [];
  let current: WorkExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.company || current.title || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of workLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { details: [normalizeTimeRange(line)] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.company && isLikelyCompany(line)) {
      current.company = line;
      continue;
    }

    if (!current.title && isLikelyTitle(line)) {
      current.title = line;
      continue;
    }

    if (isTimeRangeLine(line)) {
      current.details.push(normalizeTimeRange(line));
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();

  if (experiences.length > 0) {
    return experiences;
  }

  return fallbackCompany || fallbackTitle ? [{ company: fallbackCompany, title: fallbackTitle, details: [] }] : [];
}

function parseProjectExperiences(lines: string[]): ProjectExperience[] {
  const projectLines = trimTrailingSectionNoise(collectSection(lines, ['项目经历', '项目经验'], ['教育经历', '教育背景', '技能', '技能标签', '语言能力', '证书', '个人优势']));
  if (projectLines.length === 0) {
    return [];
  }

  const experiences: ProjectExperience[] = [];
  let current: ProjectExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.name || current.company || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of projectLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { start: normalizeTimeRange(line), details: [] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.name && !isLikelyCompany(line) && !isLikelyTitle(line) && line.length <= 40) {
      current.name = line;
      continue;
    }

    if (!current.company && isLikelyCompany(line)) {
      current.company = line;
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();
  return experiences;
}

function parseEducationExperiences(lines: string[], fallbackEducation?: string): EducationExperience[] {
  const educationLines = trimTrailingSectionNoise(collectSection(lines, ['教育经历', '教育背景'], ['技能', '技能标签', '语言能力', '证书', '个人优势']));
  if (educationLines.length === 0) {
    return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
  }

  const experiences: EducationExperience[] = [];
  let current: EducationExperience | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    current.details = current.details.filter(Boolean);
    if (current.school || current.degree || current.major || current.details.length > 0) {
      experiences.push(current);
    }
    current = null;
  };

  for (const rawLine of educationLines) {
    const line = normalizeText(rawLine);
    if (!line || isNoiseLine(line) || isSectionTitle(line)) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      pushCurrent();
      current = { details: [normalizeTimeRange(line)] };
      continue;
    }

    if (!current) {
      current = { details: [] };
    }

    if (!current.school && /大学|学院|学校|中学/.test(line)) {
      current.school = line;
      continue;
    }

    if (!current.degree && isLikelyEducation(line)) {
      current.degree = line.match(/博士|硕士|本科|大专|中专|高中/)?.[0] ?? line;
      const major = line.replace(/博士|硕士|本科|大专|中专|高中/g, '').trim();
      if (major) {
        current.major = major;
      }
      continue;
    }

    current.details.push(line);
  }

  pushCurrent();
  return experiences.length > 0 ? experiences : (fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : []);
}

function parseCertificates(lines: string[]): string[] {
  return collectSection(lines, ['证书'], ['个人优势'])
    .filter((line) => !isNoiseLine(line) && !isSectionTitle(line));
}

export function parseLiepinResumeText(
  bodyRawText: string,
  candidate: CandidateListItem,
  pageUrl: string,
): CandidateResume {
  const bodyText = normalizePreservingLines(bodyRawText);
  const lines = splitNormalizedLines(bodyText).filter((line) => !isNoiseLine(line));
  const name = candidate.name ?? lines.find((line) => isLikelyPersonName(line)) ?? undefined;
  const education = lines.find((line) => isLikelyEducation(line));
  const regionLine = lines.find((line) => isLikelyRegion(line));
  const company = candidate.currentCompany ?? lines.find((line) => isLikelyCompany(line));
  const title = candidate.currentTitle ?? lines.find((line) => isLikelyTitle(line));
  return {
    candidateId: candidate.candidateId || extractCandidateIdFromText(pageUrl) || candidate.candidateId,
    resumeUrl: candidate.resumeUrl ?? pageUrl,
    name,
    education,
    regions: regionLine ? [regionLine] : [],
    pr: [],
    workExperiences: parseWorkExperiences(lines, company, title),
    projectExperiences: parseProjectExperiences(lines),
    educationExperiences: parseEducationExperiences(lines, education),
    skill: [],
    certificates: parseCertificates(lines),
  };
}
