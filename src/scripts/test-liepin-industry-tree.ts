import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../config.js';
import {
  buildLiepinIndustryFilterDefinition,
  mergeLiepinIndustryFiltersIntoCatalog,
  type LiepinIndustryTreeDiscovery,
} from '../platforms/liepin-industry-tree.js';
import { buildApplicationFilterOptions, validateApplicationFilterInput } from '../search/filter-application-options.js';
import { buildApplicationFilterConditions } from '../search/search-subscription.js';
import { createEmptySearchFilterCatalog, type SearchFilterCatalog } from '../search/filter-catalog.js';
import { JobStore } from '../storage/job-store.js';
import {
  closeBrowserSessionRef,
  discoverLiepinIndustryTreeRef,
  ensureAuthenticatedBrowserSessionRef,
  parseArgs,
  prepareLiepinSearchConditionPageRef,
  runDiscoverLiepinIndustryTree,
} from './discover-liepin-industry-tree.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-liepin-industry-tree-'));
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

function createBaseLiepinCatalog(): SearchFilterCatalog {
  return {
    ...createEmptySearchFilterCatalog('liepin', '优衣库', 'https://example.com/search'),
    capturedAt: '2026-06-01T12:00:00.000Z',
    filters: [
      {
        key: 'work-years-filter',
        label: '工作经验',
        controlType: 'singleSelect',
        valueShape: 'string',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'text', value: '工作经验' }],
        options: [
          { label: '不限', value: '不限', depth: 0 },
          { label: '3-5年', value: '3-5年', depth: 0 },
        ],
      },
      {
        key: 'old-current-industry-filter',
        label: '当前行业',
        controlType: 'textInput',
        valueShape: 'string',
        status: 'optionsExtracted',
        childrenLazy: true,
        inputPlaceholder: '当前行业',
        selectorHints: [{ kind: 'text', value: '当前行业' }],
        options: [
          { label: 'AI/互联网/IT', depth: 0, pathLabels: ['AI/互联网/IT'] },
        ],
      },
    ],
  };
}

function createIndustryDiscovery(): LiepinIndustryTreeDiscovery {
  const engagedFilter = buildLiepinIndustryFilterDefinition('当前行业', [
    { label: 'AI/互联网/IT', children: ['不限', '电子商务', '新零售'] },
    { label: '消费品', children: ['不限', '服装/纺织/皮革'] },
  ]);
  const expectedFilter = buildLiepinIndustryFilterDefinition('期望行业', [
    { label: 'AI/互联网/IT', children: ['不限', '电子商务'] },
    { label: '交通/物流/贸易/零售', children: ['不限', '新零售', '电子商务'] },
  ]);

  return {
    platform: 'liepin',
    capturedAt: '2026-06-02T09:00:00.000Z',
    pageUrl: 'https://h.liepin.com/search/getconditionitem',
    fields: [
      {
        fieldId: 'engaged_industry',
        label: '当前行业',
        roots: [
          { label: 'AI/互联网/IT', children: ['不限', '电子商务', '新零售'] },
          { label: '消费品', children: ['不限', '服装/纺织/皮革'] },
        ],
        filter: engagedFilter,
      },
      {
        fieldId: 'expected_industry',
        label: '期望行业',
        roots: [
          { label: 'AI/互联网/IT', children: ['不限', '电子商务'] },
          { label: '交通/物流/贸易/零售', children: ['不限', '新零售', '电子商务'] },
        ],
        filter: expectedFilter,
      },
    ],
  };
}

test('Liepin industry filter definition emits leaf options with full paths', () => {
  const filter = buildLiepinIndustryFilterDefinition('当前行业', [
    { label: 'AI/互联网/IT', children: ['不限', '电子商务', '新零售', '电子商务'] },
    { label: '消费品', children: ['不限', '服装/纺织/皮革'] },
  ]);

  assert.equal(filter.label, '当前行业');
  assert.equal(filter.controlType, 'textInput');
  assert.equal(filter.childrenLazy, false);
  assert.deepEqual(filter.options, [
    {
      label: '不限',
      value: '不限',
      depth: 1,
      parentPathLabels: ['AI/互联网/IT'],
      pathLabels: ['AI/互联网/IT', '不限'],
    },
    {
      label: '电子商务',
      value: '电子商务',
      depth: 1,
      parentPathLabels: ['AI/互联网/IT'],
      pathLabels: ['AI/互联网/IT', '电子商务'],
    },
    {
      label: '新零售',
      value: '新零售',
      depth: 1,
      parentPathLabels: ['AI/互联网/IT'],
      pathLabels: ['AI/互联网/IT', '新零售'],
    },
    {
      label: '不限',
      value: '不限',
      depth: 1,
      parentPathLabels: ['消费品'],
      pathLabels: ['消费品', '不限'],
    },
    {
      label: '服装/纺织/皮革',
      value: '服装/纺织/皮革',
      depth: 1,
      parentPathLabels: ['消费品'],
      pathLabels: ['消费品', '服装/纺织/皮革'],
    },
  ]);
  assert.equal(filter.options?.some((option) => option.label === 'AI/互联网/IT'), false);
});

