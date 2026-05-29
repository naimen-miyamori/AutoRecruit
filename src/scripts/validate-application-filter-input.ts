import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import {
  validateApplicationFilterInput,
  type ApplicationFilterOptions,
  type ValidateApplicationFilterInputResult,
} from '../search/filter-application-options.js';
import type { SupportedPlatform } from '../platforms/types.js';

export interface ValidateApplicationFilterInputCliInput {
  platform: SupportedPlatform;
  inputPath: string;
  optionsPath?: string;
}

export interface ValidateApplicationFilterInputSummary extends ValidateApplicationFilterInputResult {
  platform: SupportedPlatform;
  inputPath: string;
  optionsPath: string;
}

export function parseArgs(argv: readonly string[]): ValidateApplicationFilterInputCliInput {
  const platform = parsePlatformArg(argv[0]);
  const inputPath = argv[1]?.trim();
  const optionsPath = argv[2]?.trim() || undefined;

  if (!inputPath) {
    throw new Error('Usage: validate-application-filter-input <platform> <input-json> [application-filter-options-json]');
  }

  return {
    platform,
    inputPath,
    optionsPath,
  };
}

function buildDefaultOptionsPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'application-filter-options.latest.json');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

export async function validateApplicationFilterInputFile(
  input: ValidateApplicationFilterInputCliInput,
): Promise<ValidateApplicationFilterInputSummary> {
  const inputPath = path.resolve(input.inputPath);
  const optionsPath = path.resolve(input.optionsPath ?? buildDefaultOptionsPath(input.platform));
  const [applicationOptions, applicationInput] = await Promise.all([
    readJsonFile<ApplicationFilterOptions>(optionsPath),
    readJsonFile<unknown>(inputPath),
  ]);

  if (applicationOptions.platform !== input.platform) {
    throw new Error(`Application filter options platform mismatch: expected ${input.platform}, got ${applicationOptions.platform}`);
  }

  if (!isPlainRecord(applicationInput)) {
    throw new Error('Application filter input must be a JSON object keyed by application fieldId.');
  }

  const result = validateApplicationFilterInput(applicationOptions, applicationInput);
  return {
    platform: input.platform,
    inputPath,
    optionsPath,
    ...result,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await validateApplicationFilterInputFile(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
