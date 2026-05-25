import { z } from 'zod';
import { config } from '../config.js';
import { completeJsonTextFromOpenAI } from '../llm/openai-client.js';
import { AgeRange, NormalizedJob, SalaryRange } from '../types/job.js';

const salaryRangeSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().optional(),
  period: z.string().optional(),
  raw: z.string().optional(),
});

const ageRangeSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  raw: z.string().optional(),
});

const normalizedJobPayloadSchema = z.object({
  title: z.string(),
  location: z.string().optional(),
  department: z.string().optional(),
  salaryRange: salaryRangeSchema.optional(),
  ageRange: ageRangeSchema.optional(),
  education: z.string().optional(),
  majors: z.array(z.string()),
  languageRequirements: z.array(z.string()),
  responsibilities: z.array(z.string()),
  hardRequirements: z.array(z.string()),
  preferredRequirements: z.array(z.string()),
  experienceYearsMin: z.number().optional(),
  regionPreferences: z.array(z.string()),
  industryTags: z.array(z.string()),
});

function sanitizeString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeStringList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function sanitizeSalaryRange(range?: SalaryRange): SalaryRange | undefined {
  if (!range) {
    return undefined;
  }

  const next: SalaryRange = {
    min: typeof range.min === 'number' ? range.min : undefined,
    max: typeof range.max === 'number' ? range.max : undefined,
    currency: sanitizeString(range.currency),
    period: sanitizeString(range.period),
    raw: sanitizeString(range.raw),
  };

  return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

function sanitizeAgeRange(range?: AgeRange): AgeRange | undefined {
  if (!range) {
    return undefined;
  }

  const next: AgeRange = {
    min: typeof range.min === 'number' ? range.min : undefined,
    max: typeof range.max === 'number' ? range.max : undefined,
    raw: sanitizeString(range.raw),
  };

  return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

function sanitizeNormalizedJob(job: NormalizedJob): NormalizedJob {
  return {
    title: sanitizeString(job.title) ?? '',
    location: sanitizeString(job.location),
    department: sanitizeString(job.department),
    salaryRange: sanitizeSalaryRange(job.salaryRange),
    ageRange: sanitizeAgeRange(job.ageRange),
    education: sanitizeString(job.education),
    majors: sanitizeStringList(job.majors),
    languageRequirements: sanitizeStringList(job.languageRequirements),
    responsibilities: sanitizeStringList(job.responsibilities),
    hardRequirements: sanitizeStringList(job.hardRequirements),
    preferredRequirements: sanitizeStringList(job.preferredRequirements),
    experienceYearsMin: typeof job.experienceYearsMin === 'number' && job.experienceYearsMin >= 0
      ? job.experienceYearsMin
      : undefined,
    regionPreferences: sanitizeStringList(job.regionPreferences),
    industryTags: sanitizeStringList(job.industryTags),
  };
}

function parseNormalizedJobPayload(rawText: string): NormalizedJob {
  return normalizedJobPayloadSchema.parse(JSON.parse(rawText));
}

export function extractJsonObjectFromModelText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('JD parsing model returned empty text content');
  }

  try {
    parseNormalizedJobPayload(trimmed);
    return trimmed;
  } catch {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const fencedContent = fencedMatch?.[1]?.trim();
    if (fencedContent) {
      parseNormalizedJobPayload(fencedContent);
      return fencedContent;
    }
  }

  throw new Error('JD parsing model did not return parseable JSON text');
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildJobKey(searchKeyword: string, title: string): string {
  const normalizedKeyword = slugify(searchKeyword);
  if (normalizedKeyword) {
    return normalizedKeyword;
  }

  return slugify(title);
}

export function extractNormalizedJobFromTextResponse(response: { output_text: string }): NormalizedJob {
  const jsonText = extractJsonObjectFromModelText(response.output_text);
  return sanitizeNormalizedJob(parseNormalizedJobPayload(jsonText));
}

export async function parseJobDescription(rawText: string): Promise<NormalizedJob> {
  if (!config.openai.apiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }

  const responseText = await completeJsonTextFromOpenAI({
    featureName: 'JD parsing',
    modelEnvName: 'JD_PARSING_MODEL',
    input: [
      'JD 原文：',
      rawText,
    ].join('\n'),
    instructions: [
      '请把下面的中文招聘 JD 解析成一个 JSON 对象。',
      '只返回 JSON，不要解释，不要 markdown，不要代码块，不要前后缀文本。',
      '要求：',
      '1. 只提取文本中明确出现或可稳健归纳的信息。',
      '2. 不要编造未出现的字段。',
      '3. title 必须提取职位标题；如果首行就是职位名，直接用首行。',
      '4. responsibilities、hardRequirements、preferredRequirements 必须输出为字符串数组。',
      '5. majors、languageRequirements、regionPreferences、industryTags 也必须输出为字符串数组。',
      '6. languageRequirements 提取语言要求原文。',
      '7. regionPreferences 提取地域偏好，如东南亚、泰国、越南、马来西亚、印尼、新加坡。',
      '8. industryTags 提取行业或业务标签，如阀门、化工、半导体、数据中心、销售等。',
      '9. 保留中文原文表达，避免无根据改写。',
    ].join('\n'),
    maxOutputTokens: 1600,
  });

  return extractNormalizedJobFromTextResponse({ output_text: responseText });
}
