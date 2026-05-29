import { BrowserContext, Frame, Page } from 'playwright';
import { CandidateListItem, CandidateResume, EducationExperience, LanguageSkill, ProjectExperience, ResumeDomSnapshot, ResumeDomWorkNode, ResumePageEvidence, WorkExperience } from '../types/job.js';
import { buildRawPageSource } from '../extraction/page-source.js';
import { extractResumeFromSource as extractResumeFromCrawl4AiSource } from '../extraction/crawl4ai-extractor.js';
import { config } from '../config.js';

const EDUCATION_KEYWORDS = ['博士', '硕士', '本科', '大专', '中技/中专', '中专', '高中'];
const LANGUAGE_KEYWORDS = ['英语', '日语', '韩语', '粤语', '法语', '德语', '西班牙语'];
const REGION_KEYWORDS = ['深圳', '上海', '苏州', '无锡', '杭州', '南通', '东南亚', '越南', '泰国', '马来西亚', '印尼', '新加坡'];
const SKILL_KEYWORDS = ['渠道销售', '门店/柜台销售', '会展销售', '商业谈判', '行业知识', '技术指导', '技术培训', '询价', '销售', '技术支持', '报价', '阀门', '客户开发能力', '营销经验', '电话销售', '网络/线上销售', '数据分析', '客户开发', '商务谈判', '展会', '领英', 'LinkedIn', 'WhatsApp', 'Instagram', 'Facebook', 'Google Ads', '阿里巴巴国际站', '中国制造', '环球资源', '小满系统'];
const NOISE_PATTERNS = [/^声明：/, /^相似人才/, /^立即Hi聊$/, /^不感兴趣$/, /^操作动态$/, /^发送$/, /^聊$/, /^天$/, /^举报$/, /^---$/, /^✅/, /^🎯/, /^🌍/, /^🛠️/, /^项目内容[:：]?$/, /^项目成果[:：]?$/, /^成果[:：]?$/, /^候选人似乎处于离职状态/, /^您可对候选人的在职状态进行相关询问/];
const ROLE_LINE_PATTERNS = ['工程师', '主管', '经理', '总监', '专员', '销售', '顾问', '运营', '业务员', '主任', '检验员', '项目', '教师', '助理'];
const detailContentPollIntervalMs = 500;
const COMPANY_EXCLUDE_PATTERNS = [
  /^\d+[、.]/,
  /^[-–—]+/,
  /^成果$/,
  /^核心能力$/,
  /^求职偏好[:：]?$/,
  /^项目周期[:：]?/,
  /^合作对象[:：]?/,
  /^项目金额[:：]?/,
  /^项目内容[:：]?/,
  /^项目成果[:：]?/,
  /^单个项目/,
  /^唯一负责人/,
  /^普通话证书$/,
  /^高中教师资格证$/,
  /^私立学校$/,
  /^英语$/,
  /^中共党员$/,
  /^上市公司从业$/,
  /^大中型企业从业$/,
  /^招聘与配置$/,
  /^绩效管理$/,
  /^人力资源规划$/,
  /^人力资源\/管理类专业$/,
  /^人工智能$/,
  /^医疗设备\/器械$/,
  /^家居\/家具\/家电$/,
  /^院校$/,
  /^深圳民办学校$/,
  /^您可对候选人的在职状态进行相关询问/,
  /^候选人似乎处于离职状态/,
  /^Working Responsibilities:?$/i,
];

function parseNumber(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeDomTexts(texts: string[]): string[] {
  return unique(texts.map((text) => text.replace(/\s+/g, ' ').trim()));
}

function normalizeCombinedWorkMetaLine(line: string): string[] {
  const normalized = line.trim();
  if (isInlineTimeRangeLine(normalized)) {
    const parsed = parseTimeRange(normalized);
    const parts = [
      parsed.start && parsed.end ? `${parsed.start}-${parsed.end}` : undefined,
      parsed.duration ? `（${parsed.duration}）` : undefined,
    ].filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts : [normalized];
  }

  if (!isCompressedIndustryMetaLine(normalized)) {
    return [normalized];
  }

  const fragments: string[] = [];

  const industryMatch = normalized.match(/(机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校|汽车|政府机关|公共事业|政府\/公共事业|其他专业服务|房地产|服装\/纺织\/皮革|建材)/);
  if (industryMatch) {
    fragments.push(industryMatch[1]);
  }

  const sizeMatch = normalized.match(/(\d+-\d+人|少于\d+人)/);
  if (sizeMatch) {
    fragments.push(sizeMatch[1]);
  }

  const tags = normalized.match(/(国企|民营|外资|合资|已上市|上市公司)/g) ?? [];
  fragments.push(...tags);

  return fragments.length > 0 ? unique(fragments) : [normalized];
}

function normalizeDomLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function flattenDomSnapshotTexts(domSnapshot?: ResumeDomSnapshot): string[] {
  return domSnapshot?.workLines ?? [];
}

function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !line.includes('上海君乐礼实业有限公司'));
}

function sectionBetween(text: string, startMarker: string, endMarkers: string[]): string {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.replace(/\s+/g, ' ').trim() === startMarker);
  if (startIndex === -1) {
    return '';
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const normalized = lines[index].replace(/\s+/g, ' ').trim();
    if (endMarkers.includes(normalized)) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join('\n');
}

function extractHeaderSection(text: string): string {
  const onlineResumeIndex = text.indexOf('在线简历');
  const resumeIndex = onlineResumeIndex >= 0 ? onlineResumeIndex : text.indexOf('Resume');
  const start = resumeIndex >= 0 ? resumeIndex : 0;
  const end = text.indexOf('求职意向');
  return text.slice(start, end >= 0 ? end : 1500);
}

function pickEducation(line: string): string | undefined {
  return EDUCATION_KEYWORDS.find((keyword) => line.includes(keyword));
}

function parseName(headerLines: string[], fallback?: string): string | undefined {
  const direct = headerLines.find((line) => /^[\u4e00-\u9fa5]{1,6}(先生|女士)$/.test(line));
  if (direct) {
    return direct;
  }

  if (fallback && /^[\u4e00-\u9fa5]{1,6}(先生|女士)$/.test(fallback)) {
    return fallback;
  }

  return undefined;
}

function parseEducation(headerLines: string[]): string | undefined {
  for (const line of headerLines) {
    const education = pickEducation(line);
    if (education && line.includes('年经验')) {
      return education;
    }
  }

  return undefined;
}

function parseRegions(texts: string[]): string[] {
  return unique(texts.flatMap((text) => REGION_KEYWORDS.filter((keyword) => text.includes(keyword))));
}

function parseRegionsFromHeader(headerLines: string[]): string[] {
  const directRegionLines = headerLines.filter((line) => /现居|居住地|期望工作地|意向工作地|偏好工作地/.test(line));
  const regionSource = directRegionLines.length > 0 ? directRegionLines : headerLines;
  return parseRegions(regionSource);
}

function parseCertificates(bodyText: string): string[] {
  const rawSection = sectionBetween(bodyText, '证书', ['举报', '相似人才', '声明：']);
  const lines = rawSection
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !['工作经历', '教育经历', '技能/语言', '证书'].includes(line));

  return lines;
}

function parsePersonalAdvantages(bodyText: string): string[] {
  const rawSection = sectionBetween(bodyText, '个人优势', ['行业知识', '工作经历', '项目经验', '教育经历']);
  const lines = rawSection
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !/^我的优势$|^个人简介$|^核心能力$|^全球机动支持$|^个人特质$/.test(line));

  return lines.length > 0 ? [lines.join('\n')] : [];
}

function parseLanguageSkills(skillLines: string[]): LanguageSkill[] {
  const englishLevel = skillLines.find((line) => line.includes('流利') || line === '良好' || line === '精通');

  if (!englishLevel && !skillLines.includes('英语')) {
    return [];
  }

  const result: LanguageSkill = {};
  if (englishLevel) {
    result.english = englishLevel;
    if (englishLevel === '良好' || englishLevel === '精通') {
      result['english level'] = englishLevel;
    }
  } else {
    result.english = '英语';
  }

  return [result];
}

function parseTimeRange(line: string): { start?: string; end?: string; duration?: string } {
  const match = line.match(/(\d{4}\.\d{2})\s*-\s*(至今|\d{4}\.\d{2})(?:（([^）]+)）)?/);
  if (!match) {
    return {};
  }

  return {
    start: match[1],
    end: match[2],
    duration: match[3],
  };
}

