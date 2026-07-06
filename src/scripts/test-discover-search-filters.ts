import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Locator, Page } from 'playwright';

import {
  buildOpenedTextInputResult,
  detectOpenedTextInputInteraction,
} from '../search/filter-discovery.js';
import {
  buildDiscoveryQueue,
  buildFilterKey,
  collectUniqueOptions,
  diffChangedContainers,
  isLikelyFilterContainer,
  isFilterLikeControl,
} from '../search/filter-dom.js';
import type { PlatformAdapter } from '../platforms/types.js';
import type { SearchFilterCatalog, SearchFilterPageSnapshot } from '../search/filter-catalog.js';

async function loadDiscoverModule(): Promise<typeof import('./discover-search-filters.ts')> {
  const scriptPath = fileURLToPath(new URL('./discover-search-filters.ts', import.meta.url));
  return import(`${pathToFileURL(scriptPath).href}?discoverFiltersTest=${Date.now()}-${Math.random()}`);
}

describe('discover search filters CLI', () => {
  it('parseArgs requires keyword and parses optional knobs', async () => {
    const module = await loadDiscoverModule();

    assert.throws(() => module.parseArgs([]), /Missing required argument --keyword/);
    assert.throws(
      () => module.parseArgs(['--platform', 'all', '--keyword', '优衣库', '--output', './catalog.json']),
      /--output cannot be combined with --platform all/,
    );
    assert.deepEqual(module.parseArgs([
      '--platform',
      'zhilian',
      '--keyword',
      '优衣库',
      '--max-depth',
      '2',
      '--max-options-per-level',
      '15',
      '--include-remote-probes',
      'true',
      '--slow-click',
      'true',
      '--global-timeout-ms',
      '180000',
      '--output',
      './catalog.json',
    ]), {
      platform: 'zhilian',
      keyword: '优衣库',
      maxDepth: 2,
      maxOptionsPerLevel: 15,
      includeRemoteProbes: true,
      slowClick: true,
      globalTimeoutMs: 180000,
      outputPath: './catalog.json',
    });
  });

  it('runDiscoverSearchFilters passes slow-click discovery options to adapters', async () => {
    const module = await loadDiscoverModule();
    const receivedOptions: unknown[] = [];
    const session = {
      page: { id: 'page' },
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as never;
    const adapter: PlatformAdapter = {
      platform: 'liepin',
      displayName: 'Liepin',
      subscribeSearchUrl: '',
      loginUrl: '',
      storageStateFileName: '',
      openLoginPage: async () => undefined,
      openAuthenticatedHome: async (page) => page,
      assertAuthenticated: async () => undefined,
      openSubscribeSearch: async (page) => page,
      prepareSearchConditionPage: async (page) => page,
      discoverSearchFilters: async (_page, options) => {
        receivedOptions.push(options);
        return {
          platform: 'liepin',
          keyword: options.keyword,
          capturedAt: '2026-05-26T00:00:00.000Z',
          pageUrl: 'https://example.com/liepin',
          filters: [],
          failures: [],
          stats: {
            discoveredControls: 0,
            inspectedControls: 0,
            optionsExtracted: 0,
            failedControls: 0,
            unknownControls: 0,
          },
        } satisfies SearchFilterCatalog;
      },
      extractCandidateList: async () => ({ candidates: [] }),
      openResumeDetail: async (_context, page) => page,
      parseResumeDetail: async () => ({
        candidateId: 'x',
        regions: [],
        pr: [],
        workExperiences: [],
        projectExperiences: [],
        educationExperiences: [],
        skill: [],
        certificates: [],
      }),
    };

    const originalGetPlatformAdapter = module.getPlatformAdapterRef.fn;
    const originalEnsure = module.ensureAuthenticatedBrowserSessionRef.fn;
    const originalClose = module.closeBrowserSessionRef.fn;
    const originalSave = module.saveSearchFilterCatalogRef.fn;

    module.getPlatformAdapterRef.fn = (() => adapter) as typeof module.getPlatformAdapterRef.fn;
    module.ensureAuthenticatedBrowserSessionRef.fn = async () => session;
    module.closeBrowserSessionRef.fn = async () => undefined;
    module.saveSearchFilterCatalogRef.fn = async (_store, platform, catalog) => ({
      latestPath: `/tmp/${platform}/latest.json`,
      timestampedPath: `/tmp/${platform}/${catalog.capturedAt}.json`,
    });

    try {
      await module.runDiscoverSearchFilters({
        platform: 'liepin',
        keyword: '优衣库',
        includeRemoteProbes: true,
        slowClick: true,
        maxDepth: 2,
        maxOptionsPerLevel: 25,
      });
    } finally {
      module.getPlatformAdapterRef.fn = originalGetPlatformAdapter;
      module.ensureAuthenticatedBrowserSessionRef.fn = originalEnsure;
      module.closeBrowserSessionRef.fn = originalClose;
      module.saveSearchFilterCatalogRef.fn = originalSave;
    }

    assert.deepEqual(receivedOptions, [{
      keyword: '优衣库',
      globalTimeoutMs: 180000,
      maxDepth: 2,
      maxOptionsPerLevel: 25,
      includeRemoteProbes: true,
      slowClick: true,
    }]);
  });

  it('runDiscoverSearchFilters preserves all-platform order and stops on failure', async () => {
    const module = await loadDiscoverModule();
    const sessionCalls: string[] = [];
    const closeCalls: string[] = [];
    const prepareCalls: string[] = [];
    const discoverCalls: string[] = [];
    const saveCalls: string[] = [];
    const session = {
      page: { id: 'page' },
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
    } as never;
    const adapters = new Map<string, PlatformAdapter>([
      ['51job', {
        platform: '51job',
        displayName: '51job',
        subscribeSearchUrl: '',
        loginUrl: '',
        storageStateFileName: '',
        openLoginPage: async () => undefined,
        openAuthenticatedHome: async (page) => page,
        assertAuthenticated: async () => undefined,
        openSubscribeSearch: async (page) => page,
        prepareSearchConditionPage: async (page) => {
          prepareCalls.push('51job');
          return page;
        },
        discoverSearchFilters: async () => {
          discoverCalls.push('51job');
          return {
            platform: '51job',
            keyword: '优衣库',
            capturedAt: '2026-05-26T00:00:00.000Z',
            pageUrl: 'https://example.com/51job',
            filters: [],
            failures: [],
            stats: {
              discoveredControls: 0,
              inspectedControls: 0,
              optionsExtracted: 0,
              failedControls: 0,
              unknownControls: 0,
            },
          } satisfies SearchFilterCatalog;
        },
        extractCandidateList: async () => ({ candidates: [] }),
        openResumeDetail: async (_context, page) => page,
        parseResumeDetail: async () => ({
          candidateId: 'x',
          regions: [],
          pr: [],
          workExperiences: [],
          projectExperiences: [],
          educationExperiences: [],
          skill: [],
          certificates: [],
        }),
      }],
      ['liepin', {
        platform: 'liepin',
        displayName: 'Liepin',
        subscribeSearchUrl: '',
        loginUrl: '',
        storageStateFileName: '',
        openLoginPage: async () => undefined,
        openAuthenticatedHome: async (page) => page,
        assertAuthenticated: async () => undefined,
        openSubscribeSearch: async (page) => page,
        prepareSearchConditionPage: async () => {
          prepareCalls.push('liepin');
          throw new Error('liepin prepare failed');
        },
        discoverSearchFilters: async () => {
          discoverCalls.push('liepin');
          throw new Error('should not reach discovery');
        },
        extractCandidateList: async () => ({ candidates: [] }),
        openResumeDetail: async (_context, page) => page,
        parseResumeDetail: async () => ({
          candidateId: 'x',
          regions: [],
          pr: [],
          workExperiences: [],
          projectExperiences: [],
          educationExperiences: [],
          skill: [],
          certificates: [],
        }),
      }],
      ['zhilian', {
        platform: 'zhilian',
        displayName: 'Zhilian',
        subscribeSearchUrl: '',
        loginUrl: '',
        storageStateFileName: '',
        openLoginPage: async () => undefined,
        openAuthenticatedHome: async (page) => page,
        assertAuthenticated: async () => undefined,
        openSubscribeSearch: async (page) => page,
        prepareSearchConditionPage: async (page) => {
          prepareCalls.push('zhilian');
          return page;
        },
        discoverSearchFilters: async () => {
          discoverCalls.push('zhilian');
          return {
            platform: 'zhilian',
            keyword: '优衣库',
            capturedAt: '2026-05-26T00:00:00.000Z',
            pageUrl: 'https://example.com/zhilian',
            filters: [],
            failures: [],
            stats: {
              discoveredControls: 0,
              inspectedControls: 0,
              optionsExtracted: 0,
              failedControls: 0,
              unknownControls: 0,
            },
          } satisfies SearchFilterCatalog;
        },
        extractCandidateList: async () => ({ candidates: [] }),
        openResumeDetail: async (_context, page) => page,
        parseResumeDetail: async () => ({
          candidateId: 'x',
          regions: [],
          pr: [],
          workExperiences: [],
          projectExperiences: [],
          educationExperiences: [],
          skill: [],
          certificates: [],
        }),
      }],
    ]);

    const originalGetPlatformAdapter = module.getPlatformAdapterRef.fn;
    const originalListPlatforms = module.listSupportedPlatformsRef.fn;
    const originalEnsure = module.ensureAuthenticatedBrowserSessionRef.fn;
    const originalClose = module.closeBrowserSessionRef.fn;
    const originalSave = module.saveSearchFilterCatalogRef.fn;

    module.getPlatformAdapterRef.fn = ((platform) => adapters.get(platform)!) as typeof module.getPlatformAdapterRef.fn;
    module.listSupportedPlatformsRef.fn = (() => ['51job', 'liepin', 'zhilian']) as typeof module.listSupportedPlatformsRef.fn;
    module.ensureAuthenticatedBrowserSessionRef.fn = async (platform) => {
      sessionCalls.push(platform);
      return session;
    };
    module.closeBrowserSessionRef.fn = async () => {
      closeCalls.push('close');
    };
    module.saveSearchFilterCatalogRef.fn = async (_store, platform, catalog) => {
      saveCalls.push(platform);
      return {
        latestPath: `/tmp/${platform}/latest.json`,
        timestampedPath: `/tmp/${platform}/${catalog.capturedAt}.json`,
      };
    };

    try {
      await assert.rejects(
        () => module.runDiscoverSearchFilters({
          platform: 'all',
          keyword: '优衣库',
          includeRemoteProbes: false,
          slowClick: false,
        }),
        /liepin prepare failed/,
      );
    } finally {
      module.getPlatformAdapterRef.fn = originalGetPlatformAdapter;
      module.listSupportedPlatformsRef.fn = originalListPlatforms;
      module.ensureAuthenticatedBrowserSessionRef.fn = originalEnsure;
      module.closeBrowserSessionRef.fn = originalClose;
      module.saveSearchFilterCatalogRef.fn = originalSave;
    }

    assert.deepEqual(sessionCalls, ['51job', 'liepin']);
    assert.deepEqual(prepareCalls, ['51job', 'liepin']);
    assert.deepEqual(discoverCalls, ['51job']);
    assert.deepEqual(saveCalls, ['51job']);
    assert.deepEqual(closeCalls, ['close', 'close']);
  });
});

describe('filter DOM helpers', () => {
  it('filters out obvious non-filter controls and builds a bounded queue', () => {
    const snapshot: SearchFilterPageSnapshot = {
      controls: [
        {
          discoveryId: 'a',
          label: '城市',
          text: '城市',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '城市 筛选',
          domPath: 'div:nth-of-type(1)',
          cssPath: 'div.filter > button',
          x: 10,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: 'listbox',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
        {
          discoveryId: 'b',
          label: '下一页',
          text: '下一页',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '分页 下一页',
          domPath: 'div:nth-of-type(2)',
          cssPath: 'div.pagination > button',
          x: 10,
          y: 60,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
        {
          discoveryId: 'c',
          label: '订阅当前搜索条件，第一时间获取匹配的人才',
          text: '订阅',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '订阅 订阅当前搜索条件，第一时间获取匹配的人才 订阅',
          domPath: 'div:nth-of-type(3)',
          cssPath: 'div.popover > button',
          x: 10,
          y: 110,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    assert.equal(isFilterLikeControl(snapshot.controls[0]), true);
    assert.equal(isFilterLikeControl(snapshot.controls[1]), false);
    assert.deepEqual(buildDiscoveryQueue(snapshot, {
      maxControls: 5,
      ignoreTextPatterns: [/订阅当前搜索条件/, /第一时间获取匹配的人才/],
    }).map((item) => item.discoveryId), ['a']);
    assert.match(buildFilterKey('城市', 'filter-123'), /^城市-filter-123$/);
  });

  it('supports platform-specific include and ignore control hooks', () => {
    const snapshot: SearchFilterPageSnapshot = {
      controls: [
        {
          discoveryId: 'location',
          label: '',
          text: '',
          placeholder: '期望工作地',
          role: '',
          tagName: 'input',
          inputType: 'text',
          containerText: '',
          domPath: 'div:nth-of-type(1)',
          cssPath: 'div.location > input',
          x: 10,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
        {
          discoveryId: 'keyword',
          label: '',
          text: '',
          placeholder: '优衣库',
          role: '',
          tagName: 'input',
          inputType: 'text',
          containerText: '',
          domPath: 'div:nth-of-type(2)',
          cssPath: 'div.keyword > input',
          x: 120,
          y: 10,
          width: 180,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '优衣库',
          multi: false,
        },
        {
          discoveryId: 'search',
          label: '搜索',
          text: '搜索',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '搜索',
          domPath: 'div:nth-of-type(3)',
          cssPath: 'button.search_button',
          x: 320,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    assert.deepEqual(buildDiscoveryQueue(snapshot, {
      shouldIncludeControl: (control) => control.placeholder === '期望工作地',
      shouldIgnoreControl: (control) => control.placeholder === '优衣库' || control.text === '搜索',
    }).map((item) => item.discoveryId), ['location']);
  });

  it('allows platform-specific interaction mapping hooks', () => {
    const control = {
      discoveryId: 'location',
      label: '',
      text: '',
      placeholder: '期望工作地',
      role: '',
      tagName: 'input',
      inputType: 'text',
      containerText: '',
      domPath: 'div:nth-of-type(1)',
      cssPath: 'div.location > input',
      x: 10,
      y: 10,
      width: 100,
      height: 32,
      ariaExpanded: '',
      ariaHasPopup: '',
      readOnly: true,
      checked: false,
      disabled: true,
      value: '',
      multi: false,
    };

    const mapped = {
      ...control,
      disabled: false,
    };

    assert.equal(control.disabled, true);
    assert.equal(mapped.disabled, false);

    const fallback = { kind: 'fallback' } as unknown as Locator;
    const resolved = ((_: Page, currentControl: typeof control, currentFallback: Locator) => {
      if (currentControl.placeholder === '期望工作地') {
        return { kind: 'overlay' } as unknown as Locator;
      }
      return currentFallback;
    })({} as Page, mapped, fallback);

    assert.notEqual(resolved, fallback);
  });

  it('detects opened text-entry dialogs and skips option harvesting', () => {
    const before: SearchFilterPageSnapshot = {
      controls: [
        {
          discoveryId: 'industry-trigger',
          label: '期望行业',
          text: '期望行业',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '期望行业',
          domPath: 'div:nth-of-type(1)',
          cssPath: 'button.base-select-button',
          x: 10,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: 'dialog',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    const after: SearchFilterPageSnapshot = {
      controls: [
        before.controls[0],
        {
          discoveryId: 'industry-input',
          label: '',
          text: '',
          placeholder: '请输入行业',
          role: '',
          tagName: 'input',
          inputType: 'text',
          containerText: '期望行业 自定义专业',
          domPath: 'div:nth-of-type(2)',
          cssPath: 'div.dialog input',
          x: 20,
          y: 60,
          width: 180,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    assert.deepEqual(
      detectOpenedTextInputInteraction(before, after, before.controls[0]),
      { inputPlaceholder: '请输入行业' },
    );
  });

  it('records constrained menu options for text-entry dialogs with cascaders', () => {
    const before: SearchFilterPageSnapshot = {
      controls: [
        {
          discoveryId: 'industry-trigger',
          label: '期望行业',
          text: '期望行业',
          placeholder: '',
          role: 'button',
          tagName: 'button',
          inputType: '',
          containerText: '期望行业',
          domPath: 'div:nth-of-type(1)',
          cssPath: 'button.base-select-button',
          x: 10,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: 'dialog',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    const after: SearchFilterPageSnapshot = {
      controls: [
        before.controls[0],
        {
          discoveryId: 'industry-input',
          label: '',
          text: '',
          placeholder: '请输入行业',
          role: '',
          tagName: 'input',
          inputType: 'text',
          containerText: '期望行业 选择行业',
          domPath: 'div:nth-of-type(2)',
          cssPath: 'div.dialog input',
          x: 20,
          y: 60,
          width: 180,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: false,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [
        {
          key: 'industry-menu',
          discoveryId: 'container-1',
          text: '互联网/IT/电子/通信 金融 消费品 电子商务 企业服务',
          domPath: 'div:nth-of-type(3)',
          optionNodes: [
            {
              discoveryId: 'option-1',
              label: '互联网/IT/电子/通信',
              value: '互联网/IT/电子/通信',
              role: 'option',
              tagName: 'li',
              depth: 0,
              disabled: false,
              selected: false,
              checked: false,
              domPath: 'li:nth-of-type(1)',
            },
            {
              discoveryId: 'option-2',
              label: '电子商务',
              value: '电子商务',
              role: 'option',
              tagName: 'li',
              depth: 1,
              disabled: false,
              selected: false,
              checked: false,
              domPath: 'li:nth-of-type(2)',
            },
          ],
        },
      ],
    };

    assert.deepEqual(
      buildOpenedTextInputResult(before, after, before.controls[0]),
      {
        changedContainers: after.containers,
        controlType: 'textInput',
        inputPlaceholder: '请输入行业',
        childrenLazy: true,
        message: 'Opened text-entry dialog. Visible menu options were recorded as a constrained input pool.',
        preserveScopedContainers: true,
      },
    );
  });

  it('treats readonly inputs as selectable controls', () => {
    const snapshot: SearchFilterPageSnapshot = {
      controls: [
        {
          discoveryId: 'readonly-select',
          label: '',
          text: '',
          placeholder: '性别',
          role: '',
          tagName: 'input',
          inputType: 'text',
          containerText: '',
          domPath: 'div:nth-of-type(1)',
          cssPath: 'div.el-select > input',
          x: 10,
          y: 10,
          width: 100,
          height: 32,
          ariaExpanded: '',
          ariaHasPopup: '',
          readOnly: true,
          checked: false,
          disabled: false,
          value: '',
          multi: false,
        },
      ],
      containers: [],
    };

    assert.equal(isFilterLikeControl(snapshot.controls[0]), true);
    assert.deepEqual(buildDiscoveryQueue(snapshot).map((item) => item.discoveryId), ['readonly-select']);
  });

  it('detects changed containers and collects unique options', () => {
    const before = [{
      key: 'cities',
      discoveryId: 'container-1',
      text: '城市 北京 上海',
      domPath: 'div:nth-of-type(1)',
      optionNodes: [{
        discoveryId: 'option-1',
        label: '北京',
        value: '北京',
        role: 'option',
        tagName: 'li',
        depth: 0,
        disabled: false,
        selected: false,
        checked: false,
        domPath: 'li:nth-of-type(1)',
      }],
    }];
    const after = [{
      key: 'cities',
      discoveryId: 'container-1',
      text: '城市 北京 上海',
      domPath: 'div:nth-of-type(1)',
      optionNodes: [
        before[0].optionNodes[0],
        {
          discoveryId: 'option-2',
          label: '上海',
          value: '上海',
          role: 'option',
          tagName: 'li',
          depth: 0,
          disabled: false,
          selected: false,
          checked: false,
          domPath: 'li:nth-of-type(2)',
        },
      ],
    }];

    const changed = diffChangedContainers(before, after);
    assert.equal(changed.length, 1);
    assert.deepEqual(collectUniqueOptions(changed, 5).map((option) => option.label), ['北京', '上海']);
    assert.equal(isLikelyFilterContainer(after[0]), true);
  });
});
