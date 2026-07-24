import { Locator, Page } from 'playwright';
import { config } from '../config.js';
import { clickPlatformLocator } from './pacing.js';
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
  '[class*="to-talent-search"]',
  '[title*="人才搜索"]',
  '[aria-label*="人才搜索"]',
];
const cardSelector = '.talent-subscribe-card-main-wrapper';
const titleSelector = '.card-title';
const conditionPanelSelector = '.talent-subscribe-condition-popover';
const conditionPanelTitleSelector = '.subscribe-title';
const pageReadySelector = `${cardSelector}, .el-empty`;
const loadingMaskSelector = '.el-loading-mask';
const subscriptionCardsSettleDelayMs = 3000;
const subscriptionPanelPollMs = 100;
const preferredSubscriptionPanelWaitMs = 2500;
const viewedFilterSelector = 'label.el-checkbox:has-text("我已看"), label:has-text("我已看")';
const viewedFilterSettleMs = 1000;
const viewedFilterPollMs = 100;
const viewedFilterMaxWaitMs = 8000;
const searchConditionPollMs = 200;
const platform = '51job';
const subscribePageUrlPattern = /^https:\/\/ehire\.51job\.com\/Revision\/talent\/subscribe(?:[/?#].*)?$/i;

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

function hasSearchKeywordCondition(pageText: string, searchKeyword: string): boolean {
  const normalizedText = normalizeText(pageText);
  const normalizedKeyword = normalizeText(searchKeyword);
  if (!normalizedText || !normalizedKeyword) {
    return false;
  }

  return normalizedText.includes(`关键词:${normalizedKeyword}`)
    || normalizedText.includes(`关键词：${normalizedKeyword}`);
}

function getRemainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function resolveSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + config.playwright.searchPageTimeoutMs;
}

function is51jobSubscribePage(page: Page): boolean {
  return subscribePageUrlPattern.test(page.url());
}

async function closeExtra51jobSubscribePages(searchPage: Page): Promise<void> {
  const pages = searchPage.context().pages();
  await Promise.all(pages.map(async (candidatePage) => {
    if (candidatePage === searchPage || candidatePage.isClosed() || !is51jobSubscribePage(candidatePage)) {
      return;
    }

    await candidatePage.close().catch(() => undefined);
  }));
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

async function waitForActiveSubscriptionConditionPanel(
  page: Page,
  searchKeyword: string,
  deadline: number,
  options: { returnUndefinedWhenMissing?: boolean } = {},
): Promise<Locator | undefined> {
  const normalizedKeyword = normalizeText(searchKeyword);
  const panels = page.locator(conditionPanelSelector);
  let visiblePanelTitles: string[] = [];

  while (Date.now() < deadline) {
    visiblePanelTitles = [];
    const count = await panels.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const panel = panels.nth(index);
      const isVisible = await panel.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const title = await panel.locator(conditionPanelTitleSelector).first().innerText().catch(() => '');
      const normalizedTitle = normalizeText(title);
      if (normalizedTitle) {
        visiblePanelTitles.push(title.trim());
      }

      if (normalizedTitle === normalizedKeyword) {
        return panel;
      }
    }

    if (visiblePanelTitles.length > 0) {
      break;
    }

    const waitMs = Math.min(subscriptionPanelPollMs, getRemainingTimeout(deadline));
    if (waitMs <= 1) {
      break;
    }

    await page.waitForTimeout(waitMs).catch(() => undefined);
  }

  if (options.returnUndefinedWhenMissing && visiblePanelTitles.length === 0) {
    return undefined;
  }

  throw new Error(`51job saved search "${searchKeyword}" did not become the active subscription detail panel. Visible panel titles: ${visiblePanelTitles.join(' | ') || '(none)'}`);
}

async function resolveSearchTriggerFromPanel(activePanel: Locator, searchKeyword: string, deadline: number): Promise<Locator> {
  const panelCandidates = [
    activePanel.locator('button.to-talent-search-button').first(),
    activePanel.locator('.to-talent-search-button').first(),
    activePanel.locator('button:has-text("去搜索")').first(),
    activePanel.locator('.el-button:has-text("去搜索")').first(),
    activePanel.locator('[role="button"]:has-text("去搜索")').first(),
  ];
  const panelMatch = await resolveSearchTriggerFromTier(panelCandidates, deadline);
  if (panelMatch) {
    return panelMatch;
  }

  throw new Error(`Talent search entry did not appear within the active 51job subscription detail panel for "${searchKeyword}".`);
}

async function resolveSearchTrigger(page: Page, card: Locator, searchKeyword: string, deadline: number): Promise<Locator> {
  const preferredPanelDeadline = Math.min(deadline, Date.now() + preferredSubscriptionPanelWaitMs);
  const preferredActivePanel = await waitForActiveSubscriptionConditionPanel(
    page,
    searchKeyword,
    preferredPanelDeadline,
    { returnUndefinedWhenMissing: true },
  );
  if (preferredActivePanel) {
    return resolveSearchTriggerFromPanel(preferredActivePanel, searchKeyword, deadline);
  }

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

  const activePanel = await waitForActiveSubscriptionConditionPanel(page, searchKeyword, deadline);
  if (!activePanel) {
    throw new Error(`51job saved search "${searchKeyword}" did not become the active subscription detail panel.`);
  }
  return resolveSearchTriggerFromPanel(activePanel, searchKeyword, deadline);
}

async function readSearchPageText(page: Page, deadline: number): Promise<string> {
  const timeout = Math.min(1000, getRemainingTimeout(deadline));
  const locators = [
    page.locator('#app'),
    page.locator('body'),
  ];
  const chunks: string[] = [];

  for (const locator of locators) {
    const readableLocator = 'first' in locator && typeof locator.first === 'function'
      ? locator.first()
      : locator;
    const readable = readableLocator as Partial<Pick<Locator, 'textContent' | 'innerText'>>;
    const [textContent, innerText] = await Promise.all([
      readable.textContent?.({ timeout }).catch(() => '') ?? Promise.resolve(''),
      readable.innerText?.({ timeout }).catch(() => '') ?? Promise.resolve(''),
    ]);
    if (textContent) {
      chunks.push(textContent);
    }
    if (innerText) {
      chunks.push(innerText);
    }
  }

  return chunks.join('\n');
}

async function waitFor51jobSearchKeywordCondition(page: Page, searchKeyword: string, deadline: number): Promise<void> {
  let latestText = '';

  while (Date.now() < deadline) {
    latestText = await readSearchPageText(page, deadline);
    if (hasSearchKeywordCondition(latestText, searchKeyword)) {
      return;
    }

    const waitMs = Math.min(searchConditionPollMs, getRemainingTimeout(deadline));
    if (waitMs <= 1) {
      break;
    }

    await page.waitForTimeout(waitMs).catch(() => undefined);
  }

  const preview = latestText.replace(/\s+/g, ' ').trim().slice(0, 1000) || '(empty)';
  throw new Error(`51job talent search page did not confirm saved search keyword "${searchKeyword}". URL: ${page.url()}. Page text preview: ${preview}`);
}

async function clickSearchTrigger(page: Page, searchTrigger: Locator, options?: SearchWaitOptions): Promise<void> {
  const deadline = resolveSearchDeadline(options);
  let lastError: unknown;

  while (Date.now() < deadline) {
    await waitForSearchTriggerReadyRef.fn(page, searchTrigger, { deadline });

    try {
      await clickPlatformLocator(searchTrigger, page, platform, getRemainingTimeout(deadline));
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Talent search button did not become clickable before timing out.');
}

async function is51jobViewedFilterChecked(viewedFilter: Locator): Promise<boolean> {
  return viewedFilter.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    return checkbox?.checked === true || element.classList.contains('is-checked');
  }).catch(() => false);
}

export async function clear51jobViewedFilter(page: Page, options?: SearchWaitOptions): Promise<void> {
  await set51jobViewedFilterChecked(page, false, options);
}

export async function ensure51jobViewedFilterChecked(page: Page, options?: SearchWaitOptions): Promise<void> {
  await set51jobViewedFilterChecked(page, true, options);
}

async function set51jobViewedFilterChecked(page: Page, checked: boolean, options?: SearchWaitOptions): Promise<boolean> {
  const deadline = resolveSearchDeadline(options);
  const waitUntil = Math.min(deadline, Date.now() + viewedFilterMaxWaitMs);
  const viewedFilter = page.locator(viewedFilterSelector).first();
  try {
    await viewedFilter.waitFor({ state: 'visible', timeout: Math.max(1, waitUntil - Date.now()) });
  } catch {
    return false;
  }

  let clicked = false;
  let stableSince: number | undefined;

  while (Date.now() < waitUntil) {
    const currentChecked = await is51jobViewedFilterChecked(viewedFilter);
    if (currentChecked !== checked) {
      stableSince = undefined;
      await clickPlatformLocator(
        viewedFilter,
        page,
        platform,
        Math.min(1000, Math.max(1, waitUntil - Date.now())),
      ).then(() => {
        clicked = true;
      }).catch(() => undefined);
    } else {
      if (!clicked) {
        return false;
      }

      const now = Date.now();
      stableSince ??= now;
      if (now - stableSince >= viewedFilterSettleMs) {
        return clicked;
      }
    }

    await page.waitForTimeout(Math.min(viewedFilterPollMs, Math.max(1, waitUntil - Date.now()))).catch(() => undefined);
  }

  return clicked;
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
  await clickPlatformLocator(card, page, platform, getRemainingTimeout(deadline)).catch(() => undefined);

  const searchTrigger = await resolveSearchTrigger(page, card, searchKeyword, deadline);

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
    await waitFor51jobSearchKeywordCondition(openOutcome.page, searchKeyword, deadline);
    if (options?.includeViewedCandidates) {
      await clear51jobViewedFilter(openOutcome.page, { deadline });
    } else {
      await ensure51jobViewedFilterChecked(openOutcome.page, { deadline });
    }
    await closeExtra51jobSubscribePages(openOutcome.page);
    return openOutcome.page;
  }

  const searchLinkHref = await searchTrigger.getAttribute('href').catch(() => null);
  if (searchLinkHref) {
    await page.goto(searchLinkHref, { waitUntil: 'domcontentloaded', timeout: getRemainingTimeout(deadline) });
    await waitFor51jobSearchKeywordCondition(page, searchKeyword, deadline);
    if (options?.includeViewedCandidates) {
      await clear51jobViewedFilter(page, { deadline });
    } else {
      await ensure51jobViewedFilterChecked(page, { deadline });
    }
    await closeExtra51jobSubscribePages(page);
    return page;
  }

  throw new Error('Talent search did not open a popup or navigate the current page before the shared search deadline.');
}
