import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { waitPlatformActionPace } from '../browser/pacing.js';
import { config } from '../config.js';
import { buildJobKey, parseJobDescription } from '../parsers/jd-parser.js';
import { JobStore } from '../storage/job-store.js';
import type {
  BossJobSyncInput,
  BossJobSyncItem,
  BossJobSyncRun,
  BossPositionDetail,
  BossPositionStatus,
  BossPositionSummary,
} from '../types/boss.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';

const bossJobListUrl = 'https://www.zhipin.com/web/chat/job/list';
const bossJobRowSelector = [
  '.job-list .job-item',
  '.job-list .job-card',
  '.job-list-item',
  '.job-card',
  'table tbody tr',
].join(', ');

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

async function runBossAction<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await waitPlatformActionPace(page, 'boss');
  return action();
}

function positionStatus(text: string): BossPositionStatus {
  if (/招聘中|开放|在招|发布中/.test(text)) return 'open';
  if (/审核中|待审核|处理中/.test(text)) return 'pending';
  if (/关闭|已下线|停止招聘|已结束/.test(text)) return 'closed';
  return 'unknown';
}

export function buildBossSyncedJobKey(name: string, bossJobId: string): string {
  const nameKey = buildJobKey(name, '') || 'boss-job';
  const idKey = bossJobId.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    || createHash('sha256').update(bossJobId).digest('hex').slice(0, 16);
  return `${nameKey}-${idKey}`;
}

export function hashBossJd(rawJd: string): string {
  return createHash('sha256').update(rawJd.replace(/\r\n/g, '\n').trim()).digest('hex');
}

