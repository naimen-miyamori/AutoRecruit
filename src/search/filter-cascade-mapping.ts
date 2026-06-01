import type {
  SearchFilterCatalog,
  SearchFilterOption,
  SearchFilterSelectorHint,
} from './filter-catalog.js';

export interface SearchFilterCascadeApplicationOption {
  label: string;
  value: string;
  disabled: boolean;
  selected: boolean;
  depth: number;
  parentPathLabels: string[];
  pathLabels: string[];
}

export interface SearchFilterCascadeRootOnlyOption {
  label: string;
  value: string;
  disabled: boolean;
  selected: boolean;
}

export interface SearchFilterCascadeApplicationTreeNode {
  key: string;
  label: string;
  value: string;
  depth: number;
  pathLabels: string[];
  children: SearchFilterCascadeApplicationTreeNode[];
}

export interface SearchFilterCascadeApplicationField {
  fieldId: string;
  filterKey: string;
  label: string;
  controlType: 'cascadeSelect';
  valueShape: 'object';
  childrenLazy: boolean;
  optionCount: number;
  levelCount: number;
  rootOptions: SearchFilterCascadeApplicationOption[] | SearchFilterCascadeRootOnlyOption[];
  orderedRootLabels?: string[];
  optionsByDepth?: Array<{
    depth: number;
    options: SearchFilterCascadeApplicationOption[];
  }>;
  tree?: SearchFilterCascadeApplicationTreeNode[];
  selectorHints: SearchFilterSelectorHint[];
}

export interface SearchFilterCascadeApplicationMapping {
  platform: SearchFilterCatalog['platform'];
  capturedAt: string;
  keyword: string;
  fieldCount: number;
  fieldIds: string[];
  labels: string[];
  fieldIdByLabel: Record<string, string>;
  fieldsById: Record<string, SearchFilterCascadeApplicationField>;
}

const knownFieldIdByLabel: Record<string, string> = {
  期望年薪: 'expected_salary',
  期望月薪: 'expected_salary',
  期望薪资: 'expected_salary',
  目前年薪: 'current_salary',
  目前薪资: 'current_salary',
  当前年薪: 'current_salary',
  当前薪资: 'current_salary',
};

