import type { BossPositionDetail } from '../../../types/boss.js';
import type { AgeRange, NormalizedJob, SalaryRange } from '../../../types/job.js';

export const BOSS_PAGE_RULES_NORMALIZATION = {
  kind: 'boss-page-rules',
  version: 2,
} as const;

type JdSection = 'responsibilities' | 'hardRequirements' | 'preferredRequirements';

interface ParsedSections {
  responsibilities: string[];
  hardRequirements: string[];
  preferredRequirements: string[];
}

interface HeadingMatch {
  section?: JdSection;
  inlineText?: string;
}

const SECTION_HEADINGS: Array<{ section: JdSection; labels: readonly string[] }> = [
  {
    section: 'responsibilities',
    labels: ['岗位职责', '职位职责', '工作职责', '职位描述', '工作内容', '职责描述', '主要职责', '岗位工作内容', '工作任务'],
  },
  {
    section: 'hardRequirements',
    labels: ['任职资格', '任职要求', '岗位要求', '职位要求', '基本要求', '招聘要求', '职位资格'],
  },
  {
    section: 'preferredRequirements',
    labels: ['优先条件', '优先任职条件', '加分项', '优先考虑'],
  },
];

const NON_REQUIREMENT_HEADINGS = [
  '薪资待遇', '薪酬待遇', '福利待遇', '薪资福利', '福利', '工作地址', '工作地点', '工作时间',
  '公司介绍', '公司简介', '职位亮点', '联系我们', '其他说明', '补充说明',
];

const LANGUAGE_PATTERN = /(?:英语|日语|韩语|德语|法语|西班牙语|俄语|阿拉伯语|粤语|普通话)/;

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)))];
}

function stripListPrefix(value: string): string {
  return value
    .replace(/^\s*(?:[-*•▪·]|[（(]?(?:\d{1,3}|[一二三四五六七八九十]+)[）).、．])\s*/, '')
    .trim();
}

function parseHeading(value: string): HeadingMatch | undefined {
  const line = stripListPrefix(value);
  const bracketed = line.match(/^【\s*([^】]+?)\s*】\s*(?:[:：]\s*(.*))?$/);
  const bracketedLabel = bracketed?.[1]?.trim();
  const bracketedInlineText = bracketed?.[2]?.trim() || undefined;
  for (const entry of SECTION_HEADINGS) {
    for (const label of entry.labels) {
      if (bracketedLabel === label) {
        return { section: entry.section, inlineText: bracketedInlineText };
      }
      if (line === label) return { section: entry.section };
      if (line.startsWith(`${label}：`) || line.startsWith(`${label}:`)) {
        return { section: entry.section, inlineText: line.slice(label.length + 1).trim() || undefined };
      }
    }
  }

  for (const label of NON_REQUIREMENT_HEADINGS) {
    if (bracketedLabel === label) return {};
    if (line === label || line.startsWith(`${label}：`) || line.startsWith(`${label}:`)) {
      return {};
    }
  }

  return undefined;
}

function parseSections(rawJd: string): ParsedSections {
  const sections: ParsedSections = {
    responsibilities: [],
    hardRequirements: [],
    preferredRequirements: [],
  };
  let current: JdSection | undefined;

  for (const rawLine of rawJd.replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n').split('\n')) {
    const line = normalizeText(rawLine);
    if (!line) continue;

    const heading = parseHeading(line);
    if (heading) {
      current = heading.section;
      if (current && heading.inlineText) {
        sections[current].push(stripListPrefix(heading.inlineText));
      }
      continue;
    }

    if (current) {
      const item = stripListPrefix(line);
      if (item) sections[current].push(item);
    }
  }

  return {
    responsibilities: uniqueStrings(sections.responsibilities),
    hardRequirements: uniqueStrings(sections.hardRequirements),
    preferredRequirements: uniqueStrings(sections.preferredRequirements),
  };
}

function splitExplicitPreferredRequirements(sections: ParsedSections): ParsedSections {
  const preferredFromRequirements: string[] = [];
  const hardRequirements: string[] = [];
  for (const requirement of sections.hardRequirements) {
    if (!/(?:优先|加分)/.test(requirement)) {
      hardRequirements.push(requirement);
      continue;
    }

    const split = requirement.match(/^(.*?)(?:[，,；;]\s*)((?:[^，,；;]*?(?:优先|加分)[^，,；;]*))$/);
    if (split) {
      const baseRequirement = normalizeText(split[1]);
      const preferredRequirement = normalizeText(split[2]);
      if (baseRequirement) hardRequirements.push(baseRequirement);
      if (preferredRequirement) preferredFromRequirements.push(preferredRequirement);
    } else {
      preferredFromRequirements.push(requirement);
    }
  }

  return {
    responsibilities: sections.responsibilities,
    hardRequirements,
    preferredRequirements: uniqueStrings([...sections.preferredRequirements, ...preferredFromRequirements]),
  };
}

