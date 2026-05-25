import { Page } from 'playwright';

export interface RawPageSource {
  url: string;
  title: string;
  html: string;
  visibleText: string;
  fetchedAt: string;
}

export async function buildRawPageSource(page: Page, fetchedAt = new Date().toISOString()): Promise<RawPageSource> {
  const [title, html, visibleText] = await Promise.all([
    page.title().catch(() => ''),
    page.content(),
    page.locator('body').innerText().catch(() => ''),
  ]);

  return {
    url: page.url(),
    title,
    html,
    visibleText,
    fetchedAt,
  };
}
