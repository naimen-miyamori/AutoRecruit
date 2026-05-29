import { pathToFileURL } from 'node:url';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { normalize51jobFilterDefinition } from '../platforms/51job-filter-normalization.js';
import { JobStore } from '../storage/job-store.js';

export interface NormalizeFilterCatalogCliInput {
  platform: SupportedPlatform;
}

export interface NormalizeFilterCatalogSummary {
  platform: SupportedPlatform;
  latestPath: string;
  timestampedPath: string;
  filterCount: number;
}

export function parseArgs(argv: readonly string[]): NormalizeFilterCatalogCliInput {
  return {
    platform: parsePlatformArg(argv[0]),
  };
}

function normalizeCatalogFilters(platform: SupportedPlatform, storeCatalog: Awaited<ReturnType<JobStore['readLatestSearchFilterCatalog']>>) {
  if (!storeCatalog) {
    throw new Error(`Missing latest filter catalog for ${platform}.`);
  }

  if (platform !== '51job') {
    return storeCatalog;
  }

  return {
    ...storeCatalog,
    filters: storeCatalog.filters.map(normalize51jobFilterDefinition),
  };
}

export async function normalizeFilterCatalog(
  input: NormalizeFilterCatalogCliInput,
): Promise<NormalizeFilterCatalogSummary> {
  const store = new JobStore();
  const catalog = normalizeCatalogFilters(input.platform, await store.readLatestSearchFilterCatalog(input.platform));
  const saved = await store.saveSearchFilterCatalog(input.platform, catalog);
  return {
    platform: input.platform,
    latestPath: saved.latestPath,
    timestampedPath: saved.timestampedPath,
    filterCount: catalog.filters.length,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await normalizeFilterCatalog(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
