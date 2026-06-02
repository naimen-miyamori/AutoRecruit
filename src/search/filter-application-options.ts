import { buildCascadeApplicationMapping } from './filter-cascade-mapping.js';
import type { SearchFilterOptionInputSpec } from './filter-catalog.js';
import type { SearchFilterCatalog } from './filter-catalog.js';
import { buildTextInputApplicationMapping } from './filter-input-mapping.js';
import type { SearchFilterTextInputPoolDepth, SearchFilterTextInputPoolNode } from './filter-input-pool.js';
import { buildSingleSelectApplicationMapping } from './filter-single-select-mapping.js';

export interface ApplicationFilterOption {
  label: string;
  value: string;
  depth?: number;
  disabled: boolean;
  selected: boolean;
  parentPathLabels?: string[];
  pathLabels?: string[];
  inputSpec?: SearchFilterOptionInputSpec;
}

export interface ApplicationFilterSingleSelectField {
  fieldId: string;
  filterKey: string;
  label: string;
  kind: 'singleSelect';
  restrictInput: true;
  valueShape: 'string';
  acceptedInputShapes: ['string'] | ['string', 'customInput'];
  allowedValues: string[];
  options: ApplicationFilterOption[];
  customInput?: {
    label: string;
    value: string;
    inputSpec: SearchFilterOptionInputSpec;
  };
}

export interface ApplicationFilterTextInputField {
  fieldId: string;
  filterKey: string;
  label: string;
  kind: 'textInput';
  semanticKind: string;
  scope: string;
  restrictInput: boolean;
  valueShape: 'string|string[]';
  acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'];
  allowedValues: string[];
  rootValues: string[];
  valuesByDepth: SearchFilterTextInputPoolDepth[];
  tree: SearchFilterTextInputPoolNode[];
}

export interface ApplicationFilterTextInputValueWithPath {
  value: string;
  pathLabels: string[];
}

export interface ApplicationFilterSalaryRangeField {
  fieldId: string;
  filterKey: string;
  label: string;
  kind: 'salaryRange';
  restrictInput: true;
  valueShape: 'object';
  acceptedInputShapes: ['{ min: string; max: string }'];
  minKey: 'min';
  maxKey: 'max';
  minLabel: '薪资下限';
  maxLabel: '薪资上限';
  orderedValues: string[];
  minOptions: string[];
  maxOptions: string[];
  rule: {
    kind: 'orderedRange';
    comparison: 'maxSalaryValue >= minSalaryValue';
    message: string;
  };
}

export interface ApplicationFilterNumberRangeField {
  fieldId: string;
  filterKey: string;
  label: string;
  kind: 'numberRange';
  restrictInput: true;
  valueShape: 'object';
  acceptedInputShapes: ['{ min?: number|string; max?: number|string }'];
  minKey: 'min';
  maxKey: 'max';
  minLabel: string;
  maxLabel: string;
  unit?: string;
  min?: number;
  max?: number;
  orderedValues: string[];
  minOptions: string[];
  maxOptions: string[];
  rule: {
    kind: 'orderedRange';
    comparison: 'maxNumberValue >= minNumberValue';
    message: string;
  };
}

export type ApplicationFilterField =
  | ApplicationFilterSingleSelectField
  | ApplicationFilterTextInputField
  | ApplicationFilterSalaryRangeField
  | ApplicationFilterNumberRangeField;

export interface ApplicationFilterOptions {
  platform: SearchFilterCatalog['platform'];
  capturedAt: string;
  keyword: string;
  fieldCount: number;
  fieldIds: string[];
  fieldIdByLabel: Record<string, string>;
  groups: {
    singleSelect: string[];
    textInput: string[];
    salaryRange: string[];
    numberRange: string[];
  };
  fieldsById: Record<string, ApplicationFilterField>;
}

export interface ValidateApplicationFilterInputError {
  fieldId: string;
  code: string;
  message: string;
}

export interface ValidateApplicationFilterInputResult {
  ok: boolean;
  errors: ValidateApplicationFilterInputError[];
}

function normalizeValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeStringOrNumberValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  return normalizeValue(value);
}

function buildAllowedValues(options: ApplicationFilterOption[]): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    if (option.disabled || option.inputSpec) {
      continue;
    }

    for (const value of [normalizeValue(option.value), normalizeValue(option.label)]) {
      if (value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
  }

  return values;
}

