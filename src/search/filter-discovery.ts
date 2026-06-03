import type { Locator, Page } from 'playwright';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  buildSearchFilterDiscoveryStats,
  createEmptySearchFilterCatalog,
  type SearchFilterCatalog,
  type SearchFilterControlSnapshot,
  type SearchFilterDefinition,
  type SearchFilterDiscoveryFailure,
  type SearchFilterDiscoveryRunOptions,
  type SearchFilterDomContainerSnapshot,
  type SearchFilterOption,
  type SearchFilterPageSnapshot,
  type SearchFilterSelectorHint,
  type SearchFilterValueShape,
  type SearchFilterControlType,
} from './filter-catalog.js';
import {
  FILTER_CONTROL_SELECTOR,
  FILTER_OPTION_SELECTOR,
  buildDiscoveryQueue,
  buildFilterKey,
  collectUniqueOptions,
  diffChangedContainers,
  isLikelyFilterContainer,
  type FilterControlCandidate,
  type FilterDomScanOptions,
} from './filter-dom.js';

const controlAttributeName = 'data-autorecruit-filter-id';
const containerSelector = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="tabpanel"]',
  'ul',
  'ol',
  'section',
  'aside',
  'form',
  'fieldset',
  'div[class*="filter"]',
  'div[class*="search"]',
  'div[class*="select"]',
  'div[class*="dropdown"]',
  'div[class*="popover"]',
  'div[class*="panel"]',
  'div[class*="menu"]',
  'div[class*="modal"]',
].join(', ');
const defaultRemoteProbeValues = ['上海', '销售'];

export interface SearchFilterDiscoveryPlatformOptions extends FilterDomScanOptions {
  beforeScan?: (page: Page) => Promise<void>;
  resolveInteractionLocator?: (
    page: Page,
    control: SearchFilterControlSnapshot,
    fallback: Locator,
  ) => Locator;
  mapControlForInteraction?: (control: SearchFilterControlSnapshot) => SearchFilterControlSnapshot;
}

interface ResolvedDiscoveryOptions {
  deadline: number;
  maxControls: number;
  maxDepth: number;
  maxOptionsPerLevel: number;
  controlTimeoutMs: number;
  stabilityWaitMs: number;
  slowClick: boolean;
  includeRemoteProbes: boolean;
  remoteProbeValues: string[];
  maxContainers: number;
  maxOptionsPerContainer: number;
  rootSelectors: string[];
}

interface OpenedTextInputInteraction {
  inputPlaceholder?: string;
}

