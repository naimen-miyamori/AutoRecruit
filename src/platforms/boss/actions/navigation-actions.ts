import type { Page } from 'playwright';
import { config } from '../../../config.js';
import { clickBossControl, runBossAction } from './context.js';

const bossChatUrlPattern = /^https:\/\/www\.zhipin\.com\/web\/chat\/index(?:[/?#].*)?$/i;

export function isBossChatPage(url: string): boolean {
  return bossChatUrlPattern.test(url);
}

export async function openBossChatPage(page: Page): Promise<Page> {
  if (!isBossChatPage(page.url())) {
    await clickBossControl(
      page.locator('a[ka="menu-im"], a[href^="/web/chat/index"]').first(),
      page,
      config.playwright.searchPageTimeoutMs,
    );
    await page.waitForURL((url) => isBossChatPage(url.toString()), {
      timeout: config.playwright.searchPageTimeoutMs,
    });
  }

  await runBossAction(page, () => page.reload({
    waitUntil: 'domcontentloaded',
    timeout: config.playwright.searchPageTimeoutMs,
  }));

  const unreadTab = page.locator('.chat-message-filter-left span').filter({ hasText: '未读' }).first();
  await unreadTab.waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  const className = await unreadTab.getAttribute('class') ?? '';
  if (!className.split(/\s+/).includes('active')) {
    await clickBossControl(unreadTab, page, config.playwright.searchPageTimeoutMs);
  }

  await page.locator('.user-list').first().waitFor({ state: 'visible', timeout: config.playwright.searchPageTimeoutMs });
  return page;
}
