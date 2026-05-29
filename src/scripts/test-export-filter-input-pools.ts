import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import { exportFilterInputPools, parseArgs } from './export-filter-input-pools.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-filter-pools-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('export filter input pools parses args', () => {
  assert.deepEqual(parseArgs(['51job']), {
    platform: '51job',
    outputPath: undefined,
  });

  assert.deepEqual(parseArgs(['zhilian', './out.json']), {
    platform: 'zhilian',
    outputPath: './out.json',
  });
});

test('export filter input pools writes text-input pool json from latest catalog', async () => {
  const outputPath = path.join(tempDir, 'pools.json');
  const store = new JobStore();

  const catalog: SearchFilterCatalog = {
    platform: '51job',
    keyword: '优衣库',
    capturedAt: '2026-05-26T10:01:42.444Z',
    pageUrl: 'https://example.com/filters',
    filters: [
      {
        key: 'industry-filter',
        label: '期望行业',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        inputPlaceholder: '请输入',
        childrenLazy: true,
        selectorHints: [],
        options: [
          { label: '金融', depth: 0, pathLabels: ['金融'] },
          { label: '银行', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '银行'] },
        ],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 1,
      inspectedControls: 1,
      optionsExtracted: 2,
      failedControls: 0,
      unknownControls: 0,
    },
  };

  await store.saveSearchFilterCatalog('51job', catalog);
  const summary = await exportFilterInputPools({
    platform: '51job',
    outputPath,
  });
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
    platform: string;
    poolCount: number;
    pools: Record<string, { tree: Array<{ label: string; children: Array<{ label: string }> }> }>;
  };

  assert.equal(summary.platform, '51job');
  assert.equal(summary.poolCount, 1);
  assert.equal(written.platform, '51job');
  assert.equal(written.poolCount, 1);
  assert.deepEqual(written.pools.期望行业.tree, [{
    key: '金融',
    label: '金融',
    depth: 0,
    pathLabels: ['金融'],
    children: [{
      key: '金融\u0000银行',
      label: '银行',
      depth: 1,
      pathLabels: ['金融', '银行'],
      children: [],
    }],
  }]);
});
