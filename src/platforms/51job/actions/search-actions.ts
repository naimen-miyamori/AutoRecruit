import type { Page } from 'playwright';
import {
  prepare51jobSearchConditionPageWithOptions,
  read51jobSearchResultTotal,
  save51jobSearchCondition,
} from '../../../browser/51job-search-subscription.js';
import { clickPrimarySearchButton } from '../../../search/page-actions.js';
import type { SearchCondition } from '../../../types/job.js';
import type { PlatformAdapter } from '../../types.js';
import { apply51jobSearchCondition } from './filter-actions.js';

type DirectSearchOptions = Parameters<NonNullable<PlatformAdapter['openDirectSearch']>>[3];

export async function open51jobSubscribeSearch(
  ...args: Parameters<NonNullable<PlatformAdapter['openSubscribeSearch']>>
): Promise<Page> {
  const { openSubscribeSearch } = await import('../../../browser/subscribe-search.js');
  return openSubscribeSearch(...args);
}

export async function prepare51jobSearchCondition(
  ...args: Parameters<NonNullable<PlatformAdapter['prepareSearchConditionPage']>>
): Promise<Page> {
  return prepare51jobSearchConditionPageWithOptions(...args);
}

export async function read51jobSearchConditionResultTotal(
  ...args: Parameters<NonNullable<PlatformAdapter['readSearchConditionResultTotal']>>
): Promise<Awaited<ReturnType<NonNullable<PlatformAdapter['readSearchConditionResultTotal']>>>> {
  return read51jobSearchResultTotal(args[0]);
}

export async function savePrepared51jobSearchCondition(
  ...args: Parameters<NonNullable<PlatformAdapter['saveSearchCondition']>>
): Promise<void> {
  await save51jobSearchCondition(args[0], args[1]);
}

export async function open51jobDirectSearch(
  page: Page,
  keyword: string,
  conditions: SearchCondition[],
  options?: DirectSearchOptions,
): Promise<Page> {
  const searchPage = await prepare51jobSearchConditionPageWithOptions(page, keyword, options);
  for (const condition of conditions) {
    const result = await apply51jobSearchCondition(searchPage, condition);
    if (result.status !== 'applied') {
      throw new Error(`51job direct search condition ${condition.kind} failed: ${result.message ?? result.status}`);
    }
  }

  const {
    clear51jobViewedFilter,
    ensure51jobViewedFilterChecked,
  } = await import('../../../browser/subscribe-search.js');
  if (options?.includeViewedCandidates) {
    await clear51jobViewedFilter(searchPage, options);
  } else {
    await ensure51jobViewedFilterChecked(searchPage, options);
  }

  await clickPrimarySearchButton(searchPage, 1500, '51job').catch(() => false);
  return searchPage;
}