function isTimeRangeLine(line: string): boolean {
  return /(\d{4}\.\d{2})\s*-\s*(至今|\d{4}\.\d{2})/.test(line);
}

function isLikelyIndustryOnlyLine(line: string): boolean {
  return /^(原材料和加工|消费电子产品|新能源|计算机硬件|机械\/设备\/重工|批发\/零售|贸易\/进出口|政府\/公共事业|建材|原材料)/.test(line)
    && !/\d+-\d+人|少于\d+人|国企|民营|外资|合资|已上市|上市公司/.test(line);
}

function isIndustryLine(line: string): boolean {
  return /\d+-\d+人|少于\d+人|国企|民营|外资|合资|上市公司|机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校|汽车|政府机关|公共事业|政府\/公共事业|其他专业服务|房地产|服装\/纺织\/皮革|建材/.test(line);
}

function isWorkMetaLine(line: string): boolean {
  return (COMPANY_EXCLUDE_PATTERNS.some((pattern) => pattern.test(line)) && !/^[0-9A-Za-z]+[、.．)]/.test(line))
    || /^（[^）]+）$/.test(line);
}

function isLikelySchoolEmployer(line: string): boolean {
  if (!line || line.length > 40 || isTimeRangeLine(line) || pickEducation(line) !== undefined) {
    return false;
  }

  if (/^深圳民办学校$/.test(line)) {
    return true;
  }

  if (COMPANY_EXCLUDE_PATTERNS.some((pattern) => pattern.test(line))) {
    return false;
  }

  return line.includes('学校') || line.includes('中学');
}

function isLikelyWorkEntryStart(line: string, nextLine?: string, nextNextLine?: string, thirdLine?: string): boolean {
  return isLikelyCompany(line)
    || isLikelySchoolEmployer(line)
    || isLikelyCompanyHeaderPattern(nextLine, nextNextLine, thirdLine);
}

function isWorkSectionStopLine(line: string): boolean {
  return line === '项目经验'
    || line === '教育经历'
    || line === '技能/语言'
    || line === '证书'
    || line === '举报'
    || line === '相似人才';
}

function isLikelyRelatedTagLine(line: string): boolean {
  return SKILL_KEYWORDS.includes(line)
    || LANGUAGE_KEYWORDS.includes(line)
    || line === '英语'
    || line === '听说读写流利'
    || line === '良好'
    || line === '大客户销售'
    || /^您可对候选人的在职状态进行相关询问/.test(line)
    || /^(行业知识|营销经验|客户开发能力|商业谈判|熟练使用办公软件|数据分析|地推|面销\/陌拜|电话销售|网络\/线上销售|会展销售|渠道销售|管理|沟通协调能力|熟练掌握办公室软件|较强的工作责任心|文件处理能力|项目管理工作|外企|中级会计职称|初级会计职称|ERP系统|突发事件处理|员工培训监督与考核)$/.test(line);
}

function isLikelyWorkBusinessTag(line: string): boolean {
  return /^(市场洞察|用户需求|GTM|STP|4P|跨文化谈判|项目管理|数据分析|B2B|展会|市场开发|外贸销售)$/.test(line);
}

function isLikelySameCompanyContinuation(line: string): boolean {
  return /^\d{4}年\d{1,2}月/.test(line)
    || /^工作内容[:：]?$/.test(line)
    || /^\d+[、.．)]/.test(line)
    || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(line)
    || /^[▪•●■◆·-]/.test(line)
    || /负责|参与|协助|跟进|处理|安排|制作|维护|记录|通知|提交|确认|协调|汇总|检测|跟踪|督促|对接|推动|完成/.test(line)
    || /熟练掌握|责任心|沟通协调能力|文件处理能力|员工培训监督与考核|突发事件处理|学会用英语进行沟通|用邮件全英文与客户进行预订咨询回复等/.test(line);
}

function isStandaloneDurationLine(line: string): boolean {
  return /^（[^）]+）$/.test(line);
}

function isLikelyCompanyHeaderPattern(nextLine?: string, nextNextLine?: string, thirdLine?: string): boolean {
  if (!nextLine || !isLikelyWorkTitle(nextLine) || !nextNextLine) {
    return false;
  }

  if (isIndustryLine(nextNextLine) || isLikelyIndustryOnlyLine(nextNextLine)) {
    return Boolean(thirdLine && (isTimeRangeLine(thirdLine) || isStandaloneDurationLine(thirdLine) || isInlineTimeRangeLine(thirdLine)));
  }

  return isTimeRangeLine(nextNextLine) || isStandaloneDurationLine(nextNextLine) || isInlineTimeRangeLine(nextNextLine);
}

function isCompactCompanyRoleLine(line: string, nextLine: string): boolean {
  if (!line || !nextLine || !isLikelyWorkTitle(nextLine)) {
    return false;
  }

  if (/^[A-Za-z]/.test(line) || /[。；，：:]/.test(line)) {
    return false;
  }

  if (line.length < 4 || line.length > 18) {
    return false;
  }

  return /(老师|教育|学校|培训|零部件|电子|科技|旅行社|公司|工厂|贸易|模具|汽车|英语|平台)/.test(line);
}

function isLikelyCompanyLineByContext(line: string, nextLine?: string, nextNextLine?: string, thirdLine?: string): boolean {
  if (!line || isWorkSectionStopLine(line) || shouldSkipWorkDetailLine(line) || isIndustryLine(line)) {
    return false;
  }

  if (nextLine && isCompactCompanyRoleLine(line, nextLine)) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9&.,'()\-\/\s]{2,80}$/.test(line) && nextLine && isLikelyWorkTitle(nextLine)) {
    return true;
  }

  if (/^（[^）]+）$/.test(line) || isLikelySameCompanyContinuation(line)) {
    return false;
  }

  if (line === '·' || /^(吴女士|江先生|杨女士|陈女士)$/.test(line)) {
    return false;
  }

  if (isLikelyWorkEntryStart(line, nextLine, nextNextLine, thirdLine)) {
    return true;
  }

  if (isLikelyForeignCompanyLine(line, nextLine, nextNextLine)) {
    return true;
  }

  if (/[。；，,.：:]/.test(line)) {
    return false;
  }

  return isLikelyCompanyHeaderPattern(nextLine, nextNextLine, thirdLine);
}

function isLikelyWorkTitle(line: string): boolean {
  if (['文员', '会计师', '成本管理员', '出纳', '英语老师实习', '风险控制', '企业贸易合规师实习', '外贸业务', '护士/护理人员', '客户代表'].includes(line)) {
    return true;
  }

  if (line === '大客户销售' || line === '资深业务跟单' || line === '高级业务跟单' || line === '外贸销售' || line === '外贸运营' || line === '初中英语老师' || line === '出境领队') {
    return true;
  }

  if (/^[A-Za-z][A-Za-z\s/&+-]{1,40}$/.test(line)) {
    return true;
  }

  if (!ROLE_LINE_PATTERNS.some((keyword) => line.includes(keyword))) {
    return false;
  }

  if (/^[0-9A-Za-z]+[、.．)]/.test(line)) {
    return false;
  }

  if (line.length > 60) {
    return false;
  }

  if (/[：:；;，,。]/.test(line)) {
    return false;
  }

  if (/负责|参与|主导|统筹|通过|协助|实现|推动|处理|跟进|完成|搭建|建立/.test(line)) {
    return false;
  }

  return true;
}

function isLikelyPromotableWorkTitle(line: string): boolean {
  if (!line || isIndustryLine(line) || isCompressedIndustryMetaLine(line) || isLikelyIndustryOnlyLine(line)) {
    return false;
  }

  if (isLikelyWorkTitle(line)) {
    return true;
  }

  if (line.length > 24 || /[：:；;，,。]/.test(line)) {
    return false;
  }

  return /(采购员|采购工程师|文员|领班|调度|审核员|翻译|专员|助理|老师|实习生|业务员|跟单|客服|销售|运营|仓库|物流|船务)/.test(line);
}

function isLikelyEmbeddedRoleSummary(line: string): boolean {
  return /(售后客服交付专员|外贸专员|外贸业务员|销售工程师|外贸销售|海外销售|贸易跟单|审计员|客户代表|行政专员\/助理)/.test(line)
    && !/[：:；;，,。]/.test(line);
}

