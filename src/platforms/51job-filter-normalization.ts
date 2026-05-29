import type {
  SearchFilterDefinition,
  SearchFilterOption,
  SearchFilterOptionInputSpec,
} from '../search/filter-catalog.js';
import { buildFilterKey } from '../search/filter-dom.js';

const recentActivityTimeContainerPattern = /近1周\s+近2周\s+近1个月\s+近2个月\s+近6个月\s+近1年\s+1年及以上/;
const noisyAggregateTextPattern = /取\s*消|确\s*定|请选择|获得更好的推荐|基础信息|期望\/经历|其他筛选|选择现居地|选择行业|选择职能|选择专业/;

const suffixDelimitedOptionLabels = new Set([
  '工作年限',
  '年龄',
  '学历要求',
  '学校性质',
  '毕业时间',
  '语言要求',
  '公司性质',
]);

const fixedOptionValueMap: Record<string, string[]> = {
  求职状态: ['不限', '离职-周内到岗', '在职-月内到岗', '在职-观望机会'],
  工作类型: ['不限', '全职', '兼职', '实习'],
  跳槽次数: ['不限', '5年内跳槽次数<3次', '最近一份工作>1年'],
  性别: ['不限', '男', '女'],
};

const languageLevelLabelsByRoot: Record<string, string[]> = {
  英语: [
    '大学英语四级及以上',
    '大学英语六级及以上',
    '英语专业四级及以上',
    '英语专业八级',
    '简单沟通/读写（一般）',
    '读写熟练（良好/熟练）',
    '听说读写流利（精通）',
  ],
};

const singleLayerControlLabels = new Set([
  '工作年限',
  '年龄',
  '学历要求',
  '学校性质',
  '求职状态',
  '最近活跃时间',
  '毕业时间',
  '语言要求',
  '工作类型',
  '公司性质',
  '跳槽次数',
  '性别',
]);

const customInputSpecByFilterLabel: Record<string, SearchFilterOptionInputSpec> = {
  工作年限: {
    kind: 'numberRange',
    confirmLabel: '确定',
    unit: '年',
    fields: [
      { key: 'min', valueType: 'number', placeholder: '最低' },
      { key: 'max', valueType: 'number', placeholder: '最高' },
    ],
  },
  年龄: {
    kind: 'numberRange',
    confirmLabel: '确定',
    unit: '岁',
    fields: [
      { key: 'min', valueType: 'number', placeholder: '最低' },
      { key: 'max', valueType: 'number', placeholder: '最高' },
    ],
  },
  学历要求: {
    kind: 'selectRange',
    confirmLabel: '确定',
    fields: [
      { key: 'min', valueType: 'string', label: '最低学历' },
      { key: 'max', valueType: 'string', label: '最高学历' },
    ],
  },
  毕业时间: {
    kind: 'numberRange',
    confirmLabel: '确定',
    fields: [
      { key: 'min', valueType: 'number', placeholder: '最低' },
      { key: 'max', valueType: 'number', placeholder: '最高' },
    ],
  },
};

export function normalize51jobFilterText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function dedupeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const label of labels) {
    const normalized = normalize51jobFilterText(label);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function compareSourceTextPriority(left: string, right: string): number {
  const leftIsNoisy = noisyAggregateTextPattern.test(left);
  const rightIsNoisy = noisyAggregateTextPattern.test(right);
  if (leftIsNoisy !== rightIsNoisy) {
    return leftIsNoisy ? 1 : -1;
  }

  const leftTokenCount = left.split(' ').filter(Boolean).length;
  const rightTokenCount = right.split(' ').filter(Boolean).length;
  const leftIsAggregate = leftTokenCount > 1;
  const rightIsAggregate = rightTokenCount > 1;
  if (leftIsAggregate !== rightIsAggregate) {
    return leftIsAggregate ? -1 : 1;
  }

  return left.length - right.length;
}

function collectSourceTexts(filter: SearchFilterDefinition): string[] {
  const optionTexts = (filter.options ?? []).flatMap((option) => [
    option.label,
    option.value,
  ].filter((value): value is string => typeof value === 'string'));
  const texts = dedupeLabels([
    ...optionTexts,
    ...((filter.selectorHints ?? []).map((hint) => hint.value)),
  ]);

  return texts.sort(compareSourceTextPriority);
}

function extractDelimitedOptions(sourceTexts: readonly string[], label: string): string[] {
  for (const sourceText of sourceTexts) {
    if (sourceText === label || !sourceText.endsWith(label)) {
      continue;
    }

    const optionText = normalize51jobFilterText(sourceText.slice(0, sourceText.length - label.length));
    if (!optionText) {
      continue;
    }

    const options = dedupeLabels(optionText.split(' '));
    if (options.length >= 2) {
      return options;
    }
  }

  return [];
}

function extractUniqueRegexMatches(sourceTexts: readonly string[], pattern: RegExp): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const expression = new RegExp(pattern.source, flags);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const sourceText of sourceTexts) {
    expression.lastIndex = 0;
    for (const match of sourceText.matchAll(expression)) {
      const value = normalize51jobFilterText(match[0]);
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      matches.push(value);
    }
  }

  return matches;
}

