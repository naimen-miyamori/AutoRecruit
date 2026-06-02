import type {
  SearchFilterCatalog,
  SearchFilterDefinition,
  SearchFilterDiscoveryFailure,
  SearchFilterDiscoveryRunOptions,
  SearchFilterOption,
  SearchFilterOptionInputSpec,
} from '../search/filter-catalog.js';
import { buildSearchFilterDiscoveryStats } from '../search/filter-catalog.js';

type LiepinStaticFilterKind = 'singleSelect' | 'textInput' | 'salaryRange';

interface LiepinStaticFilterTarget {
  label: string;
  kind: LiepinStaticFilterKind;
  aliases: string[];
}

export interface LiepinVisibleFilterRow {
  label: string;
  text: string;
  options: string[];
  selectorHint?: string;
}

const customWorkYearsInputSpec: SearchFilterOptionInputSpec = {
  kind: 'numberRange',
  confirmLabel: '确定',
  unit: '年',
  fields: [
    { key: 'min', valueType: 'number', placeholder: '最低' },
    { key: 'max', valueType: 'number', placeholder: '最高' },
  ],
};

const liepinDefaultAnnualSalaryOptions = ['不限', '10万', '20万', '30万', '40万', '50万'];
const liepinDefaultAgeOptions = ['不限', '20岁', '25岁', '30岁', '35岁', '40岁', '45岁', '50岁'];
const liepinDefaultActivityOptions = ['不限', '今天活跃', '3天内活跃', '7天内活跃', '30天内活跃', '最近三个月活跃', '最近半年活跃', '最近一年活跃'];
const liepinDefaultGenderOptions = ['不限', '男', '女'];
const liepinDefaultJobHoppingOptions = ['跳槽频率（不限）', '近5年不超过3段', '近3年不超过2段', '近2段均不低于2年'];
const liepinDefaultJobStatusOptions = ['离职，正在找工作', '在职，急寻新工作', '在职，看看新机会', '在职，暂无跳槽打算'];
const liepinDefaultResumeLanguageOptions = ['简历语言（不限）', '中文简历', '英文简历'];
const liepinBooleanOptionLabelsByLabel: Record<string, string[]> = {
  海外工作经验: ['不限', '有海外工作经验'],
  管理经验: ['不限', '有管理经验'],
};
const liepinTextInputPlaceholderOptionsByLabel: Record<string, string[]> = {
  职位名称: ['请输入职位名称'],
  公司名称: ['请输入公司名称'],
  当前行业: ['不限', '电子商务', '新零售'],
  当前职位: ['不限', '店长/卖场管理', '店长', '门店店长', '销售/客服', '运营'],
  期望行业: ['不限', '电子商务', '新零售'],
  期望职位: ['不限', '店长/卖场管理', '店长', '门店店长', '销售/客服', '运营'],
  毕业院校: ['请输入学校名称'],
  专业名称: ['请输入专业名称'],
};
const liepinForcedPlaceholderTextInputLabels = new Set(['职位名称', '公司名称']);

