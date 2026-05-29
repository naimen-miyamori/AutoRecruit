import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTextInputPool,
  buildTextInputPoolMap,
  findTextInputPoolNode,
  findTextInputPool,
  listTextInputPoolChildValues,
  listTextInputPools,
} from '../search/filter-input-pool.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

const catalogFixture: SearchFilterCatalog = {
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
        { label: '互联网/IT/电子/通信', value: '互联网/IT/电子/通信', depth: 0, pathLabels: ['互联网/IT/电子/通信'] },
        { label: '金融', value: '金融', depth: 0, pathLabels: ['金融'] },
        { label: '通用子类', value: '通用子类', depth: 1, parentPathLabels: ['互联网/IT/电子/通信'], pathLabels: ['互联网/IT/电子/通信', '通用子类'] },
        { label: '银行', value: '银行', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '银行'] },
        { label: '基金', value: '基金', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '基金'] },
        { label: '通用子类', value: '通用子类', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '通用子类'] },
        { label: '基金', value: '基金', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '基金'] },
        { label: '禁用项', value: '禁用项', depth: 1, parentPathLabels: ['金融'], pathLabels: ['金融', '禁用项'], disabled: true },
      ],
    },
    {
      key: 'location-filter',
      label: '居住地',
      controlType: 'textInput',
      valueShape: 'string',
      status: 'optionsExtracted',
      selectorHints: [],
      options: [
        { label: '广东省', value: '广东省', depth: 0, pathLabels: ['广东省'] },
        { label: '深圳', value: '深圳', depth: 1, parentPathLabels: ['广东省'], pathLabels: ['广东省', '深圳'] },
        { label: '南山区', value: '南山区', depth: 2, parentPathLabels: ['广东省', '深圳'], pathLabels: ['广东省', '深圳', '南山区'] },
      ],
    },
    {
      key: 'education-filter',
      label: '学历要求',
      controlType: 'cascadeSelect',
      valueShape: 'object',
      status: 'optionsExtracted',
      selectorHints: [],
      options: [
        { label: '本科', value: '本科', depth: 0 },
      ],
    },
  ],
  failures: [],
  stats: {
    discoveredControls: 3,
    inspectedControls: 3,
    optionsExtracted: 10,
    failedControls: 0,
    unknownControls: 0,
  },
};

describe('filter input pool helpers', () => {
  it('builds a text-input pool with flat and per-depth values', () => {
    const pool = buildTextInputPool(catalogFixture.filters[0]);
    assert.deepEqual(pool, {
      key: 'industry-filter',
      label: '期望行业',
      inputPlaceholder: '请输入',
      childrenLazy: true,
      optionCount: 5,
      values: ['互联网/IT/电子/通信', '金融', '通用子类', '银行', '基金'],
      valuesByDepth: [
        { depth: 0, values: ['互联网/IT/电子/通信', '金融'] },
        { depth: 1, values: ['通用子类', '银行', '基金'] },
      ],
      tree: [
        {
          key: '互联网/IT/电子/通信',
          label: '互联网/IT/电子/通信',
          depth: 0,
          pathLabels: ['互联网/IT/电子/通信'],
          children: [{
            key: '互联网/IT/电子/通信\u0000通用子类',
            label: '通用子类',
            depth: 1,
            pathLabels: ['互联网/IT/电子/通信', '通用子类'],
            children: [],
          }],
        },
        {
          key: '金融',
          label: '金融',
          depth: 0,
          pathLabels: ['金融'],
          children: [
            {
              key: '金融\u0000银行',
              label: '银行',
              depth: 1,
              pathLabels: ['金融', '银行'],
              children: [],
            },
            {
              key: '金融\u0000基金',
              label: '基金',
              depth: 1,
              pathLabels: ['金融', '基金'],
              children: [],
            },
            {
              key: '金融\u0000通用子类',
              label: '通用子类',
              depth: 1,
              pathLabels: ['金融', '通用子类'],
              children: [],
            },
          ],
        },
      ],
    });
  });

  it('lists and maps only text-input filters with extracted options', () => {
    const pools = listTextInputPools(catalogFixture);
    assert.equal(pools.length, 2);
    assert.deepEqual(pools.map((pool) => pool.label), ['期望行业', '居住地']);

    const poolMap = buildTextInputPoolMap(catalogFixture);
    assert.deepEqual(Object.keys(poolMap), ['期望行业', '居住地']);
    assert.equal(poolMap.居住地.valuesByDepth[2]?.values[0], '南山区');
    assert.deepEqual(poolMap.期望行业.tree.map((node) => node.label), ['互联网/IT/电子/通信', '金融']);
  });

  it('finds a pool by label', () => {
    assert.equal(findTextInputPool(catalogFixture, '期望行业')?.optionCount, 5);
    assert.equal(findTextInputPool(catalogFixture, '不存在的字段'), undefined);
  });

  it('finds pool nodes and child values by parent path', () => {
    const pool = findTextInputPool(catalogFixture, '期望行业');
    assert(pool);
    assert.deepEqual(listTextInputPoolChildValues(pool), ['互联网/IT/电子/通信', '金融']);
    assert.deepEqual(listTextInputPoolChildValues(pool, ['金融']), ['银行', '基金', '通用子类']);
    assert.deepEqual(findTextInputPoolNode(pool, ['互联网/IT/电子/通信', '通用子类'])?.pathLabels, ['互联网/IT/电子/通信', '通用子类']);
    assert.deepEqual(findTextInputPoolNode(pool, ['金融', '通用子类'])?.pathLabels, ['金融', '通用子类']);
  });
});