function extractFixedOptions(sourceTexts: readonly string[], values: readonly string[]): string[] {
  return values.filter((value) => sourceTexts.some((sourceText) => sourceText.includes(value)));
}

function extractNormalizedOptionLabels(filter: SearchFilterDefinition): string[] {
  const sourceTexts = collectSourceTexts(filter);

  if (sourceTexts.length === 0) {
    return [];
  }

  if (suffixDelimitedOptionLabels.has(filter.label)) {
    return extractDelimitedOptions(sourceTexts, filter.label);
  }

  if (filter.label === '最近活跃时间') {
    return extractUniqueRegexMatches(sourceTexts, /近1周|近2周|近1个月|近2个月|近6个月|近1年|1年及以上/g);
  }

  if (fixedOptionValueMap[filter.label]) {
    return extractFixedOptions(sourceTexts, fixedOptionValueMap[filter.label]);
  }

  return [];
}

function inferOptionDepth(options: readonly SearchFilterOption[] | undefined): number | undefined {
  return options?.find((option) => typeof option.depth === 'number')?.depth;
}

function buildNormalizedOption(
  filter: SearchFilterDefinition,
  label: string,
): SearchFilterOption {
  const inputSpec = label === '自定义'
    ? customInputSpecByFilterLabel[filter.label]
    : undefined;
  const matchedOption = filter.options?.find((option) => normalize51jobFilterText(option.label) === label);
  if (matchedOption) {
    return {
      label,
      value: normalize51jobFilterText(matchedOption.value) || label,
      depth: matchedOption.depth,
      disabled: matchedOption.disabled,
      selected: matchedOption.selected,
      parentPathLabels: matchedOption.parentPathLabels,
      pathLabels: matchedOption.pathLabels,
      children: matchedOption.children,
      message: matchedOption.message,
      inputSpec,
    };
  }

  return {
    label,
    value: label,
    depth: inferOptionDepth(filter.options),
    disabled: false,
    selected: false,
    inputSpec,
  };
}

function normalizePollutedSingleLayerOptions(filter: SearchFilterDefinition): SearchFilterDefinition {
  if (filter.controlType !== 'cascadeSelect' || !filter.options || filter.options.length === 0) {
    return filter;
  }

  const optionLabels = extractNormalizedOptionLabels(filter);
  if (optionLabels.length === 0) {
    return filter;
  }

  return {
    ...filter,
    controlType: singleLayerControlLabels.has(filter.label) ? 'singleSelect' : filter.controlType,
    valueShape: singleLayerControlLabels.has(filter.label) ? 'string' : filter.valueShape,
    status: 'optionsExtracted',
    options: optionLabels.map((label) => buildNormalizedOption(filter, label)),
  };
}

function enrichNormalizedSingleLayerOptions(filter: SearchFilterDefinition): SearchFilterDefinition {
  if (!singleLayerControlLabels.has(filter.label) || !filter.options || filter.options.length === 0) {
    return filter;
  }

  if (filter.controlType !== 'singleSelect' || filter.status !== 'optionsExtracted') {
    return filter;
  }

  return {
    ...filter,
    valueShape: 'string',
    options: filter.options.map((option) => (
      option.label === '自定义'
        ? {
          ...option,
          value: normalize51jobFilterText(option.value) || option.label,
          inputSpec: customInputSpecByFilterLabel[filter.label],
        }
        : option
    )),
  };
}

export function normalize51jobFilterDefinition(filter: SearchFilterDefinition): SearchFilterDefinition {
  const normalizedContainerText = filter.selectorHints
    .find((hint) => hint.kind === 'containerText')
    ?.value ?? '';

  if (filter.label === '近1年' && recentActivityTimeContainerPattern.test(normalizedContainerText)) {
    filter = {
      ...filter,
      key: buildFilterKey('最近活跃时间', '51job-recent-activity-time'),
      label: '最近活跃时间',
    };
  }

  const normalizedFilter = enrichNormalizedSingleLayerOptions(normalizePollutedSingleLayerOptions(filter));

  if (normalizedFilter.label !== '语言要求' || !normalizedFilter.options || normalizedFilter.options.length === 0) {
    return normalizedFilter;
  }

  const options = normalizedFilter.options.flatMap((option) => {
    const languageLevelLabels = languageLevelLabelsByRoot[normalize51jobFilterText(option.label)];
    if (!languageLevelLabels) {
      return [option];
    }

    return languageLevelLabels.map((label) => ({
      ...option,
      label,
      value: label,
      depth: 1,
      parentPathLabels: [normalize51jobFilterText(option.label)],
      pathLabels: [normalize51jobFilterText(option.label), label],
      inputSpec: undefined,
    }));
  });

  return {
    ...normalizedFilter,
    childrenLazy: true,
    options,
  };
}
