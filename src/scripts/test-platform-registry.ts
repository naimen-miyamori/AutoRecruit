import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStorageStatePath } from '../config.js';
import { normalize51jobFilterDefinition } from '../platforms/51job-filter-normalization.js';
import { getPlatformAdapter, listSupportedPlatforms, parsePlatformArg } from '../platforms/registry.js';

test('listSupportedPlatforms returns the stable supported platform order', () => {
  assert.deepEqual(listSupportedPlatforms(), ['51job', 'liepin', 'zhilian']);
});

test('parsePlatformArg defaults to 51job', () => {
  assert.equal(parsePlatformArg(), '51job');
});

test('parsePlatformArg accepts supported platform values', () => {
  assert.equal(parsePlatformArg('51job'), '51job');
  assert.equal(parsePlatformArg('liepin'), 'liepin');
  assert.equal(parsePlatformArg('zhilian'), 'zhilian');
});

test('parsePlatformArg rejects unsupported platforms with supported values in the error', () => {
  assert.throws(
    () => parsePlatformArg('boss'),
    /Unsupported platform: boss\. Supported platforms: 51job, liepin, zhilian/,
  );
});

test('resolveStorageStatePath returns platform-specific default paths', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;
  delete process.env.STORAGE_STATE_PATH;

  try {
    assert.match(resolveStorageStatePath('51job'), /storage-state\.json$/);
    assert.match(resolveStorageStatePath('liepin'), /storage-state\.liepin\.json$/);
    assert.match(resolveStorageStatePath('zhilian'), /storage-state\.zhilian\.json$/);
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('resolveStorageStatePath honors platform-specific STORAGE_STATE_PATH overrides', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;

  try {
    process.env.STORAGE_STATE_PATH = '/tmp/custom-51job-storage-state.json';
    assert.equal(resolveStorageStatePath('51job'), '/tmp/custom-51job-storage-state.json');

    process.env.STORAGE_STATE_PATH = '/tmp/custom-liepin-storage-state.json';
    assert.equal(resolveStorageStatePath('liepin'), '/tmp/custom-liepin-storage-state.json');

    process.env.STORAGE_STATE_PATH = '/tmp/custom-zhilian-storage-state.json';
    assert.equal(resolveStorageStatePath('zhilian'), '/tmp/custom-zhilian-storage-state.json');
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('resolveStorageStatePath rejects cross-platform or shared STORAGE_STATE_PATH overrides', () => {
  const originalStorageStatePath = process.env.STORAGE_STATE_PATH;

  try {
    process.env.STORAGE_STATE_PATH = '/tmp/storage-state.json';
    assert.throws(() => resolveStorageStatePath('liepin'), /not safe for liepin/);
    assert.throws(() => resolveStorageStatePath('zhilian'), /not safe for zhilian/);

    process.env.STORAGE_STATE_PATH = '/tmp/custom-liepin-storage-state.json';
    assert.throws(() => resolveStorageStatePath('51job'), /not safe for 51job/);
    assert.throws(() => resolveStorageStatePath('zhilian'), /not safe for zhilian/);
  } finally {
    if (originalStorageStatePath === undefined) {
      delete process.env.STORAGE_STATE_PATH;
    } else {
      process.env.STORAGE_STATE_PATH = originalStorageStatePath;
    }
  }
});

test('51job adapter exposes the shared auth contract', () => {
  const fiftyOneJobAdapter = getPlatformAdapter('51job');
  assert.equal(fiftyOneJobAdapter.platform, '51job');
  assert.equal(fiftyOneJobAdapter.displayName, '51job');
  assert.equal(fiftyOneJobAdapter.subscribeSearchUrl, 'https://ehire.51job.com/Revision/talent/subscribe');
  assert.equal(fiftyOneJobAdapter.loginUrl, 'https://ehire.51job.com/Revision/talent/subscribe');
  assert.equal(fiftyOneJobAdapter.storageStateFileName, 'storage-state.json');
  assert.equal(typeof fiftyOneJobAdapter.openLoginPage, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof fiftyOneJobAdapter.assertAuthenticated, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof fiftyOneJobAdapter.discoverSearchFilters, 'function');
  assert.equal(typeof fiftyOneJobAdapter.extractCandidateList, 'function');
  assert.equal(typeof fiftyOneJobAdapter.openResumeDetail, 'function');
  assert.equal(typeof fiftyOneJobAdapter.parseResumeDetail, 'function');
});

test('51job adapter normalizes recent activity filter labels after discovery', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '近1年-filter-16',
    label: '近1年',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '近1周 近2周 近1个月 近2个月 近6个月 近1年 1年及以上 近1年' },
    ],
  });

  assert.equal(normalized.label, '最近活跃时间');
  assert.equal(normalized.key, '最近活跃时间-job-recent-activity-time');
});