function createDiscoveryDeadline(options: SearchFilterDiscoveryRunOptions): number {
  if (options.deadline) {
    return options.deadline;
  }

  const timeoutMs = options.globalTimeoutMs ?? Math.max(config.playwright.searchPageTimeoutMs, 45000);
  return Date.now() + timeoutMs;
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function resolveDiscoveryOptions(options: SearchFilterDiscoveryRunOptions): ResolvedDiscoveryOptions {
  return {
    deadline: createDiscoveryDeadline(options),
    maxControls: options.maxControls ?? 40,
    maxDepth: options.maxDepth ?? 3,
    maxOptionsPerLevel: options.maxOptionsPerLevel ?? 50,
    controlTimeoutMs: options.controlTimeoutMs ?? 3000,
    stabilityWaitMs: options.stabilityWaitMs ?? 250,
    slowClick: options.slowClick ?? false,
    includeRemoteProbes: options.includeRemoteProbes ?? false,
    remoteProbeValues: options.remoteProbeValues?.filter(Boolean) ?? defaultRemoteProbeValues,
    maxContainers: Math.max(options.maxControls ?? 40, 60),
    maxOptionsPerContainer: Math.max(options.maxOptionsPerLevel ?? 50, 80),
    rootSelectors: [],
  };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hasTruthySelection(option: SearchFilterOption): boolean {
  return Boolean(option.selected);
}

function normalizeSnapshotText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function choosePreferredFilterLabel(
  candidate: FilterControlCandidate,
  control: SearchFilterControlSnapshot | undefined,
): string {
  const buttonText = normalizeSnapshotText(control?.text);
  if (buttonText && buttonText.length <= 24) {
    return buttonText;
  }

  const placeholder = normalizeSnapshotText(control?.placeholder);
  if (placeholder && placeholder.length <= 24) {
    return placeholder;
  }

  const label = normalizeSnapshotText(control?.label);
  if (label) {
    return label;
  }

  return normalizeSnapshotText(candidate.label) || candidate.discoveryId;
}

function isTextEntryControl(control: SearchFilterControlSnapshot): boolean {
  if (control.disabled || control.readOnly) {
    return false;
  }

  if (control.tagName === 'textarea') {
    return true;
  }

  if (control.tagName !== 'input') {
    return false;
  }

  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(control.inputType);
}

export function detectOpenedTextInputInteraction(
  before: SearchFilterPageSnapshot,
  after: SearchFilterPageSnapshot,
  triggerControl: SearchFilterControlSnapshot,
): OpenedTextInputInteraction | undefined {
  if (['input', 'textarea', 'select'].includes(triggerControl.tagName)) {
    return undefined;
  }

  const beforeIds = new Set(before.controls.map((control) => control.discoveryId));
  const afterInputs = after.controls
    .filter((control) => control.discoveryId !== triggerControl.discoveryId)
    .filter((control) => !beforeIds.has(control.discoveryId))
    .filter(isTextEntryControl);

  if (afterInputs.length === 0) {
    return undefined;
  }

  const preferredInput = afterInputs.find((control) => control.placeholder)
    ?? afterInputs.find((control) => control.label)
    ?? afterInputs[0];
  const inputPlaceholder = preferredInput
    ? normalizeSnapshotText(preferredInput.placeholder || preferredInput.label || preferredInput.text)
    : '';

  return {
    inputPlaceholder: inputPlaceholder || undefined,
  };
}

export function buildOpenedTextInputResult(
  before: SearchFilterPageSnapshot,
  after: SearchFilterPageSnapshot,
  control: SearchFilterControlSnapshot,
  changedContainersOverride?: SearchFilterDomContainerSnapshot[],
): {
  changedContainers: SearchFilterDomContainerSnapshot[];
  controlType: 'textInput';
  inputPlaceholder?: string;
  childrenLazy?: boolean;
  message: string;
  preserveScopedContainers?: boolean;
} | undefined {
  const openedTextInputInteraction = detectOpenedTextInputInteraction(before, after, control);
  if (!openedTextInputInteraction) {
    return undefined;
  }

  const beforeContainers = buildFilteredContainerList(before.containers, {});
  const changedContainers = changedContainersOverride ?? diffChangedContainers(
    beforeContainers,
    buildFilteredContainerList(after.containers, {}),
  );
  const hasConstrainedInputOptions = changedContainers.some((container) => container.optionNodes.length > 0);
  const hasNestedOptions = changedContainers.some((container) => container.optionNodes.some((option) => option.depth > 0));

  return {
    changedContainers,
    controlType: 'textInput',
    inputPlaceholder: openedTextInputInteraction.inputPlaceholder || control.placeholder || undefined,
    childrenLazy: hasNestedOptions || undefined,
    message: hasConstrainedInputOptions
      ? 'Opened text-entry dialog. Visible menu options were recorded as a constrained input pool.'
      : 'Opened text-entry dialog. Enter text in the visible input and confirm.',
    preserveScopedContainers: hasConstrainedInputOptions || undefined,
  };
}

async function captureTextInputScopedContainers(
  page: Page,
  options: ResolvedDiscoveryOptions,
  control: SearchFilterControlSnapshot,
  preferredPlaceholder?: string,
): Promise<SearchFilterDomContainerSnapshot[]> {
  const containers = await page.evaluate(async ({
    maxContainers,
    maxOptionsPerContainer,
    maxOptionsPerLevel,
    maxDepth,
    stabilityWaitMs,
    controlAttribute,
    controlLabel,
    preferredPlaceholderValue,
  }) => {
    const normalizeText = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
      }
      if (value === null || value === undefined) {
        return '';
      }
      return String(value).replace(/\s+/g, ' ').trim();
    };
    const isHtmlElement = (value: Element | null): value is HTMLElement => value instanceof HTMLElement;
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!isHtmlElement(element)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const ensureId = (element: HTMLElement): string => {
      const existing = element.getAttribute(controlAttribute);
      if (existing) {
        return existing;
      }

      const globalWindow = window as typeof window & { __autorecruitFilterNextId?: number };
      globalWindow.__autorecruitFilterNextId ??= 1;
      const nextId = `filter-${globalWindow.__autorecruitFilterNextId}`;
      globalWindow.__autorecruitFilterNextId += 1;
      element.setAttribute(controlAttribute, nextId);
      return nextId;
    };
    const buildDomPath = (element: Element): string => {
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body) {
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement
          ? Array.from(parentElement.children).filter((child: Element) => child.tagName === current!.tagName)
          : [];
        const siblingIndex = siblings.indexOf(current) + 1;
        segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${Math.max(siblingIndex, 1)})`);
        current = parentElement;
      }
      return segments.join(' > ');
    };
    const shortText = (element: Element | null | undefined, maxLength = 240): string => normalizeText(element?.textContent).slice(0, maxLength);
    const isDisabled = (element: HTMLElement): boolean => {
      const ariaDisabled = normalizeText(element.getAttribute('aria-disabled')).toLowerCase();
      return ariaDisabled === 'true' || ('disabled' in element && Boolean((element as HTMLInputElement).disabled));
    };
    const readChecked = (element: HTMLElement): boolean => {
      const ariaChecked = normalizeText(element.getAttribute('aria-checked')).toLowerCase();
      if (ariaChecked === 'true') {
        return true;
      }
      if (ariaChecked === 'false') {
        return false;
      }
      if ('checked' in element) {
        return Boolean((element as HTMLInputElement).checked);
      }
      return /\b(active|selected|checked|is-checked)\b/i.test(element.className);
    };
    const readSelected = (element: HTMLElement): boolean => {
      const ariaSelected = normalizeText(element.getAttribute('aria-selected')).toLowerCase();
      if (ariaSelected === 'true') {
        return true;
      }
      if (ariaSelected === 'false') {
        return false;
      }
      if ('selected' in element) {
        return Boolean((element as HTMLOptionElement).selected);
      }
      return /\b(active|selected|current|checked)\b/i.test(element.className);
    };
    const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const clickWaitMs = Math.max(120, Math.min(stabilityWaitMs * 2, 400));
    const readOptionLabel = (element: HTMLElement): string => shortText(
      element.querySelector('.cascader_item_label') ?? element,
      160,
    );
    const buildOptionNode = (element: HTMLElement, depth: number, parentPathLabels: string[] = []) => {
      const label = readOptionLabel(element);
      const normalizedParentPathLabels = parentPathLabels
        .map((value) => normalizeText(value))
        .filter(Boolean);
      const pathLabels = label
        ? [...normalizedParentPathLabels, label]
        : [...normalizedParentPathLabels];
      return {
        discoveryId: ensureId(element),
        label,
        value: normalizeText(element.getAttribute('data-value'))
          || ('value' in element ? normalizeText((element as HTMLInputElement).value) : '')
          || label,
        role: normalizeText(element.getAttribute('role')) || 'option',
        tagName: element.tagName.toLowerCase(),
        depth,
        disabled: isDisabled(element),
        selected: readSelected(element),
        checked: readChecked(element),
        domPath: buildDomPath(element),
        parentPathLabels: normalizedParentPathLabels.length > 0 ? normalizedParentPathLabels : undefined,
        pathLabels: pathLabels.length > 0 ? pathLabels : undefined,
      };
    };

    const dialogRootSelector = [
      '[role="dialog"]',
      '.el-dialog__wrapper',
      '.el-dialog',
      '[class*="popover"]',
      '[class*="modal"]',
      '[class*="panel"]',
      '[class*="drawer"]',
    ].join(', ');
    const preferredMenuSelector = [
      'ul.cascader_panel_menu',
      '.el-select-dropdown__list',
      '.ant-select-dropdown-menu',
    ].join(', ');
    const fallbackMenuSelector = [
      preferredMenuSelector,
      '[role="listbox"]',
      '[role="menu"]',
      '.ant-select-dropdown [role="listbox"]',
    ].join(', ');
    const getVisibleCascaderMenus = (root: ParentNode): HTMLElement[] => Array.from(root.querySelectorAll('ul.cascader_panel_menu'))
      .filter(isVisible) as HTMLElement[];
    const getVisibleCascaderItems = (menu: HTMLElement): HTMLElement[] => Array.from(menu.children)
      .filter(isVisible)
      .filter((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return /(^|\s)cascader_panel_item(\s|$)/.test(child.className) || child.tagName === 'LI';
      }) as HTMLElement[];
    const readMenuSignature = (root: HTMLElement, depth: number): string => {
      const menu = getVisibleCascaderMenus(root)[depth];
      if (!menu) {
        return '';
      }

      return getVisibleCascaderItems(menu)
        .map((item) => readOptionLabel(item))
        .filter(Boolean)
        .join(' | ');
    };
    const readActiveLabel = (root: HTMLElement, depth: number): string => {
      const menu = getVisibleCascaderMenus(root)[depth];
      if (!menu) {
        return '';
      }

      const activeItem = getVisibleCascaderItems(menu)
        .find((item) => /\b(active|selected|current|checked)\b/i.test(item.className));
      return activeItem ? readOptionLabel(activeItem) : '';
    };
    const upsertOptionNode = (
      destination: Map<string, ReturnType<typeof buildOptionNode>>,
      optionNode: ReturnType<typeof buildOptionNode>,
      limit: number,
    ): void => {
      if (!optionNode.label || optionNode.label.length > 80) {
        return;
      }
      if (destination.size >= limit) {
        return;
      }
      const key = `${optionNode.depth}|${optionNode.pathLabels?.join('\u0000') ?? optionNode.label}`;
      if (!destination.has(key)) {
        destination.set(key, optionNode);
      }
    };
    const clickCascaderItem = async (
      root: HTMLElement,
      depth: number,
      target: ReturnType<typeof buildOptionNode>,
    ): Promise<boolean> => {
      const menu = getVisibleCascaderMenus(root)[depth];
      if (!menu) {
        return false;
      }

      const match = getVisibleCascaderItems(menu).find((item) => {
        const itemId = ensureId(item);
        return itemId === target.discoveryId || readOptionLabel(item) === target.label;
      });
      if (!match) {
        return false;
      }

      const previousActiveLabel = readActiveLabel(root, depth);
      const previousNextMenuSignature = readMenuSignature(root, depth + 1);
      match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      match.click();
      match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      const waitUntil = Date.now() + Math.max(clickWaitMs * 4, 800);
      while (Date.now() < waitUntil) {
        const activeLabel = readActiveLabel(root, depth);
        const nextMenuSignature = readMenuSignature(root, depth + 1);
        const becameActive = activeLabel === target.label;
        const nextMenuChanged = depth + 1 >= maxDepth
          || nextMenuSignature !== previousNextMenuSignature
          || nextMenuSignature.length === 0;
        if (becameActive && nextMenuChanged) {
          return true;
        }
        if (becameActive && previousActiveLabel === target.label) {
          return true;
        }
        await delay(50);
      }

      await delay(clickWaitMs);
      return true;
    };
    const collectInteractiveCascaderContainers = async (root: HTMLElement): Promise<SearchFilterDomContainerSnapshot[]> => {
      const levels = Array.from({ length: maxDepth }, () => new Map<string, ReturnType<typeof buildOptionNode>>());

      const visitDepth = async (depth: number, parentPathLabels: string[] = []): Promise<void> => {
        if (depth >= maxDepth) {
          return;
        }

        const menu = getVisibleCascaderMenus(root)[depth];
        if (!menu) {
          return;
        }

        const items = getVisibleCascaderItems(menu)
          .slice(0, maxOptionsPerLevel)
          .map((item) => buildOptionNode(item, depth, parentPathLabels));
        for (const item of items) {
          upsertOptionNode(levels[depth], item, Number.POSITIVE_INFINITY);
        }

        if (depth + 1 >= maxDepth) {
          return;
        }

        for (const item of items) {
          if (item.disabled) {
            continue;
          }

          const clicked = await clickCascaderItem(root, depth, item);
          if (!clicked) {
            continue;
          }

          const nextMenu = getVisibleCascaderMenus(root)[depth + 1];
          if (!nextMenu) {
            continue;
          }

          const nextItems = getVisibleCascaderItems(nextMenu)
            .slice(0, maxOptionsPerLevel)
            .map((nextItem) => buildOptionNode(nextItem, depth + 1, item.pathLabels ?? [...parentPathLabels, item.label]));
          for (const nextItem of nextItems) {
            upsertOptionNode(levels[depth + 1], nextItem, Number.POSITIVE_INFINITY);
          }

          const hasDeeperChildren = getVisibleCascaderItems(nextMenu)
            .some((nextItem) => !/\bleaf\b/i.test(nextItem.className));
          if (hasDeeperChildren) {
            await visitDepth(depth + 1, item.pathLabels ?? [...parentPathLabels, item.label]);
          }
        }
      };

      await visitDepth(0, []);

      return levels
        .map((level, depth) => ({
          key: `${buildDomPath(root)}|interactive-cascader-depth-${depth}`,
          discoveryId: `${buildDomPath(root)}|interactive-cascader-depth-${depth}`,
          text: Array.from(level.values()).map((option) => option.label).join(' '),
          domPath: `${buildDomPath(root)}|interactive-cascader-depth-${depth}`,
          optionNodes: Array.from(level.values()),
        }))
        .filter((container) => container.optionNodes.length > 0);
    };

    const visibleTextInputs = Array.from(document.querySelectorAll('input, textarea'))
      .filter(isVisible)
      .filter((element) => {
        const input = element as HTMLInputElement;
        const inputType = normalizeText(input.type).toLowerCase();
        if (input.readOnly || input.disabled) {
          return false;
        }
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(inputType);
      });

    const matchingInputs = visibleTextInputs.filter((element) => {
      const placeholder = normalizeText(element.getAttribute('placeholder'));
      if (preferredPlaceholderValue && placeholder === preferredPlaceholderValue) {
        return true;
      }

      const nearbyText = normalizeText([
        element.getAttribute('aria-label'),
        element.previousElementSibling?.textContent,
        element.parentElement?.textContent,
      ].join(' '));
      return controlLabel ? nearbyText.includes(controlLabel) : false;
    });

    const rootCandidates = new Map<string, HTMLElement>();
    const candidateInputs = matchingInputs.length > 0 ? matchingInputs : visibleTextInputs;
    for (const input of candidateInputs) {
      let current: HTMLElement | null = input.parentElement;
      let selectedRoot: HTMLElement | null = null;

      while (current && current !== document.body) {
        if (isVisible(current)) {
          const menuContainers = Array.from(current.querySelectorAll(fallbackMenuSelector)).filter(isVisible);
          if (menuContainers.length > 0) {
            selectedRoot = current;
            if (current.matches('[role="dialog"], .el-dialog__wrapper, .el-dialog, [class*="modal"], [class*="drawer"]')) {
              break;
            }
          }
        }
        current = current.parentElement;
      }

      if (!selectedRoot) {
        continue;
      }

      rootCandidates.set(buildDomPath(selectedRoot), selectedRoot);
    }

    const roots = rootCandidates.size > 0
      ? Array.from(rootCandidates.values())
      : Array.from(document.querySelectorAll(dialogRootSelector))
        .filter(isVisible)
        .filter((root) => {
          const text = shortText(root, 400);
          return (!controlLabel || text.includes(controlLabel))
            && Boolean(root.querySelector(fallbackMenuSelector));
        })
        .map((root) => root as HTMLElement);

    return roots
      .slice(0, maxContainers)
      .flatMap(async (root) => {
        const preferredContainers = Array.from(root.querySelectorAll(preferredMenuSelector)).filter(isVisible);
        if (preferredContainers.some((container) => container.matches('ul.cascader_panel_menu'))) {
          return collectInteractiveCascaderContainers(root);
        }

        const selectedContainers = preferredContainers.length > 0
          ? preferredContainers
          : Array.from(root.querySelectorAll(fallbackMenuSelector)).filter(isVisible);

        return selectedContainers.map((container, depth) => {
          const containerElement = container as HTMLElement;
          const directChildren = Array.from(containerElement.children).filter(isVisible) as HTMLElement[];
          const optionCandidates = directChildren.filter((child) => {
            if (child.closest(fallbackMenuSelector) !== containerElement) {
              return false;
            }

            if (/(^|\s)cascader_panel_item(\s|$)/.test(child.className)) {
              return true;
            }

            const role = normalizeText(child.getAttribute('role'));
            if (['option', 'menuitem', 'checkbox', 'radio'].includes(role)) {
              return true;
            }

            if (['LI', 'BUTTON', 'A', 'LABEL'].includes(child.tagName)) {
              return true;
            }

            return /\b(item|option)\b/i.test(child.className);
          });
          const optionNodes = optionCandidates
            .slice(0, maxOptionsPerContainer)
            .map((node) => {
              const optionElement = node as HTMLElement;
              const label = shortText(optionElement, 160);
              return {
                discoveryId: ensureId(optionElement),
                label,
                value: normalizeText(optionElement.getAttribute('data-value'))
                  || ('value' in optionElement ? normalizeText((optionElement as HTMLInputElement).value) : '')
                  || label,
                role: normalizeText(optionElement.getAttribute('role')),
                tagName: optionElement.tagName.toLowerCase(),
                depth,
                disabled: isDisabled(optionElement),
                selected: readSelected(optionElement),
                checked: readChecked(optionElement),
                domPath: buildDomPath(optionElement),
              };
            })
            .filter((option) => option.label)
            .filter((option) => option.label.length <= 80);

          return {
            key: `${buildDomPath(containerElement)}|${depth}|${shortText(containerElement, 120)}`,
            discoveryId: ensureId(containerElement),
            text: shortText(containerElement, 400),
            domPath: buildDomPath(containerElement),
            optionNodes,
          };
        })
          .filter((container) => container.optionNodes.length > 0);
      })
      .reduce(async (promise, current) => {
        const resolved = await promise;
        const next = await current;
        resolved.push(...next);
        return resolved;
      }, Promise.resolve([] as SearchFilterDomContainerSnapshot[]));
  }, {
    maxContainers: options.maxContainers,
    maxOptionsPerContainer: options.maxOptionsPerContainer,
    maxOptionsPerLevel: options.maxOptionsPerLevel,
    maxDepth: options.maxDepth,
    stabilityWaitMs: options.stabilityWaitMs,
    controlAttribute: controlAttributeName,
    controlLabel: control.label || control.text || '',
    preferredPlaceholderValue: preferredPlaceholder || '',
  });

  return containers as SearchFilterDomContainerSnapshot[];
}

async function waitForUiStability(page: Page, options: ResolvedDiscoveryOptions): Promise<void> {
  const waitMs = Math.min(options.stabilityWaitMs, remainingTime(options.deadline));
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

async function waitForSlowDiscoveryPace(page: Page, options: ResolvedDiscoveryOptions): Promise<void> {
  if (!options.slowClick) {
    return;
  }

  const waitMs = Math.min(Math.max(options.stabilityWaitMs, 2000), remainingTime(options.deadline));
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

async function capturePageSnapshot(page: Page, options: ResolvedDiscoveryOptions): Promise<SearchFilterPageSnapshot> {
  const snapshot = await page.evaluate(({ controlSelector, optionSelector, containerSelectorValue, maxContainers, maxOptionsPerContainer, controlAttribute, rootSelectors }) => {
    const globalWindow = window as typeof window & {
      __autorecruitFilterNextId?: number;
    };
    globalWindow.__autorecruitFilterNextId ??= 1;

    const normalizeText = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim();
      }
      if (value === null || value === undefined) {
        return '';
      }
      return String(value).replace(/\s+/g, ' ').trim();
    };
    const isHtmlElement = (value: Element | null): value is HTMLElement => value instanceof HTMLElement;
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!isHtmlElement(element)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const ensureId = (element: HTMLElement): string => {
      const existing = element.getAttribute(controlAttribute);
      if (existing) {
        return existing;
      }

      const nextNumericId = globalWindow.__autorecruitFilterNextId ?? 1;
      globalWindow.__autorecruitFilterNextId = nextNumericId + 1;
      const nextId = `filter-${nextNumericId}`;
      element.setAttribute(controlAttribute, nextId);
      return nextId;
    };
    const buildDomPath = (element: Element): string => {
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body) {
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement
          ? Array.from(parentElement.children).filter((child: Element) => child.tagName === current!.tagName)
          : [];
        const siblingIndex = siblings.indexOf(current) + 1;
        segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${Math.max(siblingIndex, 1)})`);
        current = parentElement;
      }
      return segments.join(' > ');
    };
    const buildCssPath = (element: Element): string => {
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && segments.length < 4) {
        const tag = current.tagName.toLowerCase();
        const id = current.getAttribute('id');
        if (id) {
          segments.unshift(`${tag}#${id}`);
          break;
        }

        const classNames = normalizeText(current.getAttribute('class') ?? '')
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join('');
        segments.unshift(`${tag}${classNames}`);
        current = current.parentElement;
      }
      return segments.join(' > ');
    };
    const shortText = (element: Element | null | undefined, maxLength = 240): string => normalizeText(element?.textContent).slice(0, maxLength);
    const readLabel = (element: HTMLElement): string => {
      const directLabel = normalizeText(element.getAttribute('aria-label'));
      if (directLabel) {
        return directLabel;
      }

      if ('labels' in element && Array.isArray((element as HTMLInputElement).labels)) {
        const labels = (element as HTMLInputElement).labels ?? [];
        const labelText = Array.from(labels).map((label) => shortText(label, 120)).find(Boolean);
        if (labelText) {
          return labelText;
        }
      }

      const closestLabel = element.closest('label');
      if (closestLabel) {
        const labelText = shortText(closestLabel, 120);
        if (labelText) {
          return labelText;
        }
      }

      const previousText = shortText(element.previousElementSibling, 80);
      if (previousText) {
        return previousText;
      }

      const parentText = shortText(element.parentElement, 120);
      if (parentText && parentText !== shortText(element, 120)) {
        return parentText;
      }

      return '';
    };
    const readContainerText = (element: HTMLElement): string => {
      const container = element.closest('[class*="filter"], [class*="search"], [class*="form"], [class*="item"], section, form, fieldset, li, dd, dt')
        ?? element.parentElement
        ?? document.body;
      return shortText(container, 320);
    };
    const isDisabled = (element: HTMLElement): boolean => {
      const ariaDisabled = normalizeText(element.getAttribute('aria-disabled')).toLowerCase();
      return ariaDisabled === 'true' || 'disabled' in element && Boolean((element as HTMLInputElement).disabled);
    };
    const readChecked = (element: HTMLElement): boolean => {
      const ariaChecked = normalizeText(element.getAttribute('aria-checked')).toLowerCase();
      if (ariaChecked === 'true') {
        return true;
      }
      if (ariaChecked === 'false') {
        return false;
      }
      if ('checked' in element) {
        return Boolean((element as HTMLInputElement).checked);
      }
      return /\b(active|selected|checked|is-checked)\b/i.test(element.className);
    };
    const readSelected = (element: HTMLElement): boolean => {
      const ariaSelected = normalizeText(element.getAttribute('aria-selected')).toLowerCase();
      if (ariaSelected === 'true') {
        return true;
      }
      if (ariaSelected === 'false') {
        return false;
      }
      if ('selected' in element) {
        return Boolean((element as HTMLOptionElement).selected);
      }
      return /\b(active|selected|current|checked)\b/i.test(element.className);
    };
    const readDepth = (element: HTMLElement, root: HTMLElement): number => {
      let depth = 0;
      let current: Element | null = element.parentElement;
      while (current && current !== root) {
        if (['UL', 'OL', 'DL'].includes(current.tagName) || current.getAttribute('role') === 'group') {
          depth += 1;
        }
        current = current.parentElement;
      }
      return depth;
    };
    const uniqueElements = <T extends Element>(elements: T[]): T[] => {
      const seen = new Set<T>();
      const unique: T[] = [];
      for (const element of elements) {
        if (seen.has(element)) {
          continue;
        }
        seen.add(element);
        unique.push(element);
      }
      return unique;
    };
    const rootElements = uniqueElements(
      rootSelectors
        .flatMap((selector: string) => Array.from(document.querySelectorAll(selector)))
        .filter(isVisible),
    );
    const searchRoots: ParentNode[] = rootElements.length > 0 ? rootElements : [document];
    const isInsideScanRoot = (element: Element): boolean => {
      if (rootElements.length === 0) {
        return true;
      }
      return rootElements.some((root) => root === element || root.contains(element));
    };
    const isDetachedOptionContainer = (element: Element): boolean => {
      if (!isHtmlElement(element)) {
        return false;
      }
      const role = normalizeText(element.getAttribute('role'));
      const className = normalizeText(element.getAttribute('class'));
      if (/^(listbox|menu|dialog|tabpanel)$/i.test(role)) {
        return true;
      }
      if (/(dropdown|popover|modal|select|cascader|picker|tooltip|menu|listbox|km-modal|ant-select|el-select|ivu-select)/i.test(className)) {
        return true;
      }
      const style = window.getComputedStyle(element);
      return /^(fixed|absolute)$/i.test(style.position) && element.querySelector(optionSelector) !== null;
    };
    const queryScoped = (selector: string): Element[] => uniqueElements(
      searchRoots.flatMap((root) => Array.from(root.querySelectorAll(selector))),
    );

    const controls = queryScoped(controlSelector)
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const input = element as HTMLInputElement;
        const discoveryId = ensureId(element);
        return {
          discoveryId,
          label: readLabel(element),
          text: shortText(element, 160),
          placeholder: normalizeText(element.getAttribute('placeholder')),
          role: normalizeText(element.getAttribute('role')),
          tagName: element.tagName.toLowerCase(),
          inputType: normalizeText(input.type),
          containerText: readContainerText(element),
          domPath: buildDomPath(element),
          cssPath: buildCssPath(element),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          ariaExpanded: normalizeText(element.getAttribute('aria-expanded')),
          ariaHasPopup: normalizeText(element.getAttribute('aria-haspopup')),
          readOnly: 'readOnly' in input ? Boolean(input.readOnly) : false,
          checked: readChecked(element),
          disabled: isDisabled(element),
          value: 'value' in input ? normalizeText(input.value) : '',
          multi: element instanceof HTMLSelectElement ? element.multiple : false,
        };
      })
      .sort((left, right) => left.y - right.y || left.x - right.x);

    const containers = Array.from(document.querySelectorAll(containerSelectorValue))
      .filter((container) => rootElements.length === 0 || isInsideScanRoot(container) || isDetachedOptionContainer(container))
      .filter(isVisible)
      .slice(0, maxContainers)
      .map((container) => {
        const containerElement = container as HTMLElement;
        const optionNodes = Array.from(container.querySelectorAll(optionSelector))
          .filter(isVisible)
          .slice(0, maxOptionsPerContainer)
          .map((node) => {
            const optionElement = node as HTMLElement;
            return {
              discoveryId: ensureId(optionElement),
              label: shortText(optionElement, 160),
              value: normalizeText(optionElement.getAttribute('data-value'))
                || ('value' in optionElement ? normalizeText((optionElement as HTMLInputElement).value) : ''),
              role: normalizeText(optionElement.getAttribute('role')),
              tagName: optionElement.tagName.toLowerCase(),
              depth: readDepth(optionElement, containerElement),
              disabled: isDisabled(optionElement),
              selected: readSelected(optionElement),
              checked: readChecked(optionElement),
              domPath: buildDomPath(optionElement),
            };
          });

        return {
          key: `${buildDomPath(containerElement)}|${shortText(containerElement, 120)}`,
          discoveryId: ensureId(containerElement),
          text: shortText(containerElement, 400),
          domPath: buildDomPath(containerElement),
          optionNodes,
        };
      });

    return {
      controls,
      containers,
    };
  }, {
    controlSelector: FILTER_CONTROL_SELECTOR,
    optionSelector: FILTER_OPTION_SELECTOR,
    containerSelectorValue: containerSelector,
    maxContainers: options.maxContainers,
    maxOptionsPerContainer: options.maxOptionsPerContainer,
    controlAttribute: controlAttributeName,
    rootSelectors: options.rootSelectors,
  });

  return snapshot as SearchFilterPageSnapshot;
}