const liepinStaticFilterTargets: LiepinStaticFilterTarget[] = [
  {
    label: '职位名称',
    kind: 'textInput',
    aliases: ['职位名称'],
  },
  {
    label: '公司名称',
    kind: 'textInput',
    aliases: ['公司名称'],
  },
  {
    label: '目前城市',
    kind: 'textInput',
    aliases: ['目前城市', '当前城市', '所在城市', '所在地区'],
  },
  {
    label: '期望城市',
    kind: 'textInput',
    aliases: ['期望城市', '意向城市'],
  },
  {
    label: '工作经验',
    kind: 'singleSelect',
    aliases: ['工作经验', '工作年限', '工作年限要求'],
  },
  {
    label: '教育经历',
    kind: 'singleSelect',
    aliases: ['教育经历', '学历', '学历要求'],
  },
  {
    label: '统招要求',
    kind: 'singleSelect',
    aliases: ['统招要求', '统招/非统招'],
  },
  {
    label: '院校要求',
    kind: 'singleSelect',
    aliases: ['院校要求', '学校要求', '学校性质'],
  },
  {
    label: '当前行业',
    kind: 'textInput',
    aliases: ['当前行业', '从事行业'],
  },
  {
    label: '当前职位',
    kind: 'textInput',
    aliases: ['当前职位', '当前职能', '从事职能'],
  },
  {
    label: '年龄',
    kind: 'singleSelect',
    aliases: ['年龄', '年 龄'],
  },
  {
    label: '活跃度',
    kind: 'singleSelect',
    aliases: ['活跃度', '最近活跃时间'],
  },
  {
    label: '性别',
    kind: 'singleSelect',
    aliases: ['性别', '性 别'],
  },
  {
    label: '跳槽频率',
    kind: 'singleSelect',
    aliases: ['跳槽频率', '跳槽次数'],
  },
  {
    label: '语言',
    kind: 'singleSelect',
    aliases: ['语言', '语 言', '语言能力', '语言要求'],
  },
  {
    label: '期望薪资',
    kind: 'salaryRange',
    aliases: ['期望薪资', '期望月薪', '期望年薪'],
  },
  {
    label: '目前薪资',
    kind: 'salaryRange',
    aliases: ['目前薪资', '当前薪资', '目前年薪', '当前年薪'],
  },
  {
    label: '期望行业',
    kind: 'textInput',
    aliases: ['期望行业', '意向行业'],
  },
  {
    label: '期望职位',
    kind: 'textInput',
    aliases: ['期望职位', '期望职能', '意向职位', '意向职能'],
  },
  {
    label: '毕业院校',
    kind: 'textInput',
    aliases: ['毕业院校', '毕业学校', '学校名称'],
  },
  {
    label: '专业名称',
    kind: 'textInput',
    aliases: ['专业名称', '专业'],
  },
  {
    label: '求职状态',
    kind: 'singleSelect',
    aliases: ['求职状态'],
  },
  {
    label: '简历语言',
    kind: 'singleSelect',
    aliases: ['简历语言'],
  },
  {
    label: '海外工作经验',
    kind: 'singleSelect',
    aliases: ['海外工作经验'],
  },
  {
    label: '管理经验',
    kind: 'singleSelect',
    aliases: ['管理经验'],
  },
];

const liepinBodyTextBoundaryLabels = [
  '清空筛选条件',
  '收起更多条件',
  '保存条件',
  '全选',
  '批量查看',
  '隐藏已查看',
  '隐藏已沟通',
  '隐藏已获取联系方式',
  '共',
];

const knownOptionLabels = [
  '不限',
  '其他',
  '应届生',
  '1-3年',
  '3-5年',
  '5-10年',
  '10年以上',
  '自定义',
  '本科',
  '硕士',
  '博士/博士后',
  '博士',
  '博士后',
  '大专',
  '中专/中技',
  '中专',
  '中技',
  '高中及以下',
  '高中',
  '初中及以下',
  '统招/非统招（不限）',
  '统招',
  '非统招',
  '统招本科',
  'MBA/EMBA',
  '211',
  '985',
  '双一流',
  '海外留学',
  '男',
  '女',
  '普通话',
  '英语',
  '日语',
  '法语',
  '粤语',
  '离职，正在找工作',
  '在职，急寻新工作',
  '在职，看看新机会',
  '在职，暂无跳槽打算',
  '简历语言（不限）',
  '中文简历',
  '英文简历',
  '海外工作经验',
  '管理经验',
  '跳槽频率（不限）',
  '近5年不超过3段',
  '近3年不超过2段',
  '近2段均不低于2年',
  '今天活跃',
  '3天内活跃',
  '7天内活跃',
  '30天内活跃',
  '最近三个月活跃',
  '最近半年活跃',
  '最近一年活跃',
  '在线',
  '上海',
  '北京',
  '深圳',
  '广州',
  '杭州',
  '苏州',
  '南京',
  '东莞',
  '孝感',
  '江苏',
  '浙江',
  '广东',
  '河北',
  '韩国',
  '新加坡',
  '俄罗斯',
  '马来西亚',
  '德国',
];

