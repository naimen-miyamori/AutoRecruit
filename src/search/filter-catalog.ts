import type { SupportedPlatform } from '../platforms/types.js';

export type SearchFilterControlType =
  | 'singleSelect'
  | 'multiSelect'
  | 'cascadeSelect'
  | 'rangeInput'
  | 'textInput'
  | 'remoteSuggest'
  | 'datePreset'
  | 'toggle'
  | 'unknown';

export type SearchFilterValueShape = 'string' | 'string[]' | 'range' | 'boolean' | 'object';

export type SearchFilterDiscoveryStatus =
  | 'discovered'
  | 'inspected'
  | 'optionsExtracted'
  | 'noOptions'
  | 'failed'
  | 'unknownControl';

export type SearchFilterSelectorHintKind =
  | 'discoveryId'
  | 'cssPath'
  | 'domPath'
  | 'text'
  | 'placeholder'
  | 'role'
  | 'containerText';

export interface SearchFilterSelectorHint {
  kind: SearchFilterSelectorHintKind;
  value: string;
}

export type SearchFilterOptionInputValueType = 'string' | 'number';

export type SearchFilterOptionInputSpecKind = 'numberRange' | 'selectRange';

export interface SearchFilterOptionInputField {
  key: string;
  valueType: SearchFilterOptionInputValueType;
  label?: string;
  placeholder?: string;
}

export interface SearchFilterOptionInputSpec {
  kind: SearchFilterOptionInputSpecKind;
  confirmLabel?: string;
  unit?: string;
  fields: SearchFilterOptionInputField[];
}

export interface SearchFilterOption {
  label: string;
  value?: string;
  depth?: number;
  disabled?: boolean;
  selected?: boolean;
  parentPathLabels?: string[];
  pathLabels?: string[];
  children?: SearchFilterOption[];
  message?: string;
  inputSpec?: SearchFilterOptionInputSpec;
}

export interface SearchFilterFailureContext {
  controlType?: SearchFilterControlType;
  selectorHints?: SearchFilterSelectorHint[];
  message?: string;
}

export interface SearchFilterDiscoveryFailure extends SearchFilterFailureContext {
  key: string;
  label: string;
  stage: 'scan' | 'interact' | 'extract' | 'classify' | 'restore';
  reason: string;
}

export interface SearchFilterDefinition extends SearchFilterFailureContext {
  key: string;
  label: string;
  controlType: SearchFilterControlType;
  valueShape: SearchFilterValueShape;
  status: SearchFilterDiscoveryStatus;
  options?: SearchFilterOption[];
  selectorHints: SearchFilterSelectorHint[];
  inputPlaceholder?: string;
  childrenLazy?: boolean;
}

export interface SearchFilterDiscoveryStats {
  discoveredControls: number;
  inspectedControls: number;
  optionsExtracted: number;
  failedControls: number;
  unknownControls: number;
}

export interface SearchFilterCatalog {
  platform: SupportedPlatform;
  keyword: string;
  capturedAt: string;
  pageUrl: string;
  filters: SearchFilterDefinition[];
  failures: SearchFilterDiscoveryFailure[];
  stats: SearchFilterDiscoveryStats;
}

export interface SearchFilterDiscoveryRunOptions {
  keyword: string;
  deadline?: number;
  globalTimeoutMs?: number;
  maxControls?: number;
  maxDepth?: number;
  maxOptionsPerLevel?: number;
  controlTimeoutMs?: number;
  stabilityWaitMs?: number;
  includeRemoteProbes?: boolean;
  remoteProbeValues?: string[];
}

export interface SearchFilterControlSnapshot {
  discoveryId: string;
  label: string;
  text: string;
  placeholder: string;
  role: string;
  tagName: string;
  inputType: string;
  containerText: string;
  domPath: string;
  cssPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ariaExpanded: string;
  ariaHasPopup: string;
  readOnly: boolean;
  checked: boolean;
  disabled: boolean;
  value: string;
  multi: boolean;
}

export interface SearchFilterOptionSnapshot {
  discoveryId: string;
  label: string;
  value: string;
  role: string;
  tagName: string;
  depth: number;
  disabled: boolean;
  selected: boolean;
  checked: boolean;
  domPath: string;
  parentPathLabels?: string[];
  pathLabels?: string[];
}

export interface SearchFilterDomContainerSnapshot {
  key: string;
  discoveryId: string;
  text: string;
  domPath: string;
  optionNodes: SearchFilterOptionSnapshot[];
}

export interface SearchFilterPageSnapshot {
  controls: SearchFilterControlSnapshot[];
  containers: SearchFilterDomContainerSnapshot[];
}

export function createEmptySearchFilterCatalog(
  platform: SupportedPlatform,
  keyword: string,
  pageUrl: string,
): SearchFilterCatalog {
  return {
    platform,
    keyword,
    capturedAt: new Date().toISOString(),
    pageUrl,
    filters: [],
    failures: [],
    stats: {
      discoveredControls: 0,
      inspectedControls: 0,
      optionsExtracted: 0,
      failedControls: 0,
      unknownControls: 0,
    },
  };
}

export function buildSearchFilterDiscoveryStats(filters: SearchFilterDefinition[]): SearchFilterDiscoveryStats {
  return filters.reduce<SearchFilterDiscoveryStats>((stats, filter) => {
    stats.discoveredControls += 1;
    if (filter.status !== 'discovered') {
      stats.inspectedControls += 1;
    }
    if (filter.status === 'optionsExtracted') {
      stats.optionsExtracted += filter.options?.length ?? 0;
    }
    if (filter.status === 'failed') {
      stats.failedControls += 1;
    }
    if (filter.status === 'unknownControl') {
      stats.unknownControls += 1;
    }
    return stats;
  }, {
    discoveredControls: 0,
    inspectedControls: 0,
    optionsExtracted: 0,
    failedControls: 0,
    unknownControls: 0,
  });
}
