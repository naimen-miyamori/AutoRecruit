import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  type ApplicationFilterOptions,
} from '../search/filter-application-options.js';
import {
  parseArgs,
  validateApplicationFilterInputFile,
} from './validate-application-filter-input.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-validate-filter-input-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createOptions(): ApplicationFilterOptions {
  return {
    platform: '51job',
    capturedAt: '2026-05-26T13:23:24.638Z',
    keyword: '优衣库',
    fieldCount: 6,
    fieldIds: ['work_years', 'expected_location', 'living_location', 'expected_industry', 'expected_salary', 'age'],
    fieldIdByLabel: {
      工作年限: 'work_years',
      期望工作地: 'expected_location',
      居住地: 'living_location',
      期望行业: 'expected_industry',
      期望月薪: 'expected_salary',
      年龄: 'age',
    },
    groups: {
      singleSelect: ['work_years'],
      textInput: ['expected_location', 'living_location', 'expected_industry'],
      salaryRange: ['expected_salary'],
      numberRange: ['age'],
    },
    fieldsById: {
      work_years: {
        fieldId: 'work_years',
        filterKey: 'work-years-filter',
        label: '工作年限',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string', 'customInput'],
        allowedValues: ['不限', '1-3年'],
        options: [
          { label: '不限', value: '不限', disabled: false, selected: false },
          {
            label: '自定义',
            value: '自定义',
            disabled: false,
            selected: false,
            inputSpec: {
              kind: 'numberRange',
              confirmLabel: '确定',
              unit: '年',
              fields: [
                { key: 'min', valueType: 'number', placeholder: '最低' },
                { key: 'max', valueType: 'number', placeholder: '最高' },
              ],
            },
          },
        ],
        customInput: {
          label: '自定义',
          value: '自定义',
          inputSpec: {
            kind: 'numberRange',
            confirmLabel: '确定',
            unit: '年',
            fields: [
              { key: 'min', valueType: 'number', placeholder: '最低' },
              { key: 'max', valueType: 'number', placeholder: '最高' },
            ],
          },
        },
      },
      expected_location: {
        fieldId: 'expected_location',
        filterKey: 'expected-location-filter',
        label: '期望工作地',
        kind: 'textInput',
        semanticKind: 'location',
        scope: 'expected',
        restrictInput: true,
        valueShape: 'string|string[]',
        acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: ['广东省', '深圳'],
        rootValues: ['广东省'],
        valuesByDepth: [
          { depth: 0, values: ['广东省'] },
          { depth: 1, values: ['深圳'] },
        ],
        tree: [],
      },
      living_location: {
        fieldId: 'living_location',
        filterKey: 'living-location-filter',
        label: '居住地',
        kind: 'textInput',
        semanticKind: 'location',
        scope: 'living',
        restrictInput: true,
        valueShape: 'string|string[]',
        acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
        allowedValues: ['上海市', '浦东新区'],
        rootValues: ['上海市'],
        valuesByDepth: [
          { depth: 0, values: ['上海市'] },
          { depth: 1, values: ['浦东新区'] },
        ],
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
        allowedValues: ['互联网/IT/电子/通信', '电子商务'],
        rootValues: ['互联网/IT/电子/通信'],
        valuesByDepth: [
          { depth: 0, values: ['互联网/IT/电子/通信'] },
          { depth: 1, values: ['电子商务'] },
        ],
        tree: [],
      },
      expected_salary: {
        fieldId: 'expected_salary',
        filterKey: 'expected-salary-filter',
        label: '期望月薪',
        kind: 'salaryRange',
        restrictInput: true,
        valueShape: 'object',
        acceptedInputShapes: ['{ min: string; max: string }'],
        minKey: 'min',
        maxKey: 'max',
        minLabel: '薪资下限',
        maxLabel: '薪资上限',
        orderedValues: ['2千', '3千', '4千'],
        minOptions: ['2千', '3千', '4千'],
        maxOptions: ['2千', '3千', '4千'],
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
        min: 16,
        max: 65,
        orderedValues: ['16', '25', '35', '65'],
        minOptions: ['16', '25', '35', '65'],
        maxOptions: ['16', '25', '35', '65'],
        rule: {
          kind: 'orderedRange',
          comparison: 'maxNumberValue >= minNumberValue',
          message: '右侧年龄上限不能低于左侧年龄下限。',
        },
      },
    },
  };
}

