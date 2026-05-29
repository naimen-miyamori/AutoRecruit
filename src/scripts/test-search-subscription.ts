import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';

import type { PlatformAdapter } from '../platforms/types.js';
import {
  loadSearchConditionPlanFile,
  runSearchSubscriptionWorkflow,
} from '../search/search-subscription.js';

function buildAdapter(overrides: Partial<PlatformAdapter>): PlatformAdapter {
  return {
    platform: '51job',
    displayName: '51job',
    subscribeSearchUrl: 'https://example.com/subscribe',
    loginUrl: 'https://example.com/login',
    storageStateFileName: 'storage-state.json',
    openLoginPage: async () => undefined,
    openAuthenticatedHome: async (page) => page,
    assertAuthenticated: async () => undefined,
    openSubscribeSearch: async (page) => page,
    extractCandidateList: async () => ({ candidates: [] }),
    openResumeDetail: async (_context: BrowserContext, page: Page) => page,
    parseResumeDetail: async () => ({
      candidateId: 'candidate-1',
      regions: [],
      pr: [],
      workExperiences: [],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    }),
    ...overrides,
  };
}

async function loadIndexModule(): Promise<typeof import('../index.js')> {
  const scriptPath = fileURLToPath(new URL('../index.ts', import.meta.url));
  const moduleUrl = `${pathToFileURL(scriptPath).href}?searchSubscriptionTest=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

async function captureConsole(fn: () => Promise<void>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { stdout, stderr };
}

describe('search subscription workflow', () => {
  it('opens the condition search page, reads the total, and leaves non-keyword conditions skipped', async () => {
    const calls: string[] = [];
    const rootPage = { id: 'root-page' } as unknown as Page;
    const searchPage = { id: 'search-page' } as unknown as Page;
    const adapter = buildAdapter({
      prepareSearchConditionPage: async (page, keyword) => {
        assert.equal(page, rootPage);
        calls.push(`prepare:${keyword}`);
        return searchPage;
      },
      readSearchConditionResultTotal: async (page) => {
        assert.equal(page, searchPage);
        calls.push('read-total');
        return { resultTotal: 17, resultTotalSource: 'page' };
      },
      saveSearchCondition: async () => {
        calls.push('save');
      },
    });

    const summary = await runSearchSubscriptionWorkflow(adapter, rootPage, {
      keyword: '东南亚 销售',
      conditions: [{ kind: 'education', value: '本科' }],
    }, {
      save: false,
    });

    assert.deepStrictEqual(calls, ['prepare:东南亚 销售', 'read-total']);
    assert.equal(summary.platform, '51job');
    assert.equal(summary.keyword, '东南亚 销售');
    assert.equal(summary.resultTotal, 17);
    assert.equal(summary.resultTotalSource, 'page');
    assert.equal(summary.saveRequested, false);
    assert.equal(summary.saved, false);
    assert.equal(summary.allConditionsApplied, false);
    assert.deepEqual(summary.conditionStatusCounts, {
      applied: 0,
      skipped: 1,
      failed: 0,
    });
    assert.equal(summary.conditionResults.length, 1);
    assert.equal(summary.conditionResults[0].status, 'skipped');
    assert.match(summary.conditionResults[0].message ?? '', /not implemented/i);
  });

  it('saves the search condition only after reading the result total when requested', async () => {
    const calls: string[] = [];
    const rootPage = { id: 'root-page' } as unknown as Page;
    const searchPage = { id: 'search-page' } as unknown as Page;
    const adapter = buildAdapter({
      prepareSearchConditionPage: async (_page, keyword) => {
        calls.push(`prepare:${keyword}`);
        return searchPage;
      },
      readSearchConditionResultTotal: async () => {
        calls.push('read-total');
        return { resultTotal: 8, resultTotalSource: 'page' };
      },
      saveSearchCondition: async (_page, savedSearchName) => {
        calls.push(`save:${savedSearchName}`);
      },
    });

    const summary = await runSearchSubscriptionWorkflow(adapter, rootPage, {
      keyword: '优衣库',
      savedSearchName: '优衣库订阅',
      conditions: [],
    }, {
      save: true,
    });

    assert.deepStrictEqual(calls, ['prepare:优衣库', 'read-total', 'save:优衣库订阅']);
    assert.equal(summary.saved, true);
    assert.equal(summary.savedSearchName, '优衣库订阅');
  });

  it('refuses to save when any search condition was not applied', async () => {
    const calls: string[] = [];
    const rootPage = { id: 'root-page' } as unknown as Page;
    const searchPage = { id: 'search-page' } as unknown as Page;
    const adapter = buildAdapter({
      prepareSearchConditionPage: async () => {
        calls.push('prepare');
        return searchPage;
      },
      readSearchConditionResultTotal: async () => {
        calls.push('read-total');
        return { resultTotal: 8, resultTotalSource: 'page' };
      },
      saveSearchCondition: async () => {
        calls.push('save');
      },
    });

    await assert.rejects(
      () => runSearchSubscriptionWorkflow(adapter, rootPage, {
        keyword: '优衣库',
        savedSearchName: '优衣库订阅',
        conditions: [{ kind: 'education', value: '本科' }],
      }, {
        save: true,
      }),
      /not all search conditions were applied/i,
    );
    assert.deepEqual(calls, ['prepare', 'read-total']);
  });

  it('loads a condition plan from a JSON file and lets CLI keyword override the file keyword', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-search-subscription-'));
    const planPath = path.join(tempDir, 'conditions.json');

    try {
      await fs.writeFile(planPath, JSON.stringify({
        keyword: '文件关键词',
        savedSearchName: '文件订阅名',
        conditions: [{ kind: 'education', value: '本科' }],
      }), 'utf8');

      const plan = await loadSearchConditionPlanFile(planPath, {
        keywordOverride: '命令行关键词',
      });

      assert.deepStrictEqual(plan, {
        keyword: '命令行关键词',
        savedSearchName: '文件订阅名',
        conditions: [{ kind: 'education', value: '本科' }],
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads application filter input file and expands it into applicationFilter conditions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-search-subscription-filters-'));
    const planPath = path.join(tempDir, 'conditions.json');
    const inputPath = path.join(tempDir, 'filter-input.json');
    const optionsPath = path.join(tempDir, 'application-filter-options.json');

    try {
      await fs.writeFile(optionsPath, JSON.stringify({
        platform: '51job',
        capturedAt: '2026-05-26T13:23:24.638Z',
        keyword: '优衣库',
        fieldCount: 3,
        fieldIds: ['language', 'expected_location', 'expected_salary'],
        fieldIdByLabel: {
          语言要求: 'language',
          期望工作地: 'expected_location',
          期望月薪: 'expected_salary',
        },
        groups: {
          singleSelect: ['language'],
          textInput: ['expected_location'],
          salaryRange: ['expected_salary'],
        },
        fieldsById: {
          language: {
            fieldId: 'language',
            filterKey: 'language-filter',
            label: '语言要求',
            kind: 'singleSelect',
            restrictInput: true,
            valueShape: 'string',
            acceptedInputShapes: ['string'],
            allowedValues: ['大学英语四级及以上'],
            options: [{
              label: '大学英语四级及以上',
              value: '大学英语四级及以上',
              depth: 1,
              disabled: false,
              selected: false,
              parentPathLabels: ['英语'],
              pathLabels: ['英语', '大学英语四级及以上'],
            }],
          },
          expected_location: {
            fieldId: 'expected_location',
            filterKey: 'expected-location-filter',
            label: '期望工作地',
            kind: 'textInput',
            semanticKind: 'location',
            scope: 'expected',
            restrictInput: true,
            valueShape: 'string|string[]',
            acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
            allowedValues: ['热门城市', '广东省', '深圳'],
            rootValues: ['热门城市', '广东省'],
            valuesByDepth: [
              { depth: 0, values: ['热门城市', '广东省'] },
              { depth: 1, values: ['深圳'] },
            ],
            tree: [
              {
                key: '热门城市',
                label: '热门城市',
                depth: 0,
                pathLabels: ['热门城市'],
                children: [{
                  key: '热门城市\u0000深圳',
                  label: '深圳',
                  depth: 1,
                  pathLabels: ['热门城市', '深圳'],
                  children: [],
                }],
              },
              {
                key: '广东省',
                label: '广东省',
                depth: 0,
                pathLabels: ['广东省'],
                children: [{
                  key: '广东省\u0000深圳',
                  label: '深圳',
                  depth: 1,
                  pathLabels: ['广东省', '深圳'],
                  children: [],
                }],
              },
            ],
          },
          expected_salary: {
            fieldId: 'expected_salary',
            filterKey: 'expected-salary-filter',
            label: '期望月薪',
            kind: 'salaryRange',
            restrictInput: true,
            valueShape: 'object',
            acceptedInputShapes: ['{ min: string; max: string }'],
            minKey: 'min',
            maxKey: 'max',
            minLabel: '薪资下限',
            maxLabel: '薪资上限',
            orderedValues: ['2千', '3千'],
            minOptions: ['2千', '3千'],
            maxOptions: ['2千', '3千'],
            rule: {
              kind: 'orderedRange',
              comparison: 'maxSalaryValue >= minSalaryValue',
              message: '右侧薪资上限不能低于左侧薪资下限。',
            },
          },
        },
      }), 'utf8');
      await fs.writeFile(inputPath, JSON.stringify({
        language: '大学英语四级及以上',
        expected_location: {
          value: '深圳',
          pathLabels: ['广东省', '深圳'],
        },
        expected_salary: {
          min: '2千',
          max: '3千',
        },
      }), 'utf8');
      await fs.writeFile(planPath, JSON.stringify({
        keyword: '文件关键词',
        applicationFilterInputFile: './filter-input.json',
      }), 'utf8');

      const plan = await loadSearchConditionPlanFile(planPath, {
        platform: '51job',
        applicationFilterOptionsPath: optionsPath,
      });

      assert.equal(plan.keyword, '文件关键词');
      assert.deepEqual(plan.conditions, [
        {
          kind: 'applicationFilter',
          fieldId: 'language',
          label: '语言要求',
          fieldKind: 'singleSelect',
          value: '大学英语四级及以上',
          values: [{
            value: '大学英语四级及以上',
            pathLabels: ['英语', '大学英语四级及以上'],
          }],
        },
        {
          kind: 'applicationFilter',
          fieldId: 'expected_location',
          label: '期望工作地',
          fieldKind: 'textInput',
          value: {
            value: '深圳',
            pathLabels: ['广东省', '深圳'],
          },
          values: [{
            value: '深圳',
            pathLabels: ['广东省', '深圳'],
            ambiguous: false,
          }],
        },
        {
          kind: 'applicationFilter',
          fieldId: 'expected_salary',
          label: '期望月薪',
          fieldKind: 'salaryRange',
          value: {
            min: '2千',
            max: '3千',
          },
          values: [
            { value: '2千' },
            { value: '3千' },
          ],
        },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks text input conditions ambiguous when duplicate labels need a path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-search-subscription-ambiguous-filters-'));
    const optionsPath = path.join(tempDir, 'application-filter-options.json');

    try {
      await fs.writeFile(optionsPath, JSON.stringify({
        platform: '51job',
        capturedAt: '2026-05-26T13:23:24.638Z',
        keyword: '优衣库',
        fieldCount: 1,
        fieldIds: ['expected_location'],
        fieldIdByLabel: {
          期望工作地: 'expected_location',
        },
        groups: {
          singleSelect: [],
          textInput: ['expected_location'],
          salaryRange: [],
        },
        fieldsById: {
          expected_location: {
            fieldId: 'expected_location',
            filterKey: 'expected-location-filter',
            label: '期望工作地',
            kind: 'textInput',
            semanticKind: 'location',
            scope: 'expected',
            restrictInput: true,
            valueShape: 'string|string[]',
            acceptedInputShapes: ['string', 'string[]', '{ value: string; pathLabels: string[] }', '{ value: string; pathLabels: string[] }[]'],
            allowedValues: ['热门城市', '广东省', '深圳'],
            rootValues: ['热门城市', '广东省'],
            valuesByDepth: [
              { depth: 0, values: ['热门城市', '广东省'] },
              { depth: 1, values: ['深圳'] },
            ],
            tree: [
              {
                key: '热门城市',
                label: '热门城市',
                depth: 0,
                pathLabels: ['热门城市'],
                children: [{
                  key: '热门城市\u0000深圳',
                  label: '深圳',
                  depth: 1,
                  pathLabels: ['热门城市', '深圳'],
                  children: [],
                }],
              },
              {
                key: '广东省',
                label: '广东省',
                depth: 0,
                pathLabels: ['广东省'],
                children: [{
                  key: '广东省\u0000深圳',
                  label: '深圳',
                  depth: 1,
                  pathLabels: ['广东省', '深圳'],
                  children: [],
                }],
              },
            ],
          },
        },
      }), 'utf8');

      const planPath = path.join(tempDir, 'conditions.json');
      await fs.writeFile(planPath, JSON.stringify({
        keyword: '文件关键词',
        applicationFilterInput: {
          expected_location: '深圳',
        },
      }), 'utf8');

      const plan = await loadSearchConditionPlanFile(planPath, {
        platform: '51job',
        applicationFilterOptionsPath: optionsPath,
      });

      assert.deepEqual(plan.conditions, [{
        kind: 'applicationFilter',
        fieldId: 'expected_location',
        label: '期望工作地',
        fieldKind: 'textInput',
        value: '深圳',
        values: [{
          value: '深圳',
          pathLabels: ['热门城市', '深圳'],
          ambiguous: true,
        }],
      }]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applies search conditions through adapter before reading result total', async () => {
    const calls: string[] = [];
    const rootPage = { id: 'root-page' } as unknown as Page;
    const searchPage = { id: 'search-page' } as unknown as Page;
    const condition = {
      kind: 'applicationFilter',
      fieldId: 'expected_location',
      label: '期望工作地',
      fieldKind: 'textInput',
      value: '深圳',
      values: [{ value: '深圳', pathLabels: ['广东省', '深圳'] }],
    } as const;
    const adapter = buildAdapter({
      prepareSearchConditionPage: async () => {
        calls.push('prepare');
        return searchPage;
      },
      applySearchCondition: async (page, appliedCondition) => {
        assert.equal(page, searchPage);
        assert.deepEqual(appliedCondition, condition);
        calls.push(`apply:${appliedCondition.kind}`);
        return {
          platform: '51job',
          condition: appliedCondition,
          status: 'applied',
        };
      },
      readSearchConditionResultTotal: async (page) => {
        assert.equal(page, searchPage);
        calls.push('read-total');
        return { resultTotal: 21, resultTotalSource: 'page' };
      },
    });

    const summary = await runSearchSubscriptionWorkflow(adapter, rootPage, {
      keyword: '优衣库',
      conditions: [condition],
    }, {
      save: false,
    });

    assert.deepEqual(calls, ['prepare', 'apply:applicationFilter', 'read-total']);
    assert.equal(summary.resultTotal, 21);
    assert.equal(summary.allConditionsApplied, true);
    assert.deepEqual(summary.conditionStatusCounts, {
      applied: 1,
      skipped: 0,
      failed: 0,
    });
    assert.deepEqual(summary.conditionResults, [{
      platform: '51job',
      condition,
      status: 'applied',
    }]);
  });

  it('runs the standalone CLI mode without JD parsing or resume capture', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-search-subscription-cli-'));
    const planPath = path.join(tempDir, 'conditions.json');
    const rootPage = { id: 'root-page' } as unknown as Page;
    const calls: string[] = [];

    try {
      await fs.writeFile(planPath, JSON.stringify({
        keyword: '文件关键词',
        savedSearchName: '保存的订阅名',
        conditions: [],
      }), 'utf8');

      const indexModule = await loadIndexModule();
      indexModule.ensureAuthenticatedBrowserSessionRef.fn = async (platform) => {
        calls.push(`session:${platform}`);
        return {
          page: rootPage,
          context: { close: async () => undefined },
          browser: { close: async () => undefined },
        } as never;
      };
      indexModule.closeBrowserSessionRef.fn = async () => {
        calls.push('close');
      };
      indexModule.parseJobDescriptionRef.fn = async () => {
        throw new Error('JD parsing should not run in search-subscription mode');
      };
      indexModule.openSubscribeSearchRef.fn = async () => {
        throw new Error('resume capture should not run in search-subscription mode');
      };
      indexModule.runSearchSubscriptionWorkflowRef.fn = async (adapter, page, plan, options) => {
        assert.equal(adapter.platform, '51job');
        assert.equal(page, rootPage);
        calls.push(`workflow:${plan.keyword}:${options.save}:${options.savedSearchName ?? ''}`);
        return {
          platform: adapter.platform,
          keyword: plan.keyword,
          savedSearchName: plan.savedSearchName,
          resultTotal: 12,
          resultTotalSource: 'page',
          saveRequested: options.save,
          saved: options.save,
          allConditionsApplied: true,
          conditionStatusCounts: {
            applied: 0,
            skipped: 0,
            failed: 0,
          },
          conditionResults: [],
        };
      };

      const output = await captureConsole(async () => {
        await indexModule.main([
          '--platform',
          '51job',
          '--search-subscription-file',
          planPath,
          '--keyword',
          '命令行关键词',
          '--save-search-subscription',
          'true',
        ]);
      });

      const summary = JSON.parse(output.stdout.at(-1) ?? '{}') as {
        keyword?: string;
        resultTotal?: number;
        saved?: boolean;
        savedSearchName?: string;
      };

      assert.deepStrictEqual(calls, [
        'session:51job',
        'workflow:命令行关键词:true:',
        'close',
      ]);
      assert.equal(summary.keyword, '命令行关键词');
      assert.equal(summary.resultTotal, 12);
      assert.equal(summary.saved, true);
      assert.equal(summary.savedSearchName, '保存的订阅名');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
