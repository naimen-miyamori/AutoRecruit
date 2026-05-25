import { pathToFileURL } from 'node:url';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  if (!keyword || keyword.startsWith('--')) {
    throw new Error('Usage: npm run smoke:liepin -- --keyword "<keyword>" [--parse-first]');
  }

  return keyword;
}

export async function runLiepinSmokeFlow(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const parseFirst = argv.includes('--parse-first');
  const adapter = getPlatformAdapter('liepin');
  const session = await ensureAuthenticatedBrowserSession('liepin');

  try {
    let searchPage;
    try {
      searchPage = await adapter.openSubscribeSearch(session.page, keyword);
    } catch (error) {
      const page = session.page;
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const diagnostics = {
        stage: 'openSubscribeSearch',
        platform: adapter.platform,
        keyword,
        finalUrl: page.url(),
        title: await page.title().catch(() => ''),
        bodyPreview: bodyText.slice(0, 1200),
      };
      console.error(JSON.stringify(diagnostics, null, 2));
      throw error;
    }

    const { candidates } = await adapter.extractCandidateList(searchPage);
    const summary: Record<string, unknown> = {
      platform: adapter.platform,
      keyword,
      totalCandidates: candidates.length,
      sampleCandidates: candidates.slice(0, 5),
    };

    if (parseFirst && candidates[0]) {
      const detailPage = await adapter.openResumeDetail(session.context, searchPage, candidates[0]);

      try {
        summary.firstResume = await adapter.parseResumeDetail(detailPage, candidates[0]);
      } finally {
        if (detailPage !== session.page) {
          await detailPage.close();
        }
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

async function main(): Promise<void> {
  await runLiepinSmokeFlow(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
