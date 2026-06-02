import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import type { ApplicationFilterOptions } from '../search/filter-application-options.js';
import {
  buildLiepinApplicationFilterOptionVerificationCases,
  parseArgs,
  verifyLiepinApplicationFilterOptions,
} from './verify-liepin-application-filter-options.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-liepin-option-verify-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createLiepinApplicationOptions(): ApplicationFilterOptions {
  return {
    platform: 'liepin',
    capturedAt: '2026-06-01T12:00:00.000Z',
    keyword: '优衣库',
    fieldCount: 7,
    fieldIds: [
      'work_years',
      'recruitment_type',
      'keyword_title',
      'company_name',
      'expected_industry',
      'expected_salary',
      'age',
    ],
    fieldIdByLabel: {
      工作经验: 'work_years',
      统招要求: 'recruitment_type',
      职位名称: 'keyword_title',
      公司名称: 'company_name',
      期望行业: 'expected_industry',
      期望薪资: 'expected_salary',
      年龄: 'age',
    },
    groups: {
      singleSelect: ['work_years', 'recruitment_type'],
      textInput: ['keyword_title', 'company_name', 'expected_industry'],
      salaryRange: ['expected_salary'],
      numberRange: ['age'],
    },
    fieldsById: {
      work_years: {
        fieldId: 'work_years',
        filterKey: 'work-years-filter',
        label: '工作经验',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string'],
        allowedValues: ['不限', '1-3年', '3-5年'],
        options: [
          { label: '不限', value: '不限', disabled: false, selected: false },
          { label: '1-3年', value: '1-3年', disabled: false, selected: false },
          { label: '3-5年', value: '3-5年', disabled: false, selected: false },
        ],
      },
      recruitment_type: {
        fieldId: 'recruitment_type',
        filterKey: 'recruitment-type-filter',
        label: '统招要求',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string'],
        allowedValues: ['统招/非统招（不限）'],
        options: [
          { label: '统招/非统招（不限）', value: '统招/非统招（不限）', disabled: false, selected: false },
        ],
      },
      keyword_title: {
        fieldId: 'keyword_title',
        filterKey: 'keyword-title-filter',
        label: '职位名称',
        kind: 'textInput',
        semanticKind: 'other',
        scope: 'other',
        restrictInput: false,
        valueShape: 'string|string[]',
        acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: ['请输入职位名称'],
        rootValues: ['请输入职位名称'],
        valuesByDepth: [{ depth: 0, values: ['请输入职位名称'] }],
        tree: [],
      },
      company_name: {
        fieldId: 'company_name',
        filterKey: 'company-name-filter',
        label: '公司名称',
        kind: 'textInput',
        semanticKind: 'other',
        scope: 'other',
        restrictInput: false,
        valueShape: 'string|string[]',
        acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: ['请输入公司名称'],
        rootValues: ['请输入公司名称'],
        valuesByDepth: [{ depth: 0, values: ['请输入公司名称'] }],
        tree: [],
      },
      expected_industry: {
        fieldId: 'expected_industry',
        filterKey: 'expected-industry-filter',
        label: '期望行业',
        kind: 'textInput',
        semanticKind: 'industry',
        scope: 'expected',
        restrictInput: true,
        valueShape: 'string|string[]',
        acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: ['不限', '电子商务', '新零售', '服装/纺织/皮革'],
        rootValues: ['AI/互联网/IT', '消费品'],
        valuesByDepth: [
          { depth: 1, values: ['不限', '电子商务', '新零售', '服装/纺织/皮革'] },
        ],
        tree: [
          {
            key: 'AI/互联网/IT',
            label: 'AI/互联网/IT',
            depth: 0,
            pathLabels: ['AI/互联网/IT'],
            children: [
              { key: 'AI/互联网/IT\u0000不限', label: '不限', depth: 1, pathLabels: ['AI/互联网/IT', '不限'], children: [] },
              { key: 'AI/互联网/IT\u0000电子商务', label: '电子商务', depth: 1, pathLabels: ['AI/互联网/IT', '电子商务'], children: [] },
              { key: 'AI/互联网/IT\u0000新零售', label: '新零售', depth: 1, pathLabels: ['AI/互联网/IT', '新零售'], children: [] },
            ],
          },
          {
            key: '消费品',
            label: '消费品',
            depth: 0,
            pathLabels: ['消费品'],
            children: [
              { key: '消费品\u0000不限', label: '不限', depth: 1, pathLabels: ['消费品', '不限'], children: [] },
              { key: '消费品\u0000服装/纺织/皮革', label: '服装/纺织/皮革', depth: 1, pathLabels: ['消费品', '服装/纺织/皮革'], children: [] },
            ],
          },
        ],
      },
      expected_salary: {
        fieldId: 'expected_salary',
        filterKey: 'expected-salary-filter',
        label: '期望薪资',
        kind: 'salaryRange',
        restrictInput: true,
        valueShape: 'object',
        acceptedInputShapes: ['{ min: string; max: string }'],
        minKey: 'min',
        maxKey: 'max',
        minLabel: '薪资下限',
        maxLabel: '薪资上限',
        orderedValues: ['不限', '10万', '20万'],
        minOptions: ['不限', '10万', '20万'],
        maxOptions: ['不限', '10万', '20万'],
        rule: {
          kind: 'orderedRange',
          comparison: 'maxSalaryValue >= minSalaryValue',
          message: '右侧薪资上限不能低于左侧薪资下限。',
        },
      },
      age: {
        fieldId: 'age',
        filterKey: 'age-filter',
        label: '年龄',
        kind: 'numberRange',
        restrictInput: true,
        valueShape: 'object',
        acceptedInputShapes: ['{ min?: number|string; max?: number|string }'],
        minKey: 'min',
        maxKey: 'max',
        minLabel: '年龄下限',
        maxLabel: '年龄上限',
        unit: '岁',
        min: 20,
        max: 30,
        orderedValues: ['20岁', '25岁', '30岁'],
        minOptions: ['20岁', '25岁', '30岁'],
        maxOptions: ['20岁', '25岁', '30岁'],
        rule: {
          kind: 'orderedRange',
          comparison: 'maxNumberValue >= minNumberValue',
          message: '右侧年龄上限不能低于左侧年龄下限。',
        },
      },
    },
  };
}

