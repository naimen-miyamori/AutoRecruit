import { pathToFileURL } from 'node:url';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  return keyword && !keyword.startsWith('--') ? keyword : '';
}

export async function runBossSearchSmokeFlow(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const adapter = getPlatformAdapter('boss');
  const session = await ensureAuthenticatedBrowserSession('boss');

  try {
    const page = await adapter.openSubscribeSearch(session.page, keyword);
    const frame = page.frames().find((candidate) => /\/web\/frame\/search\//.test(candidate.url()))
      ?? page.frame({ name: 'searchFrame' });
    const selectedJob = frame
      ? await frame.locator('.search-job-list-C .search-current-job, .search-job-list-C .ui-dropmenu-label').first().innerText().catch(() => '')
      : '';

    console.log(JSON.stringify({
      platform: adapter.platform,
      keyword,
      url: page.url(),
      frameUrl: frame?.url() ?? '',
      selectedJob: selectedJob.replace(/\s+/g, ' ').trim(),
      browserKeptOpen: session.keepOpenOnExit === true,
    }, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

async function main(): Promise<void> {
  await runBossSearchSmokeFlow(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
