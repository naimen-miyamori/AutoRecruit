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

function rootOptionLabels(catalog: SearchFilterCatalog, label: string): string[] {
  return catalog.filters
    .find((filter) => filter.label === label)
    ?.options
    ?.filter((option) => (option.depth ?? 0) === 0)
    .map((option) => option.label) ?? [];
}

test('liepin filter normalization splits visible filter text into application fields', async () => {
  const page = createEvaluatePage([
    '清空筛选条件',
    '目前城市：不限上海韩国新加坡深圳俄罗斯马来西亚德国浙江其他',
    '期望城市：不限上海深圳东莞江苏孝感北京苏州河北其他',
    '工作年限：不限应届生1-3年3-5年5-10年10年以上自定义确 定',
    '教育经历：不限本科硕士博士/博士后大专中专/中技高中及以下',
    '期望年薪：目前年薪：',
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
    '目前薪资',
  ]);
  assert.deepEqual(options.fieldIds, [
    'work_years',
    'education',
    'living_location',
    'expected_location',
    'expected_salary',
    'current_salary',
  ]);
  assert.deepEqual(options.groups.textInput, ['living_location', 'expected_location']);
  assert.deepEqual(options.groups.singleSelect, ['work_years', 'education']);
  assert.deepEqual(options.groups.salaryRange, ['expected_salary', 'current_salary']);

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
  assert.equal(options.fieldIdByLabel.期望薪资, 'expected_salary');
  assert.deepEqual(
    catalog.filters.find((filter) => filter.label === '期望薪资')?.selectorHints
      .filter((hint) => hint.kind === 'text')
      .map((hint) => hint.value),
    ['期望年薪', '期望薪资'],
  );
  assert.deepEqual(expectedSalary.minOptions, ['不限', '10万', '20万', '30万', '40万', '50万']);
  assert.deepEqual(expectedSalary.maxOptions, ['不限', '10万', '20万', '30万', '40万', '50万']);
});