function normalizeLiepinFilterText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeCompactText(value: string | undefined): string {
  return normalizeLiepinFilterText(value).replace(/\s+/g, '');
}

function uniqueNormalized(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalizedValue = normalizeLiepinFilterText(value);
    if (!normalizedValue || seen.has(normalizedValue)) {
      continue;
    }

    seen.add(normalizedValue);
    result.push(normalizedValue);
  }

  return result;
}

function createLiepinFilterKey(label: string): string {
  return `liepin-${label.replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '')}-filter`;
}

function createSelectorHints(row: LiepinVisibleFilterRow, label: string): SearchFilterDefinition['selectorHints'] {
  const rowLabel = normalizeLiepinFilterText(row.label).replace(/[:：]$/, '');
  return [
    { kind: 'text', value: rowLabel || label },
    ...(rowLabel && rowLabel !== label ? [{ kind: 'text' as const, value: label }] : []),
    { kind: 'containerText', value: row.text.slice(0, 160) },
    ...(row.selectorHint ? [{ kind: 'cssPath' as const, value: row.selectorHint }] : []),
  ];
}

function inferWorkYearsInputSpec(label: string): SearchFilterOptionInputSpec | undefined {
  return label === '自定义' ? customWorkYearsInputSpec : undefined;
}

function toSingleSelectOption(label: string, filterLabel: string): SearchFilterOption {
  return {
    label,
    value: label,
    depth: 0,
    inputSpec: filterLabel === '工作经验' ? inferWorkYearsInputSpec(label) : undefined,
  };
}

function toTextInputOption(label: string): SearchFilterOption {
  return {
    label,
    depth: 0,
    pathLabels: [label],
  };
}

function toRangeOptions(options: readonly string[]): SearchFilterOption[] {
  const rangeOptions = uniqueNormalized(options);
  const result: SearchFilterOption[] = rangeOptions.map((label) => ({
    label,
    value: label,
    depth: 0,
    pathLabels: [label],
  }));

  for (const minLabel of rangeOptions) {
    for (const maxLabel of rangeOptions) {
      result.push({
        label: maxLabel,
        value: maxLabel,
        depth: 1,
        parentPathLabels: [minLabel],
        pathLabels: [minLabel, maxLabel],
      });
    }
  }

  return result;
}

function parseSalaryAmount(label: string): number | undefined {
  const normalizedLabel = normalizeCompactText(label);
  if (normalizedLabel === '不限') {
    return 0;
  }

  const matched = normalizedLabel.match(/^(\d+(?:\.\d+)?)(千|万)$/);
  if (!matched) {
    return undefined;
  }

  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return matched[2] === '万' ? amount * 10000 : amount * 1000;
}

function listSalaryOptions(options: readonly string[]): string[] {
  const salaryOptions = uniqueNormalized(options)
    .filter((option) => parseSalaryAmount(option) !== undefined)
    .sort((left, right) => (parseSalaryAmount(left) ?? 0) - (parseSalaryAmount(right) ?? 0));

  return salaryOptions;
}

function filterKnownOptions(options: readonly string[], allowedOptions: readonly string[]): string[] {
  const allowed = new Set(allowedOptions);
  return uniqueNormalized(options).filter((option) => allowed.has(option));
}

function filterLiepinActivityOptions(options: readonly string[]): string[] {
  const visibleOptions = uniqueNormalized(options).filter((option) =>
    option === '不限' || (/活跃|在线/.test(option) && !option.includes('跳槽')),
  );
  return uniqueNormalized([...visibleOptions, ...liepinDefaultActivityOptions]);
}

