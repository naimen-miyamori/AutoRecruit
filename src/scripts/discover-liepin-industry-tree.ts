import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeBrowserSessionRef, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import {
  discoverLiepinIndustryTree,
  mergeLiepinIndustryFiltersIntoCatalog,
  type LiepinIndustryFieldId,
  type LiepinIndustryTreeDiscovery,
} from '../platforms/liepin-industry-tree.js';
import { liepinAdapter } from '../platforms/liepin-adapter.js';
import { buildApplicationFilterOptions } from '../search/filter-application-options.js';
import { createEmptySearchFilterCatalog } from '../search/filter-catalog.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';
import { JobStore } from '../storage/job-store.js';

export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export { closeBrowserSessionRef };
export const prepareLiepinSearchConditionPageRef = {
  fn: liepinAdapter.prepareSearchConditionPage?.bind(liepinAdapter),
};
export const discoverLiepinIndustryTreeRef = { fn: discoverLiepinIndustryTree };

export interface DiscoverLiepinIndustryTreeCliInput {
  keyword: string;
  fieldIds?: LiepinIndustryFieldId[];
  outputPath?: string;
  catalogOutputPath?: string;
  applicationOptionsOutputPath?: string;
}

export interface DiscoverLiepinIndustryTreeSummary {
  platform: 'liepin';
  keyword: string;
  capturedAt: string;
  pageUrl: string;
  fields: Array<{
    fieldId: LiepinIndustryFieldId;
    label: string;
    rootCount: number;
    optionCount: number;
  }>;
  rawLatestPath: string;
  rawTimestampedPath: string;
  rawOutputPath?: string;
  catalogLatestPath: string;
  catalogTimestampedPath: string;
  catalogOutputPath?: string;
  applicationOptionsPath: string;
}

function normalizeArgValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseFieldIds(value: string | undefined): LiepinIndustryFieldId[] | undefined {
  const normalizedValue = normalizeArgValue(value);
  if (!normalizedValue) {
    return undefined;
  }

  const fieldIds = normalizedValue.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const validFieldIds = new Set<LiepinIndustryFieldId>(['engaged_industry', 'expected_industry']);

  for (const fieldId of fieldIds) {
    if (!validFieldIds.has(fieldId as LiepinIndustryFieldId)) {
      throw new Error(`Unsupported Liepin industry field: ${fieldId}`);
    }
  }

  return fieldIds as LiepinIndustryFieldId[];
}

export function parseArgs(argv: readonly string[]): DiscoverLiepinIndustryTreeCliInput {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  const keyword = normalizeArgValue(values.get('keyword'));
  if (!keyword) {
    throw new Error('Missing required argument --keyword');
  }

  return {
    keyword,
    fieldIds: parseFieldIds(values.get('field')),
    outputPath: normalizeArgValue(values.get('output')),
    catalogOutputPath: normalizeArgValue(values.get('catalog-output')),
    applicationOptionsOutputPath: normalizeArgValue(values.get('application-options-output')),
  };
}

function buildDefaultApplicationOptionsPath(): string {
  return path.join(config.dataDir, 'liepin', 'filter-catalog', 'application-filter-options.latest.json');
}

function buildIndustryTreeOutputPaths(discovery: LiepinIndustryTreeDiscovery): {
  latestPath: string;
  timestampedPath: string;
} {
  const dir = path.join(config.dataDir, 'liepin', 'filter-catalog', 'industry-tree');
  const timestamp = discovery.capturedAt.replace(/[:.]/g, '-');
  return {
    latestPath: path.join(dir, 'latest.json'),
    timestampedPath: path.join(dir, `${timestamp}.json`),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function saveIndustryTreeDiscovery(
  discovery: LiepinIndustryTreeDiscovery,
  outputPath?: string,
): Promise<{ latestPath: string; timestampedPath: string; outputPath?: string }> {
  const paths = buildIndustryTreeOutputPaths(discovery);
  await Promise.all([
    writeJson(paths.latestPath, discovery),
    writeJson(paths.timestampedPath, discovery),
    outputPath ? writeJson(path.resolve(outputPath), discovery) : Promise.resolve(),
  ]);

  return {
    latestPath: paths.latestPath,
    timestampedPath: paths.timestampedPath,
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
  };
}

function createBaseCatalog(keyword: string, pageUrl: string): SearchFilterCatalog {
  return createEmptySearchFilterCatalog('liepin', keyword, pageUrl);
}

export async function runDiscoverLiepinIndustryTree(
  input: DiscoverLiepinIndustryTreeCliInput,
): Promise<DiscoverLiepinIndustryTreeSummary> {
  const store = new JobStore();
  const session = await ensureAuthenticatedBrowserSessionRef.fn('liepin');

  try {
    const searchDeadline = Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 45000);
    const searchPage = await prepareLiepinSearchConditionPageRef.fn?.(
      session.page,
      input.keyword,
      { deadline: searchDeadline },
    );
    if (!searchPage) {
      throw new Error('Liepin does not support opening a search-condition input page.');
    }

    const discovery = await discoverLiepinIndustryTreeRef.fn(searchPage, input.fieldIds);
    const rawSaved = await saveIndustryTreeDiscovery(discovery, input.outputPath);
    const latestCatalog = await store.readLatestSearchFilterCatalog('liepin');
    const baseCatalog = latestCatalog ?? createBaseCatalog(input.keyword, discovery.pageUrl);
    const mergedCatalog = mergeLiepinIndustryFiltersIntoCatalog(
      {
        ...baseCatalog,
        platform: 'liepin',
        keyword: baseCatalog.keyword || input.keyword,
      },
      discovery.fields.map((field) => field.filter),
      discovery.capturedAt,
      discovery.pageUrl,
    );
    const catalogSaved = await store.saveSearchFilterCatalog('liepin', mergedCatalog, input.catalogOutputPath);
    const applicationOptions = buildApplicationFilterOptions(mergedCatalog);
    const applicationOptionsPath = path.resolve(input.applicationOptionsOutputPath ?? buildDefaultApplicationOptionsPath());
    await writeJson(applicationOptionsPath, applicationOptions);

    return {
      platform: 'liepin',
      keyword: mergedCatalog.keyword,
      capturedAt: discovery.capturedAt,
      pageUrl: discovery.pageUrl,
      fields: discovery.fields.map((field) => ({
        fieldId: field.fieldId,
        label: field.label,
        rootCount: field.roots.length,
        optionCount: field.filter.options?.length ?? 0,
      })),
      rawLatestPath: rawSaved.latestPath,
      rawTimestampedPath: rawSaved.timestampedPath,
      rawOutputPath: rawSaved.outputPath,
      catalogLatestPath: catalogSaved.latestPath,
      catalogTimestampedPath: catalogSaved.timestampedPath,
      catalogOutputPath: catalogSaved.outputPath,
      applicationOptionsPath,
    };
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runDiscoverLiepinIndustryTree(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
