import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { getPlatformAdapter } from '../platforms/registry.js';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  if (!keyword || keyword.startsWith('--')) {
    throw new Error('Usage: npx tsx src/scripts/debug-liepin-search-state.ts --keyword "<keyword>"');
  }

  return keyword;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const session = await ensureAuthenticatedBrowserSession('liepin');
  const adapter = getPlatformAdapter('liepin');
  let searchApiPayload: unknown;
  let searchApiUrl = '';

  try {
    session.page.on('response', async (response) => {
      if (!/api-h\.liepin\.com\/api\/com\.liepin\.searchfront4r\.h\.search-resumes/.test(response.url())) {
        return;
      }

      searchApiUrl = response.url();
      try {
        searchApiPayload = JSON.parse(await response.text()) as unknown;
      } catch {
        searchApiPayload = { parseError: true };
      }
    });

    const page = await adapter.openSubscribeSearch(session.page, keyword);
    const body = await page.locator('body').innerText().catch(() => '');
    const candidateLikeAnchors = await page.locator([
      'a[href*="resumeId="]',
      'a[href*="candidateId="]',
      'a[href*="/resume/"]',
      'a[href*="/resume-detail/"]',
      'a[data-resume-id]',
      'a[data-candidate-id]',
    ].join(', ')).count().catch(() => -1);
    const cardDiagnostics = await page.locator('body').evaluate(() => {
      const preview = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const allElements = Array.from(document.querySelectorAll<HTMLElement>('body *'));
      const candidateish = allElements
        .filter((element) => {
          const text = element.innerText ?? '';
          return /立即沟通/.test(text) && /求职期望/.test(text);
        })
        .slice(0, 5);

      const dataAttributeElements = allElements
        .filter((element) => Array.from(element.getAttributeNames()).some((name) => /resume|candidate|resid|userid|data-v-|data-id|data-tlg/i.test(name)))
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          attributes: Object.fromEntries(
            element.getAttributeNames()
              .filter((name) => /resume|candidate|resid|userid|data-v-|data-id|data-tlg/i.test(name))
              .map((name) => [name, element.getAttribute(name)]),
          ),
          text: preview(element.innerText),
        }));

      return {
        candidateish: candidateish.map((element) => {
          const ancestors = [];
          let current: HTMLElement | null = element;
          for (let depth = 0; depth < 4 && current; depth += 1) {
            const node: HTMLElement = current;
            ancestors.push({
              tag: node.tagName,
              className: node.className,
              attributes: Object.fromEntries(node.getAttributeNames().map((name: string) => [name, node.getAttribute(name)])),
              text: preview(node.innerText),
              html: node.outerHTML.slice(0, 1200),
            });
            current = node.parentElement;
          }
          return ancestors;
        }),
        buttons: allElements
          .filter((element) => /立即沟通|查看|简历|详情/.test(element.innerText ?? ''))
          .slice(0, 20)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            role: element.getAttribute('role'),
            attributes: Object.fromEntries(element.getAttributeNames().map((name) => [name, element.getAttribute(name)])),
            text: preview(element.innerText),
            html: element.outerHTML.slice(0, 600),
          })),
        dataAttributeElements,
      };
    }).catch(() => ({ candidateish: [], buttons: [], dataAttributeElements: [] }));
    const links = await page.locator('a[href]').evaluateAll((elements) => elements.slice(0, 80).map((element) => ({
      href: (element as HTMLAnchorElement).href,
      text: ((element.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120),
    }))).catch(() => [] as Array<{ href: string; text: string }>);

    console.log(JSON.stringify({
      keyword,
      url: page.url(),
      title: await page.title().catch(() => ''),
      candidateLikeAnchors,
      resultCountText: body.match(/共\s*\d+\s*位人选/g) ?? [],
      hasQuickSearch: /快捷搜索/.test(body),
      hasSearchButton: /搜\s*索/.test(body),
      searchApiUrl,
      searchApiPayload,
      cardDiagnostics,
      bodyPreview: body.slice(0, 2000),
      links,
    }, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