function filterLiepinAgeOptions(options: readonly string[]): string[] {
  const visibleAgeOptions = uniqueNormalized(options).filter((option) => option === '不限' || /^\d+(?:\.\d+)?岁$/.test(option));
  return uniqueNormalized([...visibleAgeOptions, ...liepinDefaultAgeOptions]);
}

function filterLiepinJobHoppingOptions(options: readonly string[]): string[] {
  const visibleOptions = filterKnownOptions(options, ['不限', ...liepinDefaultJobHoppingOptions])
    .map((option) => option === '不限' ? '跳槽频率（不限）' : option);
  return uniqueNormalized([...visibleOptions, ...liepinDefaultJobHoppingOptions]);
}

function filterLiepinResumeLanguageOptions(options: readonly string[]): string[] {
  const visibleOptions = filterKnownOptions(options, ['不限', ...liepinDefaultResumeLanguageOptions])
    .map((option) => option === '不限' ? '简历语言（不限）' : option);
  return uniqueNormalized([...visibleOptions, ...liepinDefaultResumeLanguageOptions]);
}

function cleanLiepinStaticOptions(target: LiepinStaticFilterTarget, options: readonly string[]): string[] {
  if (liepinBooleanOptionLabelsByLabel[target.label]) {
    return liepinBooleanOptionLabelsByLabel[target.label];
  }

  if (target.kind === 'textInput' && (liepinForcedPlaceholderTextInputLabels.has(target.label) || target.label in liepinTextInputPlaceholderOptionsByLabel)) {
    return liepinTextInputPlaceholderOptionsByLabel[target.label] ?? [];
  }

  switch (target.label) {
    case '工作经验':
      return filterKnownOptions(options, ['不限', '应届生', '1-3年', '3-5年', '5-10年', '10年以上', '自定义']);
    case '教育经历':
      return filterKnownOptions(options, [
        '不限',
        '本科',
        '硕士',
        '博士/博士后',
        '博士',
        '博士后',
        '大专',
        '中专/中技',
        '中专',
        '中技',
        '高中及以下',
        '高中',
        '初中及以下',
        'MBA/EMBA',
      ]);
    case '统招要求':
      return options.includes('统招/非统招（不限）')
        ? ['统招/非统招（不限）']
        : filterKnownOptions(options, ['统招', '非统招', '统招本科']);
    case '院校要求':
      return filterKnownOptions(options, ['不限', '211', '985', '双一流', '海外留学']);
    case '年龄':
      return filterLiepinAgeOptions(options);
    case '活跃度':
      return filterLiepinActivityOptions(options);
    case '性别':
      return uniqueNormalized([...filterKnownOptions(options, liepinDefaultGenderOptions), ...liepinDefaultGenderOptions]);
    case '跳槽频率':
      return filterLiepinJobHoppingOptions(options);
    case '语言':
      return filterKnownOptions(options, ['不限', '普通话', '英语', '日语', '法语', '粤语', '其他']);
    case '求职状态':
      return uniqueNormalized([...filterKnownOptions(options, liepinDefaultJobStatusOptions), ...liepinDefaultJobStatusOptions]);
    case '简历语言':
      return filterLiepinResumeLanguageOptions(options);
    default:
      return uniqueNormalized(options);
  }
}

function toSalaryOptions(options: readonly string[]): SearchFilterOption[] {
  const salaryOptions = listSalaryOptions(options);
  const result: SearchFilterOption[] = salaryOptions.map((label) => ({
    label,
    value: label,
    depth: 0,
    pathLabels: [label],
  }));

  for (const minLabel of salaryOptions) {
    const minAmount = parseSalaryAmount(minLabel);
    if (minAmount === undefined) {
      continue;
    }

    for (const maxLabel of salaryOptions) {
      const maxAmount = parseSalaryAmount(maxLabel);
      if (maxAmount === undefined || maxAmount < minAmount) {
        continue;
      }

      result.push({
        label: maxLabel,
        value: maxLabel,
        depth: 1,
        parentPathLabels: [minLabel],
        pathLabels: [minLabel, maxLabel],
      });
    }
  }

  return result;
}