test('Liepin industry filters replace historical parent-only industry filters in catalog', () => {
  const discovery = createIndustryDiscovery();
  const merged = mergeLiepinIndustryFiltersIntoCatalog(
    createBaseLiepinCatalog(),
    discovery.fields.map((field) => field.filter),
    discovery.capturedAt,
    discovery.pageUrl,
  );

  assert.equal(merged.capturedAt, discovery.capturedAt);
  assert.equal(merged.pageUrl, discovery.pageUrl);
  assert.deepEqual(merged.filters.map((filter) => filter.label), ['工作经验', '当前行业', '期望行业']);
  assert.equal(merged.filters.find((filter) => filter.key === 'old-current-industry-filter'), undefined);
  assert.equal(merged.stats.discoveredControls, 3);
  assert.equal(merged.stats.optionsExtracted, 12);
});

test('Liepin industry application options use parent labels as tree nodes, not direct values', async () => {
  const discovery = createIndustryDiscovery();
  const catalog = mergeLiepinIndustryFiltersIntoCatalog(
    createBaseLiepinCatalog(),
    discovery.fields.map((field) => field.filter),
    discovery.capturedAt,
    discovery.pageUrl,
  );
  const options = buildApplicationFilterOptions(catalog);
  const engagedIndustry = options.fieldsById.engaged_industry;
  const expectedIndustry = options.fieldsById.expected_industry;

  if (engagedIndustry.kind !== 'textInput' || expectedIndustry.kind !== 'textInput') {
    assert.fail('industry fields should be textInput fields');
  }

  assert.deepEqual(engagedIndustry.rootValues, ['AI/互联网/IT', '消费品']);
  assert.deepEqual(engagedIndustry.allowedValues, ['不限', '电子商务', '新零售', '服装/纺织/皮革']);
  assert.equal(engagedIndustry.allowedValues.includes('AI/互联网/IT'), false);
  assert.deepEqual(expectedIndustry.tree.map((node) => ({
    label: node.label,
    children: node.children.map((child) => child.label),
  })), [
    { label: 'AI/互联网/IT', children: ['不限', '电子商务'] },
    { label: '交通/物流/贸易/零售', children: ['不限', '新零售', '电子商务'] },
  ]);
  assert.deepEqual(validateApplicationFilterInput(options, {
    expected_industry: {
      value: '电子商务',
      pathLabels: ['交通/物流/贸易/零售', '电子商务'],
    },
  }), {
    ok: true,
    errors: [],
  });
  assert.deepEqual(validateApplicationFilterInput(options, {
    expected_industry: {
      value: '电子商务',
      pathLabels: ['AI/互联网/IT'],
    },
  }), {
    ok: false,
    errors: [{
      fieldId: 'expected_industry',
      code: 'invalid_text_input_path',
      message: '期望行业 的 pathLabels 必须指向输入值。',
    }],
  });

  const optionsPath = path.join(tempDir, 'application-filter-options.json');
  await writeJson(optionsPath, options);
  const conditions = await buildApplicationFilterConditions('liepin', {
    expected_industry: {
      value: '电子商务',
      pathLabels: ['交通/物流/贸易/零售', '电子商务'],
    },
  }, {
    applicationFilterOptionsPath: optionsPath,
  });

  assert.deepEqual(conditions, [{
    kind: 'applicationFilter',
    fieldId: 'expected_industry',
    label: '期望行业',
    fieldKind: 'textInput',
    value: {
      value: '电子商务',
      pathLabels: ['交通/物流/贸易/零售', '电子商务'],
    },
    values: [{
      value: '电子商务',
      pathLabels: ['交通/物流/贸易/零售', '电子商务'],
      ambiguous: false,
    }],
  }]);
});

