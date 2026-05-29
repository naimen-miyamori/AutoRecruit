import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import { exportFilterSingleSelectMapping, parseArgs } from './export-filter-single-select-mapping.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-single-select-mapping-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('export filter single-select mapping parses args', () => {
  assert.deepEqual(parseArgs(['51job']), {
    platform: '51job',
    outputPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './single-select-mapping.json']), {
    platform: 'zhilian',
    outputPath: './single-select-mapping.json',
  });
});

test('export filter single-select mapping writes application-oriented json', async () => {
  const outputPath = path.join(tempDir, 'single-select-mapping.json');
  const store = new JobStore();

  const catalog: SearchFilterCatalog = {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T13:03:17.765Z',
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
          { label: '不限', value: '不限', depth: 1 },
          {
            label: '自定义',
            value: '自定义',
            depth: 1,
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
        selectorHints: [{ kind: 'cssPath', value: '.expected-location' }],
        options: [
          { label: '广东省', depth: 0, pathLabels: ['广东省'] },
        ],
      },
      {
        key: 'gender-filter',
        label: '性别',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'containerText', value: '不限 不限男女' }],
        options: [
          { label: '不限', value: '不限', depth: 1 },
          { label: '男', value: '男', depth: 1 },
          { label: '女', value: '女', depth: 1 },
        ],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 2,
      inspectedControls: 2,
      optionsExtracted: 3,
      failedControls: 0,
      unknownControls: 0,
    },
  };

  await store.saveSearchFilterCatalog('51job', catalog);
  const summary = await exportFilterSingleSelectMapping({
    platform: '51job',
    outputPath,
  });
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
    fieldCount: number;
    fieldIds: string[];
    fieldIdByLabel: Record<string, string>;
    fieldsById: Record<string, unknown>;
  };

  assert.equal(summary.platform, '51job');
  assert.equal(summary.fieldCount, 2);
  assert.deepEqual(summary.fieldIds, ['work_years', 'gender']);
  assert.equal(written.fieldCount, 2);
  assert.deepEqual(written.fieldIds, ['work_years', 'gender']);
  assert.deepEqual(written.fieldIdByLabel, {
    工作年限: 'work_years',
    性别: 'gender',
  });
  assert.deepEqual(written.fieldsById.work_years, {
    fieldId: 'work_years',
    filterKey: 'work-years-filter',
    label: '工作年限',
    controlType: 'singleSelect',
    valueShape: 'string',
    optionCount: 2,
    options: [
      {
        label: '不限',
        value: '不限',
        depth: 1,
        disabled: false,
        selected: false,
      },
      {
        label: '自定义',
        value: '自定义',
        depth: 1,
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
    customInputOption: {
      label: '自定义',
      value: '自定义',
      depth: 1,
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
    selectorHints: [{ kind: 'cssPath', value: '.work-years' }],
  });
  assert.deepEqual(written.fieldsById.gender, {
    fieldId: 'gender',
    filterKey: 'gender-filter',
    label: '性别',
    controlType: 'singleSelect',
    valueShape: 'string',
    optionCount: 3,
    options: [
      {
        label: '不限',
        value: '不限',
        depth: 1,
        disabled: false,
        selected: false,
      },
      {
        label: '男',
        value: '男',
        depth: 1,
        disabled: false,
        selected: false,
      },
      {
        label: '女',
        value: '女',
        depth: 1,
        disabled: false,
        selected: false,
      },
    ],
    selectorHints: [{ kind: 'containerText', value: '不限 不限男女' }],
  });
});
