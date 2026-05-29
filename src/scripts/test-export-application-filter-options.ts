import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import {
  buildApplicationFilterOptions,
  validateApplicationFilterInput,
  type ApplicationFilterOptions,
} from '../search/filter-application-options.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';
import { JobStore } from '../storage/job-store.js';
import { exportApplicationFilterOptions, parseArgs } from './export-application-filter-options.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-application-filter-options-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function createCatalog(): SearchFilterCatalog {
  return {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T13:23:24.638Z',
    pageUrl: 'https://example.com/filters',
    filters: [
      {
        key: 'work-years-filter',
        label: '工作年限',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'cssPath', value: '.work-years' }],
        options: [
          { label: '不限', value: '不限', depth: 0 },
          {
            label: '自定义',
            value: '自定义',
            depth: 0,
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
      },
      {
        key: 'expected-location-filter',
        label: '期望工作地',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '期望工作地',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.expected-location' }],
        options: [
          { label: '广东省', depth: 0, pathLabels: ['广东省'] },
          { label: '深圳', depth: 1, parentPathLabels: ['广东省'], pathLabels: ['广东省', '深圳'] },
        ],
      },
      {
        key: 'living-location-filter',
        label: '居住地',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '居住地',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.living-location' }],
        options: [
          { label: '上海市', depth: 0, pathLabels: ['上海市'] },
          { label: '浦东新区', depth: 1, parentPathLabels: ['上海市'], pathLabels: ['上海市', '浦东新区'] },
        ],
      },
      {
        key: 'expected-industry-filter',
        label: '期望行业',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '期望行业',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.expected-industry' }],
        options: [
          { label: '互联网/电子商务', depth: 0, pathLabels: ['互联网/电子商务'] },
          {
            label: '电子商务',
            depth: 1,
            parentPathLabels: ['互联网/电子商务'],
            pathLabels: ['互联网/电子商务', '电子商务'],
          },
        ],
      },
      {
        key: 'expected-salary-filter',
        label: '期望月薪',
        controlType: 'cascadeSelect',
        valueShape: 'object',
        status: 'optionsExtracted',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.salary' }],
        options: [
          { label: '2千', value: '2千', depth: 0, pathLabels: ['2千'] },
          { label: '3千', value: '3千', depth: 0, pathLabels: ['3千'] },
          { label: '4千', value: '4千', depth: 0, pathLabels: ['4千'] },
          { label: '3千', value: '3千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '3千'] },
          { label: '2千', value: '2千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '2千'] },
          { label: '4千', value: '4千', depth: 1, parentPathLabels: ['3千'], pathLabels: ['3千', '4千'] },
        ],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 5,
      inspectedControls: 5,
      optionsExtracted: 13,
      failedControls: 0,
      unknownControls: 0,
    },
  };
}

function createLiepinCatalog(): SearchFilterCatalog {
  return {
    platform: 'liepin',
    keyword: '优衣库',
    capturedAt: '2026-05-29T10:00:00.000Z',
    pageUrl: 'https://h.liepin.com/search/getconditionitem',
    filters: [
      {
        key: 'work-experience-filter',
        label: '工作经验',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'text', value: '工作经验' }],
        options: [
          { label: '不限', value: '不限', depth: 0 },
          { label: '1-3年', value: '1-3年', depth: 0 },
          { label: '3-5年', value: '3-5年', depth: 0 },
        ],
      },
      {
        key: 'education-filter',
        label: '教育经历',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'text', value: '教育经历' }],
        options: [
          { label: '不限', value: '不限', depth: 0 },
          { label: '本科', value: '本科', depth: 0 },
          { label: '硕士', value: '硕士', depth: 0 },
        ],
      },
      {
        key: 'current-city-filter',
        label: '目前城市',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '目前城市',
        childrenLazy: true,
        selectorHints: [{ kind: 'text', value: '目前城市' }],
        options: [
          { label: '上海', depth: 0, pathLabels: ['上海'] },
          { label: '浦东新区', depth: 1, parentPathLabels: ['上海'], pathLabels: ['上海', '浦东新区'] },
        ],
      },
      {
        key: 'expected-city-filter',
        label: '期望城市',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '期望城市',
        childrenLazy: true,
        selectorHints: [{ kind: 'text', value: '期望城市' }],
        options: [
          { label: '广东', depth: 0, pathLabels: ['广东'] },
          { label: '深圳', depth: 1, parentPathLabels: ['广东'], pathLabels: ['广东', '深圳'] },
        ],
      },
      {
        key: 'expected-salary-filter',
        label: '期望薪资',
        controlType: 'cascadeSelect',
        valueShape: 'object',
        status: 'optionsExtracted',
        childrenLazy: true,
        selectorHints: [{ kind: 'text', value: '期望薪资' }],
        options: [
          { label: '10万', value: '10万', depth: 0, pathLabels: ['10万'] },
          { label: '20万', value: '20万', depth: 0, pathLabels: ['20万'] },
          { label: '30万', value: '30万', depth: 0, pathLabels: ['30万'] },
          { label: '20万', value: '20万', depth: 1, parentPathLabels: ['10万'], pathLabels: ['10万', '20万'] },
          { label: '30万', value: '30万', depth: 1, parentPathLabels: ['20万'], pathLabels: ['20万', '30万'] },
        ],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 5,
      inspectedControls: 5,
      optionsExtracted: 16,
      failedControls: 0,
      unknownControls: 0,
    },
  };
}