function buildLiepinStaticFilter(
  target: LiepinStaticFilterTarget,
  row: LiepinVisibleFilterRow,
): SearchFilterDefinition | undefined {
  const rowOptions = uniqueNormalized(row.options)
    .filter((option) => !target.aliases.includes(option) && option !== `${row.label}：` && !/[:：]$/.test(option))
    .filter((option) => !/^请输入/.test(option) || target.kind === 'textInput')
    .filter((option) => !['down', '确 定', '确定'].includes(option));
  const cleanedOptions = cleanLiepinStaticOptions(target, rowOptions);
  const sourceOptions = target.kind === 'salaryRange' && listSalaryOptions(cleanedOptions).length === 0
    ? liepinDefaultAnnualSalaryOptions
    : target.kind === 'textInput' && cleanedOptions.length === 0
        ? liepinTextInputPlaceholderOptionsByLabel[target.label] ?? []
        : cleanedOptions;
  if (sourceOptions.length === 0) {
    return undefined;
  }

  if (target.kind === 'salaryRange') {
    const options = toSalaryOptions(sourceOptions);
    if (options.length === 0) {
      return undefined;
    }

    return {
      key: createLiepinFilterKey(target.label),
      label: target.label,
      controlType: 'cascadeSelect',
      valueShape: 'object',
      status: 'optionsExtracted',
      childrenLazy: false,
      selectorHints: createSelectorHints(row, target.label),
      options,
    };
  }

  if (target.label === '年龄') {
    return {
      key: createLiepinFilterKey(target.label),
      label: target.label,
      controlType: 'cascadeSelect',
      valueShape: 'object',
      status: 'optionsExtracted',
      childrenLazy: false,
      selectorHints: createSelectorHints(row, target.label),
      options: toRangeOptions(sourceOptions),
    };
  }

  if (target.kind === 'textInput') {
    return {
      key: createLiepinFilterKey(target.label),
      label: target.label,
      controlType: 'textInput',
      valueShape: 'string',
      status: 'optionsExtracted',
      childrenLazy: false,
      inputPlaceholder: target.label,
      selectorHints: createSelectorHints(row, target.label),
      options: sourceOptions.map(toTextInputOption),
    };
  }

  return {
    key: createLiepinFilterKey(target.label),
    label: target.label,
    controlType: 'singleSelect',
    valueShape: 'string',
    status: 'optionsExtracted',
    selectorHints: createSelectorHints(row, target.label),
    options: sourceOptions.map((option) => toSingleSelectOption(option, target.label)),
  };
}

function matchTargetLabel(label: string): LiepinStaticFilterTarget | undefined {
  const normalizedLabel = normalizeLiepinFilterText(label).replace(/[:：]$/, '');
  return liepinStaticFilterTargets.find((target) => target.aliases.includes(normalizedLabel));
}