function listUniqueOptionLabelsByDepth(catalog: SearchFilterCatalog, label: string, depth: number): string[] {
  const filter = catalog.filters.find((item) => item.label === label);
  const values: string[] = [];
  const seen = new Set<string>();

  for (const option of filter?.options ?? []) {
    if ((option.depth ?? 0) !== depth || option.disabled) {
      continue;
    }

    const value = normalizeValue(option.label);
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    values.push(value);
  }

  return values;
}

function parseSalaryValue(value: string): number | undefined {
  if (value === '不限') {
    return 0;
  }

  const normalizedValue = value.replace(/\s+/g, '');
  const matched = normalizedValue.match(/^(\d+(?:\.\d+)?)(千|万)/);
  if (!matched) {
    return undefined;
  }

  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }

  return matched[2] === '万' ? amount * 10000 : amount * 1000;
}

function parseNumberRangeValue(value: string): number | undefined {
  if (!value || value === '不限') {
    return undefined;
  }

  const matched = value.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)/);
  if (!matched) {
    return undefined;
  }

  const numberValue = Number(matched[1]);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeNumberRangeInputValue(value: unknown): string {
  const rawValue = normalizeStringOrNumberValue(value);
  if (!rawValue) {
    return '';
  }

  const parsed = parseNumberRangeValue(rawValue);
  return parsed === undefined ? rawValue : String(parsed);
}