function findControlSnapshot(snapshot: SearchFilterPageSnapshot, candidate: FilterControlCandidate): SearchFilterControlSnapshot | undefined {
  return snapshot.controls.find((control) => control.discoveryId === candidate.discoveryId);
}

function buildFilteredContainerList(
  containers: SearchFilterDomContainerSnapshot[],
  scanOptions: FilterDomScanOptions,
): SearchFilterDomContainerSnapshot[] {
  return containers.filter((container) => isLikelyFilterContainer(container, scanOptions));
}

function toSelectorHints(
  currentControl: SearchFilterControlSnapshot | undefined,
  fallback: FilterControlCandidate,
): SearchFilterSelectorHint[] {
  if (!currentControl) {
    return fallback.selectorHints.map((hint) => ({
      kind: hint.kind as SearchFilterSelectorHint['kind'],
      value: hint.value,
    }));
  }

  return [
    { kind: 'discoveryId', value: currentControl.discoveryId },
    { kind: 'cssPath', value: currentControl.cssPath },
    { kind: 'domPath', value: currentControl.domPath },
    ...(currentControl.label ? [{ kind: 'text' as const, value: currentControl.label }] : []),
    ...(currentControl.placeholder ? [{ kind: 'placeholder' as const, value: currentControl.placeholder }] : []),
    ...(currentControl.role ? [{ kind: 'role' as const, value: currentControl.role }] : []),
    ...(currentControl.containerText ? [{ kind: 'containerText' as const, value: currentControl.containerText.slice(0, 160) }] : []),
  ];
}

