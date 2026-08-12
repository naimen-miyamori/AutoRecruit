import { bindCoreSavedSearchTarget } from '../mode-runners/saved-search-binding-runner.js';
import { verifyCoreSavedSearchTarget } from '../mode-runners/saved-search-verification-runner.js';
import type { CoreSavedSearchPlatform } from '../search/saved-search-target.js';
import { runBrowserCliMain } from '../browser/cli-lifecycle.js';

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name)?.normalize('NFKC').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function platformOption(argv: readonly string[]): CoreSavedSearchPlatform {
  const value = required(argv, '--platform');
  if (value !== '51job' && value !== 'liepin' && value !== 'zhilian') {
    throw new Error('--platform must be 51job, liepin, or zhilian.');
  }
  return value;
}

function revisionOption(argv: readonly string[]): number {
  const value = Number(required(argv, '--expected-revision'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--expected-revision must be a positive integer.');
  return value;
}

export async function runCoreSavedSearchMaintenanceCli(argv: readonly string[]): Promise<unknown> {
  const allowed = new Set([
    '--phase', '--platform', '--job-key', '--expected-revision', '--name', '--expected-keyword',
    '--evidence-hash', '--confirmed',
  ]);
  if (argv.length % 2 !== 0) throw new Error('Every option requires one value.');
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]!)) throw new Error(`Unknown option ${argv[index]}.`);
  }
  const phase = required(argv, '--phase');
  const common = {
    platform: platformOption(argv),
    jobKey: required(argv, '--job-key'),
    expectedRevision: revisionOption(argv),
    name: required(argv, '--name'),
    expectedKeyword: required(argv, '--expected-keyword'),
  };
  if (phase === 'verify') {
    if (readOption(argv, '--evidence-hash') || readOption(argv, '--confirmed')) {
      throw new Error('verify does not accept --evidence-hash or --confirmed.');
    }
    return verifyCoreSavedSearchTarget(common);
  }
  if (phase !== 'bind') throw new Error('--phase must be verify or bind.');
  if (required(argv, '--confirmed') !== 'true') throw new Error('bind requires --confirmed true.');
  return bindCoreSavedSearchTarget({
    ...common,
    evidenceHash: required(argv, '--evidence-hash'),
    confirmed: true,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runBrowserCliMain(async () => {
    const result = await runCoreSavedSearchMaintenanceCli(process.argv.slice(2));
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}