function extractRoleFromSummaryLine(line: string): string | undefined {
  const matches = line.match(/(售后客服交付专员|外贸专员|外贸业务员|销售工程师|外贸销售|海外销售|贸易跟单|审计员|客户代表|行政专员\/助理)/g);
  if (!matches || matches.length === 0) {
    return undefined;
  }

  return matches[matches.length - 1];
}

function isLikelyWorkCapabilityTag(line: string): boolean {
  return /^(品质控制（QC）|品质管理（QE）|客户质量管理（CQE）|8D报告|CPK|制定SOP|熟练使用办公软件)$/.test(line);
}

function isLikelyStandaloneResumeLine(line: string): boolean {
  return /^案例体现[:：]?$/.test(line)
    || /^学会用英语进行沟通$/.test(line)
    || /^用邮件全英文与客户进行预订咨询回复等$/.test(line);
}

function isLikelyDomTag(line: string): boolean {
  return ['面销/陌拜', '会展销售', '网络/线上销售', '行业知识', '客户开发能力', '商业谈判', '数据分析', '地推', '电话销售', '渠道销售'].includes(line);
}

function shouldSkipWorkDetailLine(line: string): boolean {
  return isLikelyStandaloneResumeLine(line)
    || isLikelyRelatedTagLine(line)
    || isLikelyDomTag(line)
    || isLikelyWorkCapabilityTag(line)
    || isLikelyWorkBusinessTag(line);
}

function cleanupWorkExperience(experience: WorkExperience): WorkExperience {
  const title = experience.title?.trim();
  const cleanedDetails = experience.details.filter((line) => {
    if (title && line.includes(title) && isLikelyEmbeddedRoleSummary(line)) {
      return false;
    }

    if (shouldSkipWorkDetailLine(line)) {
      return false;
    }

    return true;
  });

  return {
    ...experience,
    details: cleanedDetails,
  };
}

function normalizeParsedWorkExperiences(experiences: WorkExperience[]): WorkExperience[] {
  const normalized: WorkExperience[] = [];

  for (const experience of experiences) {
    const splitExperiences = splitWorkDetailsIntoExperiences(experience);
    normalized.push(...splitExperiences);
  }

  return normalized;
}

function isLikelyStandaloneCompanyLine(line: string): boolean {
  return Boolean(line)
    && !shouldSkipWorkDetailLine(line)
    && (isLikelyCompany(line) || isLikelySchoolEmployer(line) || /^[\u4e00-\u9fa5A-Za-z]{2,20}$/.test(line))
    && !isLikelyWorkTitle(line)
    && !isIndustryLine(line)
    && !isCompressedIndustryMetaLine(line)
    && !isLikelyIndustryOnlyLine(line)
    && !isTimeRangeLine(line)
    && !isInlineTimeRangeLine(line)
    && !isStandaloneDurationLine(line)
    && !/[：:；;，,。]/.test(line);
}

function isLikelyWorkHeaderWindow(companyLine?: string, titleLine?: string, thirdLine?: string, fourthLine?: string, fifthLine?: string): boolean {
  if (!companyLine || !(isLikelyCompany(companyLine) || isLikelySchoolEmployer(companyLine))) {
    return false;
  }

  if (!titleLine || !isLikelyWorkTitle(titleLine)) {
    return false;
  }

  const candidates = [thirdLine, fourthLine, fifthLine].filter((line): line is string => Boolean(line));
  let sawIndustryMeta = false;

  for (const line of candidates) {
    if (isTimeRangeLine(line) || isInlineTimeRangeLine(line)) {
      return true;
    }

    if (isIndustryMetaFragment(line) || isCompressedIndustryMetaLine(line)) {
      sawIndustryMeta = true;
      continue;
    }

    if (sawIndustryMeta) {
      return false;
    }
  }

  return false;
}

function isInlineTimeRangeLine(line: string): boolean {
  return /^(\d{4}\.\d{2})\s*-\s*(至今|\d{4}\.\d{2})(?:（[^）]+）)?$/.test(line);
}

function isWorkHeaderStartAt(lines: string[], index: number): boolean {
  const line = lines[index];
  const nextLine = lines[index + 1];
  const nextNextLine = lines[index + 2];
  const thirdLine = lines[index + 3];
  const fourthLine = lines[index + 4];

  if (!line || shouldSkipWorkDetailLine(line) || isWorkSectionStopLine(line) || isLikelyRelatedTagLine(line) || isIndustryLine(line) || isLikelyIndustryOnlyLine(line)) {
    return false;
  }

  if (/^（[^）]+）$/.test(line) || isLikelySameCompanyContinuation(line)) {
    return false;
  }

  if (isLikelyStandaloneCompanyLine(line) && nextLine && isLikelyPromotableWorkTitle(nextLine)) {
    if (nextNextLine && (isIndustryMetaFragment(nextNextLine) || isCompressedIndustryMetaLine(nextNextLine) || isLikelyIndustryOnlyLine(nextNextLine))) {
      if (thirdLine && (isTimeRangeLine(thirdLine) || isInlineTimeRangeLine(thirdLine))) {
        return true;
      }
    }

    if (nextNextLine && (isTimeRangeLine(nextNextLine) || isInlineTimeRangeLine(nextNextLine))) {
      return true;
    }
  }

  if (isLikelyForeignCompanyLine(line, nextLine, nextNextLine)) {
    return true;
  }

  if (isLikelyCompanyLineByContext(line, nextLine, nextNextLine, thirdLine)) {
    return true;
  }

  if ((isLikelyCompany(line) || isLikelySchoolEmployer(line)) && nextLine && isLikelyWorkTitle(nextLine)) {
    if (nextNextLine && (isTimeRangeLine(nextNextLine) || isInlineTimeRangeLine(nextNextLine))) {
      return true;
    }

    if (isLikelyWorkHeaderWindow(line, nextLine, nextNextLine, thirdLine, fourthLine)) {
      return true;
    }
  }

  return isLikelyWorkHeaderWindow(line, nextLine, nextNextLine, thirdLine, fourthLine);
}

function isPotentialWorkPrelude(line: string): boolean {
  return isLikelyStandaloneResumeLine(line)
    || isLikelyRelatedTagLine(line)
    || /^（[^）]+）$/.test(line);
}

function findWorkHeaderStart(lines: string[], index: number): number | undefined {
  for (let candidate = index; candidate <= Math.min(index + 2, lines.length - 1); candidate += 1) {
    if (isWorkHeaderStartAt(lines, candidate)) {
      return candidate;
    }

    if (!isPotentialWorkPrelude(lines[candidate])) {
      break;
    }
  }

  return undefined;
}

function collectWorkHeaderIndexes(lines: string[]): number[] {
  const indexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (isWorkSectionStopLine(lines[index])) {
      break;
    }

    const previousLine = lines[index - 1];
    if (previousLine && isLikelyStandaloneCompanyLine(previousLine) && isForcedWorkHeaderAt(lines, index)) {
      continue;
    }

    if (isForcedWorkHeaderAt(lines, index)) {
      if (indexes[indexes.length - 1] !== index) {
        indexes.push(index);
      }
      continue;
    }

    const forcedHeaderStart = findForcedWorkHeaderStart(lines, index);
    if (forcedHeaderStart !== undefined) {
      if (indexes[indexes.length - 1] !== forcedHeaderStart) {
        indexes.push(forcedHeaderStart);
      }
      index = forcedHeaderStart;
      continue;
    }

    const headerStart = findWorkHeaderStart(lines, index);
    if (headerStart === undefined) {
      continue;
    }

    if (indexes[indexes.length - 1] !== headerStart) {
      indexes.push(headerStart);
    }

    index = headerStart;
  }

  return indexes;
}

function collectWorkBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  const headerIndexes = collectWorkHeaderIndexes(lines);

  for (let index = 0; index < headerIndexes.length; index += 1) {
    const start = headerIndexes[index];
    const nextStart = headerIndexes[index + 1] ?? lines.length;
    let block = lines.slice(start, nextStart).filter((line) => !isWorkSectionStopLine(line));

    if (
      block.length === 1
      && isLikelyStandaloneCompanyLine(block[0])
      && index + 1 < headerIndexes.length
      && headerIndexes[index + 1] === start + 1
    ) {
      const mergedNextStart = headerIndexes[index + 2] ?? lines.length;
      block = lines.slice(start, mergedNextStart).filter((line) => !isWorkSectionStopLine(line));
      index += 1;
    }

    if (block.length > 0) {
      blocks.push(block);
    }
  }

  return blocks;
}

