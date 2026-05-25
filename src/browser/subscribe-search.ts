import { Locator, Page } from 'playwright';
import { config } from '../config.js';
import { openAuthenticatedHome as openAuthenticatedSubscribePage } from './session.js';
import type { SearchWaitOptions, SupportedPlatform } from '../platforms/types.js';

const searchButtonSelector = 'button.to-talent-search-button';
const searchLinkSelector = 'a.to-talent-search-button, a[href*="/Revision/talent/search"]';
const searchTriggerSelectors = [
  searchLinkSelector,
  searchButtonSelector,
  '.to-talent-search-button',
  '[data-role="to-talent-search"]',
  '[data-action*="talent"][data-action*="search"]',
  '[class*="talent-search"]',
  '[class*="to-talent-search"]',
  '[class*="search-btn"]',
  '[class*="search-button"]',
  '[title*="人才搜索"]',
  '[aria-label*="人才搜索"]',
];
const pageLevelSearchSelectors = [
  ...searchTriggerSelectors,
  'button:has-text("搜索")',
  '.el-button:has-text("搜索")',
  '[role="button"]:has-text("搜索")',
];
const cardSelector = '.talent-subscribe-card-main-wrapper';
const titleSelector = '.card-title';
const pageReadySelector = `${cardSelector}, .el-empty`;
const loadingMaskSelector = '.el-loading-mask';
const subscriptionCardsSettleDelayMs = 3000;

export const waitForAuthenticatedSubscribeReadyRef = {
  fn: waitForAuthenticatedSubscribeReady,
};
export const openAuthenticatedSubscribePageRef = {
  fn: openAuthenticatedSubscribePageWithDeadline,
};
export const waitForSearchTriggerReadyRef = {
  fn: waitForSearchTriggerReady,
};
export const clickSearchTriggerRef = {
  fn: clickSearchTrigger,
};
export const findSubscriptionCardRef = {
  fn: findSubscriptionCard,
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '').trim().toLowerCase();
}

function getRemainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function resolveSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + config.playwright.searchPageTimeoutMs;
}

async function openAuthenticatedSubscribePageWithDeadline(
  page: Page,
  platform: SupportedPlatform,
  options?: SearchWaitOptions,
): Promise<Page> {
  if (platform === '51job' && options?.deadline) {
    await page.goto(config.playwright.subscribeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: getRemainingTimeout(options.deadline),
    });
    await waitForAuthenticatedSubscribeReadyRef.fn(page, options);
    return page;
  }

  return openAuthenticatedSubscribePage(page, platform);
}

async function raceSuccessfulWaits<T>(operations: Array<() => Promise<T>>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let pending = operations.length;

    if (pending === 0) {
      resolve(undefined);
      return;
    }

    for (const operation of operations) {
      operation()
        .then((value) => resolve(value))
        .catch(() => {
          pending -= 1;
          if (pending === 0) {
            resolve(undefined);
          }
        });
    }
  });
}

export async function waitForAuthenticatedSubscribeReady(page: Page, options?: SearchWaitOptions): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  if (await isLoginPage(page)) {
    throw new Error('51job authenticated subscribe page is not available because the session has fallen back to the login screen.');
  }

  const cards = page.locator(cardSelector);
  const deadline = resolveSearchDeadline(options);
  const readiness = await raceSuccessfulWaits([
    async () => {
      await cards.first().waitFor({ state: 'visible', timeout: getRemainingTimeout(deadline) });
      return 'visible' as const;
    },
    async () => {
      await page.locator(pageReadySelector).first().waitFor({ state: 'visible', timeout: getRemainingTimeout(deadline) });
      return 'page-ready' as const;
    },
    async () => {
      await cards.first().waitFor({ state: 'attached', timeout: getRemainingTimeout(deadline) });
      return 'attached' as const;
    },
  ]);

  if (!readiness) {
    await cards.first().waitFor({ state: 'attached', timeout: getRemainingTimeout(deadline) });
  }
}

async function listVisibleCardTitles(page: Page): Promise<string[]> {
  const cards = page.locator(cardSelector);
  const count = await cards.count();
  const titles: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const title = await cards.nth(index).locator(titleSelector).first().innerText().catch(() => '');
    if (title.trim()) {
      titles.push(title.trim());
    }
  }

  return titles;
}

async function waitForSearchTriggerReady(page: Page, searchTrigger: Locator, options?: SearchWaitOptions): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  await searchTrigger.waitFor({ state: 'attached', timeout: getRemainingTimeout(deadline) });
  await searchTrigger.waitFor({ state: 'visible', timeout: getRemainingTimeout(deadline) });
  const loadingMask = page.locator(loadingMaskSelector).filter({ visible: true }).first();
  await loadingMask.waitFor({ state: 'hidden', timeout: 1 }).catch(() => undefined);
}

async function resolveSearchTriggerFromTier(candidates: Locator[], deadline: number): Promise<Locator | undefined> {
  return raceSuccessfulWaits(candidates.map((searchTrigger) => async () => {
    await searchTrigger.waitFor({ state: 'attached', timeout: Math.min(2000, getRemainingTimeout(deadline)) });
    return searchTrigger;
  }));
}