test('51job adapter cleans polluted work-years options into a usable single-layer list', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '工作年限-filter-4',
    label: '工作年限',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '不限 无经验 1-3年 3-5年 5-10年 10年及以上 自定义 工作年限' },
    ],
    options: [
      { label: '基础信息 不限 无经验 1-3年 3-5年 5-10年 10年及以上 自定义 工作年限 年龄', value: '0', depth: 1 },
      { label: '不限 无经验 1-3年 3-5年 5-10年 10年及以上 自定义 工作年限', value: '不限 无经验 1-3年 3-5年 5-10年 10年及以上 自定义 工作年限', depth: 1 },
      { label: '不限', value: '不限', depth: 1 },
      { label: '无经验', value: '无经验', depth: 1 },
      { label: '1-3年', value: '1-3年', depth: 1 },
      { label: '3-5年', value: '3-5年', depth: 1 },
      { label: '5-10年', value: '5-10年', depth: 1 },
      { label: '10年及以上', value: '10年及以上', depth: 1 },
    ],
  });

  assert.deepEqual(
    normalized.options?.map((option) => option.label),
    ['不限', '无经验', '1-3年', '3-5年', '5-10年', '10年及以上', '自定义'],
  );
  assert.equal(normalized.controlType, 'singleSelect');
  assert.equal(normalized.valueShape, 'string');
  assert.deepEqual(
    normalized.options?.find((option) => option.label === '自定义')?.inputSpec,
    {
      kind: 'numberRange',
      confirmLabel: '确定',
      unit: '年',
      fields: [
        { key: 'min', valueType: 'number', placeholder: '最低' },
        { key: 'max', valueType: 'number', placeholder: '最高' },
      ],
    },
  );
});

test('51job adapter annotates custom option input spec for age and education', () => {
  const ageNormalized = normalize51jobFilterDefinition({
    key: '年龄-filter-5',
    label: '年龄',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '不限 22岁及以下 22-25岁 25-30岁 30-35岁 35-45岁 45岁及以上 自定义 年龄' },
    ],
    options: [
      { label: '不限', value: '不限', depth: 1 },
      { label: '22岁及以下', value: '22岁及以下', depth: 1 },
    ],
  });

  assert.equal(ageNormalized.controlType, 'singleSelect');
  assert.deepEqual(
    ageNormalized.options?.find((option) => option.label === '自定义')?.inputSpec,
    {
      kind: 'numberRange',
      confirmLabel: '确定',
      unit: '岁',
      fields: [
        { key: 'min', valueType: 'number', placeholder: '最低' },
        { key: 'max', valueType: 'number', placeholder: '最高' },
      ],
    },
  );

  const educationNormalized = normalize51jobFilterDefinition({
    key: '学历要求-filter-7',
    label: '学历要求',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '不限 大专及以上 本科及以上 硕士及以上 自定义 学历要求' },
    ],
    options: [
      { label: '不限', value: '不限', depth: 1 },
      { label: '本科及以上', value: '本科及以上', depth: 1 },
    ],
  });

  assert.equal(educationNormalized.controlType, 'singleSelect');
  assert.deepEqual(
    educationNormalized.options?.find((option) => option.label === '自定义')?.inputSpec,
    {
      kind: 'selectRange',
      confirmLabel: '确定',
      fields: [
        { key: 'min', valueType: 'string', label: '最低学历' },
        { key: 'max', valueType: 'string', label: '最高学历' },
      ],
    },
  );

  const graduationYearNormalized = normalize51jobFilterDefinition({
    key: '毕业时间-filter-17',
    label: '毕业时间',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '不限 2026年 2025年 2024年 2023年 2022年 自定义 毕业时间' },
    ],
    options: [
      { label: '不限', value: '不限', depth: 1 },
      { label: '2026年', value: '2026年', depth: 1 },
    ],
  });

  assert.equal(graduationYearNormalized.controlType, 'singleSelect');
  assert.deepEqual(
    graduationYearNormalized.options?.find((option) => option.label === '自定义')?.inputSpec,
    {
      kind: 'numberRange',
      confirmLabel: '确定',
      fields: [
        { key: 'min', valueType: 'number', placeholder: '最低' },
        { key: 'max', valueType: 'number', placeholder: '最高' },
      ],
    },
  );
});

test('51job adapter extracts normalized recent activity options from polluted containers', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '近1年-filter-16',
    label: '最近活跃时间',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '近1周 近2周 近1个月 近2个月 近6个月 近1年 1年及以上 近1年' },
    ],
    options: [
      { label: '其他筛选 近1周 近2周 近1个月 近2个月 近6个月 近1年 1年及以上 近1年', value: '0', depth: 1 },
      { label: '近1周 近2周 近1个月 近2个月 近6个月 近1年 1年及以上', value: '近1周 近2周 近1个月 近2个月 近6个月 近1年 1年及以上', depth: 1 },
    ],
  });

  assert.deepEqual(
    normalized.options?.map((option) => option.label),
    ['近1周', '近2周', '近1个月', '近2个月', '近6个月', '近1年', '1年及以上'],
  );
});

