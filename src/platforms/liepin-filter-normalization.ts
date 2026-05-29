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

const liepinStaticFilterTargets: LiepinStaticFilterTarget[] = [
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
    label: '期望薪资',
    kind: 'salaryRange',
    aliases: ['期望薪资', '期望月薪'],
  },
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
  '统招本科',
  'MBA/EMBA',
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
  return [
    { kind: 'text', value: label },
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
    .filter((option) => !target.aliases.includes(option) && option !== `${row.label}：`);
  if (rowOptions.length === 0) {
    return undefined;
  }

  if (target.kind === 'salaryRange') {
    const options = toSalaryOptions(rowOptions);
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
      options: rowOptions.map(toTextInputOption),
    };
  }

  return {
    key: createLiepinFilterKey(target.label),
    label: target.label,
    controlType: 'singleSelect',
    valueShape: 'string',
    status: 'optionsExtracted',
    selectorHints: createSelectorHints(row, target.label),
    options: rowOptions.map((option) => toSingleSelectOption(option, target.label)),
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
    const nextLabelPattern = liepinStaticFilterTargets
      .filter((item) => item !== target)
      .flatMap((item) => item.aliases)
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
      '期望薪资',
      '期望月薪',
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
        .map((item) => normalize((item as HTMLElement).innerText || item.getAttribute('title') || item.getAttribute('aria-label')))
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
        rowsByTarget.set(target.label, {
          ...row,
          label: target.label,
        });
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
  if (/目前城市|期望城市|工作年限|工作经验|教育经历|学历|期望薪资/.test(containerText) && normalizedLabel === '搜 索') {
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
