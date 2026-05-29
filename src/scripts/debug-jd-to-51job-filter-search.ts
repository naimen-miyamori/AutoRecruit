import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { parseJobDescription } from '../parsers/jd-parser.js';
import { fiftyOneJobAdapter } from '../platforms/51job-adapter.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  type ApplicationFilterOptions,
  type ApplicationFilterSalaryRangeField,
  type ApplicationFilterTextInputField,
  validateApplicationFilterInput,
} from '../search/filter-application-options.js';
import {
  buildApplicationFilterConditions,
  runSearchSubscriptionWorkflow,
} from '../search/search-subscription.js';
import type { NormalizedJob, SearchSubscriptionSummary } from '../types/job.js';

interface DebugJdTo51jobFilterSearchInput {
  jdFilePath: string;
  keyword?: string;
  optionsPath?: string;
  outputPath?: string;
}

interface AppliedMapping {
  fieldId: string;
  label: string;
  value: unknown;
  reason: string;
}

interface SkippedMapping {
  fieldId: string;
  label: string;
  reason: string;
}

interface BuildFilterInputResult {
  applicationFilterInput: Record<string, unknown>;
  appliedMappings: AppliedMapping[];
  skippedMappings: SkippedMapping[];
}

interface DebugJdTo51jobFilterSearchSummary {
  platform: SupportedPlatform;
  jdFilePath: string;
  optionsPath: string;
  keyword: string;
  normalizedJob: NormalizedJob;
  applicationFilterInput: Record<string, unknown>;
  appliedMappings: AppliedMapping[];
  skippedMappings: SkippedMapping[];
  searchSummary: SearchSubscriptionSummary;
  outputPath?: string;
}

const platform: SupportedPlatform = '51job';

function parseArgs(argv: readonly string[]): DebugJdTo51jobFilterSearchInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    jdFilePath: values.get('jd-file') ?? 'jd.txt',
    keyword: values.get('keyword'),
    optionsPath: values.get('application-filter-options'),
    outputPath: values.get('output'),
  };
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function compactText(...parts: Array<string | undefined>): string {
  return parts.map((part) => normalizeText(part)).filter(Boolean).join(' ');
}

function buildDefaultOptionsPath(): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function setMappedValue(
  options: ApplicationFilterOptions,
  input: Record<string, unknown>,
  appliedMappings: AppliedMapping[],
  fieldId: string,
  value: unknown,
  reason: string,
): void {
  const field = options.fieldsById[fieldId];
  if (!field) {
    return;
  }

  input[fieldId] = value;
  appliedMappings.push({
    fieldId,
    label: field.label,
    value,
    reason,
  });
}

function skipMappedValue(
  options: ApplicationFilterOptions,
  skippedMappings: SkippedMapping[],
  fieldId: string,
  reason: string,
): void {
  const field = options.fieldsById[fieldId];
  if (!field) {
    return;
  }

  skippedMappings.push({
    fieldId,
    label: field.label,
    reason,
  });
}

function hasAllowedValue(options: ApplicationFilterOptions, fieldId: string, value: string): boolean {
  const field = options.fieldsById[fieldId];
  return Boolean(field && 'allowedValues' in field && field.allowedValues.includes(value));
}

function chooseWorkYearsValue(experienceYearsMin: number | undefined): string | undefined {
  if (experienceYearsMin === undefined) {
    return undefined;
  }

  if (experienceYearsMin <= 0) {
    return '无经验';
  }

  if (experienceYearsMin <= 3) {
    return '1-3年';
  }

  if (experienceYearsMin <= 5) {
    return '3-5年';
  }

  if (experienceYearsMin <= 10) {
    return '5-10年';
  }

  return '10年及以上';
}

function chooseEducationValue(education: string | undefined): string | undefined {
  const text = normalizeText(education);
  if (!text) {
    return undefined;
  }

  if (/硕士|研究生|博士/.test(text)) {
    return '硕士及以上';
  }

  if (/本科|学士/.test(text)) {
    return '本科及以上';
  }

  if (/大专|专科|高职/.test(text)) {
    return '大专及以上';
  }

  return undefined;
}

function chooseLanguageValue(job: NormalizedJob): string | undefined {
  const text = compactText(...job.languageRequirements);
  if (!text) {
    return undefined;
  }

  if (/四级|CET-?4/i.test(text)) {
    return '大学英语四级及以上';
  }

  if (/六级|CET-?6/i.test(text)) {
    return '大学英语六级及以上';
  }

  if (/英语|英文/.test(text)) {
    if (/流利|精通|熟练.*听|听说读写/.test(text)) {
      return '听说读写流利（精通）';
    }

    if (/读写|书面|口头|熟练/.test(text)) {
      return '读写熟练（良好/熟练）';
    }

    return '简单沟通/读写（一般）';
  }

  if (/普通话/.test(text)) {
    return '普通话';
  }

  return undefined;
}

