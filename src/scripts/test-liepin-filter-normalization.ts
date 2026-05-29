import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  discoverLiepinStaticSearchFilters,
  mergeLiepinSearchFilterCatalog,
} from '../platforms/liepin-filter-normalization.js';
import { buildApplicationFilterOptions } from '../search/filter-application-options.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

function createEvaluatePage(bodyText: string) {
  return {
    async evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T> {
      const previousDocument = globalThis.document;
      const previousWindow = globalThis.window;
      try {
        (globalThis as typeof globalThis & { document: Document }).document = {
          body: { innerText: bodyText },
          querySelectorAll: () => [],
        } as unknown as Document;
        (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
          getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
        } as unknown as Window & typeof globalThis;
        return await pageFunction();
      } finally {
        if (previousDocument === undefined) {
          Reflect.deleteProperty(globalThis, 'document');
        } else {
          (globalThis as typeof globalThis & { document: Document }).document = previousDocument;
        }

        if (previousWindow === undefined) {
          Reflect.deleteProperty(globalThis, 'window');
        } else {
          (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = previousWindow;
        }
      }
    },
  };
}

function createGenericLiepinCatalog(): SearchFilterCatalog {
  return {
    platform: 'liepin',
    keyword: '优衣库',
    capturedAt: '2026-05-29T10:00:00.000Z',
    pageUrl: 'https://h.liepin.com/search/getconditionitem',
    filters: [
      {
        key: '搜-索-filter-3',
        label: '搜 索',
        controlType: 'cascadeSelect',
        valueShape: 'object',
        status: 'optionsExtracted',
        selectorHints: [{ kind: 'containerText', value: '目前城市：不限上海韩国新加坡深圳俄罗斯马来西亚德国浙江其他期望城市：不限上海深圳东莞江苏孝感北京苏州河北其他' }],
        options: [
          { label: '目前城市：不限上海韩国新加坡深圳俄罗斯马来西亚德国浙江其他', value: '目前城市：不限上海韩国新加坡深圳俄罗斯马来西亚德国浙江其他', depth: 0 },
          { label: '上海', value: '上海', depth: 0 },
        ],
      },
      {
        key: '批量查看-filter-17',
        label: '批量查看',
        controlType: 'unknown',
        valueShape: 'string',
        status: 'unknownControl',
        selectorHints: [{ kind: 'text', value: '批量查看' }],
      },
    ],
    failures: [],
    stats: {
      discoveredControls: 2,
      inspectedControls: 2,
      optionsExtracted: 2,
      failedControls: 0,
      unknownControls: 1,
    },
  };
}

test('liepin filter normalization splits visible filter text into application fields', async () => {
  const page = createEvaluatePage([
    '清空筛选条件',
    '目前城市：不限上海韩国新加坡深圳俄罗斯马来西亚德国浙江其他',
    '期望城市：不限上海深圳东莞江苏孝感北京苏州河北其他',
    '工作年限：不限应届生1-3年3-5年5-10年10年以上自定义确 定',
    '教育经历：不限本科硕士博士/博士后大专中专/中技高中及以下',
    '期望薪资：不限10万20万30万40万50万',
    '搜 索',
  ].join(''));

  const staticResult = await discoverLiepinStaticSearchFilters(page, {
    keyword: '优衣库',
    maxDepth: 2,
    maxOptionsPerLevel: 50,
  });
  const catalog = mergeLiepinSearchFilterCatalog(createGenericLiepinCatalog(), staticResult.filters);
  const options = buildApplicationFilterOptions(catalog);

  assert.deepEqual(catalog.filters.map((filter) => filter.label), [
    '目前城市',
    '期望城市',
    '工作经验',
    '教育经历',
    '期望薪资',
  ]);
  assert.deepEqual(options.fieldIds, [
    'work_years',
    'education',
    'living_location',
    'expected_location',
    'expected_salary',
  ]);
  assert.deepEqual(options.groups.textInput, ['living_location', 'expected_location']);
  assert.deepEqual(options.groups.singleSelect, ['work_years', 'education']);
  assert.deepEqual(options.groups.salaryRange, ['expected_salary']);

  const livingLocation = options.fieldsById.living_location;
  const workYears = options.fieldsById.work_years;
  const expectedSalary = options.fieldsById.expected_salary;
  if (livingLocation.kind !== 'textInput') {
    assert.fail('living_location should be a textInput field');
  }
  if (workYears.kind !== 'singleSelect') {
    assert.fail('work_years should be a singleSelect field');
  }
  if (expectedSalary.kind !== 'salaryRange') {
    assert.fail('expected_salary should be a salaryRange field');
  }

  assert.deepEqual(livingLocation.allowedValues, ['不限', '上海', '韩国', '新加坡', '深圳', '俄罗斯', '马来西亚', '德国', '浙江', '其他']);
  assert.deepEqual(workYears.allowedValues, ['不限', '应届生', '1-3年', '3-5年', '5-10年', '10年以上']);
  assert.equal(workYears.customInput?.label, '自定义');
  assert.deepEqual(expectedSalary.minOptions, ['不限', '10万', '20万', '30万', '40万', '50万']);
  assert.deepEqual(expectedSalary.maxOptions, ['不限', '10万', '20万', '30万', '40万', '50万']);
});