function isIndustryMetaFragment(line: string): boolean {
  return isIndustryLine(line)
    || /^\d+-\d+人$/.test(line)
    || /^少于\d+人$/.test(line)
    || /^(国企|民营|外资|合资|已上市|上市公司)$/.test(line);
}

function isCompressedIndustryMetaLine(line: string): boolean {
  return isIndustryMetaFragment(line)
    || /^.+(?:\d+-\d+人|少于\d+人).*(?:国企|民营|外资|合资|已上市|上市公司)?$/.test(line)
    || /^(?:国企|民营|外资|合资|已上市|上市公司).*(?:\d+-\d+人|少于\d+人|公共事业|政府\/公共事业|建材|机械\/设备\/重工|仪器仪表\/工业自动化).*$/.test(line);
}

function parseWorkBlock(blockLines: string[]): WorkExperience {
  const [company, ...rest] = blockLines;
  const experience: WorkExperience = {
    company,
    details: [],
  };
  const industryFragments: string[] = [];
  let seenTimeRange = false;

  for (const line of rest) {
    if (!experience.title && isLikelyWorkTitle(line) && !isCompressedIndustryMetaLine(line) && !isLikelyIndustryOnlyLine(line)) {
      experience.title = line;
      continue;
    }

    if (!experience.title && isLikelyEmbeddedRoleSummary(line)) {
      const extractedTitle = extractRoleFromSummaryLine(line);
      if (extractedTitle) {
        experience.title = extractedTitle;
        continue;
      }
    }

    if (isTimeRangeLine(line)) {
      if (!experience.start) {
        Object.assign(experience, parseTimeRange(line));
      }
      seenTimeRange = true;
      continue;
    }

    const durationMatch = line.match(/^（([^）]+)）$/);
    if (durationMatch) {
      if (!experience.duration) {
        experience.duration = durationMatch[1];
      }
      continue;
    }

    if (!seenTimeRange && isCompressedIndustryMetaLine(line)) {
      industryFragments.push(line);
      continue;
    }

    if (!isWorkMetaLine(line) && !shouldSkipWorkDetailLine(line)) {
      experience.details.push(line);
    }
  }

  if (!experience.title && experience.details.length > 0 && isLikelyPromotableWorkTitle(experience.details[0])) {
    experience.title = experience.details.shift();
  }

  if (experience.title && isCompressedIndustryMetaLine(experience.title) && experience.details.length > 0 && isLikelyPromotableWorkTitle(experience.details[0])) {
    industryFragments.unshift(experience.title);
    experience.title = experience.details.shift();
  }

  if (industryFragments.length > 0) {
    experience.industry = industryFragments.join('');
  }

  return cleanupWorkExperience(experience);
}

function isForcedWorkHeaderAt(lines: string[], index: number): boolean {
  const line = lines[index];
  const nextLine = lines[index + 1];
  if (!line || !nextLine || shouldSkipWorkDetailLine(line) || shouldSkipWorkDetailLine(nextLine)) {
    return false;
  }

  if (isLikelyStandaloneCompanyLine(line) && isLikelyPromotableWorkTitle(nextLine)) {
    let cursor = index + 2;
    while (cursor < lines.length && (isIndustryMetaFragment(lines[cursor] ?? '') || isCompressedIndustryMetaLine(lines[cursor] ?? '') || isLikelyIndustryOnlyLine(lines[cursor] ?? ''))) {
      cursor += 1;
    }

    const timeLine = lines[cursor];
    return Boolean(timeLine && (isInlineTimeRangeLine(timeLine) || isTimeRangeLine(timeLine)));
  }

  if (!(isLikelyCompany(line) || isLikelySchoolEmployer(line)) || !isLikelyWorkTitle(nextLine)) {
    return false;
  }

  let cursor = index + 2;
  while (cursor < lines.length && (isIndustryMetaFragment(lines[cursor] ?? '') || isCompressedIndustryMetaLine(lines[cursor] ?? '') || isLikelyIndustryOnlyLine(lines[cursor] ?? ''))) {
    cursor += 1;
  }

  const timeLine = lines[cursor];
  return Boolean(timeLine && (isInlineTimeRangeLine(timeLine) || isTimeRangeLine(timeLine)));
}

function findForcedWorkHeaderStart(lines: string[], index: number): number | undefined {
  for (let candidate = index; candidate <= Math.min(index + 2, lines.length - 1); candidate += 1) {
    if (isForcedWorkHeaderAt(lines, candidate)) {
      return candidate;
    }

    if (!isPotentialWorkPrelude(lines[candidate])) {
      break;
    }
  }

  return undefined;
}

function isLikelyDetailToHeaderBoundary(prevLine: string | undefined, line: string, nextLine?: string, nextNextLine?: string, thirdLine?: string): boolean {
  if (!prevLine || !line || !nextLine || shouldSkipWorkDetailLine(line) || shouldSkipWorkDetailLine(nextLine)) {
    return false;
  }

  const matchesStandardHeader = isLikelyCompany(line) && isLikelyWorkTitle(nextLine);
  const matchesCompactHeader = isCompactCompanyRoleLine(line, nextLine);
  const matchesStandaloneHeader = isLikelyStandaloneCompanyLine(line) && isLikelyPromotableWorkTitle(nextLine);
  if (!matchesStandardHeader && !matchesCompactHeader && !matchesStandaloneHeader) {
    return false;
  }

  const lookahead = [nextNextLine, thirdLine].filter((item): item is string => Boolean(item));
  const hasTimeWindow = lookahead.some((item) => isTimeRangeLine(item) || isInlineTimeRangeLine(item) || isStandaloneDurationLine(item));
  if (!hasTimeWindow) {
    return false;
  }

  const previousLineBlocksHeader = isLikelyCompany(prevLine)
    || isCompactCompanyRoleLine(prevLine, line)
    || isLikelyStandaloneCompanyLine(prevLine)
    || isLikelyWorkTitle(prevLine)
    || isLikelyPromotableWorkTitle(prevLine)
    || isIndustryMetaFragment(prevLine)
    || isCompressedIndustryMetaLine(prevLine)
    || isLikelyIndustryOnlyLine(prevLine)
    || isTimeRangeLine(prevLine)
    || isInlineTimeRangeLine(prevLine)
    || isStandaloneDurationLine(prevLine)
    || isLikelyRelatedTagLine(prevLine);

  if (!previousLineBlocksHeader) {
    return true;
  }

  return /^\d+[、.．)]/.test(prevLine)
    || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(prevLine)
    || /^[▪•●■◆·-]/.test(prevLine)
    || /负责|参与|协助|跟进|处理|安排|制作|维护|记录|通知|提交|确认|协调|汇总|检测|跟踪|督促|对接|推动|完成/.test(prevLine)
    || /[；。]$/.test(prevLine);
}

function splitWorkBlockLines(blockLines: string[]): string[][] {
  const headerIndexes = collectWorkHeaderIndexes(blockLines);
  const derivedIndexes = [...headerIndexes];

  for (let index = 1; index < blockLines.length; index += 1) {
    if (derivedIndexes.includes(index)) {
      continue;
    }

    if (isLikelyDetailToHeaderBoundary(
      blockLines[index - 1],
      blockLines[index],
      blockLines[index + 1],
      blockLines[index + 2],
      blockLines[index + 3],
    )) {
      derivedIndexes.push(index);
    }
  }

  const sortedIndexes = [...new Set(derivedIndexes)].sort((left, right) => left - right);
  if (sortedIndexes.length <= 1) {
    return [blockLines];
  }

  const firstStart = sortedIndexes[0] === 0 ? sortedIndexes : [0, ...sortedIndexes];
  const blocks: string[][] = [];

  for (let index = 0; index < firstStart.length; index += 1) {
    const start = firstStart[index];
    const nextStart = firstStart[index + 1] ?? blockLines.length;
    let block = blockLines.slice(start, nextStart).filter(Boolean);

    if (
      block.length === 1
      && isLikelyStandaloneCompanyLine(block[0])
      && index + 1 < firstStart.length
      && firstStart[index + 1] === start + 1
    ) {
      const mergedNextStart = firstStart[index + 2] ?? blockLines.length;
      block = blockLines.slice(start, mergedNextStart).filter(Boolean);
      index += 1;
    }

    if (block.length > 0) {
      blocks.push(block);
    }
  }

  return blocks.length > 0 ? blocks : [blockLines];
}