function chooseFirstAllowedTextValue(
  field: ApplicationFilterTextInputField,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates.map(normalizeText).filter(Boolean)) {
    if (field.allowedValues.includes(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function chooseIndustryValue(field: ApplicationFilterTextInputField, job: NormalizedJob): string | undefined {
  const text = compactText(job.title, ...job.industryTags, ...job.hardRequirements, ...job.responsibilities);
  const candidates: string[] = [];

  if (/服装|纺织|皮革/.test(text)) {
    candidates.push('服装');
  }
  if (/零售|门店|店铺|店长|收银|导购|新零售/.test(text)) {
    candidates.push('批发/零售', '新零售', '交通/物流/贸易/零售');
  }
  if (/玩具|礼品|赠品/.test(text)) {
    candidates.push('玩具/礼品');
  }
  if (/消费品/.test(text)) {
    candidates.push('消费品');
  }

  return chooseFirstAllowedTextValue(field, candidates);
}

function chooseFunctionValue(field: ApplicationFilterTextInputField, job: NormalizedJob): string | undefined {
  const text = compactText(job.title, ...job.hardRequirements, ...job.responsibilities);
  const candidates: string[] = [];

  if (/店长|门店.*经理|店铺.*经理/.test(text)) {
    candidates.push('门店经理/店长');
  }
  if (/门店销售|商品介绍|收银|导购/.test(text)) {
    candidates.push('门店销售');
  }
  if (/销售管理|销售指标|销售意识|销售技巧/.test(text)) {
    candidates.push('销售经理', '销售高级管理');
  }
  if (/零售|门店|店铺/.test(text)) {
    candidates.push('生活服务/零售');
  }

  return chooseFirstAllowedTextValue(field, candidates);
}

function chooseLocationValue(field: ApplicationFilterTextInputField, job: NormalizedJob): string | undefined {
  const text = compactText(job.location, ...job.regionPreferences, ...job.hardRequirements, ...job.responsibilities);
  const candidates: string[] = [];

  if (/上海|环贸|世博天地|世博/.test(text)) {
    candidates.push('上海');
  }
  if (/深圳/.test(text)) {
    candidates.push('深圳');
  }
  if (/北京/.test(text)) {
    candidates.push('北京');
  }
  if (/广州/.test(text)) {
    candidates.push('广州');
  }
  if (/杭州/.test(text)) {
    candidates.push('杭州');
  }

  return chooseFirstAllowedTextValue(field, candidates);
}

function salaryNumberToOption(value: number, field: ApplicationFilterSalaryRangeField, side: 'min' | 'max'): string | undefined {
  const options = side === 'min' ? field.minOptions : field.maxOptions;
  const normalizedValue = value >= 1000 ? value / 1000 : value;
  const candidate = normalizedValue >= 10
    ? `${Number((normalizedValue / 10).toFixed(1)).toString().replace(/\.0$/, '')}万`
    : `${Number(normalizedValue.toFixed(1)).toString().replace(/\.0$/, '')}千`;

  return options.includes(candidate) ? candidate : undefined;
}

function chooseSalaryValue(field: ApplicationFilterSalaryRangeField, job: NormalizedJob): { min: string; max: string } | undefined {
  const min = typeof job.salaryRange?.min === 'number'
    ? salaryNumberToOption(job.salaryRange.min, field, 'min')
    : undefined;
  const max = typeof job.salaryRange?.max === 'number'
    ? salaryNumberToOption(job.salaryRange.max, field, 'max')
    : undefined;

  if (!min || !max) {
    return undefined;
  }

  return { min, max };
}

function buildApplicationFilterInput(options: ApplicationFilterOptions, job: NormalizedJob): BuildFilterInputResult {
  const applicationFilterInput: Record<string, unknown> = {};
  const appliedMappings: AppliedMapping[] = [];
  const skippedMappings: SkippedMapping[] = [];

  const workYears = chooseWorkYearsValue(job.experienceYearsMin);
  if (workYears && hasAllowedValue(options, 'work_years', workYears)) {
    skipMappedValue(options, skippedMappings, 'work_years', 'JD 工作年限可映射，但 51job 单选/自定义页面状态仍不稳定，调试链路默认不提交。');
  } else {
    skipMappedValue(options, skippedMappings, 'work_years', 'JD 未解析出可稳定映射的最低工作年限。');
  }

  const education = chooseEducationValue(job.education);
  if (education && hasAllowedValue(options, 'education', education)) {
    skipMappedValue(options, skippedMappings, 'education', 'JD 学历可映射，但容易过度收窄结果，调试链路默认不提交。');
  } else {
    skipMappedValue(options, skippedMappings, 'education', 'JD 未解析出可稳定映射的学历。');
  }

  const language = chooseLanguageValue(job);
  if (language && hasAllowedValue(options, 'language', language)) {
    setMappedValue(options, applicationFilterInput, appliedMappings, 'language', language, `JD languageRequirements=${job.languageRequirements.join('；')}`);
  } else {
    skipMappedValue(options, skippedMappings, 'language', 'JD 未解析出可稳定映射的语言要求。');
  }

  for (const fieldId of ['expected_industry']) {
    const field = options.fieldsById[fieldId];
    if (field?.kind !== 'textInput') {
      continue;
    }

    const industry = chooseIndustryValue(field, job);
    if (industry) {
      setMappedValue(options, applicationFilterInput, appliedMappings, fieldId, industry, `JD industryTags=${job.industryTags.join('；')}`);
    } else {
      skipMappedValue(options, skippedMappings, fieldId, 'JD 行业信息未命中选项池。');
    }
  }

  for (const fieldId of ['expected_function']) {
    const field = options.fieldsById[fieldId];
    if (field?.kind !== 'textInput') {
      continue;
    }

    const jobFunction = chooseFunctionValue(field, job);
    if (jobFunction) {
      setMappedValue(options, applicationFilterInput, appliedMappings, fieldId, jobFunction, `JD title=${job.title}`);
    } else {
      skipMappedValue(options, skippedMappings, fieldId, 'JD 职能信息未命中选项池。');
    }
  }
  skipMappedValue(options, skippedMappings, 'engaged_function', '已用同一 JD 职能填入期望职能；不重复填从事职能，避免把搜索条件过度收窄。');

  skipMappedValue(options, skippedMappings, 'engaged_industry', '已用同一 JD 行业填入期望行业；不重复填从事行业，避免把搜索条件过度收窄。');

  const expectedLocationField = options.fieldsById.expected_location;
  if (expectedLocationField?.kind === 'textInput') {
    const location = chooseLocationValue(expectedLocationField, job);
    if (location) {
      skipMappedValue(options, skippedMappings, 'expected_location', 'JD 工作地点可映射，但城市弹层选中态与回填不稳定，调试链路默认不提交。');
    } else {
      skipMappedValue(options, skippedMappings, 'expected_location', 'JD 工作地点未命中选项池。');
    }
  }

  const salaryField = options.fieldsById.expected_salary;
  if (salaryField?.kind === 'salaryRange') {
    const salary = chooseSalaryValue(salaryField, job);
    if (salary) {
      skipMappedValue(options, skippedMappings, 'expected_salary', 'JD 薪资可映射，但期望月薪页面回填仍需单独验证，调试链路默认不提交。');
    } else {
      skipMappedValue(options, skippedMappings, 'expected_salary', 'JD 薪资未解析为可用的 51job 下限/上限选项。');
    }
  }

  return {
    applicationFilterInput,
    appliedMappings,
    skippedMappings,
  };
}

async function runDebugJdTo51jobFilterSearch(
  input: DebugJdTo51jobFilterSearchInput,
): Promise<DebugJdTo51jobFilterSearchSummary> {
  const jdFilePath = path.resolve(input.jdFilePath);
  const optionsPath = path.resolve(input.optionsPath ?? buildDefaultOptionsPath());
  const [jdText, applicationOptions] = await Promise.all([
    fs.readFile(jdFilePath, 'utf8'),
    readJsonFile<ApplicationFilterOptions>(optionsPath),
  ]);

  if (applicationOptions.platform !== platform) {
    throw new Error(`Application filter options platform mismatch: expected ${platform}, got ${applicationOptions.platform}`);
  }

  const normalizedJob = await parseJobDescription(jdText);
  const keyword = normalizeText(input.keyword) || normalizedJob.title;
  if (!keyword) {
    throw new Error('Unable to determine keyword from --keyword or parsed JD title.');
  }

  const {
    applicationFilterInput,
    appliedMappings,
    skippedMappings,
  } = buildApplicationFilterInput(applicationOptions, normalizedJob);
  const validation = validateApplicationFilterInput(applicationOptions, applicationFilterInput);
  if (!validation.ok) {
    throw new Error(`Generated applicationFilterInput is invalid: ${validation.errors.map((error) => `${error.fieldId}:${error.code}`).join(', ')}`);
  }

  const conditions = await buildApplicationFilterConditions(platform, applicationFilterInput, {
    platform,
    applicationFilterOptionsPath: optionsPath,
  });
  const session = await ensureAuthenticatedBrowserSession(platform);

  try {
    const searchSummary = await runSearchSubscriptionWorkflow(fiftyOneJobAdapter, session.page, {
      keyword,
      conditions,
    }, {
      save: false,
    });

    const summary: DebugJdTo51jobFilterSearchSummary = {
      platform,
      jdFilePath,
      optionsPath,
      keyword,
      normalizedJob,
      applicationFilterInput,
      appliedMappings,
      skippedMappings,
      searchSummary,
    };

    if (input.outputPath) {
      const outputPath = path.resolve(input.outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      summary.outputPath = outputPath;
      await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }

    return summary;
  } finally {
    await closeBrowserSession(session);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runDebugJdTo51jobFilterSearch(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