test('export application filter options parses args', () => {
  assert.deepEqual(parseArgs(['51job']), {
    platform: '51job',
    outputPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './application-filter-options.json']), {
    platform: 'zhilian',
    outputPath: './application-filter-options.json',
  });
});

test('export application filter options writes unified application json', async () => {
  const outputPath = path.join(tempDir, 'application-filter-options.json');
  const store = new JobStore();
  await store.saveSearchFilterCatalog('51job', createCatalog());

  const summary = await exportApplicationFilterOptions({
    platform: '51job',
    outputPath,
  });
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8')) as ApplicationFilterOptions;

  assert.equal(summary.platform, '51job');
  assert.equal(summary.fieldCount, 5);
  assert.deepEqual(summary.fieldIds, [
    'work_years',
    'expected_location',
    'living_location',
    'expected_industry',
    'expected_salary',
  ]);
  assert.deepEqual(written.groups.singleSelect, ['work_years']);
  assert.deepEqual(written.groups.textInput, ['expected_location', 'living_location', 'expected_industry']);
  assert.deepEqual(written.groups.salaryRange, ['expected_salary']);
  assert.equal(written.fieldsById.work_years.kind, 'singleSelect');
  assert.equal(written.fieldsById.expected_location.kind, 'textInput');
  assert.equal(written.fieldsById.expected_salary.kind, 'salaryRange');
  if (written.fieldsById.work_years.kind !== 'singleSelect') {
    assert.fail('work_years should be a singleSelect field');
  }
  if (written.fieldsById.expected_location.kind !== 'textInput') {
    assert.fail('expected_location should be a textInput field');
  }
  if (written.fieldsById.expected_salary.kind !== 'salaryRange') {
    assert.fail('expected_salary should be a salaryRange field');
  }
  assert.deepEqual(written.fieldsById.work_years.allowedValues, ['不限']);
  assert.equal(written.fieldsById.work_years.customInput?.label, '自定义');
  assert.deepEqual(written.fieldsById.expected_location.allowedValues, ['广东省', '深圳']);
  assert.deepEqual(written.fieldsById.expected_salary, {
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
    maxOptions: ['3千', '2千', '4千'],
    rule: {
      kind: 'orderedRange',
      comparison: 'maxSalaryValue >= minSalaryValue',
      message: '右侧薪资上限不能低于左侧薪资下限。',
    },
  });
});