function normalizeLabel(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function slugifyLabel(value: string): string {
  return normalizeLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferFieldId(label: string): string {
  return knownFieldIdByLabel[label] ?? (slugifyLabel(label) || 'unknown_cascade_field');
}

function toApplicationOption(option: SearchFilterOption): SearchFilterCascadeApplicationOption {
  const label = normalizeLabel(option.label);
  const value = normalizeLabel(option.value) || label;
  const parentPathLabels = (option.parentPathLabels ?? []).map(normalizeLabel).filter(Boolean);
  const pathLabels = (option.pathLabels ?? []).map(normalizeLabel).filter(Boolean);

  return {
    label,
    value,
    disabled: Boolean(option.disabled),
    selected: Boolean(option.selected),
    depth: Math.max(option.depth ?? 0, 0),
    parentPathLabels,
    pathLabels: pathLabels.length > 0 ? pathLabels : [...parentPathLabels, label],
  };
}

function readMaxDepth(options: SearchFilterCascadeApplicationOption[]): number {
  return options.reduce((maxDepth, option) => Math.max(maxDepth, option.depth), 0);
}

function buildOrderedRootLabels(
  fieldId: string,
  rootOptions: readonly SearchFilterCascadeApplicationOption[],
): string[] | undefined {
  if (fieldId !== 'expected_salary') {
    return undefined;
  }

  return rootOptions.map((option) => option.label);
}

function stripCascadeOptionPaths(
  option: SearchFilterCascadeApplicationOption,
): SearchFilterCascadeRootOnlyOption {
  return {
    label: option.label,
    value: option.value,
    disabled: option.disabled,
    selected: option.selected,
  };
}

export function buildCascadeApplicationMapping(
  catalog: SearchFilterCatalog,
): SearchFilterCascadeApplicationMapping {
  const cascadeFilters = catalog.filters.filter((filter) =>
    filter.controlType === 'cascadeSelect'
    && filter.valueShape === 'object'
    && filter.status === 'optionsExtracted'
    && (filter.options?.length ?? 0) > 0,
  );

  const fieldIds: string[] = [];
  const labels: string[] = [];
  const fieldIdByLabel: Record<string, string> = {};
  const fieldsById: Record<string, SearchFilterCascadeApplicationField> = {};

  for (const filter of cascadeFilters) {
    const fieldId = inferFieldId(filter.label);
    const options = (filter.options ?? []).map(toApplicationOption);
    const rootOptions = options.filter((option) => option.depth === 0);
    const optionsByDepth = new Map<number, SearchFilterCascadeApplicationOption[]>();

    for (const option of options) {
      const levelOptions = optionsByDepth.get(option.depth) ?? [];
      levelOptions.push(option);
      optionsByDepth.set(option.depth, levelOptions);
    }

    interface MutableTreeNode {
      key: string;
      label: string;
      value: string;
      depth: number;
      pathLabels: string[];
      children: MutableTreeNode[];
      childMap: Map<string, MutableTreeNode>;
    }

    const rootNodes: MutableTreeNode[] = [];
    const nodeByKey = new Map<string, MutableTreeNode>();

    for (const option of options) {
      let parentNode: MutableTreeNode | undefined;

      for (let index = 0; index < option.pathLabels.length; index += 1) {
        const currentPathLabels = option.pathLabels.slice(0, index + 1);
        const key = currentPathLabels.join('\u0000');
        let currentNode = nodeByKey.get(key);
        if (!currentNode) {
          currentNode = {
            key,
            label: currentPathLabels.at(-1) ?? '',
            value: currentPathLabels.at(-1) ?? '',
            depth: index,
            pathLabels: currentPathLabels,
            children: [],
            childMap: new Map<string, MutableTreeNode>(),
          };
          nodeByKey.set(key, currentNode);

          if (!parentNode) {
            rootNodes.push(currentNode);
          } else if (!parentNode.childMap.has(key)) {
            parentNode.childMap.set(key, currentNode);
            parentNode.children.push(currentNode);
          }
        }

        parentNode = currentNode;
      }
    }

    const toImmutableTreeNode = (node: MutableTreeNode): SearchFilterCascadeApplicationTreeNode => ({
      key: node.key,
      label: node.label,
      value: node.value,
      depth: node.depth,
      pathLabels: [...node.pathLabels],
      children: node.children.map((child) => toImmutableTreeNode(child)),
    });

    fieldIds.push(fieldId);
    labels.push(filter.label);
    fieldIdByLabel[filter.label] = fieldId;
    const isExpectedSalary = fieldId === 'expected_salary';
    fieldsById[fieldId] = {
      fieldId,
      filterKey: filter.key,
      label: filter.label,
      controlType: 'cascadeSelect',
      valueShape: 'object',
      childrenLazy: Boolean(filter.childrenLazy),
      optionCount: options.length,
      levelCount: readMaxDepth(options) + 1,
      rootOptions: isExpectedSalary ? rootOptions.map(stripCascadeOptionPaths) : rootOptions,
      orderedRootLabels: buildOrderedRootLabels(fieldId, rootOptions),
      optionsByDepth: isExpectedSalary
        ? undefined
        : Array.from(optionsByDepth.entries())
          .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
          .map(([depth, levelOptions]) => ({ depth, options: levelOptions })),
      tree: isExpectedSalary ? undefined : rootNodes.map((node) => toImmutableTreeNode(node)),
      selectorHints: filter.selectorHints.map((hint) => ({ ...hint })),
    };
  }

  return {
    platform: catalog.platform,
    capturedAt: catalog.capturedAt,
    keyword: catalog.keyword,
    fieldCount: fieldIds.length,
    fieldIds,
    labels,
    fieldIdByLabel,
    fieldsById,
  };
}