function singleValue<T>(values: readonly T[], key: (value: T) => string): T | undefined {
  const distinct = new Map(values.map((value) => [key(value), value]));
  return distinct.size === 1 ? distinct.values().next().value : undefined;
}

function extractEducation(requirements: readonly string[]): string | undefined {
  const values = requirements.flatMap((requirement) => {
    const matches = requirement.matchAll(/(?:博士|硕士|本科|大专|中专(?:\/中技)?|高中)(?:及以上|以上)?(?:学历)?/g);
    return [...matches].map((match) => match[0]);
  });
  return singleValue(uniqueStrings(values), (value) => value);
}

function extractExperienceYearsMin(requirements: readonly string[]): number | undefined {
  const values = requirements.flatMap((requirement) => {
    if (!/(?:经验|经历|从业|工作)/.test(requirement)) return [];
    const matches = requirement.matchAll(/(\d{1,2})\s*(?:[-~～至到]\s*\d{1,2})?\s*年(?=[^。；，,]{0,48}(?:经验|经历|从业|工作))/g);
    return [...matches].map((match) => Number.parseInt(match[1]!, 10));
  });
  return singleValue([...new Set(values)], (value) => String(value));
}

function extractAgeRange(requirements: readonly string[]): AgeRange | undefined {
  const values: AgeRange[] = [];
  for (const requirement of requirements) {
    const range = requirement.match(/(?:年龄|年纪)\s*(?:要求)?\s*[:：]?\s*(\d{1,2})\s*(?:-|~|～|至|到)\s*(\d{1,2})\s*岁/);
    if (range) {
      values.push({ min: Number.parseInt(range[1]!, 10), max: Number.parseInt(range[2]!, 10), raw: range[0] });
      continue;
    }

    const minimum = requirement.match(/(?:年龄|年纪)\s*(?:要求)?\s*[:：]?\s*(\d{1,2})\s*岁\s*(?:及以上|以上)/);
    if (minimum) {
      values.push({ min: Number.parseInt(minimum[1]!, 10), raw: minimum[0] });
      continue;
    }

    const maximum = requirement.match(/(?:年龄|年纪)\s*(?:要求)?\s*[:：]?\s*(\d{1,2})\s*岁\s*(?:及以下|以下)/);
    if (maximum) values.push({ max: Number.parseInt(maximum[1]!, 10), raw: maximum[0] });
  }

  return singleValue(values, (value) => `${value.min ?? ''}-${value.max ?? ''}-${value.raw ?? ''}`);
}

function extractSalaryRange(detail: BossPositionDetail): SalaryRange | undefined {
  const pageSalary = normalizeText(detail.salaryText);
  if (pageSalary) return { raw: pageSalary };

  const rawSalary = detail.rawJd
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => normalizeText(line))
    .find((line): line is string => Boolean(line && /^(?:薪资|薪酬|待遇|月薪)(?:范围|标准)?\s*[:：]/.test(line)));
  return rawSalary ? { raw: rawSalary } : undefined;
}

function extractLanguageRequirements(requirements: readonly string[]): string[] {
  return uniqueStrings(requirements.filter((requirement) => LANGUAGE_PATTERN.test(requirement)));
}

/**
 * Converts only page-backed fields and explicit JD sections into a normalized Boss job.
 * Ambiguous or unstructured information is deliberately left empty instead of inferred.
 */
export function normalizeBossPositionDetail(detail: BossPositionDetail): NormalizedJob {
  const sections = splitExplicitPreferredRequirements(parseSections(detail.rawJd));
  const allRequirements = [...sections.hardRequirements, ...sections.preferredRequirements];

  return {
    title: detail.name,
    location: normalizeText(detail.location),
    department: normalizeText(detail.department),
    salaryRange: extractSalaryRange(detail),
    ageRange: extractAgeRange(sections.hardRequirements),
    education: extractEducation(sections.hardRequirements),
    majors: [],
    languageRequirements: extractLanguageRequirements(allRequirements),
    responsibilities: sections.responsibilities,
    hardRequirements: sections.hardRequirements,
    preferredRequirements: sections.preferredRequirements,
    experienceYearsMin: extractExperienceYearsMin(sections.hardRequirements),
    regionPreferences: [],
    industryTags: [],
  };
}
