import type {
  BossHardRequirementCriterion,
  BossHardRequirementEvaluation,
  CandidateResume,
  WorkExperience,
} from '../types/job.js';

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function formatWork(work: WorkExperience): string {
  return [
    work.start && work.end ? `${work.start}-${work.end}` : work.start ?? work.end,
    work.company,
    work.title,
    ...work.details,
  ].filter(Boolean).join(' | ');
}

function formatEducation(resume: CandidateResume): string[] {
  return resume.educationExperiences.map((education) => [
    education.start && education.end ? `${education.start}-${education.end}` : education.start ?? education.end,
    education.school,
    education.degree,
    education.major,
    ...education.details,
  ].filter(Boolean).join(' | ')).filter(Boolean);
}

const shanghaiOriginQuestion = '是上海人吗？';
const explicitShanghaiOriginPattern = /上海本地人|上海人|沪籍|上海户籍|上海户口|(?:籍贯|户籍|户口|出生地|家乡)(?:是|为|在|[:：])?\s*(?:上海|沪)/;
const explicitNonShanghaiOriginPattern = /不是上海人|非上海人|非上海籍|非沪籍|(?:籍贯|户籍|户口|出生地|家乡)(?:是|为|在|[:：])?\s*(?!上海|沪)[\u4e00-\u9fff]{2,8}|(?:江苏|浙江|安徽|山东|河南|湖北|湖南|江西|四川|重庆|福建|广东|广西|云南|贵州|河北|山西|陕西|甘肃|辽宁|吉林|黑龙江|北京|天津|内蒙古|新疆|西藏|青海|宁夏|海南)人/;
const shanghaiSchoolPattern = /上海|复旦大学|同济大学|华东师范大学|华东理工大学|东华大学|华东政法大学/;

function parseYearMonth(value: string | undefined, endBoundary: boolean): { year: number; month: number } | undefined {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  if (/至今|现在|目前/.test(normalized)) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  const match = normalized.match(/(19|20)\d{2}(?:\D{0,3}(\d{1,2}))?/);
  if (!match) {
    return undefined;
  }

  const year = Number.parseInt(match[0].slice(0, 4), 10);
  const month = match[2] ? Number.parseInt(match[2], 10) : (endBoundary ? 12 : 1);
  if (month < 1 || month > 12) {
    return undefined;
  }

  return { year, month };
}

function readExplicitDurationMonths(work: WorkExperience): number | undefined {
  const details = work.details.join(' ');
  const yearDuration = details.match(/(?:工作时长[:：]?\s*)?(\d+)\s*年(?:\s*(\d+)\s*个?月)?/);
  if (yearDuration) {
    return Number.parseInt(yearDuration[1]!, 10) * 12 + Number.parseInt(yearDuration[2] ?? '0', 10);
  }

  const monthDuration = details.match(/(?:工作时长[:：]?\s*)?(\d+)\s*个?月/);
  return monthDuration ? Number.parseInt(monthDuration[1]!, 10) : undefined;
}

function readWorkDurationMonths(work: WorkExperience): number | undefined {
  const start = parseYearMonth(work.start, false);
  const end = parseYearMonth(work.end, true);
  if (start && end) {
    const months = (end.year - start.year) * 12 + end.month - start.month + 1;
    return months >= 0 ? months : undefined;
  }

  return readExplicitDurationMonths(work);
}

function buildCriterion(
  key: BossHardRequirementCriterion['key'],
  label: string,
  evidence: string[],
  missingReason: string,
): BossHardRequirementCriterion {
  const normalizedEvidence = unique(evidence);
  return {
    key,
    label,
    met: normalizedEvidence.length > 0,
    evidence: normalizedEvidence,
    reason: normalizedEvidence.length > 0 ? `已确认：${normalizedEvidence.join('；')}` : missingReason,
  };
}