function forceSplitDomWorkBlock(block: string[]): string[][] {
  const splitBlocks = splitWorkBlockLines(block).filter((item) => item.length > 0);
  if (splitBlocks.length > 1) {
    return splitBlocks;
  }

  for (let index = 1; index < block.length; index += 1) {
    if (!isLikelyCompany(block[index]) || !isLikelyWorkTitle(block[index + 1] ?? '')) {
      continue;
    }

    let cursor = index + 2;
    while (cursor < block.length && (isIndustryMetaFragment(block[cursor]) || isCompressedIndustryMetaLine(block[cursor]))) {
      cursor += 1;
    }

    if (!block[cursor] || (!isTimeRangeLine(block[cursor]) && !isInlineTimeRangeLine(block[cursor]))) {
      continue;
    }

    const previousSlice = block.slice(0, index);
    if (previousSlice.length === 0) {
      continue;
    }

    return [previousSlice, block.slice(index)];
  }

  return [block];
}

function splitWorkDetailsIntoExperiences(experience: WorkExperience): WorkExperience[] {
  if (experience.details.length === 0) {
    return [experience];
  }

  const nestedDetailBlocks = splitWorkBlockLines(experience.details);
  if (nestedDetailBlocks.length <= 1) {
    return [experience];
  }

  const [firstDetailBlock, ...restDetailBlocks] = nestedDetailBlocks;
  const firstExperienceBase: WorkExperience = {
    ...experience,
    details: [],
  };

  if (!firstExperienceBase.industry && firstDetailBlock.length > 0) {
    const extractedIndustry: string[] = [];
    let detailStartIndex = 0;

    while (detailStartIndex < firstDetailBlock.length && isCompressedIndustryMetaLine(firstDetailBlock[detailStartIndex])) {
      extractedIndustry.push(firstDetailBlock[detailStartIndex]);
      detailStartIndex += 1;
    }

    if (extractedIndustry.length > 0) {
      firstExperienceBase.industry = extractedIndustry.join('');
      firstExperienceBase.details = firstDetailBlock.slice(detailStartIndex).filter((line) => !shouldSkipWorkDetailLine(line));
    } else {
      firstExperienceBase.details = firstDetailBlock.filter((line) => !shouldSkipWorkDetailLine(line));
    }
  } else {
    firstExperienceBase.details = firstDetailBlock.filter((line) => !shouldSkipWorkDetailLine(line));
  }

  const experiences: WorkExperience[] = [cleanupWorkExperience(firstExperienceBase)];

  for (const detailBlock of restDetailBlocks) {
    const parsed = parseWorkBlock(detailBlock);
    if (parsed.company && (parsed.title || parsed.start || parsed.end || parsed.details.length > 0)) {
      experiences.push(parsed);
    }
  }

  return experiences;
}

function splitNestedWorkBlocks(block: string[]): string[][] {
  if (block.length === 0) {
    return [];
  }

  const splitBlocks = splitWorkBlockLines(block).filter((item) => item.length > 0);
  if (splitBlocks.length <= 1) {
    return [block];
  }

  return splitBlocks.flatMap((item) => splitNestedWorkBlocks(item));
}

function extractWorkBlocksFromDomSnapshot(domSnapshot?: ResumeDomSnapshot): string[][] {
  if (!domSnapshot) {
    return [];
  }

  const workNodes = domSnapshot.workNodes ?? [];
  const groupedWorkItems = workNodes
    .filter((node) => node.className === 'workExp_item')
    .map((node) => {
      const nearTopNodes = workNodes
        .filter((candidate) => candidate.top >= node.top - 5 && candidate.top <= node.top + 120)
        .sort((left, right) => left.top - right.top || left.left - right.left);

      const childNodes = workNodes.filter((candidate) => candidate.parentClassName === 'workExp_item' && candidate.top >= node.top - 5 && candidate.top <= node.top + 800);
      const contentNode = childNodes.find((candidate) => candidate.className === 'work_content');
      const tagsNode = childNodes.find((candidate) => candidate.className === 'detail_tags');

      const company = workNodes.find((candidate) => candidate.className?.includes('c_name') && candidate.top >= node.top - 5 && candidate.top <= node.top + 80)?.text;
      const title = workNodes.find((candidate) => candidate.className === 'func_name' && candidate.top >= node.top - 5 && candidate.top <= node.top + 80)?.text;
      const industryParts = nearTopNodes
        .filter((candidate) => candidate.parentClassName === 'detail_bot')
        .map((candidate) => candidate.text);
      const timeText = nearTopNodes.find((candidate) => candidate.className === 'work_timerange')?.text;
      const contentText = contentNode?.text;
      const tags = tagsNode
        ? workNodes
          .filter((candidate) => candidate.parentClassName === 'detail_tags_items' && candidate.top >= tagsNode.top - 5 && candidate.top <= tagsNode.top + 5)
          .sort((left, right) => left.left - right.left)
          .map((candidate) => candidate.text)
        : [];

      const lines = [
        ...(company ? [company] : []),
        ...(title ? [title] : []),
        ...industryParts,
        ...(timeText ? normalizeCombinedWorkMetaLine(normalizeDomLine(timeText)) : []),
      ];

      if (contentText) {
        const detailLines = normalizeDomLine(contentText)
          .replace(/ · /g, '\n· ')
          .replace(/(?<!^)(\d+[、.])/g, '\n$1')
          .split('\n')
          .map((line) => normalizeDomLine(line))
          .filter(Boolean);
        lines.push(...detailLines);
      }

      lines.push(...tags);

      return normalizeDomTexts(lines)
        .filter((line) => !NOISE_PATTERNS.some((pattern) => pattern.test(line)))
        .filter((line) => !isLikelyDomTag(line));
    })
    .filter((block) => block.length > 0);
  if (groupedWorkItems.length > 0) {
    return groupedWorkItems;
  }

  const blockLines = domSnapshot.workBlocks
    ?.map((block) => normalizeDomTexts(
      block.flatMap((line) => normalizeCombinedWorkMetaLine(normalizeDomLine(line))),
    ))
    .filter((block) => block.length > 0) ?? [];
  if (blockLines.length > 0) {
    return blockLines.flatMap((block) => forceSplitDomWorkBlock(block));
  }

  const workLines = extractWorkLinesFromDomSnapshot(domSnapshot);
  return forceSplitDomWorkBlock(workLines).flatMap((block) => splitNestedWorkBlocks(block));
}

function parseWorkExperiencesFromDomSnapshot(domSnapshot?: ResumeDomSnapshot): WorkExperience[] {
  if (!domSnapshot) {
    return [];
  }

  const splitBlocks = extractWorkBlocksFromDomSnapshot(domSnapshot);
  const parsedExperiences = splitBlocks
    .flatMap((block) => forceSplitDomWorkBlock(block))
    .map(parseWorkBlock)
    .filter((experience) => experience.company && (experience.title || experience.start || experience.end || experience.details.length > 0));

  if (parsedExperiences.length === 1) {
    return normalizeParsedWorkExperiences(parsedExperiences);
  }

  return parsedExperiences.map(cleanupWorkExperience);
}

function parseWorkExperiences(workLines: string[]): WorkExperience[] {
  const lines = extractCoreWorkLines(workLines);
  const blocks = collectWorkBlocks(lines).flatMap((block) => splitNestedWorkBlocks(block));

  return normalizeParsedWorkExperiences(
    blocks
      .map(parseWorkBlock)
      .filter((experience) => experience.company && (experience.title || experience.start || experience.end || experience.details.length > 0)),
  );
}

function isProjectMetaLine(line: string): boolean {
  return /^项目周期[:：]?|^合作对象[:：]?|^项目金额[:：]?|^项目内容[:：]?|^项目成果[:：]?/.test(line);
}

function isLikelyProjectHeadingWithDate(line: string, nextLine?: string): boolean {
  if (!nextLine || !isTimeRangeLine(nextLine)) {
    return false;
  }

  if (line.length > 40) {
    return false;
  }

  if (line.includes('：') || /^[\dA-Za-z]/.test(line) || /[。；，,]/.test(line)) {
    return false;
  }

  return line.includes('项目');
}