test('discover Liepin industry tree parseArgs accepts optional field and outputs', () => {
  assert.deepEqual(parseArgs([
    '--keyword',
    '优衣库',
    '--field',
    'engaged_industry,expected_industry',
    '--output',
    './tree.json',
    '--catalog-output',
    './catalog.json',
    '--application-options-output',
    './options.json',
  ]), {
    keyword: '优衣库',
    fieldIds: ['engaged_industry', 'expected_industry'],
    outputPath: './tree.json',
    catalogOutputPath: './catalog.json',
    applicationOptionsOutputPath: './options.json',
  });

  assert.throws(
    () => parseArgs(['--keyword', '优衣库', '--field', 'company_name']),
    /Unsupported Liepin industry field/,
  );
});

test('discover Liepin industry tree run writes raw tree, merged catalog, and application options', async () => {
  const discovery = createIndustryDiscovery();
  const outputPath = path.join(tempDir, 'raw-tree.json');
  const catalogOutputPath = path.join(tempDir, 'merged-catalog.json');
  const applicationOptionsOutputPath = path.join(tempDir, 'application-options.json');
  const store = new JobStore();

  await store.saveSearchFilterCatalog('liepin', createBaseLiepinCatalog());

  const originalEnsureSession = ensureAuthenticatedBrowserSessionRef.fn;
  const originalCloseSession = closeBrowserSessionRef.fn;
  const originalPrepare = prepareLiepinSearchConditionPageRef.fn;
  const originalDiscover = discoverLiepinIndustryTreeRef.fn;
  const calls: string[] = [];

  ensureAuthenticatedBrowserSessionRef.fn = async () => {
    calls.push('session');
    return {
      page: { id: 'root' },
      context: {},
      browser: {},
    } as never;
  };
  closeBrowserSessionRef.fn = async () => {
    calls.push('close');
  };
  prepareLiepinSearchConditionPageRef.fn = async (page, keyword) => {
    assert.deepEqual(page, { id: 'root' });
    calls.push(`prepare:${keyword}`);
    return { id: 'search' } as never;
  };
  discoverLiepinIndustryTreeRef.fn = async (page, fieldIds) => {
    assert.deepEqual(page, { id: 'search' });
    assert.deepEqual(fieldIds, ['expected_industry']);
    calls.push('discover');
    return {
      ...discovery,
      fields: discovery.fields.filter((field) => field.fieldId === 'expected_industry'),
    };
  };

  try {
    const summary = await runDiscoverLiepinIndustryTree({
      keyword: '优衣库',
      fieldIds: ['expected_industry'],
      outputPath,
      catalogOutputPath,
      applicationOptionsOutputPath,
    });

    assert.deepEqual(calls, ['session', 'prepare:优衣库', 'discover', 'close']);
    assert.equal(summary.platform, 'liepin');
    assert.equal(summary.keyword, '优衣库');
    assert.deepEqual(summary.fields, [{
      fieldId: 'expected_industry',
      label: '期望行业',
      rootCount: 2,
      optionCount: 5,
    }]);
    assert.equal(summary.rawOutputPath, outputPath);
    assert.equal(summary.catalogOutputPath, catalogOutputPath);
    assert.equal(summary.applicationOptionsPath, applicationOptionsOutputPath);

    const rawTree = JSON.parse(await fs.readFile(outputPath, 'utf8')) as LiepinIndustryTreeDiscovery;
    const mergedCatalog = JSON.parse(await fs.readFile(catalogOutputPath, 'utf8')) as SearchFilterCatalog;
    const applicationOptions = JSON.parse(await fs.readFile(applicationOptionsOutputPath, 'utf8')) as ReturnType<typeof buildApplicationFilterOptions>;

    assert.equal(rawTree.fields.length, 1);
    assert.deepEqual(mergedCatalog.filters.map((filter) => filter.label), ['工作经验', '当前行业', '期望行业']);
    assert.equal(applicationOptions.fieldsById.expected_industry.kind, 'textInput');
  } finally {
    ensureAuthenticatedBrowserSessionRef.fn = originalEnsureSession;
    closeBrowserSessionRef.fn = originalCloseSession;
    prepareLiepinSearchConditionPageRef.fn = originalPrepare;
    discoverLiepinIndustryTreeRef.fn = originalDiscover;
  }
});
