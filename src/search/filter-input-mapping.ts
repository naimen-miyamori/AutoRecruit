import type {
  SearchFilterCatalog,
  SearchFilterSelectorHint,
} from './filter-catalog.js';
import {
  buildTextInputPoolMap,
  type SearchFilterTextInputPool,
  type SearchFilterTextInputPoolDepth,
  type SearchFilterTextInputPoolNode,
} from './filter-input-pool.js';

export type SearchFilterTextInputSemanticKind =
  | 'location'
  | 'industry'
  | 'function'
  | 'major'
  | 'other';

export type SearchFilterTextInputScope =
  | 'expected'
  | 'engaged'
  | 'living'
  | 'education'
  | 'other';

export interface SearchFilterTextInputApplicationField {
  fieldId: string;
  filterKey: string;
  label: string;
  semanticKind: SearchFilterTextInputSemanticKind;
  scope: SearchFilterTextInputScope;
  controlType: 'textInput';
  inputPlaceholder?: string;
  restrictInput: boolean;
  valueSource: 'label';
  childrenLazy: boolean;
  optionCount: number;
  maxDepth: number;
  levelCount: number;
  rootValues: string[];
  values: string[];
  valuesByDepth: SearchFilterTextInputPoolDepth[];
  tree: SearchFilterTextInputPoolNode[];
  selectorHints: SearchFilterSelectorHint[];
}

export interface SearchFilterTextInputApplicationMappingGroupsBySemanticKind {
  location: string[];
  industry: string[];
  function: string[];
  major: string[];
  other: string[];
}

export interface SearchFilterTextInputApplicationMappingGroupsByScope {
  expected: string[];
  engaged: string[];
  living: string[];
  education: string[];
  other: string[];
}

export interface SearchFilterTextInputApplicationMapping {
  platform: SearchFilterCatalog['platform'];
  capturedAt: string;
  keyword: string;
  fieldCount: number;
  fieldIds: string[];
  labels: string[];
  fieldIdByLabel: Record<string, string>;
  groupsBySemanticKind: SearchFilterTextInputApplicationMappingGroupsBySemanticKind;
  groupsByScope: SearchFilterTextInputApplicationMappingGroupsByScope;
  fieldsById: Record<string, SearchFilterTextInputApplicationField>;
}

const knownFieldIdByLabel: Record<string, string> = {
  期望工作地: 'expected_location',
  期望城市: 'expected_location',
  意向城市: 'expected_location',
  居住地: 'living_location',
  目前城市: 'living_location',
  当前城市: 'living_location',
  所在城市: 'living_location',
  所在地区: 'living_location',
  期望行业: 'expected_industry',
  意向行业: 'expected_industry',
  从事行业: 'engaged_industry',
  当前行业: 'engaged_industry',
  期望职能: 'expected_function',
  期望职位: 'expected_function',
  意向职能: 'expected_function',
  意向职位: 'expected_function',
  从事职能: 'engaged_function',
  当前职能: 'engaged_function',
  当前职位: 'engaged_function',
  职位名称: 'keyword_title',
  公司名称: 'company_name',
  毕业院校: 'school_name',
  毕业学校: 'school_name',
  学校名称: 'school_name',
  专业: 'major',
  专业名称: 'major',
};

const knownSemanticKindByLabel: Record<string, SearchFilterTextInputSemanticKind> = {
  期望工作地: 'location',
  期望城市: 'location',
  意向城市: 'location',
  居住地: 'location',
  目前城市: 'location',
  当前城市: 'location',
  所在城市: 'location',
  所在地区: 'location',
  期望行业: 'industry',
  意向行业: 'industry',
  从事行业: 'industry',
  当前行业: 'industry',
  期望职能: 'function',
  期望职位: 'function',
  意向职能: 'function',
  意向职位: 'function',
  从事职能: 'function',
  当前职能: 'function',
  当前职位: 'function',
  职位名称: 'other',
  公司名称: 'other',
  毕业院校: 'other',
  毕业学校: 'other',
  学校名称: 'other',
  专业: 'major',
  专业名称: 'major',
};