test('liepin filter normalization captures expanded visible search filters', async () => {
  const page = createEvaluatePage([
    '职位名称： 全部 公司名称： 搜索公司 全部',
    '清空筛选条件',
    '目前城市： 不限 上海 韩国 新加坡 深圳 俄罗斯 马来西亚 德国 浙江 其他',
    '期望城市： 不限 上海 深圳 东莞 江苏 孝感 北京 苏州 河北 其他',
    '工作年限： 不限 应届生 1-3年 3-5年 5-10年 10年以上 自定义',
    '教育经历： 不限 本科 硕士 博士/博士后 大专 中专/中技 高中及以下',
    '统招要求： 统招/非统招（不限）',
    '院校要求： 不限 211 985 双一流 海外留学',
    '当前行业： 不限 当前职位： 不限',
    '年 龄： 活跃度： 不限 今天活跃 3天内活跃 7天内活跃 30天内活跃 最近三个月活跃 最近半年活跃 最近一年活跃 性 别： 不限 男 女 跳槽频率（不限） 近5年不超过3段 近3年不超过2段 近2段均不低于2年',
    '语 言： 不限 普通话 英语 日语 法语 粤语 其他',
    '期望年薪： 目前年薪：',
    '期望行业： 不限 期望职位： 不限',
    '毕业院校： 请输入学校名称 专业名称： 请输入专业名称',
    '其 他： 求职状态（不限） 离职，正在找工作 在职，急寻新工作 在职，看看新机会 在职，暂无跳槽打算 简历语言（不限） 中文简历 英文简历 海外工作经验 管理经验',
    '保存条件',
  ].join(' '));

  const staticResult = await discoverLiepinStaticSearchFilters(page, {
    keyword: '优衣库',
    maxDepth: 2,
    maxOptionsPerLevel: 50,
  });
  const catalog = mergeLiepinSearchFilterCatalog(createGenericLiepinCatalog(), staticResult.filters);
  const options = buildApplicationFilterOptions(catalog);

  assert.deepEqual(catalog.filters.map((filter) => filter.label), [
    '职位名称',
    '公司名称',
    '目前城市',
    '期望城市',
    '工作经验',
    '教育经历',
    '统招要求',
    '院校要求',
    '当前行业',
    '当前职位',
    '年龄',
    '活跃度',
    '性别',
    '跳槽频率',
    '语言',
    '期望薪资',
    '目前薪资',
    '期望行业',
    '期望职位',
    '毕业院校',
    '专业名称',
    '求职状态',
    '简历语言',
    '海外工作经验',
    '管理经验',
  ]);
  assert.deepEqual(options.fieldIds, [
    'work_years',
    'education',
    'recruitment_type',
    'school_nature',
    'recent_activity_time',
    'gender',
    'job_hopping_count',
    'language',
    'job_status',
    'resume_language',
    'overseas_work_experience',
    'management_experience',
    'keyword_title',
    'company_name',
    'living_location',
    'expected_location',
    'engaged_industry',
    'engaged_function',
    'expected_industry',
    'expected_function',
    'school_name',
    'major',
    'expected_salary',
    'current_salary',
    'age',
  ]);
  assert.deepEqual(options.groups.salaryRange, ['expected_salary', 'current_salary']);
  assert.deepEqual(options.groups.numberRange, ['age']);
  assert.deepEqual(options.fieldsById.school_nature.kind, 'singleSelect');
  assert.deepEqual(options.fieldsById.engaged_industry.kind, 'textInput');
  if (options.fieldsById.engaged_industry.kind !== 'textInput') {
    assert.fail('engaged_industry should be a textInput field');
  }
  if (options.fieldsById.expected_industry.kind !== 'textInput') {
    assert.fail('expected_industry should be a textInput field');
  }
  assert.deepEqual(options.fieldsById.engaged_industry.allowedValues, ['不限', '电子商务', '新零售']);
  assert.deepEqual(options.fieldsById.expected_industry.allowedValues, ['不限', '电子商务', '新零售']);
  assert.deepEqual(options.fieldsById.current_salary.kind, 'salaryRange');
  assert.deepEqual(options.fieldsById.age.kind, 'numberRange');
  assert.deepEqual(rootOptionLabels(catalog, '职位名称'), ['请输入职位名称']);
  assert.deepEqual(rootOptionLabels(catalog, '公司名称'), ['请输入公司名称']);
  assert.deepEqual(rootOptionLabels(catalog, '教育经历'), ['不限', '本科', '硕士', '博士/博士后', '大专', '中专/中技', '高中及以下']);
  assert.deepEqual(rootOptionLabels(catalog, '统招要求'), ['统招/非统招（不限）']);
  assert.deepEqual(rootOptionLabels(catalog, '年龄'), ['不限', '20岁', '25岁', '30岁', '35岁', '40岁', '45岁', '50岁']);
  assert.deepEqual(rootOptionLabels(catalog, '活跃度'), ['不限', '今天活跃', '3天内活跃', '7天内活跃', '30天内活跃', '最近三个月活跃', '最近半年活跃', '最近一年活跃']);
  assert.deepEqual(rootOptionLabels(catalog, '性别'), ['不限', '男', '女']);
  assert.deepEqual(rootOptionLabels(catalog, '跳槽频率'), ['跳槽频率（不限）', '近5年不超过3段', '近3年不超过2段', '近2段均不低于2年']);
  assert.deepEqual(rootOptionLabels(catalog, '求职状态'), ['离职，正在找工作', '在职，急寻新工作', '在职，看看新机会', '在职，暂无跳槽打算']);
  assert.deepEqual(rootOptionLabels(catalog, '简历语言'), ['简历语言（不限）', '中文简历', '英文简历']);
  assert.deepEqual(rootOptionLabels(catalog, '管理经验'), ['不限', '有管理经验']);
  assert.equal(rootOptionLabels(catalog, '年龄').includes('跳槽频率（不限）'), false);
  assert.equal(rootOptionLabels(catalog, '管理经验').includes('3-5年'), false);
});