export function evaluatePropertyElectricianHardRequirements(resume: CandidateResume): BossHardRequirementEvaluation {
  const workEvidence = resume.workExperiences.map(formatWork).filter(Boolean);
  const resumeEvidence = unique([
    ...resume.pr,
    ...resume.certificates,
    ...workEvidence,
  ]);
  const allText = resumeEvidence.join('；');
  const highVoltageEvidence = resumeEvidence.filter((value) => (
    /(?:高压|高低压).{0,10}(?:证|操作证)|(?:证|操作证).{0,10}(?:高压|高低压)/.test(value)
  ));
  const lowVoltageEvidence = resumeEvidence.filter((value) => (
    /(?:低压|高低压).{0,10}(?:证|操作证)|(?:证|操作证).{0,10}(?:低压|高低压)/.test(value)
  ));
  const propertyTerms = allText.match(/物业(?:管理|工程|维修)?|商业地产|住宅物业|写字楼|楼宇/g) ?? [];
  const electricianTerms = allText.match(/电工|电气|强电|弱电|配电|综合维修|工程维修/g) ?? [];
  const propertyElectricianEvidence = propertyTerms.length > 0 && electricianTerms.length > 0
    ? resumeEvidence.filter((value) => /物业|商业地产|住宅|写字楼|楼宇|电工|电气|强电|弱电|配电|综合维修|工程维修/.test(value))
    : [];
  const tenureEvidence = resume.workExperiences.flatMap((work) => {
    const durationMonths = readWorkDurationMonths(work);
    if (!work.company || durationMonths === undefined || durationMonths < 24) {
      return [];
    }

    return [`${work.company}：${work.start ?? '?'}-${work.end ?? '?'}（${durationMonths}个月）`];
  });
  const explicitShanghaiOriginEvidence = unique([
    resume.nativePlace && /上海|沪/.test(resume.nativePlace) ? `籍贯：${resume.nativePlace}` : '',
    ...resume.pr.filter((value) => (
      explicitShanghaiOriginPattern.test(value)
      && !explicitNonShanghaiOriginPattern.test(value)
    )),
  ]);
  const explicitNonShanghaiOrigin = Boolean(
    resume.nativePlace
    && !/上海|沪/.test(resume.nativePlace),
  ) || resume.pr.some((value) => explicitNonShanghaiOriginPattern.test(value));
  const shanghaiSchoolEvidence = unique(formatEducation(resume).filter((value) => shanghaiSchoolPattern.test(value)));
  const shanghaiOriginCriterion = buildCriterion(
    'shanghai_origin',
    '上海人',
    explicitShanghaiOriginEvidence,
    explicitNonShanghaiOrigin
      ? resume.nativePlace
        ? `简历明确籍贯为${resume.nativePlace}，不满足上海人要求`
        : '简历明确说明候选人不是上海人，不满足上海人要求'
      : shanghaiSchoolEvidence.length > 0
        ? `简历未明确是否为上海人，但发现上海就读线索，需要发送“${shanghaiOriginQuestion}”确认`
        : '简历未发现明确的上海人证据，也未发现可用于确认的上海就读线索',
  );

  const criteria: BossHardRequirementCriterion[] = [
    {
      key: 'age',
      label: '年龄小于47岁',
      met: resume.age !== undefined && resume.age < 47,
      evidence: resume.age === undefined ? [] : [`${resume.age}岁`],
      reason: resume.age === undefined
        ? '简历未提供明确年龄，无法确认小于47岁'
        : resume.age < 47
          ? `已确认：${resume.age}岁`
          : `年龄为${resume.age}岁，不满足小于47岁`,
    },
    buildCriterion(
      'high_voltage_certificate',
      '持有高压电工证',
      highVoltageEvidence,
      '简历未发现明确的高压电工证证据',
    ),
    buildCriterion(
      'low_voltage_certificate',
      '持有低压电工证',
      lowVoltageEvidence,
      '简历未发现明确的低压电工证证据',
    ),
    buildCriterion(
      'property_electrician_experience',
      '具有物业行业电工经验',
      propertyElectricianEvidence,
      '简历未同时发现物业行业和电工/电气工作证据',
    ),
    buildCriterion(
      'company_tenure',
      '至少在一家公司工作满2年',
      tenureEvidence,
      '简历未发现同一家公司连续工作至少24个月的明确记录',
    ),
    shanghaiOriginCriterion,
  ];
  const rejectionReasons = criteria.filter((criterion) => !criterion.met).map((criterion) => criterion.reason);
  const otherRequirementsMet = criteria
    .filter((criterion) => criterion.key !== 'shanghai_origin')
    .every((criterion) => criterion.met);
  const clarification = !shanghaiOriginCriterion.met
    && !explicitNonShanghaiOrigin
    && shanghaiSchoolEvidence.length > 0
    && otherRequirementsMet
    ? {
      criterionKey: 'shanghai_origin' as const,
      question: shanghaiOriginQuestion,
      evidence: shanghaiSchoolEvidence,
      reason: shanghaiOriginCriterion.reason,
    }
    : undefined;

  return {
    allMet: rejectionReasons.length === 0,
    criteria,
    rejectionReasons,
    clarification,
  };
}
