import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { isLiepinSearchUrl } from '../platforms/liepin-adapter.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseRequiredValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new Error('Usage: npm run debug:liepin-forward -- --keyword "<keyword>" --contact "<contactName>"');
  }

  return value;
}

function parseBooleanFlag(argv: string[], flag: string): boolean {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return false;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    return true;
  }

  return /^(1|true|yes)$/i.test(value);
}

function findExistingLiepinSearchPage(pages: Page[]): Page | undefined {
  return pages.find((page) => !page.isClosed() && isLiepinSearchUrl(page.url()));
}

async function closeDetailAndFocusSearchPage(detailPage: Page | undefined, searchPage: Page): Promise<void> {
  if (detailPage && detailPage !== searchPage && !detailPage.isClosed()) {
    await detailPage.close().catch(() => undefined);
  }

  if (!searchPage.isClosed()) {
    await searchPage.bringToFront().catch(() => undefined);
  }
}

export async function runLiepinForwardContactDebug(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseRequiredValue(argv, '--keyword');
  const contactName = parseRequiredValue(argv, '--contact');
  const includeViewedCandidates = parseBooleanFlag(argv, '--include-viewed');
  const confirmForward = parseBooleanFlag(argv, '--confirm');
  const adapter = getPlatformAdapter('liepin');
  const session = await ensureAuthenticatedBrowserSession('liepin');
  session.keepOpenOnExit = true;
  let searchPage: Page | undefined;
  let detailPage: Page | undefined;

  try {
    const existingSearchPage = findExistingLiepinSearchPage(session.context.pages());
    if (existingSearchPage) {
      session.page = existingSearchPage;
      console.error(`Reusing existing Liepin search page: ${existingSearchPage.url()}`);
    }

    searchPage = await adapter.openSubscribeSearch(session.page, keyword, { includeViewedCandidates });
    session.page = searchPage;
    const { candidates } = await adapter.extractCandidateList(searchPage);
    const firstCandidate = candidates[0];
    if (!firstCandidate) {
      throw new Error(`No Liepin candidates were extracted for keyword "${keyword}".`);
    }

    detailPage = await adapter.openResumeDetail(session.context, searchPage, firstCandidate);
    await adapter.afterResumeDetailOpened?.(detailPage, firstCandidate, {
      liepinForwardContact: contactName,
      liepinForwardContactMode: confirmForward ? 'confirm' : 'select-only',
    });

    const bodyText = await detailPage.locator('body').innerText().catch(() => '');
    console.log(JSON.stringify({
      stage: 'liepinForwardContactSelected',
      keyword,
      contactName,
      totalCandidates: candidates.length,
      firstCandidate,
      detailUrl: detailPage.url(),
      title: await detailPage.title().catch(() => ''),
      bodyPreview: bodyText.slice(0, 1200),
      note: confirmForward
        ? 'Forward contact was selected and the final confirm action was clicked.'
        : 'Forward dialog/contact selection was tested only. Final confirm was not clicked.',
    }, null, 2));
  } finally {
    if (searchPage) {
      await closeDetailAndFocusSearchPage(detailPage, searchPage);
      session.page = searchPage;
    }
    await closeBrowserSession(session);
  }
}

async function main(): Promise<void> {
  await runLiepinForwardContactDebug(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
