import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import { exportFilterCatalogHtml } from './export-filter-catalog-html.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-filter-html-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('export filter catalog html writes an inspectable html page', async () => {
  const outputPath = path.join(tempDir, 'catalog.html');
  const store = new JobStore();

  const catalog: SearchFilterCatalog = {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T13:23:24.638Z',
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
          { label: '10万及以上', value: '10万及以上', depth: 0, pathLabels: ['10万及以上'] },
          { label: '3千', value: '3千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '3千'] },
          { label: '10万', value: '10万', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '10万'] },
        ],
      },
      {
        key: 'expected-location-filter',
        label: '期望工作地',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        childrenLazy: true,
        selectorHints: [{ kind: 'cssPath', value: '.location' }],
        options: [{ label: '广东省', depth: 0, pathLabels: ['广东省'] }],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 2,
      inspectedControls: 2,
      optionsExtracted: 5,
      failedControls: 0,
      unknownControls: 0,
    },
  };

  await store.saveSearchFilterCatalog('51job', catalog);
  const summary = await exportFilterCatalogHtml({
    platform: '51job',
    outputPath,
  });
  const html = await fs.readFile(outputPath, 'utf8');
  const expectedSalarySection = html.match(/<h2>1\. 期望月薪<\/h2>[\s\S]*?<\/section>/)?.[0] ?? '';

  assert.equal(summary.platform, '51job');
  assert.equal(summary.filterCount, 2);
  assert.match(html, /51job Filter Catalog Check/);
  assert.match(html, /期望月薪/);
  assert.match(html, /期望工作地/);
  assert.match(html, /expected_salary/);
  assert.match(expectedSalarySection, /Selection Rule/);
  assert.match(expectedSalarySection, /左侧薪资下限选项/);
  assert.match(expectedSalarySection, /右侧薪资上限选项/);
  assert.match(expectedSalarySection, />2千</);
  assert.match(expectedSalarySection, /10万及以上/);
  assert.match(expectedSalarySection, />10万</);
  assert.match(expectedSalarySection, /右侧薪资上限不低于左侧薪资下限/);
  assert.match(expectedSalarySection, /按薪资数值比较/);
  assert.doesNotMatch(expectedSalarySection, /Options Table/);
  assert.doesNotMatch(expectedSalarySection, /Grouped Children By Parent/);
  assert.doesNotMatch(expectedSalarySection, /Cascade Tree Sample/);
  assert.doesNotMatch(expectedSalarySection, /pathLabels/);
});