function toApplicationOption(option: {
  label: string;
  value: string;
  depth?: number;
  disabled: boolean;
  selected: boolean;
  parentPathLabels?: string[];
  pathLabels?: string[];
  inputSpec?: SearchFilterOptionInputSpec;
}): ApplicationFilterOption {
  return {
    label: option.label,
    value: option.value,
    depth: option.depth,
    disabled: option.disabled,
    selected: option.selected,
    parentPathLabels: option.parentPathLabels?.map(normalizeValue).filter(Boolean),
    pathLabels: option.pathLabels?.map(normalizeValue).filter(Boolean),
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

export function buildApplicationFilterOptions(catalog: SearchFilterCatalog): ApplicationFilterOptions {
  const singleSelectMapping = buildSingleSelectApplicationMapping(catalog);
  const textInputMapping = buildTextInputApplicationMapping(catalog);
  const cascadeMapping = buildCascadeApplicationMapping(catalog);

  const fieldIds: string[] = [];
  const fieldIdByLabel: Record<string, string> = {};
  const fieldsById: Record<string, ApplicationFilterField> = {};
  const groups: ApplicationFilterOptions['groups'] = {
    singleSelect: [],
    textInput: [],
    salaryRange: [],
    numberRange: [],
  };

  for (const fieldId of singleSelectMapping.fieldIds) {
    const field = singleSelectMapping.fieldsById[fieldId];
    if (!field) {
      continue;
    }

    const options = field.options.map(toApplicationOption);
    const customInputOption = field.customInputOption?.inputSpec
      ? {
        label: field.customInputOption.label,
        value: field.customInputOption.value,
        inputSpec: field.customInputOption.inputSpec,
      }
      : undefined;

    fieldIds.push(fieldId);
    fieldIdByLabel[field.label] = fieldId;
    groups.singleSelect.push(fieldId);
    fieldsById[fieldId] = {
      fieldId,
      filterKey: field.filterKey,
      label: field.label,
      kind: 'singleSelect',
      restrictInput: true,
      valueShape: 'string',
      acceptedInputShapes: customInputOption ? ['string', 'customInput'] : ['string'],
      allowedValues: buildAllowedValues(options),
      options,
      customInput: customInputOption,
    };
  }

  for (const fieldId of textInputMapping.fieldIds) {
    const field = textInputMapping.fieldsById[fieldId];
    if (!field) {
      continue;
    }

    fieldIds.push(fieldId);
    fieldIdByLabel[field.label] = fieldId;
    groups.textInput.push(fieldId);
    fieldsById[fieldId] = {
      fieldId,
      filterKey: field.filterKey,
      label: field.label,
      kind: 'textInput',
      semanticKind: field.semanticKind,
      scope: field.scope,
      restrictInput: field.restrictInput,
      valueShape: 'string|string[]',
      acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
      allowedValues: [...field.values],
      rootValues: [...field.rootValues],
      valuesByDepth: field.valuesByDepth.map((entry) => ({
        depth: entry.depth,
        values: [...entry.values],
      })),
      tree: field.tree.map((node) => ({ ...node })),
    };
  }

  const salaryFields = [cascadeMapping.fieldsById.expected_salary, cascadeMapping.fieldsById.current_salary].filter(
    (field): field is NonNullable<typeof field> => Boolean(field),
  );
  for (const salaryField of salaryFields) {
    const orderedSalaryValues = salaryField.orderedRootLabels ?? [];
    const salaryUpperValues = listUniqueOptionLabelsByDepth(catalog, salaryField.label, 1);
    if (orderedSalaryValues.length === 0) {
      continue;
    }

    const fieldId = salaryField.fieldId;
    fieldIds.push(fieldId);
    fieldIdByLabel[salaryField.label] = fieldId;
    groups.salaryRange.push(fieldId);
    fieldsById[fieldId] = {
      fieldId,
      filterKey: salaryField.filterKey,
      label: salaryField.label,
      kind: 'salaryRange',
      restrictInput: true,
      valueShape: 'object',
      acceptedInputShapes: ['{ min: string; max: string }'],
      minKey: 'min',
      maxKey: 'max',
      minLabel: '薪资下限',
      maxLabel: '薪资上限',
      orderedValues: [...orderedSalaryValues],
      minOptions: [...orderedSalaryValues],
      maxOptions: [...salaryUpperValues],
      rule: {
        kind: 'orderedRange',
        comparison: 'maxSalaryValue >= minSalaryValue',
        message: '右侧薪资上限不能低于左侧薪资下限。',
      },
    };
  }

  const numberRangeFields = [cascadeMapping.fieldsById.age].filter(
    (field): field is NonNullable<typeof field> => Boolean(field),
  );
  for (const numberRangeField of numberRangeFields) {
    const numericRootOptions = numberRangeField.rootOptions
      .map((option) => normalizeValue(option.label))
      .filter((value) => parseNumberRangeValue(value) !== undefined);
    if (numericRootOptions.length === 0) {
      continue;
    }

    const fieldId = numberRangeField.fieldId;
    fieldIds.push(fieldId);
    fieldIdByLabel[numberRangeField.label] = fieldId;
    groups.numberRange.push(fieldId);
    fieldsById[fieldId] = {
      fieldId,
      filterKey: numberRangeField.filterKey,
      label: numberRangeField.label,
      kind: 'numberRange',
      restrictInput: true,
      valueShape: 'object',
      acceptedInputShapes: ['{ min?: number|string; max?: number|string }'],
      minKey: 'min',
      maxKey: 'max',
      minLabel: `${numberRangeField.label}下限`,
      maxLabel: `${numberRangeField.label}上限`,
      unit: numberRangeField.label === '年龄' ? '岁' : undefined,
      min: Math.min(...numericRootOptions.map((value) => parseNumberRangeValue(value) ?? Number.POSITIVE_INFINITY)),
      max: Math.max(...numericRootOptions.map((value) => parseNumberRangeValue(value) ?? Number.NEGATIVE_INFINITY)),
      orderedValues: [...numericRootOptions],
      minOptions: [...numericRootOptions],
      maxOptions: [...numericRootOptions],
      rule: {
        kind: 'orderedRange',
        comparison: 'maxNumberValue >= minNumberValue',
        message: `右侧${numberRangeField.label}上限不能低于左侧${numberRangeField.label}下限。`,
      },
    };
  }

  return {
    platform: catalog.platform,
    capturedAt: catalog.capturedAt,
    keyword: catalog.keyword,
    fieldCount: fieldIds.length,
    fieldIds,
    fieldIdByLabel,
    groups,
    fieldsById,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizePathLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => normalizeValue(item)).filter(Boolean)
    : [];
}

function isTextInputValueWithPath(value: unknown): value is ApplicationFilterTextInputValueWithPath {
  return isPlainRecord(value)
    && typeof value.value === 'string'
    && Array.isArray(value.pathLabels);
}

function findTextInputNodeByPath(
  nodes: SearchFilterTextInputPoolNode[],
  pathLabels: string[],
): SearchFilterTextInputPoolNode | undefined {
  if (pathLabels.length === 0) {
    return undefined;
  }

  let currentNodes = nodes;
  let currentNode: SearchFilterTextInputPoolNode | undefined;
  for (const pathLabel of pathLabels) {
    currentNode = currentNodes.find((node) => normalizeValue(node.label) === pathLabel);
    if (!currentNode) {
      return undefined;
    }
    currentNodes = currentNode.children;
  }

  return currentNode;
}

function validateCustomInput(
  field: ApplicationFilterSingleSelectField,
  value: Record<string, unknown>,
): ValidateApplicationFilterInputError[] {
  const label = normalizeValue(value.label);
  const customInput = field.customInput;
  if (!customInput || (label !== customInput.label && label !== customInput.value)) {
    return [{
      fieldId: field.fieldId,
      code: 'invalid_custom_input_option',
      message: `${field.label} 不支持该自定义选项。`,
    }];
  }

  if (!isPlainRecord(value.input)) {
    return [{
      fieldId: field.fieldId,
      code: 'missing_custom_input',
      message: `${field.label} 的自定义选项需要 input 对象。`,
    }];
  }

  const errors: ValidateApplicationFilterInputError[] = [];
  const numbers: Record<string, number> = {};
  for (const inputField of customInput.inputSpec.fields) {
    const inputValue = value.input[inputField.key];
    if (inputField.valueType === 'number') {
      const parsed = readNumber(inputValue);
      if (parsed === undefined) {
        errors.push({
          fieldId: field.fieldId,
          code: 'invalid_custom_number',
          message: `${field.label} 的 ${inputField.key} 必须是数字。`,
        });
        continue;
      }
      numbers[inputField.key] = parsed;
    }
  }

  if (
    customInput.inputSpec.kind === 'numberRange'
    && numbers.min !== undefined
    && numbers.max !== undefined
    && numbers.min > numbers.max
  ) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_custom_range',
      message: `${field.label} 的自定义范围下限不能大于上限。`,
    });
  }

  return errors;
}