function isProjectTitleLine(line: string, nextLine?: string): boolean {
  if (!line || line.length > 80) {
    return false;
  }

  if (isTimeRangeLine(line) || isLikelyCompany(line) || line.includes('：') || /^\d+[、.]/.test(line)) {
    return false;
  }

  if (isProjectMetaLine(line) || /^成功促成|^为客户|^单个项目|^唯一负责人/.test(line)) {
    return false;
  }

  if (/^(项目描述|工作内容)[:：]/.test(line)) {
    return false;
  }

  if (/合作,?进而建设|合作，?进而建设/.test(line)) {
    return false;
  }

  return isLikelyProjectHeadingWithDate(line, nextLine);
}

function collectProjectBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];

    if (isWorkSectionStopLine(line)) {
      break;
    }

    if (isProjectTitleLine(line, nextLine)) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = [line];
      continue;
    }

    if (currentBlock.length === 0) {
      continue;
    }

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  return blocks;
}

function parseProjectBlock(blockLines: string[]): ProjectExperience {
  const [name, ...rest] = blockLines;
  const experience: ProjectExperience = {
    name,
    details: [],
  };

  for (const line of rest) {
    if (!experience.start && isTimeRangeLine(line)) {
      Object.assign(experience, parseTimeRange(line));
      continue;
    }

    experience.details.push(line);
  }

  return experience;
}

function parseProjectExperiences(projectLines: string[]): ProjectExperience[] {
  return collectProjectBlocks(projectLines)
    .map(parseProjectBlock)
    .filter((item) => item.name || item.details.length > 0);
}

function normalizeProjectExperiences(projectExperiences: ProjectExperience[]): ProjectExperience[] {
  return projectExperiences.map((experience) => ({
    ...experience,
    details: experience.details
      .map((detail) => detail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n'))
      .filter(Boolean),
  }));
}

function isEducationStopLine(line: string): boolean {
  return line === '技能/语言' || line === '证书' || line === '培训经历';
}

function isLikelySchool(line: string): boolean {
  if (!line || line.length > 40 || isTimeRangeLine(line) || pickEducation(line) !== undefined) {
    return false;
  }

  if (line === '技能/语言' || LANGUAGE_KEYWORDS.includes(line) || line === '良好' || line === '听说读写流利') {
    return false;
  }

  if (/奖|竞赛|比赛|证书|荣誉|奖学金|优秀毕业生|三好学生|^985$|^211$|^双一流|^[0-9]+[.、]/.test(line)) {
    return false;
  }

  return line.includes('大学') || line.includes('学院') || line.includes('学校') || line.includes('中学');
}

function parseEducationExperiences(educationLines: string[]): EducationExperience[] {
  const experiences: EducationExperience[] = [];
  let current: EducationExperience | null = null;

  for (const line of educationLines) {
    if (!line || isEducationStopLine(line)) {
      break;
    }

    if (isLikelySchool(line)) {
      if (current) {
        experiences.push(current);
      }
      current = { school: line, details: [] };
      continue;
    }

    if (!current) {
      continue;
    }

    if (isTimeRangeLine(line)) {
      const range = parseTimeRange(line);
      current.start = range.start;
      current.end = range.end;
      continue;
    }

    const degree = pickEducation(line);
    if (degree) {
      const majorText = line.replace(/^(博士|硕士|本科|大专|中技\/中专|中专|高中)/, '').trim();
      current.degree = degree;
      if (majorText && !/奖|竞赛|比赛|证书|荣誉|奖学金/.test(majorText)) {
        current.major = majorText || current.major;
      } else if (majorText) {
        current.details.push(line);
      }
      continue;
    }

    if (!LANGUAGE_KEYWORDS.includes(line)
      && line !== '良好'
      && line !== '听说读写流利'
      && !/^\d{4}\.\d{2}$/.test(line)
      && !/证书$/.test(line)) {
      current.details.push(line);
    }
  }

  if (current) {
    experiences.push(current);
  }

  const deduped = new Map<string, EducationExperience>();
  for (const experience of experiences) {
    if (!experience.school && !experience.degree && !experience.major && experience.details.length === 0) {
      continue;
    }

    const key = [experience.school ?? '', experience.degree ?? '', experience.major ?? ''].join('|');
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, experience);
      continue;
    }

    const existingSpan = `${existing.start ?? ''}-${existing.end ?? ''}`;
    const currentSpan = `${experience.start ?? ''}-${experience.end ?? ''}`;
    if (currentSpan > existingSpan) {
      deduped.set(key, {
        ...experience,
        details: unique([...existing.details, ...experience.details]),
      });
      continue;
    }

    existing.details = unique([...existing.details, ...experience.details]);
  }

  return [...deduped.values()];
}

function extractCoreWorkLines(workLines: string[]): string[] {
  const stopMarkers = new Set(['项目经验', '教育经历']);
  const result: string[] = [];

  for (const line of workLines) {
    if (stopMarkers.has(line)) {
      break;
    }
    result.push(line);
  }

  return result;
}

function isLikelyCompany(line: string): boolean {
  if (line.length < 2 || line.length > 80) {
    return false;
  }

  if (line.includes('有限公司')) {
    return true;
  }

  if (/(医院|诊所|卫生院|护理院)$/.test(line)) {
    return true;
  }

  if (COMPANY_EXCLUDE_PATTERNS.some((pattern) => pattern.test(line))) {
    return false;
  }

  if (/^\d+[、.]|^\d{4}\.\d{2}|^（?\d+年|^[▪•●■◆]/.test(line)) {
    return false;
  }

  if (line.includes('负责') || line.includes('参与') || line.includes('项目经验') || line.includes('工作期间') || line.includes('工作经历') || line.includes('教育经历')) {
    return false;
  }

  if (line.includes('：') || /[。；，]/.test(line)) {
    return false;
  }

  if (/熟练掌握|责任心|沟通协调能力|文件处理能力|突发事件处理|员工培训监督与考核|项目管理工作|中级会计职称|初级会计职称|ERP系统|外企|CET-?6/i.test(line)) {
    return false;
  }

  if (/\d+-\d+人|少于\d+人|国企|民营|外资|合资|上市公司|已上市|机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校|政府机关|公共事业|政府\/公共事业|其他专业服务|房地产|服装\/纺织\/皮革|建材/.test(line)) {
    return false;
  }

  if (ROLE_LINE_PATTERNS.some((keyword) => line.includes(keyword))) {
    return false;
  }

  return line.includes('集团')
    || line.includes('科技')
    || line.includes('咨询')
    || line.includes('流体控制')
    || line.includes('服务中心')
    || line.includes('分公司')
    || line.includes('培训中心')
    || line.includes('办公室')
    || line.includes('学校')
    || line.includes('酒店')
    || line.includes('株式会社')
    || line.endsWith('教育')
    || /（[^）]+）/.test(line);
}

function isLikelyForeignCompanyLine(line: string, nextLine?: string, nextNextLine?: string): boolean {
  if (!line || !/[A-Za-z]/.test(line) || /[。；，：:]/.test(line)) {
    return false;
  }

  return Boolean(
    nextLine
      && isLikelyWorkTitle(nextLine)
      && nextNextLine
      && isTimeRangeLine(nextNextLine),
  );
}

async function extractResumeTextSources(pageOrFrame: Page | Frame): Promise<{ bodyText: string; html: string; textContent: string }> {
  const bodyLocator = pageOrFrame.locator('body');
  const [bodyTextValue, htmlValue, textContentValue] = await Promise.all([
    bodyLocator.innerText().catch(() => ''),
    ('content' in pageOrFrame && typeof pageOrFrame.content === 'function'
      ? pageOrFrame.content()
      : Promise.resolve('')).catch(() => ''),
    ('evaluate' in bodyLocator && typeof bodyLocator.evaluate === 'function'
      ? bodyLocator.evaluate((body) => body.textContent ?? '')
      : Promise.resolve('')).catch(() => ''),
  ]);

  return {
    bodyText: typeof bodyTextValue === 'string' ? bodyTextValue : String(bodyTextValue ?? ''),
    html: typeof htmlValue === 'string' ? htmlValue : String(htmlValue ?? ''),
    textContent: typeof textContentValue === 'string' ? textContentValue : String(textContentValue ?? ''),
  };
}

function buildResumeMarkers(content: string, html: string): string[] {
  return ['在线简历', '工作经历', '教育经历', '项目经验', '求职意向', '相似人才', '不感兴趣', '去搜索', '立即Hi聊']
    .filter((marker) => content.includes(marker) || html.includes(marker));
}

