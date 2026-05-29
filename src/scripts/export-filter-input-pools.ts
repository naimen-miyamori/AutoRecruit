import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { buildTextInputPoolMap } from '../search/filter-input-pool.js';
import { JobStore } from '../storage/job-store.js';

export interface ExportFilterInputPoolsCliInput {
  platform: SupportedPlatform;
  outputPath?: string;
}

export interface ExportFilterInputPoolsSummary {
  platform: SupportedPlatform;
  outputPath: string;
  poolCount: number;
  labels: string[];
}

export function parseArgs(argv: readonly string[]): ExportFilterInputPoolsCliInput {
  const platform = parsePlatformArg(argv[0]);
  const outputPath = argv[1]?.trim() || undefined;
  return {
    platform,
    outputPath,
  };
}

function buildDefaultOutputPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'text-input-pools.latest.json');
}

export async function exportFilterInputPools(
  input: ExportFilterInputPoolsCliInput,
): Promise<ExportFilterInputPoolsSummary> {
  const store = new JobStore();
  const catalog = await store.readLatestSearchFilterCatalog(input.platform);
  if (!catalog) {
    throw new Error(`Missing latest filter catalog for ${input.platform}. Run discover:filters first.`);
  }

  const poolMap = buildTextInputPoolMap(catalog);
  const outputPath = path.resolve(input.outputPath ?? buildDefaultOutputPath(input.platform));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({
    platform: input.platform,
    capturedAt: catalog.capturedAt,
    keyword: catalog.keyword,
    poolCount: Object.keys(poolMap).length,
    pools: poolMap,
  }, null, 2)}\n`, 'utf8');

  return {
    platform: input.platform,
    outputPath,
    poolCount: Object.keys(poolMap).length,
    labels: Object.keys(poolMap),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await exportFilterInputPools(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