function validateSingleSelectField(
  field: ApplicationFilterSingleSelectField,
  value: unknown,
): ValidateApplicationFilterInputError[] {
  const normalizedValue = normalizeValue(value);
  if (normalizedValue) {
    if (
      field.customInput
      && (normalizedValue === field.customInput.label || normalizedValue === field.customInput.value)
    ) {
      return [{
        fieldId: field.fieldId,
        code: 'missing_custom_input',
        message: `${field.label} 的自定义选项需要 input 对象。`,
      }];
    }

    return field.allowedValues.includes(normalizedValue)
      ? []
      : [{
        fieldId: field.fieldId,
        code: 'invalid_option',
        message: `${field.label} 只能选择已采集的选项。`,
      }];
  }

  if (isPlainRecord(value)) {
    return validateCustomInput(field, value);
  }

  return [{
    fieldId: field.fieldId,
    code: 'invalid_value_shape',
    message: `${field.label} 需要字符串，或自定义输入对象。`,
  }];
}

function validateTextInputField(
  field: ApplicationFilterTextInputField,
  value: unknown,
): ValidateApplicationFilterInputError[] {
  const values = Array.isArray(value) ? value : [value];
  const errors: ValidateApplicationFilterInputError[] = [];

  for (const item of values) {
    const normalizedValue = isTextInputValueWithPath(item)
      ? normalizeValue(item.value)
      : normalizeValue(item);
    if (!normalizedValue) {
      errors.push({
        fieldId: field.fieldId,
        code: 'invalid_text_input',
        message: field.restrictInput
          ? `${field.label} 只能输入采集到的选项文本。`
          : `${field.label} 需要非空文本。`,
      });
      continue;
    }

    if (field.restrictInput && !field.allowedValues.includes(normalizedValue)) {
      errors.push({
        fieldId: field.fieldId,
        code: 'invalid_text_input',
        message: `${field.label} 只能输入采集到的选项文本。`,
      });
      continue;
    }

    if (isTextInputValueWithPath(item)) {
      if (!field.restrictInput && field.tree.length === 0) {
        continue;
      }

      const pathLabels = normalizePathLabels(item.pathLabels);
      const pathNode = findTextInputNodeByPath(field.tree, pathLabels);
      if (!pathNode || normalizeValue(pathNode.label) !== normalizedValue) {
        errors.push({
          fieldId: field.fieldId,
          code: 'invalid_text_input_path',
          message: `${field.label} 的 pathLabels 必须指向输入值。`,
        });
      }
      continue;
    }

    if (isPlainRecord(item)) {
      errors.push({
        fieldId: field.fieldId,
        code: 'invalid_text_input_shape',
        message: `${field.label} 的对象输入需要 { value, pathLabels }。`,
      });
    }
  }

  return errors;
}

