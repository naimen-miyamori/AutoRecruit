import type {
  SearchFilterCatalog,
  SearchFilterDefinition,
} from './filter-catalog.js';

export interface SearchFilterTextInputPoolDepth {
  depth: number;
  values: string[];
}

export interface SearchFilterTextInputPoolNode {
  key: string;
  label: string;
  depth: number;
  pathLabels: string[];
  children: SearchFilterTextInputPoolNode[];
}

export interface SearchFilterTextInputPool {
  key: string;
  label: string;
  inputPlaceholder?: string;
  childrenLazy: boolean;
  optionCount: number;
  values: string[];
  valuesByDepth: SearchFilterTextInputPoolDepth[];
  tree: SearchFilterTextInputPoolNode[];
}

function normalizePoolValue(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function readPoolValue(filter: SearchFilterDefinition, option: NonNullable<SearchFilterDefinition['options']>[number]): string {
  const normalizedLabel = normalizePoolValue(option.label);
  if (filter.childrenLazy || filter.controlType === 'textInput') {
    return normalizedLabel;
  }

  const normalizedValue = normalizePoolValue(option.value);
  return normalizedValue || normalizedLabel;
}

function readPathLabels(
  option: NonNullable<SearchFilterDefinition['options']>[number],
  fallbackValue: string,
): string[] {
  const pathLabels = (option.pathLabels ?? [])
    .map((value) => normalizePoolValue(value))
    .filter(Boolean);
  if (pathLabels.length > 0) {
    return pathLabels;
  }

  const parentPathLabels = (option.parentPathLabels ?? [])
    .map((value) => normalizePoolValue(value))
    .filter(Boolean);
  if (parentPathLabels.length > 0) {
    return [...parentPathLabels, fallbackValue];
  }

  return [fallbackValue];
}

function isTextInputFilterWithOptions(filter: SearchFilterDefinition): boolean {
  return filter.controlType === 'textInput'
    && filter.status === 'optionsExtracted'
    && (filter.options?.length ?? 0) > 0;
}

export function buildTextInputPool(filter: SearchFilterDefinition): SearchFilterTextInputPool | undefined {
  if (!isTextInputFilterWithOptions(filter)) {
    return undefined;
  }

  interface MutablePoolNode extends Omit<SearchFilterTextInputPoolNode, 'children'> {
    children: MutablePoolNode[];
    childMap: Map<string, MutablePoolNode>;
  }

  const valuesSeen = new Set<string>();
  const flatValues: string[] = [];
  const valuesByDepth = new Map<number, string[]>();
  const depthSeen = new Map<number, Set<string>>();
  const rootNodes: MutablePoolNode[] = [];
  const nodeByKey = new Map<string, MutablePoolNode>();

  for (const option of filter.options ?? []) {
    if (option.disabled) {
      continue;
    }

    const value = readPoolValue(filter, option);
    if (!value) {
      continue;
    }

    const pathLabels = readPathLabels(option, value);
    const depth = Math.max(option.depth ?? 0, 0);
    if (!valuesSeen.has(value)) {
      valuesSeen.add(value);
      flatValues.push(value);
    }

    const depthValues = valuesByDepth.get(depth) ?? [];
    const currentDepthSeen = depthSeen.get(depth) ?? new Set<string>();
    if (!currentDepthSeen.has(value)) {
      currentDepthSeen.add(value);
      depthValues.push(value);
      valuesByDepth.set(depth, depthValues);
      depthSeen.set(depth, currentDepthSeen);
    }

    let parentNode: MutablePoolNode | undefined;
    for (let index = 0; index < pathLabels.length; index += 1) {
      const currentPathLabels = pathLabels.slice(0, index + 1);
      const key = currentPathLabels.join('\u0000');
      let currentNode = nodeByKey.get(key);
      if (!currentNode) {
        currentNode = {
          key,
          label: currentPathLabels.at(-1) ?? '',
          depth: index,
          pathLabels: currentPathLabels,
          children: [],
          childMap: new Map<string, MutablePoolNode>(),
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

  const toImmutableNode = (node: MutablePoolNode): SearchFilterTextInputPoolNode => ({
    key: node.key,
    label: node.label,
    depth: node.depth,
    pathLabels: [...node.pathLabels],
    children: node.children.map((child) => toImmutableNode(child)),
  });

  return {
    key: filter.key,
    label: filter.label,
    inputPlaceholder: normalizePoolValue(filter.inputPlaceholder) || undefined,
    childrenLazy: Boolean(filter.childrenLazy),
    optionCount: flatValues.length,
    values: flatValues,
    valuesByDepth: Array.from(valuesByDepth.entries())
      .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
      .map(([depth, values]) => ({ depth, values })),
    tree: rootNodes.map((node) => toImmutableNode(node)),
  };
}

export function listTextInputPools(catalog: SearchFilterCatalog): SearchFilterTextInputPool[] {
  return catalog.filters
    .map((filter) => buildTextInputPool(filter))
    .filter((pool): pool is SearchFilterTextInputPool => Boolean(pool));
}

export function buildTextInputPoolMap(catalog: SearchFilterCatalog): Record<string, SearchFilterTextInputPool> {
  return Object.fromEntries(listTextInputPools(catalog).map((pool) => [pool.label, pool]));
}

export function findTextInputPool(
  catalog: SearchFilterCatalog,
  label: string,
): SearchFilterTextInputPool | undefined {
  const normalizedLabel = normalizePoolValue(label);
  return listTextInputPools(catalog).find((pool) => normalizePoolValue(pool.label) === normalizedLabel);
}

export function findTextInputPoolNode(
  pool: SearchFilterTextInputPool,
  pathLabels: string[],
): SearchFilterTextInputPoolNode | undefined {
  const normalizedPathLabels = pathLabels
    .map((value) => normalizePoolValue(value))
    .filter(Boolean);
  if (normalizedPathLabels.length === 0) {
    return undefined;
  }

  let currentNodes = pool.tree;
  let currentNode: SearchFilterTextInputPoolNode | undefined;
  for (const label of normalizedPathLabels) {
    currentNode = currentNodes.find((node) => normalizePoolValue(node.label) === label);
    if (!currentNode) {
      return undefined;
    }
    currentNodes = currentNode.children;
  }

  return currentNode;
}

export function listTextInputPoolChildValues(
  pool: SearchFilterTextInputPool,
  parentPathLabels: string[] = [],
): string[] {
  if (parentPathLabels.length === 0) {
    return pool.tree.map((node) => node.label);
  }

  return findTextInputPoolNode(pool, parentPathLabels)?.children.map((node) => node.label) ?? [];
}
