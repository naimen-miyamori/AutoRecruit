import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import { exportFilterInputMapping, parseArgs } from './export-filter-input-mapping.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-filter-mapping-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('export filter input mapping parses args', () => {
  assert.deepEqual(parseArgs(['51job']), {
    platform: '51job',
    outputPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './mapping.json']), {
    platform: 'zhilian',
    outputPath: './mapping.json',
  });
});

test('export filter input mapping writes application-oriented text-input mapping json', async () => {
  const outputPath = path.join(tempDir, 'mapping.json');
  const store = new JobStore();

  const catalog: SearchFilterCatalog = {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T11:17:17.765Z',
    pageUrl: 'https://example.com/filters',
    filters: [
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
        key: 'major-filter',
        label: '专业',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '请输入',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.major' }],
        options: [
          { label: '哲学类', depth: 0, pathLabels: ['哲学类'] },
          { label: '哲学', depth: 1, parentPathLabels: ['哲学类'], pathLabels: ['哲学类', '哲学'] },
        ],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 2,
      inspectedControls: 2,
      optionsExtracted: 4,
      failedControls: 0,
      unknownControls: 0,
    },
  };

  await store.saveSearchFilterCatalog('51job', catalog);
  const summary = await exportFilterInputMapping({
    platform: '51job',
    outputPath,
  });
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
    fieldCount: number;
    fieldIds: string[];
    fieldIdByLabel: Record<string, string>;
    groupsBySemanticKind: Record<string, string[]>;
    groupsByScope: Record<string, string[]>;
    fieldsById: Record<string, { label: string; rootValues: string[]; maxDepth: number }>;
  };

  assert.equal(summary.platform, '51job');
  assert.equal(summary.fieldCount, 2);
  assert.deepEqual(summary.fieldIds, ['expected_location', 'major']);
  assert.equal(written.fieldCount, 2);
  assert.deepEqual(written.fieldIds, ['expected_location', 'major']);
  assert.deepEqual(written.fieldIdByLabel, {
    期望工作地: 'expected_location',
    专业: 'major',
  });
  assert.deepEqual(written.groupsBySemanticKind.location, ['expected_location']);
  assert.deepEqual(written.groupsBySemanticKind.major, ['major']);
  assert.deepEqual(written.groupsByScope.expected, ['expected_location']);
  assert.deepEqual(written.groupsByScope.education, ['major']);
  assert.deepEqual(written.fieldsById.expected_location, {
    fieldId: 'expected_location',
    filterKey: 'expected-location-filter',
    label: '期望工作地',
    semanticKind: 'location',
    scope: 'expected',
    controlType: 'textInput',
    inputPlaceholder: '期望工作地',
    restrictInput: true,
    valueSource: 'label',
    childrenLazy: true,
    optionCount: 2,
    maxDepth: 1,
    levelCount: 2,
    rootValues: ['广东省'],
    values: ['广东省', '深圳'],
    valuesByDepth: [
      { depth: 0, values: ['广东省'] },
      { depth: 1, values: ['深圳'] },
    ],
    tree: [{
      key: '广东省',
      label: '广东省',
      depth: 0,
      pathLabels: ['广东省'],
      children: [{
        key: '广东省\u0000深圳',
        label: '深圳',
        depth: 1,
        pathLabels: ['广东省', '深圳'],
        children: [],
      }],
    }],
    selectorHints: [{ kind: 'cssPath', value: '.expected-location' }],
  });
  assert.deepEqual(written.fieldsById.major.rootValues, ['哲学类']);
  assert.equal(written.fieldsById.major.maxDepth, 1);
});
