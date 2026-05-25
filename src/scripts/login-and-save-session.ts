import { pathToFileURL } from 'node:url';
import {
  closeBrowserSessionRef,
  openAuthenticatedSubscribePageRef,
  openLoginSessionRef,
  persistBrowserSessionRef,
  verifyPersistedBrowserSessionRef,
} from '../browser/session.js';
import { waitForManualLoginAndPersistSession } from '../browser/manual-login-refresh.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';

function shouldKeepOpen(argv: string[]): boolean {
  return argv.includes('--keep-open');
}

function parseArgs(argv: string[]): { platform: SupportedPlatform; keepOpen: boolean } {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') || arg === '--keep-open') {
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

  return {
    platform: parsePlatformArg(values.get('platform')),
    keepOpen: shouldKeepOpen(argv),
  };
}

export async function runManualLoginSessionSave(argv = process.argv.slice(2)): Promise<void> {
  const { keepOpen, platform } = parseArgs(argv);

  await waitForManualLoginAndPersistSession(platform, {
    openLoginSession: openLoginSessionRef.fn,
    openAuthenticatedHome: openAuthenticatedSubscribePageRef.fn,
    persistBrowserSession: persistBrowserSessionRef.fn,
    verifyPersistedBrowserSession: verifyPersistedBrowserSessionRef.fn,
    closeBrowserSession: closeBrowserSessionRef.fn,
  }, { keepOpen });
}

async function main(): Promise<void> {
  await runManualLoginSessionSave(process.argv.slice(2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
