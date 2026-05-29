import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { buildApplicationFilterOptions } from '../search/filter-application-options.js';
import { JobStore } from '../storage/job-store.js';

export interface ExportApplicationFilterOptionsCliInput {
  platform: SupportedPlatform;
  outputPath?: string;
}

export interface ExportApplicationFilterOptionsSummary {
  platform: SupportedPlatform;
  outputPath: string;
  fieldCount: number;
  fieldIds: string[];
}

export function parseArgs(argv: readonly string[]): ExportApplicationFilterOptionsCliInput {
  const platform = parsePlatformArg(argv[0]);
  const outputPath = argv[1]?.trim() || undefined;
  return {
    platform,
    outputPath,
  };
}

function buildDefaultOutputPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

export async function exportApplicationFilterOptions(
  input: ExportApplicationFilterOptionsCliInput,
): Promise<ExportApplicationFilterOptionsSummary> {
  const store = new JobStore();
  const catalog = await store.readLatestSearchFilterCatalog(input.platform);
  if (!catalog) {
    throw new Error(`Missing latest filter catalog for ${input.platform}. Run discover:filters first.`);
  }

  const applicationOptions = buildApplicationFilterOptions(catalog);
  const outputPath = path.resolve(input.outputPath ?? buildDefaultOutputPath(input.platform));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(applicationOptions, null, 2)}\n`, 'utf8');

  return {
    platform: input.platform,
    outputPath,
    fieldCount: applicationOptions.fieldCount,
    fieldIds: applicationOptions.fieldIds,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await exportApplicationFilterOptions(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