const knownScopeByLabel: Record<string, SearchFilterTextInputScope> = {
  期望工作地: 'expected',
  期望城市: 'expected',
  意向城市: 'expected',
  居住地: 'living',
  目前城市: 'living',
  当前城市: 'living',
  所在城市: 'living',
  所在地区: 'living',
  期望行业: 'expected',
  意向行业: 'expected',
  从事行业: 'engaged',
  当前行业: 'engaged',
  期望职能: 'expected',
  期望职位: 'expected',
  意向职能: 'expected',
  意向职位: 'expected',
  从事职能: 'engaged',
  当前职能: 'engaged',
  当前职位: 'engaged',
  职位名称: 'other',
  公司名称: 'other',
  毕业院校: 'education',
  毕业学校: 'education',
  学校名称: 'education',
  专业: 'education',
  专业名称: 'education',
};

const freeTextFieldIds = new Set([
  'keyword_title',
  'company_name',
  'school_name',
  'major',
]);

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
  const knownFieldId = knownFieldIdByLabel[label];
  if (knownFieldId) {
    return knownFieldId;
  }

  const inferredFieldId = slugifyLabel(label);
  return inferredFieldId || 'unknown_text_input_field';
}

function inferSemanticKind(label: string): SearchFilterTextInputSemanticKind {
  return knownSemanticKindByLabel[label] ?? 'other';
}

function inferScope(label: string): SearchFilterTextInputScope {
  return knownScopeByLabel[label] ?? 'other';
}

function readMaxDepth(pool: SearchFilterTextInputPool): number {
  return pool.valuesByDepth.reduce((maxDepth, currentDepth) => Math.max(maxDepth, currentDepth.depth), 0);
}

function createEmptySemanticGroups(): SearchFilterTextInputApplicationMappingGroupsBySemanticKind {
  return {
    location: [],
    industry: [],
    function: [],
    major: [],
    other: [],
  };
}

function createEmptyScopeGroups(): SearchFilterTextInputApplicationMappingGroupsByScope {
  return {
    expected: [],
    engaged: [],
    living: [],
    education: [],
    other: [],
  };
}

export function buildTextInputApplicationMapping(
  catalog: SearchFilterCatalog,
): SearchFilterTextInputApplicationMapping {
  const poolMap = buildTextInputPoolMap(catalog);
  const fieldIds: string[] = [];
  const labels: string[] = [];
  const fieldIdByLabel: Record<string, string> = {};
  const fieldsById: Record<string, SearchFilterTextInputApplicationField> = {};
  const groupsBySemanticKind = createEmptySemanticGroups();
  const groupsByScope = createEmptyScopeGroups();

  for (const filter of catalog.filters) {
    const pool = poolMap[filter.label];
    if (!pool) {
      continue;
    }

    const fieldId = inferFieldId(filter.label);
    const semanticKind = inferSemanticKind(filter.label);
    const scope = inferScope(filter.label);
    const maxDepth = readMaxDepth(pool);

    fieldIds.push(fieldId);
    labels.push(filter.label);
    fieldIdByLabel[filter.label] = fieldId;
    groupsBySemanticKind[semanticKind].push(fieldId);
    groupsByScope[scope].push(fieldId);
    fieldsById[fieldId] = {
      fieldId,
      filterKey: filter.key,
      label: filter.label,
      semanticKind,
      scope,
      controlType: 'textInput',
      inputPlaceholder: normalizeLabel(pool.inputPlaceholder) || undefined,
      restrictInput: !freeTextFieldIds.has(fieldId),
      valueSource: 'label',
      childrenLazy: pool.childrenLazy,
      optionCount: pool.optionCount,
      maxDepth,
      levelCount: maxDepth + 1,
      rootValues: pool.tree.map((node) => node.label),
      values: [...pool.values],
      valuesByDepth: pool.valuesByDepth.map((entry) => ({
        depth: entry.depth,
        values: [...entry.values],
      })),
      tree: pool.tree.map((node) => ({ ...node })),
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
    groupsBySemanticKind,
    groupsByScope,
    fieldsById,
  };
}