function labelPatternForTarget(target: LiepinStaticFilterTarget): string {
  return target.aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

function splitKnownOptionsFromCompactText(value: string): string[] {
  const compactValue = normalizeCompactText(value);
  const knownLabels = [...knownOptionLabels]
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const salaryPattern = '\\d+(?:\\.\\d+)?[千万]';
  const pattern = new RegExp(`${salaryPattern}|${knownLabels.join('|')}`, 'g');
  return uniqueNormalized([...compactValue.matchAll(pattern)].map((match) => match[0]));
}

function parseRowsFromBodyText(bodyText: string): LiepinVisibleFilterRow[] {
  const compactBodyText = normalizeCompactText(bodyText);
  const rows: LiepinVisibleFilterRow[] = [];

  for (const target of liepinStaticFilterTargets) {
    const labelPattern = labelPatternForTarget(target);
    const nextLabelPattern = [
      ...liepinStaticFilterTargets
        .filter((item) => item !== target)
        .flatMap((item) => item.aliases),
      ...liepinBodyTextBoundaryLabels,
    ]
      .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const matched = compactBodyText.match(new RegExp(`(${labelPattern})[:：]?(.*?)(?=${nextLabelPattern ? `(?:${nextLabelPattern})[:：]?` : '$'}|$)`));
    if (!matched) {
      continue;
    }

    const label = matched[1] ?? target.label;
    const text = matched[0] ?? '';
    rows.push({
      label,
      text,
      options: splitKnownOptionsFromCompactText(text),
    });
  }

  return rows;
}

export async function readLiepinVisibleFilterRows(page: {
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
}): Promise<LiepinVisibleFilterRow[]> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
    const targets = [
      '职位名称',
      '公司名称',
      '目前城市',
      '当前城市',
      '所在城市',
      '所在地区',
      '期望城市',
      '意向城市',
      '工作经验',
      '工作年限',
      '工作年限要求',
      '教育经历',
      '学历',
      '学历要求',
      '统招要求',
      '院校要求',
      '当前行业',
      '当前职位',
      '年龄',
      '年 龄',
      '活跃度',
      '性别',
      '性 别',
      '跳槽频率',
      '语言',
      '语 言',
      '期望薪资',
      '期望月薪',
      '期望年薪',
      '目前薪资',
      '目前年薪',
      '当前薪资',
      '当前年薪',
      '期望行业',
      '期望职位',
      '毕业院校',
      '毕业学校',
      '专业名称',
      '专业',
      '求职状态',
      '简历语言',
      '其他',
      '其 他',
    ];
    const optionSelector = [
      'button',
      'a',
      'label',
      'span',
      'li',
      '[role="button"]',
      '[role="option"]',
      '.ant-radio-button-wrapper',
      '.ant-checkbox-wrapper',
      '.ant-select-selection-item',
      '.ant-select-selection-placeholder',
      '.ant-select-item-option-content',
    ].join(',');
    const rows: LiepinVisibleFilterRow[] = [];
    const seen = new Set<string>();

    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };

    const cssPath = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        const tagName = current.tagName.toLowerCase();
        const id = current.id ? `#${CSS.escape(current.id)}` : '';
        const className = Array.from(current.classList).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        parts.unshift(`${tagName}${id}${className}`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const findRowContainer = (element: Element): HTMLElement => {
      let current: HTMLElement | null = element.parentElement;
      let best = element.parentElement as HTMLElement;
      for (let depth = 0; current && depth < 7; depth += 1) {
        const text = normalize(current.innerText);
        if (text.length > 300) {
          break;
        }
        if (text.includes('：') || text.includes(':')) {
          best = current;
        }
        if (/ant-form-item|form-item|condition|filter|row|item/i.test(current.className.toString())) {
          best = current;
          break;
        }
        current = current.parentElement;
      }
      return best;
    };

    const pushRow = (label: string, container: HTMLElement): void => {
      const text = normalize(container.innerText);
      if (!text || text.length > 400) {
        return;
      }
      const options = Array.from(container.querySelectorAll(optionSelector))
        .filter((item) => item !== container && isVisible(item))
        .map((item) => normalize(
          (item as HTMLElement).innerText
          || item.getAttribute('placeholder')
          || item.getAttribute('title')
          || item.getAttribute('aria-label'),
        ))
        .filter((item) => item && item !== label && item !== `${label}：`);
      const key = `${label}\u0000${text}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      rows.push({
        label,
        text,
        options,
        selectorHint: cssPath(container),
      });
    };

    const pushTargetRowsFromContainer = (container: HTMLElement): void => {
      const text = normalize(container.innerText);
      if (!text) {
        return;
      }

      for (const target of targets) {
        if (!text.includes(`${target}：`) && !text.includes(`${target}:`) && !text.includes(`（${target}`)) {
          continue;
        }
        pushRow(target, container);
      }
    };

    const elements = Array.from(document.querySelectorAll('body *'))
      .filter((element) => isVisible(element))
      .filter((element) => {
        const text = normalize((element as HTMLElement).innerText || element.textContent);
        return targets.some((target) => text === target || text === `${target}：` || text === `${target}:`);
      });

    for (const element of elements) {
      const label = normalize((element as HTMLElement).innerText || element.textContent).replace(/[:：]$/, '');
      pushRow(label, findRowContainer(element));
    }

    const rowSelectors = [
      '.job-comp-condition',
      '.search-item',
      '.sfilter-other-condition',
      '.sfilter-salary',
      '.sfilter-other-prefer',
      'section.multiple-filter-box',
    ].join(',');
    for (const row of Array.from(document.querySelectorAll(rowSelectors)).filter(isVisible)) {
      pushTargetRowsFromContainer(row as HTMLElement);
    }

    return rows;
  });
}

function mergeLiepinRows(...rowGroups: LiepinVisibleFilterRow[][]): LiepinVisibleFilterRow[] {
  const rowsByTarget = new Map<string, LiepinVisibleFilterRow>();

  for (const rows of rowGroups) {
    for (const row of rows) {
      const target = matchTargetLabel(row.label);
      if (!target) {
        continue;
      }

      const current = rowsByTarget.get(target.label);
      if (!current || uniqueNormalized(row.options).length > uniqueNormalized(current.options).length) {
        rowsByTarget.set(target.label, row);
      }
    }
  }

  return Array.from(rowsByTarget.values());
}

function isLiepinStaticFilter(filter: SearchFilterDefinition): boolean {
  return Boolean(matchTargetLabel(filter.label));
}

function shouldKeepGenericLiepinFilter(filter: SearchFilterDefinition): boolean {
  const normalizedLabel = normalizeLiepinFilterText(filter.label);
  if (isLiepinStaticFilter(filter)) {
    return false;
  }

  if (/^(搜\s*索|批量查看|保存条件|button|combobox|不限|万|岁)$/.test(normalizedLabel)) {
    return false;
  }

  const containerText = filter.selectorHints.find((hint) => hint.kind === 'containerText')?.value ?? '';
  if (/目前城市|期望城市|工作年限|工作经验|教育经历|学历|期望薪资|期望月薪|期望年薪/.test(containerText) && normalizedLabel === '搜 索') {
    return false;
  }

  return true;
}

export async function discoverLiepinStaticSearchFilters(
  page: {
    evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
  },
  _options: SearchFilterDiscoveryRunOptions,
): Promise<{ filters: SearchFilterDefinition[]; failures: SearchFilterDiscoveryFailure[] }> {
  const [domRows, bodyText] = await Promise.all([
    readLiepinVisibleFilterRows(page),
    page.evaluate(() => document.body?.innerText ?? ''),
  ]);
  const textRows = parseRowsFromBodyText(bodyText);
  const rows = mergeLiepinRows(domRows, textRows);
  const filters = rows
    .map((row) => {
      const target = matchTargetLabel(row.label);
      return target ? buildLiepinStaticFilter(target, row) : undefined;
    })
    .filter((filter): filter is SearchFilterDefinition => Boolean(filter));

  return { filters, failures: [] };
}

export function mergeLiepinSearchFilterCatalog(
  genericCatalog: SearchFilterCatalog,
  staticFilters: readonly SearchFilterDefinition[],
  staticFailures: readonly SearchFilterDiscoveryFailure[] = [],
): SearchFilterCatalog {
  const filters = [
    ...genericCatalog.filters.filter(shouldKeepGenericLiepinFilter),
    ...staticFilters,
  ];
  const failures = [
    ...genericCatalog.failures,
    ...staticFailures,
  ];

  return {
    ...genericCatalog,
    filters,
    failures,
    stats: buildSearchFilterDiscoveryStats(filters),
  };
}