export async function openBossJobList(page: Page): Promise<Page> {
  if (!/^https:\/\/www\.zhipin\.com\/web\/chat\/job\/list(?:[/?#].*)?$/i.test(page.url())) {
    await runBossAction(page, () => page.goto(bossJobListUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwright.searchPageTimeoutMs,
    }));
  }
  await page.locator(`${bossJobRowSelector}, .empty, .empty-page`).first().waitFor({
    state: 'attached',
    timeout: config.playwright.searchPageTimeoutMs,
  });
  return page;
}

export async function readBossPositionSummaries(page: Page): Promise<BossPositionSummary[]> {
  return page.locator(bossJobRowSelector).evaluateAll((rows) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const readPrimitive = (value: unknown) => (
      typeof value === 'string' || typeof value === 'number' ? normalize(String(value)) : ''
    );
    const inferStatus = (text: string) => {
      if (/招聘中|开放|在招|发布中/.test(text)) return 'open';
      if (/审核中|待审核|处理中/.test(text)) return 'pending';
      if (/关闭|已下线|停止招聘|已结束/.test(text)) return 'closed';
      return 'unknown';
    };
    return rows.flatMap((node) => {
      const row = node as VueElement;
      const root = row.__vue__ ?? {};
      const nested = ['job', 'jobInfo', 'item', 'data', 'position']
        .map((key) => root[key])
        .find((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
      const records = [root, ...(nested ? [nested] : [])];
      const fromRecords = (keys: readonly string[]) => {
        for (const record of records) {
          for (const key of keys) {
            const value = readPrimitive(record[key]);
            if (value) return value;
          }
        }
        return '';
      };
      const href = row.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '';
      const hrefId = href.match(/[?&](?:jobId|positionId|id)=([^&#]+)/i)?.[1];
      const bossJobId = normalize(row.getAttribute('data-job-id'))
        || normalize(row.getAttribute('data-position-id'))
        || fromRecords(['jobId', 'positionId', 'encryptJobId', 'id'])
        || (hrefId ? decodeURIComponent(hrefId) : '');
      const name = normalize(row.querySelector<HTMLElement>('.job-name, .position-name, [class*="job-title"]')?.innerText)
        || fromRecords(['jobName', 'positionName', 'name', 'title']);
      if (!bossJobId || !name) return [];
      const text = normalize(row.innerText || row.textContent);
      const rawStatus = fromRecords(['statusDesc', 'statusText', 'status']);
      return [{
        bossJobId,
        name,
        status: inferStatus(`${rawStatus} ${text}`),
        location: normalize(row.querySelector<HTMLElement>('.job-area, .location, [class*="address"]')?.innerText)
          || fromRecords(['cityName', 'locationName', 'address'])
          || undefined,
      }];
    });
  });
}

async function findPositionRow(page: Page, bossJobId: string): Promise<Locator> {
  const rows = page.locator(bossJobRowSelector);
  const index = await rows.evaluateAll((elements, expectedId) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const read = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return elements.findIndex((node) => {
      const element = node as VueElement;
      const root = element.__vue__ ?? {};
      const nested = ['job', 'jobInfo', 'item', 'data', 'position']
        .map((key) => root[key])
        .find((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
      const ids = [
        element.getAttribute('data-job-id'),
        element.getAttribute('data-position-id'),
        ...[root, ...(nested ? [nested] : [])].flatMap((record) => (
          ['jobId', 'positionId', 'encryptJobId', 'id'].map((key) => read(record[key]))
        )),
      ];
      const href = element.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '';
      return ids.includes(expectedId) || href.includes(encodeURIComponent(expectedId));
    });
  }, bossJobId);
  if (index < 0) throw new Error(`Boss position ${bossJobId} is no longer present in the job list.`);
  return rows.nth(index);
}

async function closePositionDetail(page: Page): Promise<void> {
  const details = page.locator('.job-detail-dialog, .position-detail-dialog, .job-detail, .position-detail, [data-job-detail], [role="dialog"]');
  let dialog: Locator | undefined;
  for (let index = await details.count() - 1; index >= 0; index -= 1) {
    if (await details.nth(index).isVisible().catch(() => false)) {
      dialog = details.nth(index);
      break;
    }
  }
  if (!dialog) return;
  const close = dialog.locator('.close, .dialog-close, [aria-label="Close"], [aria-label="关闭"]').first();
  if (await close.isVisible().catch(() => false)) {
    await runBossAction(page, () => close.click({ timeout: config.playwright.resumeDetailTimeoutMs }));
  } else {
    await runBossAction(page, () => page.keyboard.press('Escape'));
  }
}

export async function openAndReadBossPositionDetail(
  page: Page,
  summary: BossPositionSummary,
): Promise<BossPositionDetail> {
  const row = await findPositionRow(page, summary.bossJobId);
  const originalUrl = page.url();
  await runBossAction(page, () => row.click({ timeout: config.playwright.resumeDetailTimeoutMs }));
  const detailSelector = '.job-detail-dialog, .position-detail-dialog, .job-detail, .position-detail, [data-job-detail]';
  await page.waitForFunction((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))
    .some((element) => element.getClientRects().length > 0), detailSelector, {
    timeout: config.playwright.resumeDetailTimeoutMs,
  });
  const detail = await page.evaluate(({ fallbackId, fallbackName, fallbackStatus, fallbackLocation }) => {
    type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const root = Array.from(document.querySelectorAll<HTMLElement>('.job-detail-dialog, .position-detail-dialog, .job-detail, .position-detail, [data-job-detail]'))
      .find((element) => element.getClientRects().length > 0);
    if (!root) throw new Error('Boss position detail is not visible.');
    const vue = (root as VueElement).__vue__ ?? {};
    const nested = ['job', 'jobInfo', 'detail', 'data', 'position']
      .map((key) => vue[key])
      .find((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
    const records = [vue, ...(nested ? [nested] : [])];
    const fromRecords = (keys: readonly string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === 'string' || typeof value === 'number') {
            const text = normalize(String(value));
            if (text) return text;
          }
        }
      }
      return '';
    };
    const rawJd = normalize(root.querySelector<HTMLElement>('.job-sec-text, .job-description, .position-description, [class*="description"]')?.innerText)
      || fromRecords(['jobDescription', 'description', 'postDescription', 'jobDesc']);
    if (!rawJd) throw new Error(`Boss position ${fallbackId} has no readable JD text.`);
    const visibleId = normalize(root.getAttribute('data-job-id'))
      || fromRecords(['jobId', 'positionId', 'encryptJobId', 'id'])
      || fallbackId;
    return {
      bossJobId: visibleId,
      name: normalize(root.querySelector<HTMLElement>('.job-name, .position-name, h1, h2')?.innerText)
        || fromRecords(['jobName', 'positionName', 'name', 'title'])
        || fallbackName,
      status: fallbackStatus,
      location: normalize(root.querySelector<HTMLElement>('.job-area, .location, [class*="address"]')?.innerText)
        || fromRecords(['cityName', 'locationName', 'address'])
        || fallbackLocation,
      rawJd,
      salaryText: normalize(root.querySelector<HTMLElement>('.salary, [class*="salary"]')?.innerText)
        || fromRecords(['salaryDesc', 'salaryText'])
        || undefined,
      department: normalize(root.querySelector<HTMLElement>('.department, [class*="department"]')?.innerText)
        || fromRecords(['departmentName', 'department'])
        || undefined,
      sourceUpdatedAt: fromRecords(['updateTime', 'updatedAt', 'modifyTime']) || undefined,
    };
  }, {
    fallbackId: summary.bossJobId,
    fallbackName: summary.name,
    fallbackStatus: summary.status,
    fallbackLocation: summary.location,
  });
  if (detail.bossJobId !== summary.bossJobId) {
    throw new Error(`Boss position detail identity mismatch: expected ${summary.bossJobId}, found ${detail.bossJobId}.`);
  }
  if (detail.name !== summary.name) {
    throw new Error(`Boss position detail name mismatch: expected ${summary.name}, found ${detail.name}.`);
  }
  if (page.url() !== originalUrl && !page.url().includes('/web/chat/job/list')) {
    await runBossAction(page, () => page.goBack({ waitUntil: 'domcontentloaded', timeout: config.playwright.resumeDetailTimeoutMs }));
  } else {
    await closePositionDetail(page);
  }
  return detail;
}

export interface SyncBossJobsOptions {
  store?: JobStore;
  parseJd?: (rawJd: string) => Promise<NormalizedJob>;
  now?: () => Date;
}

export async function syncBossPositions(
  page: Page,
  input: BossJobSyncInput = { platform: 'boss' },
  options: SyncBossJobsOptions = {},
): Promise<BossJobSyncRun> {
  const store = options.store ?? new JobStore();
  const parseJd = options.parseJd ?? parseJobDescription;
  const syncedAt = (options.now ?? (() => new Date()))().toISOString();
  await openBossJobList(page);
  const allPositions = await readBossPositionSummaries(page);
  await store.saveBossPositionSnapshot(allPositions);
  const requestedIds = input.bossJobIds ? new Set(input.bossJobIds) : undefined;
  const positions = allPositions.filter((position) => (
    (!requestedIds || requestedIds.has(position.bossJobId))
    && (input.includeClosed !== false || position.status !== 'closed')
  ));
  if (requestedIds) {
    const missing = [...requestedIds].filter((id) => !allPositions.some((position) => position.bossJobId === id));
    if (missing.length > 0) throw new Error(`Boss position ID(s) not found: ${missing.join(', ')}`);
  }

  const items: BossJobSyncItem[] = [];
  for (const position of positions) {
    let detail: BossPositionDetail | undefined;
    try {
      detail = await openAndReadBossPositionDetail(page, position);
      const sourceHash = hashBossJd(detail.rawJd);
      const existing = await store.findBossJobRecordByPositionId(position.bossJobId);
      if (existing?.bossPosition?.sourceHash === sourceHash) {
        items.push({
          bossJobId: position.bossJobId,
          name: position.name,
          status: position.status,
          jobKey: existing.jobKey,
          sourceHash,
          outcome: 'unchanged',
        });
        continue;
      }

      const normalizedJob = await parseJd(detail.rawJd);
      const jobKey = existing?.jobKey ?? buildBossSyncedJobKey(position.name, position.bossJobId);
      const record: JobRecord = {
        ...(existing ?? {
          jobKey,
          platform: 'boss' as const,
          searchKeyword: position.name,
          createdAt: syncedAt,
        }),
        jobKey,
        platform: 'boss',
        searchKeyword: position.name,
        rawText: detail.rawJd,
        normalizedJob,
        bossPosition: {
          bossJobId: position.bossJobId,
          status: position.status,
          syncedAt,
          sourceHash,
        },
      };
      await store.saveJobRecord('boss', record);
      items.push({
        bossJobId: position.bossJobId,
        name: position.name,
        status: position.status,
        jobKey,
        sourceHash,
        outcome: existing ? 'updated' : 'created',
      });
    } catch (error) {
      items.push({
        bossJobId: position.bossJobId,
        name: position.name,
        status: position.status,
        ...(detail ? { sourceHash: hashBossJd(detail.rawJd) } : {}),
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const run: BossJobSyncRun = {
    platform: 'boss',
    syncedAt,
    positions: allPositions,
    items,
    created: items.filter((item) => item.outcome === 'created').length,
    updated: items.filter((item) => item.outcome === 'updated').length,
    unchanged: items.filter((item) => item.outcome === 'unchanged').length,
    failed: items.filter((item) => item.outcome === 'failed').length,
  };
  const resultPath = await store.saveBossJobSyncRun(run);
  return { ...run, resultPath };
}

export function inferBossPositionStatus(text: string): BossPositionStatus {
  return positionStatus(text);
}