function validateSalaryRangeField(
  field: ApplicationFilterSalaryRangeField,
  value: unknown,
): ValidateApplicationFilterInputError[] {
  if (!isPlainRecord(value)) {
    return [{
      fieldId: field.fieldId,
      code: 'invalid_value_shape',
      message: `${field.label} 需要 { min, max } 对象。`,
    }];
  }

  const min = normalizeValue(value.min);
  const max = normalizeValue(value.max);
  const minIndex = field.minOptions.indexOf(min);
  const maxIndex = field.maxOptions.indexOf(max);
  const minSalaryValue = parseSalaryValue(min);
  const maxSalaryValue = parseSalaryValue(max);
  const errors: ValidateApplicationFilterInputError[] = [];

  if (minIndex < 0) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_min_salary',
      message: `${field.label} 的薪资下限不在选项池中。`,
    });
  }

  if (maxIndex < 0) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_max_salary',
      message: `${field.label} 的薪资上限不在选项池中。`,
    });
  }

  if (
    minIndex >= 0
    && maxIndex >= 0
    && minSalaryValue !== undefined
    && maxSalaryValue !== undefined
    && maxSalaryValue < minSalaryValue
  ) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_salary_order',
      message: field.rule.message,
    });
  }

  return errors;
}

function validateNumberRangeField(
  field: ApplicationFilterNumberRangeField,
  value: unknown,
): ValidateApplicationFilterInputError[] {
  if (!isPlainRecord(value)) {
    return [{
      fieldId: field.fieldId,
      code: 'invalid_value_shape',
      message: `${field.label} 需要 { min, max } 对象。`,
    }];
  }

  const minRaw = normalizeNumberRangeInputValue(value.min);
  const maxRaw = normalizeNumberRangeInputValue(value.max);
  const minValue = minRaw ? parseNumberRangeValue(minRaw) : undefined;
  const maxValue = maxRaw ? parseNumberRangeValue(maxRaw) : undefined;
  const errors: ValidateApplicationFilterInputError[] = [];

  if (minRaw && minValue === undefined) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_min_number',
      message: `${field.label} 的下限必须是数字。`,
    });
  }

  if (maxRaw && maxValue === undefined) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_max_number',
      message: `${field.label} 的上限必须是数字。`,
    });
  }

  if (!minRaw && !maxRaw) {
    errors.push({
      fieldId: field.fieldId,
      code: 'empty_range',
      message: `${field.label} 至少需要一个范围边界。`,
    });
  }

  if (minValue !== undefined && field.min !== undefined && minValue < field.min) {
    errors.push({
      fieldId: field.fieldId,
      code: 'min_number_too_low',
      message: `${field.label} 的下限不能低于 ${field.min}${field.unit ?? ''}。`,
    });
  }

  if (maxValue !== undefined && field.max !== undefined && maxValue > field.max) {
    errors.push({
      fieldId: field.fieldId,
      code: 'max_number_too_high',
      message: `${field.label} 的上限不能高于 ${field.max}${field.unit ?? ''}。`,
    });
  }

  if (minValue !== undefined && maxValue !== undefined && maxValue < minValue) {
    errors.push({
      fieldId: field.fieldId,
      code: 'invalid_number_order',
      message: field.rule.message,
    });
  }

  return errors;
}

export function validateApplicationFilterInput(
  options: ApplicationFilterOptions,
  input: Record<string, unknown>,
): ValidateApplicationFilterInputResult {
  const errors: ValidateApplicationFilterInputError[] = [];

  for (const [fieldId, value] of Object.entries(input)) {
    const field = options.fieldsById[fieldId];
    if (!field) {
      errors.push({
        fieldId,
        code: 'unknown_field',
        message: `未知筛选字段：${fieldId}`,
      });
      continue;
    }

    if (field.kind === 'singleSelect') {
      errors.push(...validateSingleSelectField(field, value));
      continue;
    }

    if (field.kind === 'textInput') {
      errors.push(...validateTextInputField(field, value));
      continue;
    }

    if (field.kind === 'numberRange') {
      errors.push(...validateNumberRangeField(field, value));
      continue;
    }

    errors.push(...validateSalaryRangeField(field, value));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
