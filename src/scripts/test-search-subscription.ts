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