function buildResumeContentCandidate(candidateId: string, source: { bodyText: string; html: string; textContent: string }): string {
  if (isResumeDetailContent(source.bodyText, candidateId)) {
    return source.bodyText;
  }

  const normalizedTextContent = source.textContent.replace(/\s+/g, ' ').trim();
  if (isResumeDetailContent(normalizedTextContent, candidateId)) {
    return normalizedTextContent;
  }

  const htmlText = source.html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();

  if (isResumeDetailContent(htmlText, candidateId)) {
    return htmlText;
  }

  return source.bodyText || normalizedTextContent || htmlText;
}

async function extractResumeDomSnapshot(page: Page): Promise<ResumeDomSnapshot | undefined> {
  const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
  if (!bodyHtml) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }

      const frameBodyHtml = await frame.locator('body').innerHTML().catch(() => '');
      if (frameBodyHtml.includes('工作经历')) {
        return extractResumeDomSnapshotFromHtml(frame, frameBodyHtml);
      }
    }
  }

  return extractResumeDomSnapshotFromHtml(page, bodyHtml);
}

async function extractResumeDomSnapshotFromHtml(pageOrFrame: Page | Frame, bodyHtml: string): Promise<ResumeDomSnapshot | undefined> {
  const workSectionHtmlMatch = bodyHtml.match(/工作经历([\s\S]*?)(项目经验|教育经历|技能\/语言|证书|举报|相似人才)/);
  const workSectionHtml = workSectionHtmlMatch?.[1];

  if (!workSectionHtml) {
    return undefined;
  }

  const workLines = workSectionHtml
    .split(/<[^>]+>/g)
    .map((chunk) => chunk.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const workBlocks = await pageOrFrame.locator('section:has-text("工作经历") section').evaluateAll((sections) => sections
    .map((section) => {
      const lines = Array.from(section.querySelectorAll<HTMLElement>('span, div, p'))
        .map((node) => node.innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return [...new Set(lines)];
    })
    .filter((lines) => lines.length > 0),
  ).catch(() => [] as string[][]);

  const workNodes = await pageOrFrame.locator('body').evaluate((body): ResumeDomWorkNode[] => {
    const stopTexts = new Set(['项目经验', '教育经历', '技能/语言', '证书', '举报', '相似人才']);
    const startText = '工作经历';
    const nodes = Array.from(body.querySelectorAll<HTMLElement>('div, span, p, li'));
    let inWorkSection = false;

    return nodes.flatMap((node) => {
      const text = node.innerText.replace(/\s+/g, ' ').trim();
      if (!text) {
        return [];
      }

      if (text === startText) {
        inWorkSection = true;
        return [];
      }

      if (!inWorkSection) {
        return [];
      }

      if (stopTexts.has(text)) {
        inWorkSection = false;
        return [];
      }

      const rect = node.getBoundingClientRect();
      let depth = 0;
      let parent: HTMLElement | null = node.parentElement;
      while (parent && parent !== body) {
        depth += 1;
        parent = parent.parentElement;
      }

      return [{
        text,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        depth,
        tagName: node.tagName.toLowerCase(),
        className: node.className || undefined,
        parentClassName: node.parentElement?.className || undefined,
      }];
    });
  }).catch(() => [] as ResumeDomWorkNode[]);

  if (workLines.length === 0 && workBlocks.length === 0 && workNodes.length === 0) {
    return undefined;
  }

  return {
    workLines,
    workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
    workNodes: workNodes.length > 0 ? workNodes : undefined,
  };
}

function extractWorkLinesFromDomSnapshot(domSnapshot?: ResumeDomSnapshot): string[] {
  return normalizeDomTexts(
    flattenDomSnapshotTexts(domSnapshot)
      .flatMap((line) => normalizeCombinedWorkMetaLine(normalizeDomLine(line))),
  );
}

export function extractWorkLines(bodyText: string): string[] {
  return cleanLines(sectionBetween(bodyText, '工作经历', ['项目经验', '教育经历']));
}

export function extractProjectLines(bodyText: string): string[] {
  return cleanLines(sectionBetween(bodyText, '项目经验', ['教育经历']));
}

export function extractEducationLines(bodyText: string): string[] {
  return cleanLines(sectionBetween(bodyText, '教育经历', ['培训经历', '证书', '举报']));
}

function parseResumeText(bodyText: string, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): CandidateResume {
  const headerLines = cleanLines(extractHeaderSection(bodyText));
  const domWorkExperiences = parseWorkExperiencesFromDomSnapshot(domSnapshot);
  const domWorkLines = extractWorkLinesFromDomSnapshot(domSnapshot);
  const workLines = domWorkLines.length > 0 ? domWorkLines : extractWorkLines(bodyText);
  const projectLines = extractProjectLines(bodyText);
  const educationLines = extractEducationLines(bodyText);
  const skillLines = cleanLines(sectionBetween(bodyText, '技能/语言', ['举报', '相似人才', '声明：']));
  const workExperiences = domWorkExperiences.length > 0 ? domWorkExperiences : parseWorkExperiences(workLines);
  const projectExperiences = normalizeProjectExperiences(parseProjectExperiences(projectLines));
  const educationExperiences = parseEducationExperiences(educationLines);

  return {
    candidateId: candidate.candidateId,
    resumeUrl: candidate.resumeUrl,
    name: parseName(headerLines, candidate.name),
    age: parseNumber(headerLines.join('\n'), /(\d{2})岁/),
    education: educationExperiences[0]?.degree ?? parseEducation(headerLines),
    regions: parseRegionsFromHeader(headerLines),
    pr: parsePersonalAdvantages(bodyText),
    workExperiences,
    projectExperiences,
    educationExperiences,
    skill: parseLanguageSkills(skillLines),
    certificates: parseCertificates(bodyText),
  };
}

export function parseResumeFromSource(source: { url: string; visibleText: string }, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): CandidateResume {
  const resume = parseResumeText(source.visibleText, candidate, domSnapshot);
  return {
    ...resume,
    resumeUrl: source.url || candidate.resumeUrl,
  };
}

export function debugCollectWorkHeaderIndexes(workLines: string[], domSnapshot?: ResumeDomSnapshot): {
  normalizedWorkLines: string[];
  headerIndexes: number[];
  headerLines: Array<{ index: number; line: string }>;
  forcedHeaderChecks: Array<{
    index: number;
    line: string;
    nextLine?: string;
    forced: boolean;
    titleMatch: boolean;
    companyMatch: boolean;
  }>;
} {
  const normalizedWorkLines = domSnapshot
    ? extractWorkLinesFromDomSnapshot(domSnapshot)
    : extractCoreWorkLines(workLines);
  const headerIndexes = collectWorkHeaderIndexes(normalizedWorkLines);

  return {
    normalizedWorkLines,
    headerIndexes,
    headerLines: headerIndexes.map((index) => ({ index, line: normalizedWorkLines[index] })),
    forcedHeaderChecks: normalizedWorkLines.map((line, index) => ({
      index,
      line,
      nextLine: normalizedWorkLines[index + 1],
      forced: isForcedWorkHeaderAt(normalizedWorkLines, index),
      titleMatch: Boolean(normalizedWorkLines[index + 1] && isLikelyWorkTitle(normalizedWorkLines[index + 1])),
      companyMatch: isLikelyCompany(line) || isLikelySchoolEmployer(line),
    })),
  };
}

export function debugParseWorkExperiences(workLines: string[], domSnapshot?: ResumeDomSnapshot): {
  normalizedWorkLines: string[];
  collectedBlocks: string[][];
  splitBlocks: string[][];
  parsedExperiences: WorkExperience[];
  normalizedExperiences: WorkExperience[];
} {
  const normalizedWorkLines = domSnapshot
    ? extractWorkLinesFromDomSnapshot(domSnapshot)
    : extractCoreWorkLines(workLines);
  const collectedBlocks = domSnapshot
    ? [normalizedWorkLines]
    : collectWorkBlocks(normalizedWorkLines);
  const splitBlocks = domSnapshot
    ? extractWorkBlocksFromDomSnapshot(domSnapshot)
    : collectedBlocks.flatMap((block) => splitNestedWorkBlocks(block));
  const parsedExperiences = splitBlocks
    .map(parseWorkBlock)
    .filter((experience) => experience.company && (experience.title || experience.start || experience.end || experience.details.length > 0));
  const normalizedExperiences = normalizeParsedWorkExperiences(parsedExperiences);

  return {
    normalizedWorkLines,
    collectedBlocks,
    splitBlocks,
    parsedExperiences,
    normalizedExperiences,
  };
}

export function reparseResumeSnapshot(bodyText: string, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): CandidateResume {
  return parseResumeText(bodyText, candidate, domSnapshot);
}

async function openResumeDetailByUrl(page: Page, candidate: CandidateListItem, deadline = createDeadline()): Promise<Page> {
  if (!candidate.resumeUrl) {
    throw new Error(`Could not open resume detail for candidate ${candidate.candidateId}`);
  }

  await page.goto(candidate.resumeUrl, { waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) });

  const bodyText = await waitForResumeDetailContent(page, candidate.candidateId, { deadline });
  if (!bodyText.includes(candidate.candidateId)) {
    throw new Error(`Resume detail did not load for candidate ${candidate.candidateId}`);
  }

  return page;
}

function isResumeDetailContent(bodyText: string, candidateId: string): boolean {
  if (!bodyText.includes(candidateId)) {
    return false;
  }

  const markers = ['在线简历', '工作经历', '教育经历'].filter((marker) => bodyText.includes(marker));
  return markers.length >= 2;
}

function createDeadline(timeoutMs = config.playwright.resumeDetailTimeoutMs): number {
  return Date.now() + Math.max(timeoutMs, 1);
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function isTimeoutLikeError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}

export const waitForResumeDetailContentRef = {
  fn: waitForResumeDetailContent,
};

async function waitForResumeDetailContent(page: Page, candidateId: string, options: { deadline?: number; timeoutMs?: number } = {}): Promise<string> {
  const deadline = options.deadline ?? createDeadline(options.timeoutMs);
  await page.waitForLoadState('domcontentloaded');

  let content = '';
  const maxAttempts = Math.max(1, Math.ceil(remainingTime(deadline) / detailContentPollIntervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    content = buildResumeContentCandidate(candidateId, await extractResumeTextSources(page));
    if (isResumeDetailContent(content, candidateId)) {
      return content;
    }

    const waitMs = Math.min(detailContentPollIntervalMs, remainingTime(deadline));
    if (waitMs <= 1) {
      break;
    }

    await page.waitForTimeout(waitMs);
  }

  content = buildResumeContentCandidate(candidateId, await extractResumeTextSources(page));
  return content;
}

async function waitForResumeDetailReadyCandidate(page: Page, candidateId: string, deadline: number): Promise<Page | null> {
  const bodyText = await waitForResumeDetailContent(page, candidateId, { deadline });
  return isResumeDetailContent(bodyText, candidateId) ? page : null;
}

async function requireResumeDetailPage(pagePromise: Promise<Page | null>): Promise<Page> {
  const page = await pagePromise;
  if (!page) {
    throw new Error('Resume detail page was not ready');
  }

  return page;
}

async function waitForResumeDetailAfterClick(
  context: BrowserContext,
  page: Page,
  candidateId: string,
  previousUrl: string,
  deadline: number,
  clickAction: () => Promise<void>,
): Promise<Page | null> {
  const popupPromise = requireResumeDetailPage(context.waitForEvent('page', { timeout: remainingTime(deadline) })
    .then(async (popup) => {
      await popup.waitForLoadState('domcontentloaded');
      const readyPage = await waitForResumeDetailReadyCandidate(popup, candidateId, deadline);
      if (!readyPage) {
        await popup.close().catch(() => undefined);
      }
      return readyPage;
    })
    .catch(() => null));
  const waitForFunction = (page as Partial<Pick<Page, 'waitForFunction'>>).waitForFunction?.bind(page);
  const currentPageNavigationPromise = waitForFunction
    ? requireResumeDetailPage(waitForFunction(
      (url) => window.location.href !== url,
      previousUrl,
      { timeout: remainingTime(deadline), polling: 100 },
    )
      .then(async () => waitForResumeDetailReadyCandidate(page, candidateId, deadline))
      .catch(() => null))
    : undefined;
  const currentPageContentPromise = requireResumeDetailPage(waitForResumeDetailReadyCandidate(page, candidateId, deadline).catch(() => null));
  const readyPromise = Promise.any([
    popupPromise,
    ...(currentPageNavigationPromise ? [currentPageNavigationPromise] : []),
    currentPageContentPromise,
  ]).catch(() => null);

  try {
    await clickAction();
  } catch (error) {
    void readyPromise.catch(() => undefined);
    throw error;
  }

  return readyPromise;
}

async function collectFrameEvidence(frame: Frame): Promise<NonNullable<ResumePageEvidence['frames']>[number]> {
  const source = await extractResumeTextSources(frame);
  const content = buildResumeContentCandidate('', source);
  const normalizedBody = content.replace(/\s+/g, ' ').trim();
  const title = await frame.title().catch(() => '');
  const markers = buildResumeMarkers(content, source.html);

  return {
    url: frame.url(),
    name: frame.name(),
    title,
    bodyLength: content.length,
    bodyPreview: normalizedBody.slice(0, 400),
    htmlLength: source.html.length,
    markers,
  };
}

export async function collectResumePageEvidence(page: Page): Promise<ResumePageEvidence> {
  await page.waitForLoadState('domcontentloaded');
  const [title, source, frames] = await Promise.all([
    page.title().catch(() => ''),
    extractResumeTextSources(page),
    Promise.all(page.frames().filter((frame) => frame !== page.mainFrame()).map((frame) => collectFrameEvidence(frame))),
  ]);
  const content = buildResumeContentCandidate('', source);
  const normalizedBody = content.replace(/\s+/g, ' ').trim();
  const markers = buildResumeMarkers(content, source.html);

  return {
    url: page.url(),
    title,
    bodyPreview: normalizedBody.slice(0, 1200),
    bodyLength: content.length,
    htmlLength: source.html.length,
    markers,
    frames: frames.length > 0 ? frames : undefined,
  };
}

export async function openResumeDetail(context: BrowserContext, page: Page, candidate: CandidateListItem): Promise<Page> {
  const deadline = createDeadline();
  const trigger = page.locator(`#no_interested_${candidate.candidateId}`).first();

  try {
    await trigger.waitFor({ state: 'visible', timeout: remainingTime(deadline) });
  } catch (error) {
    if (candidate.resumeUrl) {
      return openResumeDetailByUrl(page, candidate, deadline);
    }

    if (isTimeoutLikeError(error)) {
      throw new Error(`Could not open resume detail for candidate ${candidate.candidateId} within ${config.playwright.resumeDetailTimeoutMs}ms`);
    }

    throw new Error(`Could not open resume detail for candidate ${candidate.candidateId}`);
  }

  const card = trigger.locator('xpath=ancestor::*[contains(@class, "card") or self::li][1]');
  const clickableLocators = [
    card.locator('.user').first(),
    card.locator('.userinfo').first(),
    card.locator('.info_content').first(),
    card.locator('.info').first(),
    card.locator('.detail').first(),
    card.locator('[class*="name"]').first(),
    card.locator('[class*="job"]').first(),
    card.locator('[class*="company"]').first(),
    card,
  ];

  for (const locator of clickableLocators) {
    if (await locator.count() === 0) {
      continue;
    }

    try {
      const previousUrl = page.url();
      await page.mouse.move(10, 10);
      const detailPage = await waitForResumeDetailAfterClick(
        context,
        page,
        candidate.candidateId,
        previousUrl,
        deadline,
        () => locator.click({ timeout: remainingTime(deadline), force: true }),
      );
      if (detailPage) {
        return detailPage;
      }
    } catch {
      continue;
    }
  }

  if (candidate.resumeUrl) {
    return openResumeDetailByUrl(page, candidate, deadline);
  }

  throw new Error(`Could not open resume detail for candidate ${candidate.candidateId}`);
}

export async function getResumeDomSnapshot(page: Page): Promise<ResumeDomSnapshot | undefined> {
  await page.waitForLoadState('domcontentloaded');
  return extractResumeDomSnapshot(page);
}

export async function parseResumeDetail(page: Page, candidate: CandidateListItem): Promise<{ resume: CandidateResume; domSnapshot?: ResumeDomSnapshot }> {
  const domSnapshot = await getResumeDomSnapshot(page);
  const source = await buildRawPageSource(page);
  const extracted = await extractResumeFromCrawl4AiSource(source, candidate, domSnapshot);
  return {
    resume: extracted.resume,
    domSnapshot: extracted.domSnapshot,
  };
}
