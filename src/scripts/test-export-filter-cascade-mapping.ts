import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import { exportFilterCascadeMapping, parseArgs } from './export-filter-cascade-mapping.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-cascade-mapping-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('export filter cascade mapping parses args', () => {
  assert.deepEqual(parseArgs(['51job']), {
    platform: '51job',
    outputPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './cascade-mapping.json']), {
    platform: 'zhilian',
    outputPath: './cascade-mapping.json',
  });
});

test('export filter cascade mapping writes application-oriented cascade json', async () => {
  const outputPath = path.join(tempDir, 'cascade-mapping.json');
  const store = new JobStore();

  const catalog: SearchFilterCatalog = {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T13:03:17.765Z',
    pageUrl: 'https://example.com/filters',
    filters: [
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
          { label: '3千', value: '3千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '3千'] },
          { label: '4千', value: '4千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '4千'] },
          { label: '5千', value: '5千', depth: 1, parentPathLabels: ['3千'], pathLabels: ['3千', '5千'] },
        ],
      },
      {
        key: 'work-years-filter',
        label: '工作年限',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'cssPath', value: '.work-years' }],
        options: [{ label: '不限', value: '不限', depth: 0 }],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 2,
      inspectedControls: 2,
      optionsExtracted: 6,
      failedControls: 0,
      unknownControls: 0,
    },
  };

  await store.saveSearchFilterCatalog('51job', catalog);
  const summary = await exportFilterCascadeMapping({
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
  assert.equal(summary.fieldCount, 1);
  assert.deepEqual(summary.fieldIds, ['expected_salary']);
  assert.equal(written.fieldCount, 1);
  assert.deepEqual(written.fieldIds, ['expected_salary']);
  assert.deepEqual(written.fieldIdByLabel, {
    期望月薪: 'expected_salary',
  });
  assert.deepEqual(written.fieldsById.expected_salary, {
    fieldId: 'expected_salary',
    filterKey: 'expected-salary-filter',
    label: '期望月薪',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    childrenLazy: true,
    optionCount: 5,
    levelCount: 2,
    rootOptions: [
      {
        label: '2千',
        value: '2千',
        disabled: false,
        selected: false,
      },
      {
        label: '3千',
        value: '3千',
        disabled: false,
        selected: false,
      },
    ],
    orderedRootLabels: ['2千', '3千'],
    selectorHints: [{ kind: 'cssPath', value: '.salary' }],
  });
});