function createZhilianSelectRangeOptions(): ApplicationFilterOptions {
  return {
    platform: 'zhilian',
    capturedAt: '2026-06-03T10:00:00.000Z',
    keyword: '优衣库',
    fieldCount: 1,
    fieldIds: ['education'],
    fieldIdByLabel: {
      学历要求: 'education',
    },
    groups: {
      singleSelect: ['education'],
      textInput: [],
      salaryRange: [],
      numberRange: [],
    },
    fieldsById: {
      education: {
        fieldId: 'education',
        filterKey: 'education-filter',
        label: '学历要求',
        kind: 'singleSelect',
        restrictInput: true,
        valueShape: 'string',
        acceptedInputShapes: ['string', 'customInput'],
        allowedValues: ['不限', '本科及以上'],
        options: [
          { label: '不限', value: '不限', disabled: false, selected: false },
          { label: '本科及以上', value: '本科及以上', disabled: false, selected: false },
          {
            label: '自定义',
            value: '自定义',
            disabled: false,
            selected: false,
            inputSpec: {
              kind: 'selectRange',
              fields: [
                { key: 'min', valueType: 'string', label: '最低学历' },
                { key: 'max', valueType: 'string', label: '最高学历' },
              ],
            },
          },
        ],
        customInput: {
          label: '自定义',
          value: '自定义',
          inputSpec: {
            kind: 'selectRange',
            fields: [
              { key: 'min', valueType: 'string', label: '最低学历' },
              { key: 'max', valueType: 'string', label: '最高学历' },
            ],
          },
        },
      },
    },
  };
}

test('validate application filter input parses args', () => {
  assert.deepEqual(parseArgs(['51job', './input.json']), {
    platform: '51job',
    inputPath: './input.json',
    optionsPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './input.json', './options.json']), {
    platform: 'zhilian',
    inputPath: './input.json',
    optionsPath: './options.json',
  });
});

test('validate application filter input accepts Zhilian select-range custom input', async () => {
  const inputPath = path.join(tempDir, 'zhilian-select-range-input.json');
  const optionsPath = path.join(tempDir, 'zhilian-select-range-options.json');
  await writeJson(optionsPath, createZhilianSelectRangeOptions());
  await writeJson(inputPath, {
    education: {
      label: '自定义',
      input: {
        min: '大专',
        max: '本科',
      },
    },
  });

  const result = await validateApplicationFilterInputFile({
    platform: 'zhilian',
    inputPath,
    optionsPath,
  });

  assert.deepEqual({
    ok: result.ok,
    errors: result.errors,
  }, {
    ok: true,
    errors: [],
  });
});

test('validate application filter input rejects empty Zhilian select-range custom input values', async () => {
  const inputPath = path.join(tempDir, 'zhilian-select-range-invalid-input.json');
  const optionsPath = path.join(tempDir, 'zhilian-select-range-invalid-options.json');
  await writeJson(optionsPath, createZhilianSelectRangeOptions());
  await writeJson(inputPath, {
    education: {
      label: '自定义',
      input: {
        min: '大专',
        max: '',
      },
    },
  });

  const result = await validateApplicationFilterInputFile({
    platform: 'zhilian',
    inputPath,
    optionsPath,
  });

  assert.deepEqual({
    ok: result.ok,
    errors: result.errors,
  }, {
    ok: false,
    errors: [{
      fieldId: 'education',
      code: 'invalid_custom_string',
      message: '学历要求 的 max 必须是非空文本。',
    }],
  });
});

test('validate application filter input file accepts valid application payload', async () => {
  const inputPath = path.join(tempDir, 'input.json');
  const optionsPath = path.join(tempDir, 'options.json');
  await writeJson(optionsPath, createOptions());
  await writeJson(inputPath, {
    expected_location: '深圳',
    living_location: '浦东新区',
    expected_industry: '电子商务',
    work_years: {
      label: '自定义',
      input: {
        min: 1,
        max: 3,
      },
    },
    expected_salary: {
      min: '2千',
      max: '3千',
    },
    age: {
      min: 25,
      max: 35,
    },
  });

  const result = await validateApplicationFilterInputFile({
    platform: '51job',
    inputPath,
    optionsPath,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.platform, '51job');
  assert.equal(result.inputPath, inputPath);
  assert.equal(result.optionsPath, optionsPath);
});

test('validate application filter input file reports validation errors', async () => {
  const inputPath = path.join(tempDir, 'input.json');
  const optionsPath = path.join(tempDir, 'options.json');
  await writeJson(optionsPath, createOptions());
  await writeJson(inputPath, {
    expected_location: '不存在的城市',
    expected_salary: {
      min: '4千',
      max: '2千',
    },
  });

  const result = await validateApplicationFilterInputFile({
    platform: '51job',
    inputPath,
    optionsPath,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    {
      fieldId: 'expected_location',
      code: 'invalid_text_input',
      message: '期望工作地 只能输入采集到的选项文本。',
    },
    {
      fieldId: 'expected_salary',
      code: 'invalid_salary_order',
      message: '右侧薪资上限不能低于左侧薪资下限。',
    },
  ]);
});

test('validate application filter input file rejects platform mismatch', async () => {
  const inputPath = path.join(tempDir, 'input.json');
  const optionsPath = path.join(tempDir, 'options.json');
  await writeJson(optionsPath, createOptions());
  await writeJson(inputPath, {});

  await assert.rejects(
    validateApplicationFilterInputFile({
      platform: 'liepin',
      inputPath,
      optionsPath,
    }),
    /Application filter options platform mismatch/,
  );
});