function buildFailure(
  candidate: FilterControlCandidate,
  control: SearchFilterControlSnapshot | undefined,
  stage: SearchFilterDiscoveryFailure['stage'],
  reason: string,
): SearchFilterDiscoveryFailure {
  return {
    key: buildFilterKey(candidate.label, candidate.discoveryId),
    label: control?.label || candidate.label,
    stage,
    reason,
    controlType: control ? classifyControlType(control, []) : 'unknown',
    selectorHints: toSelectorHints(control, candidate),
    message: control?.containerText,
  };
}

function toValueShape(controlType: SearchFilterControlType, control: SearchFilterControlSnapshot, options: SearchFilterOption[]): SearchFilterValueShape {
  if (controlType === 'multiSelect') {
    return 'string[]';
  }
  if (controlType === 'rangeInput') {
    return 'range';
  }
  if (controlType === 'toggle') {
    return 'boolean';
  }
  if (controlType === 'cascadeSelect') {
    return 'object';
  }
  if (control.multi || options.some(hasTruthySelection)) {
    return 'string[]';
  }
  return 'string';
}

function classifyControlType(control: SearchFilterControlSnapshot, options: SearchFilterOption[]): SearchFilterControlType {
  const haystack = [
    control.label,
    control.text,
    control.placeholder,
    control.containerText,
  ].join(' ');

  if (control.inputType === 'checkbox' || control.inputType === 'radio' || /^(checkbox|radio|switch)$/i.test(control.role)) {
    return options.length > 0 ? 'multiSelect' : 'toggle';
  }

  if (control.tagName === 'textarea') {
    return 'textInput';
  }

  if (control.tagName === 'select') {
    if (options.some((option) => (option.depth ?? 0) > 0)) {
      return 'cascadeSelect';
    }
    return control.multi ? 'multiSelect' : 'singleSelect';
  }

  if (control.tagName === 'input') {
    if (control.readOnly && !control.disabled) {
      if (options.some((option) => (option.depth ?? 0) > 0)) {
        return 'cascadeSelect';
      }
      return 'singleSelect';
    }
    if (control.inputType === 'date') {
      return 'datePreset';
    }
    if (control.inputType === 'number' || /薪资|薪酬|年龄|岁|经验|年限|范围|区间/.test(haystack)) {
      return 'rangeInput';
    }
    if (options.length > 0) {
      return 'remoteSuggest';
    }
    return 'textInput';
  }

  if (options.some((option) => (option.depth ?? 0) > 0)) {
    return 'cascadeSelect';
  }

  if (options.length > 0) {
    if (options.some(hasTruthySelection)) {
      return 'multiSelect';
    }
    if (/日期|时间|最近|今天|近/.test(haystack)) {
      return 'datePreset';
    }
    return 'singleSelect';
  }

  if (control.ariaExpanded || control.ariaHasPopup) {
    return 'singleSelect';
  }

  return 'unknown';
}

