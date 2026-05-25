import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  if (!keyword || keyword.startsWith('--')) {
    throw new Error('Usage: npx tsx src/scripts/debug-zhilian-search-state.ts --keyword "优衣库"');
  }

  return keyword;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const session = await ensureAuthenticatedBrowserSession('zhilian');
  const adapter = getPlatformAdapter('zhilian');
  const capturedResponses: Array<{ url: string; status: number; preview: unknown }> = [];

  try {
    session.page.on('response', async (response) => {
      const url = response.url();
      if (!/resume|candidate|talent|search|recommend|rd6|zhaopin/i.test(url)) {
        return;
      }

      let preview: unknown = '';
      try {
        const text = await response.text();
        preview = text.trim().startsWith('{') || text.trim().startsWith('[')
          ? JSON.parse(text)
          : text.slice(0, 1200);
      } catch {
        preview = { unreadable: true };
      }

      capturedResponses.push({
        url,
        status: response.status(),
        preview,
      });
    });

    const page = await adapter.openAuthenticatedHome(session.page);
    const body = await page.locator('body').innerText().catch(() => '');
    const links = await page.locator('a[href]').evaluateAll((elements) => elements.slice(0, 120).map((element) => ({
      href: (element as HTMLAnchorElement).href,
      text: ((element.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 160),
    }))).catch(() => [] as Array<{ href: string; text: string }>);
    const controls = await page.locator('body').evaluate(() => {
      const preview = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, button, a, [role="button"], [class*="search"], [class*="resume"], [class*="candidate"], [class*="talent"]'));
      return nodes.slice(0, 160).map((element) => ({
        tag: element.tagName,
        className: String(element.className ?? ''),
        role: element.getAttribute('role'),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        placeholder: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : null,
        text: preview(element.innerText || element.textContent),
        attributes: Object.fromEntries(
          element.getAttributeNames()
            .filter((name) => /href|resume|candidate|talent|search|data|id|class|role|placeholder/i.test(name))
            .map((name) => [name, element.getAttribute(name)]),
        ),
      }));
    }).catch(() => []);

    console.log(JSON.stringify({
      platform: 'zhilian',
      keyword,
      url: page.url(),
      title: await page.title().catch(() => ''),
      hasResumeText: /简历/.test(body),
      hasCandidateText: /候选人|人才/.test(body),
      hasSearchText: /搜索|搜人才|搜简历/.test(body),
      bodyPreview: body.slice(0, 2200),
      links,
      controls,
      capturedResponses: capturedResponses.slice(-20),
    }, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
