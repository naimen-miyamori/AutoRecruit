import path from 'node:path';
import { seedRagFixtures } from '../rag/seed-fixtures.js';

interface Args {
  fixtureDir: string;
  overwrite: boolean;
  index: boolean;
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
    fixtureDir: values.get('fixture-dir') ?? './fixtures/rag',
    overwrite: parseBoolean(values.get('overwrite'), '--overwrite', false),
    index: parseBoolean(values.get('index'), '--index', false),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await seedRagFixtures({
    fixtureDir: path.resolve(args.fixtureDir),
    overwrite: args.overwrite,
    index: args.index,
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