function mapOptionSnapshots(options: ReturnType<typeof collectUniqueOptions>, maxDepth: number): SearchFilterOption[] {
  return options
    .filter((option) => option.depth <= maxDepth)
    .map((option) => ({
      label: option.label,
      value: option.value || option.label,
      depth: option.depth,
      disabled: option.disabled,
      selected: option.selected || option.checked,
      parentPathLabels: option.parentPathLabels,
      pathLabels: option.pathLabels,
    }));
}

function collectScopedOptionSnapshots(
  containers: SearchFilterDomContainerSnapshot[],
): SearchFilterDomContainerSnapshot['optionNodes'][number][] {
  const seen = new Set<string>();
  const options: SearchFilterDomContainerSnapshot['optionNodes'][number][] = [];

  for (const container of containers) {
    for (const option of container.optionNodes) {
      const key = [
        normalizeSnapshotText(option.label),
        normalizeSnapshotText(option.value),
        option.depth,
        option.pathLabels?.map((value) => normalizeSnapshotText(value)).join('\u0000') ?? '',
      ].join('|');
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      options.push(option);
    }
  }

  return options;
}

async function openControl(
  page: Page,
  locator: Locator,
  control: SearchFilterControlSnapshot,
  options: ResolvedDiscoveryOptions,
): Promise<{
  changedContainers: SearchFilterDomContainerSnapshot[];
  controlType?: SearchFilterControlType;
  inputPlaceholder?: string;
  childrenLazy?: boolean;
  message?: string;
  preserveScopedContainers?: boolean;
}> {
  await locator.waitFor({ state: 'visible', timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) });
  if (control.disabled) {
    return {
      changedContainers: [],
      controlType: classifyControlType(control, []),
      inputPlaceholder: control.placeholder || undefined,
      message: 'Control is disabled.',
    };
  }

  const before = await capturePageSnapshot(page, options);
  const beforeContainers = buildFilteredContainerList(before.containers, {});
  let shouldRestoreInputValue = false;

  if (control.tagName === 'select') {
    return {
      changedContainers: beforeContainers.filter((container) => container.optionNodes.length > 0),
      controlType: classifyControlType(control, mapOptionSnapshots(collectUniqueOptions(beforeContainers, options.maxOptionsPerLevel), options.maxDepth)),
      inputPlaceholder: control.placeholder || undefined,
    };
  }

  if (control.tagName === 'input' || control.tagName === 'textarea') {
    const isTextLike = !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(control.inputType);
    const behavesLikeReadonlySelect = control.tagName === 'input' && control.readOnly && !control.disabled;
    if (behavesLikeReadonlySelect) {
      await locator.click({ timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) });
    } else if (isTextLike && !options.includeRemoteProbes) {
      return {
        changedContainers: [],
        controlType: classifyControlType(control, []),
        inputPlaceholder: control.placeholder || undefined,
      };
    } else if (isTextLike && options.includeRemoteProbes) {
      const probeValue = options.remoteProbeValues[0] ?? defaultRemoteProbeValues[0];
      await locator.fill(probeValue, { timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) });
      shouldRestoreInputValue = true;
    } else {
      await locator.click({ timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) });
    }
  } else if (control.inputType === 'checkbox' || control.inputType === 'radio' || /^(checkbox|radio|switch)$/i.test(control.role)) {
    return {
      changedContainers: [],
      controlType: classifyControlType(control, []),
      inputPlaceholder: control.placeholder || undefined,
      message: 'Toggle controls are classified without changing state.',
    };
  } else {
    await locator.click({ timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) });
  }

  await waitForUiStability(page, options);
  const after = await capturePageSnapshot(page, options);
  const openedTextInputInteraction = detectOpenedTextInputInteraction(before, after, control);

  if (openedTextInputInteraction) {
    const scopedChangedContainers = await captureTextInputScopedContainers(
      page,
      options,
      control,
      openedTextInputInteraction.inputPlaceholder || control.placeholder || undefined,
    );
    const openedTextInputResult = buildOpenedTextInputResult(
      before,
      after,
      control,
      scopedChangedContainers.length > 0 ? scopedChangedContainers : undefined,
    );

    if (shouldRestoreInputValue) {
      await locator.fill(control.value, { timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) }).catch(() => undefined);
    }

    if (openedTextInputResult) {
      return openedTextInputResult;
    }
  }

  const changedContainers = diffChangedContainers(
    beforeContainers,
    buildFilteredContainerList(after.containers, {}),
  );

  if (shouldRestoreInputValue) {
    await locator.fill(control.value, { timeout: Math.min(options.controlTimeoutMs, remainingTime(options.deadline)) }).catch(() => undefined);
  }

  return {
    changedContainers,
    controlType: changedContainers.some((container) => container.optionNodes.some((option) => option.depth > 0))
      ? 'cascadeSelect'
      : undefined,
    inputPlaceholder: control.placeholder || undefined,
    childrenLazy: changedContainers.some((container) => container.optionNodes.some((option) => option.depth > 0)) || undefined,
  };
}