test('51job adapter cleans polluted gender options into a usable single-layer list', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '性别-filter-6',
    label: '性别',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'containerText', value: '不限 不限男女' },
    ],
    options: [
      {
        label: '基础信息 不限 无经验 1-3年 3-5年 5-10年 10年及以上 自定义 工作年限 不限 22岁及以下 22-25岁 25-30岁 30-35岁 35-45岁 45岁及以上 自定义 年龄居住地选择现居地取 消 确 定 不限 大专及以上 本科及以上 硕士及以上 自定义 学历要求 不限 全日制 985 211 双一流',
        value: '0',
        depth: 1,
      },
      { label: '不限 不限男女', value: '不限 不限男女', depth: 1 },
      { label: '性别', value: '性别', depth: 1 },
    ],
  });

  assert.equal(normalized.controlType, 'singleSelect');
  assert.equal(normalized.valueShape, 'string');
  assert.deepEqual(
    normalized.options?.map((option) => option.label),
    ['不限', '男', '女'],
  );
});

test('51job adapter keeps expected salary as a cascade filter with parent-child paths', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '期望月薪-filter-13',
    label: '期望月薪',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    childrenLazy: true,
    selectorHints: [
      { kind: 'text', value: '期望月薪' },
    ],
    options: [
      { label: '2千', value: '2千', depth: 0, pathLabels: ['2千'] },
      { label: '3千', value: '3千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '3千'] },
    ],
  });

  assert.equal(normalized.controlType, 'cascadeSelect');
  assert.equal(normalized.valueShape, 'object');
  assert.deepEqual(normalized.options, [
    { label: '2千', value: '2千', depth: 0, pathLabels: ['2千'] },
    { label: '3千', value: '3千', depth: 1, parentPathLabels: ['2千'], pathLabels: ['2千', '3千'] },
  ]);
});

test('51job adapter reconstructs fixed options for work-type from a collapsed aggregate label', () => {
  const normalized = normalize51jobFilterDefinition({
    key: '工作类型-filter-20',
    label: '工作类型',
    controlType: 'cascadeSelect',
    valueShape: 'object',
    status: 'optionsExtracted',
    selectorHints: [
      { kind: 'placeholder', value: '工作类型' },
    ],
    options: [
      { label: '不限 不限全职兼职实习', value: '不限 不限全职兼职实习', depth: 1 },
      { label: '工作类型', value: '工作类型', depth: 1 },
    ],
  });

  assert.deepEqual(
    normalized.options?.map((option) => option.label),
    ['不限', '全职', '兼职', '实习'],
  );
});

test('liepin adapter exposes the shared auth contract', () => {
  const liepinAdapter = getPlatformAdapter('liepin');
  assert.equal(liepinAdapter.platform, 'liepin');
  assert.equal(liepinAdapter.displayName, 'Liepin');
  assert.equal(liepinAdapter.subscribeSearchUrl, 'https://h.liepin.com/search/getConditionItem');
  assert.equal(liepinAdapter.loginUrl, 'https://h.liepin.com/account/login');
  assert.equal(liepinAdapter.storageStateFileName, 'storage-state.liepin.json');
  assert.equal(typeof liepinAdapter.openLoginPage, 'function');
  assert.equal(typeof liepinAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof liepinAdapter.assertAuthenticated, 'function');
  assert.equal(typeof liepinAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof liepinAdapter.discoverSearchFilters, 'function');
  assert.equal(typeof liepinAdapter.extractCandidateList, 'function');
  assert.equal(typeof liepinAdapter.openResumeDetail, 'function');
  assert.equal(typeof liepinAdapter.parseResumeDetail, 'function');
});

test('zhilian adapter exposes the shared auth contract', () => {
  const zhilianAdapter = getPlatformAdapter('zhilian');
  assert.equal(zhilianAdapter.platform, 'zhilian');
  assert.equal(zhilianAdapter.displayName, 'Zhilian');
  assert.equal(zhilianAdapter.subscribeSearchUrl, 'https://rd6.zhaopin.com/app/search');
  assert.equal(zhilianAdapter.loginUrl, 'https://passport.zhaopin.com/org/login');
  assert.equal(zhilianAdapter.storageStateFileName, 'storage-state.zhilian.json');
  assert.equal(typeof zhilianAdapter.openLoginPage, 'function');
  assert.equal(typeof zhilianAdapter.openAuthenticatedHome, 'function');
  assert.equal(typeof zhilianAdapter.assertAuthenticated, 'function');
  assert.equal(typeof zhilianAdapter.openSubscribeSearch, 'function');
  assert.equal(typeof zhilianAdapter.discoverSearchFilters, 'function');
  assert.equal(typeof zhilianAdapter.extractCandidateList, 'function');
  assert.equal(typeof zhilianAdapter.openResumeDetail, 'function');
  assert.equal(typeof zhilianAdapter.parseResumeDetail, 'function');
});