async function resolveSearchTrigger(page: Page, card: Locator, deadline: number): Promise<Locator> {
  const selectorCandidates = searchTriggerSelectors.map((selector) => card.locator(selector).first());
  const selectorMatch = await resolveSearchTriggerFromTier(selectorCandidates, deadline);
  if (selectorMatch) {
    return selectorMatch;
  }

  const textCandidates = [
    card.getByText('人才搜索', { exact: false }).first(),
    card.getByRole('button', { name: /人才搜索|搜索/ }).first(),
    card.getByRole('link', { name: /人才搜索|搜索/ }).first(),
  ];
  const textMatch = await resolveSearchTriggerFromTier(textCandidates, deadline);
  if (textMatch) {
    return textMatch;
  }

  const pageSelectorCandidates = pageLevelSearchSelectors.map((selector) => page.locator(selector).filter({ visible: true }).first());
  const pageSelectorMatch = await resolveSearchTriggerFromTier(pageSelectorCandidates, deadline);
  if (pageSelectorMatch) {
    return pageSelectorMatch;
  }

  const pageTextCandidates = [
    page.getByText('人才搜索', { exact: false }).first(),
    page.getByRole('button', { name: /人才搜索|搜索/ }).first(),
    page.getByRole('link', { name: /人才搜索|搜索/ }).first(),
  ];
  const pageTextMatch = await resolveSearchTriggerFromTier(pageTextCandidates, deadline);
  if (pageTextMatch) {
    return pageTextMatch;
  }

  throw new Error('Talent search entry did not appear within the matched subscribe card.');
}

async function clickSearchTrigger(page: Page, searchTrigger: Locator, options?: SearchWaitOptions): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  let lastError: unknown;

  while (Date.now() < deadline) {
    await waitForSearchTriggerReadyRef.fn(page, searchTrigger, { deadline });

    try {
      await searchTrigger.click({ timeout: getRemainingTimeout(deadline) });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Talent search button did not become clickable before timing out.');
}

async function findSubscriptionCard(page: Page, searchKeyword: string, options?: SearchWaitOptions): Promise<Locator> {
  const deadline = resolveSearchDeadline(options);
  await waitForAuthenticatedSubscribeReadyRef.fn(page, { deadline });

  const settleDelayMs = Math.min(subscriptionCardsSettleDelayMs, Math.max(0, deadline - Date.now()));
  if (settleDelayMs > 0) {
    await page.waitForTimeout(settleDelayMs);
  }

  const cards = page.locator(cardSelector);
  const count = await cards.count();
  const normalizedKeyword = normalizeText(searchKeyword);
  const keywordPrefix = normalizedKeyword.slice(0, 6);
  const exactMatches: number[] = [];
  const prefixMatches: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const title = card.locator(titleSelector).first();
    const text = normalizeText(await title.innerText().catch(() => ''));

    if (!text) {
      continue;
    }

    if (text === normalizedKeyword) {
      exactMatches.push(index);
      continue;
    }

    if (keywordPrefix && text.startsWith(keywordPrefix)) {
      prefixMatches.push(index);
    }
  }

  if (exactMatches.length === 1) {
    return cards.nth(exactMatches[0]);
  }

  if (exactMatches.length > 1) {
    throw new Error(`Found multiple saved searches that exactly match "${searchKeyword}".`);
  }

  if (prefixMatches.length === 1) {
    return cards.nth(prefixMatches[0]);
  }

  if (prefixMatches.length > 1) {
    throw new Error(`Found multiple saved searches that partially match "${searchKeyword}".`);
  }

  const visibleTitles = await listVisibleCardTitles(page);
  throw new Error(`Could not find saved search "${searchKeyword}" on the subscribe page. Visible titles: ${visibleTitles.join(' | ') || '(none)'}`);
}

export async function isLoginPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText();
  return bodyText.includes('登录') || (bodyText.includes('账号') && bodyText.includes('密码'));
}

export async function assertAuthenticatedPage(page: Page): Promise<void> {
  if (await isLoginPage(page)) {
    throw new Error('51job authenticated subscribe page is not available because the session has fallen back to the login screen.');
  }

  await waitForAuthenticatedSubscribeReadyRef.fn(page);
}

export async function openSubscribeSearch(page: Page, searchKeyword: string, options?: SearchWaitOptions): Promise<Page> {
  const deadline = resolveSearchDeadline(options);
  await openAuthenticatedSubscribePageRef.fn(page, '51job', { deadline });

  const card = await findSubscriptionCardRef.fn(page, searchKeyword, { deadline });
  await card.scrollIntoViewIfNeeded();
  await card.hover();

  const searchTrigger = await resolveSearchTrigger(page, card, deadline);

  const originalUrl = page.url();
  const popupPromise = page.context().waitForEvent('page', { timeout: getRemainingTimeout(deadline) }).catch(() => null);
  const navigationPromise = page.waitForURL((url) => url.toString() !== originalUrl, { timeout: getRemainingTimeout(deadline) }).then(() => page).catch(() => null);

  await clickSearchTriggerRef.fn(page, searchTrigger, { deadline });

  const openOutcome = await Promise.race([
    popupPromise.then((popupPage) => (popupPage ? { page: popupPage } : null)),
    navigationPromise.then((navigatedPage) => (navigatedPage ? { page: navigatedPage } : null)),
  ]);

  if (openOutcome) {
    await openOutcome.page.waitForLoadState('domcontentloaded', { timeout: getRemainingTimeout(deadline) });
    return openOutcome.page;
  }

  const searchLinkHref = await searchTrigger.getAttribute('href').catch(() => null);
  if (searchLinkHref) {
    await page.goto(searchLinkHref, { waitUntil: 'domcontentloaded', timeout: getRemainingTimeout(deadline) });
    return page;
  }

  throw new Error('Talent search did not open a popup or navigate the current page before the shared search deadline.');
}