async function restorePageState(page: Page, options: ResolvedDiscoveryOptions): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.click(4, 4).catch(() => undefined);
  await waitForUiStability(page, options);
}

function buildFilterDefinition(
  candidate: FilterControlCandidate,
  control: SearchFilterControlSnapshot | undefined,
  mappedOptions: SearchFilterOption[],
  overrideControlType: SearchFilterControlType | undefined,
  overrideInputPlaceholder?: string,
  message?: string,
  childrenLazy?: boolean,
): SearchFilterDefinition {
  const label = choosePreferredFilterLabel(candidate, control);
  const controlType = overrideControlType ?? (control ? classifyControlType(control, mappedOptions) : 'unknown');
  const status = mappedOptions.length > 0
    ? 'optionsExtracted'
    : controlType === 'unknown'
      ? 'unknownControl'
      : 'inspected';

  return {
    key: buildFilterKey(label, candidate.discoveryId),
    label,
    controlType,
    valueShape: toValueShape(controlType, control ?? {
      discoveryId: candidate.discoveryId,
      label,
      text: '',
      placeholder: '',
      role: '',
      tagName: 'button',
      inputType: '',
      containerText: '',
      domPath: '',
      cssPath: '',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ariaExpanded: '',
      ariaHasPopup: '',
      readOnly: false,
      checked: false,
      disabled: false,
      value: '',
      multi: false,
    }, mappedOptions),
    status,
    options: mappedOptions.length > 0 ? mappedOptions : undefined,
    selectorHints: toSelectorHints(control, candidate),
    inputPlaceholder: overrideInputPlaceholder || control?.placeholder || undefined,
    childrenLazy,
    message,
  };
}

