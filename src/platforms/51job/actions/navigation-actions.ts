import type { Page } from 'playwright';
import { gotoPlatformPage } from '../../../browser/pacing.js';

export const fiftyOneJobLoginUrl = 'https://ehire.51job.com/Revision/talent/subscribe';
export const fiftyOneJobSubscribeSearchUrl = fiftyOneJobLoginUrl;

export async function open51jobLoginPage(page: Page): Promise<void> {
  await gotoPlatformPage(page, '51job', fiftyOneJobLoginUrl, { waitUntil: 'domcontentloaded' });
}

export async function open51jobAuthenticatedHome(page: Page): Promise<Page> {
  await gotoPlatformPage(page, '51job', fiftyOneJobSubscribeSearchUrl, { waitUntil: 'domcontentloaded' });
  const { assertAuthenticatedPage } = await import('../../../browser/subscribe-search.js');
  await assertAuthenticatedPage(page);
  return page;
}

export async function assert51jobAuthenticated(page: Page): Promise<void> {
  const { assertAuthenticatedPage } = await import('../../../browser/subscribe-search.js');
  await assertAuthenticatedPage(page);
}
