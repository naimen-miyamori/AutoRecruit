import { pathToFileURL } from 'node:url';
import { closeBrowserSessionRef, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import { getPlatformAdapter, listSupportedPlatforms, parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';

type CliPlatformSelection = SupportedPlatform | 'all';

export interface DiscoverSearchFiltersCliInput {
  platform: CliPlatformSelection;
  keyword: string;
  outputPath?: string;
  maxDepth?: number;
  maxOptionsPerLevel?: number;
  includeRemoteProbes: boolean;
  globalTimeoutMs?: number;
}

export interface DiscoverSearchFiltersPlatformSummary {
  platform: SupportedPlatform;
  catalog: SearchFilterCatalog;
  latestPath: string;
  timestampedPath: string;
  outputPath?: string;
}

export const getPlatformAdapterRef = { fn: getPlatformAdapter };
export const listSupportedPlatformsRef = { fn: listSupportedPlatforms };
export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export { closeBrowserSessionRef };
export const saveSearchFilterCatalogRef = {
  fn: (
    store: JobStore,
    platform: SupportedPlatform,
    catalog: SearchFilterCatalog,
    outputPath?: string,
  ) => store.saveSearchFilterCatalog(platform, catalog, outputPath),
};

function parseOptionalNumber(value: string | undefined, argumentName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${argumentName} must be a positive integer`);
  }

  return parsed;
}

function parseOptionalBoolean(value: string | undefined, argumentName: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${argumentName} must be true or false`);
}

function parsePlatformSelection(value: string | undefined): CliPlatformSelection {
  if (value === 'all') {
    return 'all';
  }

  return parsePlatformArg(value);
}

export function parseArgs(argv: readonly string[]): DiscoverSearchFiltersCliInput {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    flags.add(key);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  const keyword = values.get('keyword')?.trim();
  if (!keyword) {
    throw new Error('Missing required argument --keyword');
  }

  const includeRemoteProbes = flags.has('include-remote-probes')
    ? parseOptionalBoolean(values.get('include-remote-probes'), '--include-remote-probes')
    : false;
  const platform = parsePlatformSelection(values.get('platform'));

  if (platform === 'all' && values.has('output')) {
    throw new Error('--output cannot be combined with --platform all');
  }

  return {
    platform,
    keyword,
    outputPath: values.get('output'),
    maxDepth: parseOptionalNumber(values.get('max-depth'), '--max-depth'),
    maxOptionsPerLevel: parseOptionalNumber(values.get('max-options-per-level'), '--max-options-per-level'),
    includeRemoteProbes,
    globalTimeoutMs: parseOptionalNumber(values.get('global-timeout-ms'), '--global-timeout-ms'),
  };
}

function listSelectedPlatforms(platform: CliPlatformSelection): SupportedPlatform[] {
  return platform === 'all' ? listSupportedPlatformsRef.fn() : [platform];
}

export async function runDiscoverSearchFilters(
  input: DiscoverSearchFiltersCliInput,
): Promise<DiscoverSearchFiltersPlatformSummary | DiscoverSearchFiltersPlatformSummary[]> {
  const store = new JobStore();
  const results: DiscoverSearchFiltersPlatformSummary[] = [];

  for (const platform of listSelectedPlatforms(input.platform)) {
    const adapter = getPlatformAdapterRef.fn(platform);
    if (!adapter.prepareSearchConditionPage) {
      throw new Error(`Platform ${platform} does not support opening a search-condition input page.`);
    }
    if (!adapter.discoverSearchFilters) {
      throw new Error(`Platform ${platform} does not support search-filter discovery.`);
    }

    const session = await ensureAuthenticatedBrowserSessionRef.fn(platform);
    try {
      const searchDeadline = Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 45000);
      const discoveryTimeoutMs = input.globalTimeoutMs
        ?? Math.max(config.playwright.searchPageTimeoutMs * 6, 180000);
      const searchPage = await adapter.prepareSearchConditionPage(session.page, input.keyword, { deadline: searchDeadline });
      const catalog = await adapter.discoverSearchFilters(searchPage, {
        keyword: input.keyword,
        globalTimeoutMs: discoveryTimeoutMs,
        maxDepth: input.maxDepth,
        maxOptionsPerLevel: input.maxOptionsPerLevel,
        includeRemoteProbes: input.includeRemoteProbes,
      });
      const saved = await saveSearchFilterCatalogRef.fn(
        store,
        platform,
        catalog,
        input.platform === 'all' ? undefined : input.outputPath,
      );

      results.push({
        platform,
        catalog,
        latestPath: saved.latestPath,
        timestampedPath: saved.timestampedPath,
        outputPath: saved.outputPath,
      });
    } finally {
      await closeBrowserSessionRef.fn(session);
    }
  }

  return input.platform === 'all' ? results : results[0];
}

function printSummary(summary: DiscoverSearchFiltersPlatformSummary): void {
  const payload = {
    platform: summary.platform,
    keyword: summary.catalog.keyword,
    capturedAt: summary.catalog.capturedAt,
    pageUrl: summary.catalog.pageUrl,
    filters: summary.catalog.filters.length,
    failures: summary.catalog.failures.length,
    stats: summary.catalog.stats,
    latestPath: summary.latestPath,
    timestampedPath: summary.timestampedPath,
    outputPath: summary.outputPath,
  };

  console.log(JSON.stringify(payload, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseArgs(argv);
  const result = await runDiscoverSearchFilters(input);
  if (Array.isArray(result)) {
    for (const summary of result) {
      printSummary(summary);
    }
    return;
  }

  printSummary(result);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