export async function discoverSearchFiltersOnPage(
  platform: SupportedPlatform,
  page: Page,
  options: SearchFilterDiscoveryRunOptions,
  platformOptions: SearchFilterDiscoveryPlatformOptions = {},
): Promise<SearchFilterCatalog> {
  const resolvedOptions = resolveDiscoveryOptions(options);
  resolvedOptions.rootSelectors = platformOptions.rootSelectors?.filter(Boolean) ?? [];

  if (platformOptions.beforeScan) {
    await platformOptions.beforeScan(page);
    await waitForUiStability(page, resolvedOptions);
  }

  const catalog = createEmptySearchFilterCatalog(platform, options.keyword, page.url());
  const initialSnapshot = await capturePageSnapshot(page, resolvedOptions);
  const queue = buildDiscoveryQueue(initialSnapshot, {
    ignoreTextPatterns: platformOptions.ignoreTextPatterns,
    filterContainerTextPatterns: platformOptions.filterContainerTextPatterns,
    maxControls: resolvedOptions.maxControls,
    shouldIncludeControl: platformOptions.shouldIncludeControl,
    shouldIgnoreControl: platformOptions.shouldIgnoreControl,
  });

  for (const candidate of queue) {
    const currentSnapshot = await capturePageSnapshot(page, resolvedOptions);
    const currentControl = findControlSnapshot(currentSnapshot, candidate);
    const fallbackControl = currentControl ?? {
      discoveryId: candidate.discoveryId,
      label: candidate.label,
      text: '',
      placeholder: '',
      role: '',
      tagName: 'button',
      inputType: '',
      containerText: '',
      domPath: '',
      cssPath: '',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ariaExpanded: '',
      ariaHasPopup: '',
      readOnly: false,
      checked: false,
      disabled: false,
      value: '',
      multi: false,
    };

    try {
      const selector = `[${controlAttributeName}="${escapeAttributeValue(candidate.discoveryId)}"]`;
      const fallbackLocator = page.locator(selector).first();
      const interactionControl = platformOptions.mapControlForInteraction?.(fallbackControl) ?? fallbackControl;
      const locator = platformOptions.resolveInteractionLocator?.(page, interactionControl, fallbackLocator) ?? fallbackLocator;
      const openResult = await openControl(page, locator, interactionControl, resolvedOptions);
      const filteredChangedContainers = openResult.preserveScopedContainers
        ? buildFilteredContainerList(openResult.changedContainers, {
          ignoreTextPatterns: platformOptions.ignoreTextPatterns,
        })
        : buildFilteredContainerList(openResult.changedContainers, platformOptions);
      const mappedOptions = mapOptionSnapshots(
        openResult.preserveScopedContainers
          ? collectScopedOptionSnapshots(filteredChangedContainers)
          : collectUniqueOptions(filteredChangedContainers, resolvedOptions.maxOptionsPerLevel),
        resolvedOptions.maxDepth,
      );
      catalog.filters.push(buildFilterDefinition(
        candidate,
        currentControl,
        mappedOptions,
        openResult.controlType,
        openResult.inputPlaceholder,
        openResult.message,
        openResult.childrenLazy,
      ));
    } catch (error) {
      catalog.failures.push(buildFailure(
        candidate,
        currentControl,
        'interact',
        error instanceof Error ? error.message : String(error),
      ));
      catalog.filters.push({
        key: buildFilterKey(candidate.label, candidate.discoveryId),
        label: currentControl?.label || candidate.label,
        controlType: currentControl ? classifyControlType(currentControl, []) : 'unknown',
        valueShape: currentControl ? toValueShape(classifyControlType(currentControl, []), currentControl, []) : 'string',
        status: 'failed',
        selectorHints: toSelectorHints(currentControl, candidate),
        inputPlaceholder: currentControl?.placeholder || undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await restorePageState(page, resolvedOptions).catch((restoreError) => {
        catalog.failures.push(buildFailure(
          candidate,
          currentControl,
          'restore',
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        ));
      });
      await waitForSlowDiscoveryPace(page, resolvedOptions);
    }
  }

  catalog.pageUrl = page.url();
  catalog.stats = buildSearchFilterDiscoveryStats(catalog.filters);
  return catalog;
}
