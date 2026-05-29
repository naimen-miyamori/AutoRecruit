import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { buildTextInputApplicationMapping } from '../search/filter-input-mapping.js';
import { JobStore } from '../storage/job-store.js';

export interface ExportFilterInputMappingCliInput {
  platform: SupportedPlatform;
  outputPath?: string;
}

export interface ExportFilterInputMappingSummary {
  platform: SupportedPlatform;
  outputPath: string;
  fieldCount: number;
  fieldIds: string[];
}

export function parseArgs(argv: readonly string[]): ExportFilterInputMappingCliInput {
  const platform = parsePlatformArg(argv[0]);
  const outputPath = argv[1]?.trim() || undefined;
  return {
    platform,
    outputPath,
  };
}

function buildDefaultOutputPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'text-input-mapping.latest.json');
}

export async function exportFilterInputMapping(
  input: ExportFilterInputMappingCliInput,
): Promise<ExportFilterInputMappingSummary> {
  const store = new JobStore();
  const catalog = await store.readLatestSearchFilterCatalog(input.platform);
  if (!catalog) {
    throw new Error(`Missing latest filter catalog for ${input.platform}. Run discover:filters first.`);
  }

  const mapping = buildTextInputApplicationMapping(catalog);
  const outputPath = path.resolve(input.outputPath ?? buildDefaultOutputPath(input.platform));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');

  return {
    platform: input.platform,
    outputPath,
    fieldCount: mapping.fieldCount,
    fieldIds: mapping.fieldIds,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await exportFilterInputMapping(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