test('verify Liepin filter options parseArgs defaults to dry-run', () => {
  assert.deepEqual(parseArgs([]), {
    keyword: undefined,
    optionsPath: undefined,
    outputPath: undefined,
    run: false,
    offset: 0,
    limit: undefined,
    fieldIds: undefined,
    includeDefaults: true,
    includeRangeCombinations: false,
    includePolicySkips: true,
    stopOnFailure: false,
    freeTextSamples: {
      keyword_title: '店长',
      company_name: '迅销',
      school_name: '辽宁大学',
      major: '新闻学',
    },
  });

  assert.deepEqual(parseArgs([
    '--keyword', '优衣库',
    '--run', 'true',
    '--offset', '3',
    '--limit', '5',
    '--field', 'work_years,company_name',
    '--include-defaults', 'false',
    '--include-range-combinations', 'true',
    '--include-policy-skips', 'false',
    '--stop-on-failure', 'true',
    '--free-text-samples', '{"company_name":"迅销集团"}',
  ]), {
    keyword: '优衣库',
    optionsPath: undefined,
    outputPath: undefined,
    run: true,
    offset: 3,
    limit: 5,
    fieldIds: ['work_years', 'company_name'],
    includeDefaults: false,
    includeRangeCombinations: true,
    includePolicySkips: false,
    stopOnFailure: true,
    freeTextSamples: {
      keyword_title: '店长',
      company_name: '迅销集团',
      school_name: '辽宁大学',
      major: '新闻学',
    },
  });
});