test('export application filter options normalizes common Liepin fields', () => {
  const options = buildApplicationFilterOptions(createLiepinCatalog());

  assert.equal(options.platform, 'liepin');
  assert.deepEqual(options.fieldIds, [
    'work_years',
    'education',
    'living_location',
    'expected_location',
    'expected_salary',
  ]);
  assert.deepEqual(options.groups.singleSelect, ['work_years', 'education']);
  assert.deepEqual(options.groups.textInput, ['living_location', 'expected_location']);
  assert.deepEqual(options.groups.salaryRange, ['expected_salary']);
  assert.equal(options.fieldIdByLabel.工作经验, 'work_years');
  assert.equal(options.fieldIdByLabel.教育经历, 'education');
  assert.equal(options.fieldIdByLabel.目前城市, 'living_location');
  assert.equal(options.fieldIdByLabel.期望城市, 'expected_location');
  assert.equal(options.fieldIdByLabel.期望薪资, 'expected_salary');

  const workYears = options.fieldsById.work_years;
  const livingLocation = options.fieldsById.living_location;
  const expectedLocation = options.fieldsById.expected_location;
  const expectedSalary = options.fieldsById.expected_salary;
  if (workYears.kind !== 'singleSelect') {
    assert.fail('work_years should be a singleSelect field');
  }
  if (livingLocation.kind !== 'textInput') {
    assert.fail('living_location should be a textInput field');
  }
  if (expectedLocation.kind !== 'textInput') {
    assert.fail('expected_location should be a textInput field');
  }
  if (expectedSalary.kind !== 'salaryRange') {
    assert.fail('expected_salary should be a salaryRange field');
  }

  assert.deepEqual(workYears.allowedValues, ['不限', '1-3年', '3-5年']);
  assert.deepEqual(livingLocation.allowedValues, ['上海', '浦东新区']);
  assert.deepEqual(livingLocation.rootValues, ['上海']);
  assert.equal(livingLocation.semanticKind, 'location');
  assert.equal(livingLocation.scope, 'living');
  assert.deepEqual(expectedLocation.allowedValues, ['广东', '深圳']);
  assert.equal(expectedLocation.scope, 'expected');
  assert.deepEqual(expectedSalary.minOptions, ['10万', '20万', '30万']);
  assert.deepEqual(expectedSalary.maxOptions, ['20万', '30万']);

  assert.deepEqual(validateApplicationFilterInput(options, {
    work_years: '3-5年',
    education: '本科',
    living_location: {
      value: '浦东新区',
      pathLabels: ['上海', '浦东新区'],
    },
    expected_location: '深圳',
    expected_salary: {
      min: '10万',
      max: '20万',
    },
  }), {
    ok: true,
    errors: [],
  });
});

test('validate application filter input enforces pools and salary ordering', () => {
  const options = buildApplicationFilterOptions(createCatalog());

  const validResult = validateApplicationFilterInput(options, {
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
  });

  assert.deepEqual(validResult, {
    ok: true,
    errors: [],
  });

  assert.deepEqual(validateApplicationFilterInput(options, {
    expected_location: '不存在的城市',
  }), {
    ok: false,
    errors: [{
      fieldId: 'expected_location',
      code: 'invalid_text_input',
      message: '期望工作地 只能输入采集到的选项文本。',
    }],
  });

  assert.deepEqual(validateApplicationFilterInput(options, {
    work_years: '自定义',
  }), {
    ok: false,
    errors: [{
      fieldId: 'work_years',
      code: 'missing_custom_input',
      message: '工作年限 的自定义选项需要 input 对象。',
    }],
  });

  assert.deepEqual(validateApplicationFilterInput(options, {
    work_years: {
      label: '自定义',
      input: {
        min: 'x',
        max: 3,
      },
    },
  }), {
    ok: false,
    errors: [{
      fieldId: 'work_years',
      code: 'invalid_custom_number',
      message: '工作年限 的 min 必须是数字。',
    }],
  });

  assert.deepEqual(validateApplicationFilterInput(options, {
    expected_salary: {
      min: '3千',
      max: '2千',
    },
  }), {
    ok: false,
    errors: [{
      fieldId: 'expected_salary',
      code: 'invalid_salary_order',
      message: '右侧薪资上限不能低于左侧薪资下限。',
    }],
  });
});
