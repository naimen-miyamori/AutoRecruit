import path from 'node:path';
import { runRagBaseline } from '../rag/baseline.js';

interface Args {
  fixtureDir?: string;
  suiteFile?: string;
  overwrite: boolean;
  failOnMismatch: boolean;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
}

function parseOptionalPositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, flagName: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${flagName} must be true or false`);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    fixtureDir: values.get('fixture-dir'),
    suiteFile: values.get('suite-file'),
    overwrite: parseBoolean(values.get('overwrite'), '--overwrite', false),
    failOnMismatch: parseBoolean(values.get('fail-on-mismatch'), '--fail-on-mismatch', true),
    topK: parseOptionalPositiveInteger(values.get('top-k'), '--top-k'),
    denseTopK: parseOptionalPositiveInteger(values.get('dense-top-k'), '--dense-top-k'),
    keywordTopK: parseOptionalPositiveInteger(values.get('keyword-top-k'), '--keyword-top-k'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runRagBaseline({
    fixtureDir: args.fixtureDir ? path.resolve(args.fixtureDir) : undefined,
    suiteFile: args.suiteFile ? path.resolve(args.suiteFile) : undefined,
    overwrite: args.overwrite,
    topK: args.topK,
    denseTopK: args.denseTopK,
    keywordTopK: args.keywordTopK,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (args.failOnMismatch && !summary.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