test('verify Liepin filter options builds single-field cases with policy skips', () => {
  const cases = buildLiepinApplicationFilterOptionVerificationCases(createLiepinApplicationOptions(), parseArgs([
    '--include-defaults', 'false',
  ]));

  assert.deepEqual(cases.map((testCase) => ({
    caseId: testCase.caseId,
    fieldId: testCase.fieldId,
    valueLabel: testCase.valueLabel,
    runnable: testCase.runnable,
    skipReason: testCase.skipReason,
    input: testCase.applicationFilterInput,
  })), [
    {
      caseId: 'work_years-000-1-3年',
      fieldId: 'work_years',
      valueLabel: '1-3年',
      runnable: true,
      skipReason: undefined,
      input: { work_years: '1-3年' },
    },
    {
      caseId: 'work_years-001-3-5年',
      fieldId: 'work_years',
      valueLabel: '3-5年',
      runnable: true,
      skipReason: undefined,
      input: { work_years: '3-5年' },
    },
    {
      caseId: 'keyword_title-000-店长',
      fieldId: 'keyword_title',
      valueLabel: '店长',
      runnable: false,
      skipReason: '`keyword_title` is controlled by the search-subscription keyword input, not replayed as applicationFilter.',
      input: { keyword_title: '店长' },
    },
    {
      caseId: 'company_name-000-迅销',
      fieldId: 'company_name',
      valueLabel: '迅销',
      runnable: true,
      skipReason: undefined,
      input: { company_name: '迅销' },
    },
    {
      caseId: 'expected_industry-000-AI-互联网-IT-电子商务',
      fieldId: 'expected_industry',
      valueLabel: 'AI/互联网/IT > 电子商务',
      runnable: true,
      skipReason: undefined,
      input: {
        expected_industry: {
          value: '电子商务',
          pathLabels: ['AI/互联网/IT', '电子商务'],
        },
      },
    },
    {
      caseId: 'expected_industry-001-AI-互联网-IT-新零售',
      fieldId: 'expected_industry',
      valueLabel: 'AI/互联网/IT > 新零售',
      runnable: true,
      skipReason: undefined,
      input: {
        expected_industry: {
          value: '新零售',
          pathLabels: ['AI/互联网/IT', '新零售'],
        },
      },
    },
    {
      caseId: 'expected_industry-002-消费品-服装-纺织-皮革',
      fieldId: 'expected_industry',
      valueLabel: '消费品 > 服装/纺织/皮革',
      runnable: true,
      skipReason: undefined,
      input: {
        expected_industry: {
          value: '服装/纺织/皮革',
          pathLabels: ['消费品', '服装/纺织/皮革'],
        },
      },
    },
    {
      caseId: 'expected_salary-000-10万-10万',
      fieldId: 'expected_salary',
      valueLabel: '10万-10万',
      runnable: true,
      skipReason: undefined,
      input: { expected_salary: { min: '10万', max: '10万' } },
    },
    {
      caseId: 'expected_salary-001-10万-20万',
      fieldId: 'expected_salary',
      valueLabel: '10万-20万',
      runnable: true,
      skipReason: undefined,
      input: { expected_salary: { min: '10万', max: '20万' } },
    },
    {
      caseId: 'expected_salary-002-20万-20万',
      fieldId: 'expected_salary',
      valueLabel: '20万-20万',
      runnable: true,
      skipReason: undefined,
      input: { expected_salary: { min: '20万', max: '20万' } },
    },
    {
      caseId: 'age-000-20岁-20岁',
      fieldId: 'age',
      valueLabel: '20岁-20岁',
      runnable: true,
      skipReason: undefined,
      input: { age: { min: '20岁', max: '20岁' } },
    },
    {
      caseId: 'age-001-20岁-25岁',
      fieldId: 'age',
      valueLabel: '20岁-25岁',
      runnable: true,
      skipReason: undefined,
      input: { age: { min: '20岁', max: '25岁' } },
    },
    {
      caseId: 'age-002-25岁-30岁',
      fieldId: 'age',
      valueLabel: '25岁-30岁',
      runnable: true,
      skipReason: undefined,
      input: { age: { min: '25岁', max: '30岁' } },
    },
    {
      caseId: 'age-003-30岁-30岁',
      fieldId: 'age',
      valueLabel: '30岁-30岁',
      runnable: true,
      skipReason: undefined,
      input: { age: { min: '30岁', max: '30岁' } },
    },
  ]);
});

test('verify Liepin filter options keeps historical industry parent labels skipped without a tree', () => {
  const options = createLiepinApplicationOptions();
  const field = options.fieldsById.expected_industry;
  if (field.kind !== 'textInput') {
    assert.fail('expected_industry should be textInput');
  }
  field.allowedValues = ['AI/互联网/IT', '电子商务'];
  field.rootValues = ['AI/互联网/IT', '电子商务'];
  field.valuesByDepth = [{ depth: 0, values: ['AI/互联网/IT', '电子商务'] }];
  field.tree = [
    { key: 'AI/互联网/IT', label: 'AI/互联网/IT', depth: 0, pathLabels: ['AI/互联网/IT'], children: [] },
    { key: '电子商务', label: '电子商务', depth: 0, pathLabels: ['电子商务'], children: [] },
  ];

  const cases = buildLiepinApplicationFilterOptionVerificationCases(options, parseArgs([
    '--field',
    'expected_industry',
    '--include-defaults',
    'false',
  ]));

  assert.deepEqual(cases.map((testCase) => ({
    valueLabel: testCase.valueLabel,
    runnable: testCase.runnable,
    skipReason: testCase.skipReason,
    input: testCase.applicationFilterInput,
  })), [
    {
      valueLabel: 'AI/互联网/IT',
      runnable: false,
      skipReason: 'Liepin industry category "AI/互联网/IT" is a parent label in historical catalogs and is not confirmed as a directly selectable replay value.',
      input: { expected_industry: 'AI/互联网/IT' },
    },
    {
      valueLabel: '电子商务',
      runnable: true,
      skipReason: undefined,
      input: { expected_industry: '电子商务' },
    },
  ]);
});

test('verify Liepin filter options can write a dry-run plan file', async () => {
  const optionsPath = path.join(tempDir, 'application-filter-options.json');
  const outputPath = path.join(tempDir, 'plan.json');
  await writeJson(optionsPath, createLiepinApplicationOptions());

  const summary = await verifyLiepinApplicationFilterOptions(parseArgs([
    '--options-path', optionsPath,
    '--output', outputPath,
    '--field', 'work_years',
    '--limit', '2',
  ]));

  assert.equal(summary.run, false);
  assert.equal(summary.totalCases, 3);
  assert.equal(summary.selectedCases, 2);
  assert.equal(summary.plannedCases, 2);
  assert.equal(summary.outputPath, outputPath);

  const plan = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
    cases: Array<{ caseId: string }>;
  };
  assert.deepEqual(plan.cases.map((testCase) => testCase.caseId), [
    'work_years-000-不限',
    'work_years-001-1-3年',
  ]);
});
