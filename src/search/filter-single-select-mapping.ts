import type {
  SearchFilterCatalog,
  SearchFilterOption,
  SearchFilterOptionInputSpec,
  SearchFilterSelectorHint,
} from './filter-catalog.js';

export interface SearchFilterSingleSelectApplicationOption {
  label: string;
  value: string;
  depth?: number;
  disabled: boolean;
  selected: boolean;
  parentPathLabels?: string[];
  pathLabels?: string[];
  inputSpec?: SearchFilterOptionInputSpec;
}

export interface SearchFilterSingleSelectApplicationField {
  fieldId: string;
  filterKey: string;
  label: string;
  controlType: 'singleSelect';
  valueShape: 'string';
  optionCount: number;
  options: SearchFilterSingleSelectApplicationOption[];
  customInputOption?: SearchFilterSingleSelectApplicationOption;
  selectorHints: SearchFilterSelectorHint[];
}

export interface SearchFilterSingleSelectApplicationMapping {
  platform: SearchFilterCatalog['platform'];
  capturedAt: string;
  keyword: string;
  fieldCount: number;
  fieldIds: string[];
  labels: string[];
  fieldIdByLabel: Record<string, string>;
  fieldsById: Record<string, SearchFilterSingleSelectApplicationField>;
}

const knownFieldIdByLabel: Record<string, string> = {
  工作年限: 'work_years',
  工作经验: 'work_years',
  工作经验要求: 'work_years',
  经验要求: 'work_years',
  年龄: 'age',
  年龄要求: 'age',
  学历要求: 'education',
  学历: 'education',
  教育经历: 'education',
  学校性质: 'school_nature',
  院校要求: 'school_nature',
  统招要求: 'recruitment_type',
  求职状态: 'job_status',
  简历语言: 'resume_language',
  海外工作经验: 'overseas_work_experience',
  管理经验: 'management_experience',
  最近活跃时间: 'recent_activity_time',
  活跃度: 'recent_activity_time',
  活跃日期: 'recent_activity_time',
  更新时间: 'recent_activity_time',
  简历更新时间: 'recent_activity_time',
  毕业时间: 'graduation_year',
  语言要求: 'language',
  语言能力: 'language',
  语言: 'language',
  工作类型: 'work_type',
  公司性质: 'company_nature',
  企业性质: 'company_nature',
  跳槽次数: 'job_hopping_count',
  跳槽频率: 'job_hopping_count',
  性别: 'gender',
  性别要求: 'gender',
  人才类型: 'talent_type',
  人才照片: 'talent_photo',
  公司规模: 'company_size',
  企业规模: 'company_size',
  融资阶段: 'financing_stage',
};

const zhilianCustomInputSpecByLabel: Record<string, SearchFilterOptionInputSpec> = {
  学历要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低学历' },
      { key: 'max', valueType: 'string', label: '最高学历' },
    ],
  },
  经验要求: {
    kind: 'selectRange',
    fields: [
      { key: 'min', valueType: 'string', label: '最低经验' },
      { key: 'max', valueType: 'string', label: '最高经验' },
    ],
  },
};

function normalizeLabel(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function compactLabel(value: string | undefined): string {
  return normalizeLabel(value).replace(/\s+/g, '');
}

function slugifyLabel(value: string): string {
  return normalizeLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferFieldId(label: string): string {
  return knownFieldIdByLabel[label] ?? (slugifyLabel(label) || 'unknown_single_select_field');
}

function toApplicationOption(option: SearchFilterOption): SearchFilterSingleSelectApplicationOption {
  return {
    label: option.label,
    value: normalizeLabel(option.value) || option.label,
    depth: option.depth,
    disabled: Boolean(option.disabled),
    selected: Boolean(option.selected),
    parentPathLabels: option.parentPathLabels?.map(normalizeLabel).filter(Boolean),
    pathLabels: option.pathLabels?.map(normalizeLabel).filter(Boolean),
    inputSpec: option.inputSpec
      ? {
        kind: option.inputSpec.kind,
        confirmLabel: option.inputSpec.confirmLabel,
        unit: option.inputSpec.unit,
        fields: option.inputSpec.fields.map((field) => ({ ...field })),
      }
      : undefined,
  };
}

function enrichSingleSelectOptionInputSpec(
  platform: SearchFilterCatalog['platform'],
  filterLabel: string,
  option: SearchFilterOption,
): SearchFilterOption {
  if (option.inputSpec || platform !== 'zhilian') {
    return option;
  }

  const inputSpec = zhilianCustomInputSpecByLabel[normalizeLabel(filterLabel)];
  if (!inputSpec) {
    return option;
  }

  if (compactLabel(option.label) !== '自定义' && compactLabel(option.value) !== '自定义') {
    return option;
  }

  return { ...option, inputSpec };
}

export function buildSingleSelectApplicationMapping(
  catalog: SearchFilterCatalog,
): SearchFilterSingleSelectApplicationMapping {
  const singleSelectFilters = catalog.filters.filter((filter) =>
    filter.controlType === 'singleSelect'
    && filter.valueShape === 'string'
    && filter.status === 'optionsExtracted'
    && (filter.options?.length ?? 0) > 0,
  );

  const fieldIds: string[] = [];
  const labels: string[] = [];
  const fieldIdByLabel: Record<string, string> = {};
  const fieldsById: Record<string, SearchFilterSingleSelectApplicationField> = {};

  for (const filter of singleSelectFilters) {
    const fieldId = inferFieldId(filter.label);
    const options = (filter.options ?? [])
      .map((option) => enrichSingleSelectOptionInputSpec(catalog.platform, filter.label, option))
      .map(toApplicationOption);
    const customInputOption = options.find((option) => option.inputSpec);

    fieldIds.push(fieldId);
    labels.push(filter.label);
    fieldIdByLabel[filter.label] = fieldId;
    fieldsById[fieldId] = {
      fieldId,
      filterKey: filter.key,
      label: filter.label,
      controlType: 'singleSelect',
      valueShape: 'string',
      optionCount: options.length,
      options,
      customInputOption,
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
