import type {
  SearchFilterControlSnapshot,
  SearchFilterDomContainerSnapshot,
  SearchFilterOptionSnapshot,
  SearchFilterPageSnapshot,
} from './filter-catalog.js';

export const FILTER_CONTROL_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[aria-haspopup]',
  '[aria-expanded]',
  'label input[type="checkbox"]',
  'label input[type="radio"]',
].join(', ');

export const FILTER_OPTION_SELECTOR = [
  '[role="option"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'li',
  'label',
  'button',
  'a',
  '.ant-select-item',
  '.el-select-dropdown__item',
  '.ivu-select-item',
  '[class*="option"]',
  '[class*="item"]',
].join(', ');

export interface FilterDomScanOptions {
  ignoreTextPatterns?: RegExp[];
  filterContainerTextPatterns?: RegExp[];
  maxControls?: number;
  maxContainers?: number;
  maxOptionsPerContainer?: number;
  shouldIncludeControl?: (control: SearchFilterControlSnapshot) => boolean;
  shouldIgnoreControl?: (control: SearchFilterControlSnapshot) => boolean;
}

export interface FilterControlCandidate {
  discoveryId: string;
  label: string;
  selectorHints: Array<{ kind: string; value: string }>;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildFilterKey(label: string, discoveryId: string): string {
  const normalizedLabel = normalizeText(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = discoveryId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-24);
  return normalizedLabel ? `${normalizedLabel}-${suffix}` : suffix || 'unknown-filter';
}

export function diffChangedContainers(
  beforeContainers: SearchFilterDomContainerSnapshot[],
  afterContainers: SearchFilterDomContainerSnapshot[],
): SearchFilterDomContainerSnapshot[] {
  const beforeMap = new Map(beforeContainers.map((container) => [container.key, container]));
  const changed: SearchFilterDomContainerSnapshot[] = [];

  for (const container of afterContainers) {
    const previous = beforeMap.get(container.key);
    if (!previous) {
      changed.push(container);
      continue;
    }

    const previousText = normalizeText(previous.text);
    const currentText = normalizeText(container.text);
    if (previousText !== currentText) {
      changed.push(container);
      continue;
    }

    if (previous.optionNodes.length !== container.optionNodes.length) {
      changed.push(container);
      continue;
    }

    const hasOptionDelta = container.optionNodes.some((node, index) => {
      const priorNode = previous.optionNodes[index];
      return !priorNode
        || priorNode.discoveryId !== node.discoveryId
        || normalizeText(priorNode.label) !== normalizeText(node.label)
        || priorNode.selected !== node.selected
        || priorNode.checked !== node.checked;
    });

    if (hasOptionDelta) {
      changed.push(container);
    }
  }

  return changed;
}

export function collectUniqueOptions(
  containers: SearchFilterDomContainerSnapshot[],
  maxOptionsPerLevel: number,
): SearchFilterOptionSnapshot[] {
  const seen = new Set<string>();
  const options: SearchFilterOptionSnapshot[] = [];

  for (const container of containers) {
    for (const option of container.optionNodes) {
      const key = `${normalizeText(option.label)}|${normalizeText(option.value)}|${option.depth}|${option.domPath}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      options.push(option);
      if (options.length >= maxOptionsPerLevel) {
        return options;
      }
    }
  }

  return options;
}

export function isFilterLikeControl(control: SearchFilterControlSnapshot): boolean {
  const haystack = normalizeText([
    control.label,
    control.text,
    control.placeholder,
    control.containerText,
    control.role,
    control.tagName,
  ].join(' '));

  if (!haystack) {
    return false;
  }

  if (control.width <= 0 || control.height <= 0) {
    return false;
  }

  if (/导航|首页|下一页|上一页|退出|登录|注册|消息|帮助|举报|沟通|下载简历|投递|面试|职位详情|刷新|排序|导出|分享/.test(haystack)) {
    return false;
  }

  if (/候选人|简历列表|搜索结果|第\d+页|共\d+页|共\d+条/.test(haystack) && !/筛选|条件|城市|行业|职能|学历|经验|薪资/.test(haystack)) {
    return false;
  }

  return true;
}

export function shouldIgnoreByText(
  text: string,
  ignoreTextPatterns: RegExp[] = [],
): boolean {
  const normalized = normalizeText(text);
  return ignoreTextPatterns.some((pattern) => pattern.test(normalized));
}

export function isLikelyFilterContainer(
  container: SearchFilterDomContainerSnapshot,
  options: FilterDomScanOptions = {},
): boolean {
  const text = normalizeText(container.text);
  if (!text) {
    return false;
  }

  if (shouldIgnoreByText(text, options.ignoreTextPatterns)) {
    return false;
  }

  if (options.filterContainerTextPatterns && options.filterContainerTextPatterns.length > 0) {
    return options.filterContainerTextPatterns.some((pattern) => pattern.test(text));
  }

  if (container.optionNodes.length > 0) {
    return true;
  }

  return /筛选|条件|城市|地区|行业|职能|学历|经验|薪资|公司|学校|专业|语言|福利|规模|融资|年龄|性别|更新时间|发布时间/.test(text);
}

export function buildDiscoveryQueue(
  snapshot: SearchFilterPageSnapshot,
  options: FilterDomScanOptions = {},
): FilterControlCandidate[] {
  const maxControls = options.maxControls ?? Number.POSITIVE_INFINITY;
  const queue: FilterControlCandidate[] = [];

  for (const control of snapshot.controls) {
    if (options.shouldIgnoreControl?.(control)) {
      continue;
    }

    const shouldForceInclude = options.shouldIncludeControl?.(control) ?? false;

    if (!shouldForceInclude && !isFilterLikeControl(control)) {
      continue;
    }

    const combinedText = normalizeText([control.label, control.text, control.placeholder, control.containerText].join(' '));
    if (!shouldForceInclude && shouldIgnoreByText(combinedText, options.ignoreTextPatterns)) {
      continue;
    }

    queue.push({
      discoveryId: control.discoveryId,
      label: control.label || control.placeholder || control.text || control.role || control.tagName,
      selectorHints: [
        { kind: 'discoveryId', value: control.discoveryId },
        { kind: 'cssPath', value: control.cssPath },
        { kind: 'domPath', value: control.domPath },
        ...(control.label ? [{ kind: 'text', value: control.label }] : []),
        ...(control.placeholder ? [{ kind: 'placeholder', value: control.placeholder }] : []),
        ...(control.role ? [{ kind: 'role', value: control.role }] : []),
        ...(control.containerText ? [{ kind: 'containerText', value: control.containerText.slice(0, 160) }] : []),
      ],
    });

    if (queue.length >= maxControls) {
      break;
    }
  }

  return queue;
}
