import type { Frame, Locator, Page } from 'playwright';
import { config } from '../../../config.js';
import type { BossPositionDetail, BossPositionStatus, BossPositionSummary } from '../../../types/boss.js';
import { clickBossControl, clickBossControlNatively, runBossAction } from './context.js';

const bossJobListUrl = 'https://www.zhipin.com/web/chat/job/list';
const bossJobRowSelector = [
  '.job-item-container',
  '.job-list .job-item',
  '.job-list .job-card',
  '.job-list-item',
  '.job-card',
  'table tbody tr',
].join(', ');
const bossJobListReadySelector = `${bossJobRowSelector}, .empty, .empty-page`;
const bossJobListFramePattern = /\/web\/frame\/job_v2\/list(?:[/?#].*)?$/i;
const bossJobEditFramePattern = /\/web\/frame\/job\/edit(?:[/?#].*)?$/i;

interface BossJobListSurface {
  root: Page | Frame;
}

interface BossPositionRowSnapshot extends BossPositionSummary {
  rowIndex: number;
}

function remainingTime(deadline: number): number {
  return Math.max(deadline - Date.now(), 1);
}

function readBossPositionRowsInBrowser(rows: Element[]): BossPositionRowSnapshot[] {
  type VueElement = HTMLElement & { __vue__?: Record<string, unknown> };
  type VueAppHost = HTMLElement & { __vue_app__?: { config?: { globalProperties?: Record<string, unknown> } } };
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const readPrimitive = (value: unknown) => (
    typeof value === 'string' || typeof value === 'number' ? normalize(String(value)) : ''
  );
  const inferStatus = (text: string): BossPositionStatus => {
    if (/招聘中|开放中|在招|发布中/.test(text)) return 'open';
    if (/审核中|待审核|处理中|待开放/.test(text)) return 'pending';
    if (/关闭|已下线|停止招聘|已结束|已失效/.test(text)) return 'closed';
    return 'unknown';
  };
  const appHost = Array.from(document.querySelectorAll<HTMLElement>('*'))
    .find((element) => Object.prototype.hasOwnProperty.call(element, '__vue_app__')) as VueAppHost | undefined;
  const pinia = appHost?.__vue_app__?.config?.globalProperties?.$pinia as {
    state?: { value?: Record<string, unknown>; _value?: Record<string, unknown> };
  } | undefined;
  const piniaState = pinia?.state?.value ?? pinia?.state?._value;
  const pageState = piniaState?.['job-list-page'] as Record<string, unknown> | undefined;
  const rawJobList = pageState?.jobList as unknown;
  const stateRows = Array.isArray(rawJobList)
    ? rawJobList
    : rawJobList && typeof rawJobList === 'object' && Array.isArray((rawJobList as { value?: unknown }).value)
      ? (rawJobList as { value: unknown[] }).value
      : [];
  return rows.flatMap((node, rowIndex) => {
    const row = node as VueElement;
    const root = row.__vue__ ?? {};
    const nested = ['job', 'jobInfo', 'item', 'data', 'position']
      .map((key) => root[key])
      .find((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
    const indexedState = stateRows[rowIndex];
    const stateRecord = indexedState && typeof indexedState === 'object' && !Array.isArray(indexedState)
      ? indexedState as Record<string, unknown>
      : undefined;
    const records = [root, ...(nested ? [nested] : []), ...(stateRecord ? [stateRecord] : [])];
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
    const hrefId = href.match(/[?&](?:jobId|positionId|encryptId|id)=([^&#]+)/i)?.[1];
    const bossJobId = normalize(row.getAttribute('data-job-id'))
      || normalize(row.getAttribute('data-position-id'))
      || fromRecords(['jobId', 'positionId', 'encryptJobId', 'encryptId', 'id'])
      || (hrefId ? decodeURIComponent(hrefId) : '');
    const name = normalize(row.querySelector<HTMLElement>('.job-name')?.textContent)
      || normalize(row.querySelector<HTMLElement>('.position-name')?.textContent)
      || normalize(row.querySelector<HTMLElement>('[class*="job-title"]')?.textContent)
      || fromRecords(['jobName', 'positionName', 'name', 'title']);
    if (!bossJobId || !name) return [];
    const text = normalize(row.innerText || row.textContent);
    const rawStatus = fromRecords(['statusDesc', 'statusText', 'status', 'jobStatus']);
    return [{
      bossJobId,
      name,
      status: inferStatus(`${rawStatus} ${text}`),
      location: normalize(row.querySelector<HTMLElement>('.job-area')?.textContent)
        || normalize(row.querySelector<HTMLElement>('.location')?.textContent)
        || normalize(row.querySelector<HTMLElement>('[class*="address"]')?.textContent)
        || fromRecords(['cityName', 'locationName', 'address'])
        || undefined,
      rowIndex,
    }];
  });
}

async function readBossPositionRowSnapshots(root: Page | Frame): Promise<BossPositionRowSnapshot[]> {
  return root.locator(bossJobRowSelector).evaluateAll(readBossPositionRowsInBrowser);
}

async function waitForBossJobListSurface(page: Page, deadline: number): Promise<BossJobListSurface> {
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => bossJobListFramePattern.test(candidate.url()));
    if (frame && await frame.locator(bossJobListReadySelector).count().catch(() => 0) > 0) {
      const rowCount = await frame.locator(bossJobRowSelector).count().catch(() => 0);
      const snapshots = rowCount > 0
        ? await readBossPositionRowSnapshots(frame).catch(() => [])
        : [];
      if (rowCount === 0 || snapshots.length === rowCount) {
        return { root: frame };
      }
    }
    if (await page.locator(bossJobListReadySelector).count().catch(() => 0) > 0) {
      return { root: page };
    }
    await page.waitForTimeout(Math.min(100, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error('Boss job list did not expose a supported list surface before the deadline.');
}

async function waitForBossJobEditFrame(page: Page, deadline: number): Promise<Frame> {
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => bossJobEditFramePattern.test(candidate.url()));
    if (frame) {
      const ready = await frame.evaluate(() => {
        const isVisible = (element: Element): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const name = document.querySelector<HTMLInputElement>('input[name="jobName"]')?.value.trim() ?? '';
        const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(isVisible);
        const preferred = textareas.filter((textarea) => /职位描述|岗位描述|请勿填写.*联系方式|劳动法/.test(textarea.placeholder));
        const jdTextarea = preferred.length === 1 ? preferred[0] : textareas.length === 1 ? textareas[0] : undefined;
        return Boolean(name && jdTextarea?.value.trim());
      }).catch(() => false);
      if (ready) return frame;
    }
    await page.waitForTimeout(Math.min(100, remainingTime(deadline))).catch(() => undefined);
  }
  throw new Error('Boss job edit form did not expose a hydrated position name and JD before the deadline.');
}

async function closeBossJobListGuide(page: Page, deadline: number): Promise<void> {
  const guide = page.locator('.dialog-wrap.active[data-type="boss-dialog"] .dialog-hunter-daily-task-guide');
  const guideCount = await guide.count();
  if (guideCount === 0) return;
  if (guideCount !== 1 || !await guide.first().isVisible().catch(() => false)) {
    throw new Error('Boss job list daily-task guide is ambiguous or not actionable.');
  }
  const close = guide.first().locator('.close-btn');
  if (await close.count() !== 1 || !await close.isVisible().catch(() => false)) {
    throw new Error('Boss job list daily-task guide does not expose one visible close control.');
  }
  await clickBossControlNatively(page, close, remainingTime(deadline));
  await guide.first().waitFor({ state: 'hidden', timeout: remainingTime(deadline) });
}

function inferPositionStatus(text: string): BossPositionStatus {
  if (/招聘中|开放中|在招|发布中/.test(text)) return 'open';
  if (/审核中|待审核|处理中|待开放/.test(text)) return 'pending';
  if (/关闭|已下线|停止招聘|已结束|已失效/.test(text)) return 'closed';
  return 'unknown';
}

export function inferBossPositionStatus(text: string): BossPositionStatus {
  return inferPositionStatus(text);
}

async function openBossJobListWithinDeadline(page: Page, deadline: number): Promise<Page> {
  if (!/^https:\/\/www\.zhipin\.com\/web\/chat\/job\/list(?:[/?#].*)?$/i.test(page.url())) {
    await runBossAction(page, () => page.goto(bossJobListUrl, {
      waitUntil: 'domcontentloaded',
      timeout: remainingTime(deadline),
    }));
  }
  await waitForBossJobListSurface(page, deadline);
  return page;
}

export async function openBossJobList(page: Page): Promise<Page> {
  return openBossJobListWithinDeadline(page, Date.now() + config.playwright.searchPageTimeoutMs);
}

export async function readBossPositionSummaries(page: Page): Promise<BossPositionSummary[]> {
  const surface = await waitForBossJobListSurface(page, Date.now() + config.playwright.searchPageTimeoutMs);
  return (await readBossPositionRowSnapshots(surface.root)).map(({ rowIndex: _rowIndex, ...summary }) => summary);
}

async function findPositionRow(page: Page, bossJobId: string, deadline: number): Promise<Locator> {
  const surface = await waitForBossJobListSurface(page, deadline);
  const rows = surface.root.locator(bossJobRowSelector);
  const matches = (await readBossPositionRowSnapshots(surface.root))
    .filter((snapshot) => snapshot.bossJobId === bossJobId);
  if (matches.length === 0) throw new Error(`Boss position ${bossJobId} is no longer present in the job list.`);
  if (matches.length !== 1) throw new Error(`Boss position ${bossJobId} is ambiguous in the job list.`);
  return rows.nth(matches[0]!.rowIndex);
}

async function closePositionDetail(page: Page, deadline: number): Promise<void> {
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
    await clickBossControl(close, page, remainingTime(deadline));
  } else {
    await runBossAction(page, () => page.keyboard.press('Escape'));
  }
}

async function openAndReadBossV2PositionDetail(
  page: Page,
  summary: BossPositionSummary,
  deadline: number,
): Promise<BossPositionDetail> {
  try {
    await closeBossJobListGuide(page, deadline);
    const row = await findPositionRow(page, summary.bossJobId, deadline);
    const editButtons = row.locator('.operate-btn').filter({ hasText: /^\s*编辑\s*$/ });
    if (await editButtons.count() !== 1) {
      throw new Error(`Boss position ${summary.bossJobId} does not expose one exact edit control.`);
    }
    await clickBossControlNatively(page, editButtons.first(), remainingTime(deadline));
    await page.waitForURL((url) => /\/web\/chat\/job\/edit(?:[/?#].*)?$/i.test(url.toString()), {
      timeout: remainingTime(deadline),
    });
    const frame = await waitForBossJobEditFrame(page, deadline);
    const detail = await frame.evaluate(({ fallbackStatus, fallbackLocation }) => {
      const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(isVisible);
      const preferred = textareas.filter((textarea) => /职位描述|岗位描述|请勿填写.*联系方式|劳动法/.test(textarea.placeholder));
      const jdTextarea = preferred.length === 1 ? preferred[0] : textareas.length === 1 ? textareas[0] : undefined;
      const rawJd = jdTextarea?.value.trim() ?? '';
      if (!rawJd) throw new Error('Boss job edit form has no readable JD text.');
      const editUrl = new URL(window.location.href);
      const bossJobId = normalize(editUrl.searchParams.get('encryptId'));
      const name = normalize(document.querySelector<HTMLInputElement>('input[name="jobName"]')?.value);
      if (!bossJobId || !name) throw new Error('Boss job edit form does not expose stable position identity.');
      const department = normalize(document.querySelector<HTMLInputElement>('.job-department-input')?.value) || undefined;
      const location = normalize(document.querySelector<HTMLInputElement>('.job-address input.ipt, .job-address-container input.ipt')?.value)
        || fallbackLocation;
      return {
        bossJobId,
        name,
        status: fallbackStatus,
        location,
        rawJd,
        department,
      };
    }, {
      fallbackStatus: summary.status,
      fallbackLocation: summary.location,
    });
    if (detail.bossJobId !== summary.bossJobId) {
      throw new Error(`Boss position detail identity mismatch: expected ${summary.bossJobId}, found ${detail.bossJobId}.`);
    }
    if (detail.name !== summary.name) {
      throw new Error(`Boss position detail name mismatch: expected ${summary.name}, found ${detail.name}.`);
    }
    return detail;
  } finally {
    await openBossJobListWithinDeadline(page, deadline);
  }
}

export async function openAndReadBossPositionDetail(
  page: Page,
  summary: BossPositionSummary,
): Promise<BossPositionDetail> {
  const deadline = Date.now() + config.playwright.resumeDetailTimeoutMs;
  const row = await findPositionRow(page, summary.bossJobId, deadline);
  if (await row.locator('.operate-btn').filter({ hasText: /^\s*编辑\s*$/ }).count() > 0) {
    return openAndReadBossV2PositionDetail(page, summary, deadline);
  }
  const originalUrl = page.url();
  await clickBossControl(row, page, remainingTime(deadline));
  const detailSelector = '.job-detail-dialog, .position-detail-dialog, .job-detail, .position-detail, [data-job-detail]';
  await page.waitForFunction((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))
    .some((element) => element.getClientRects().length > 0), detailSelector, {
    timeout: remainingTime(deadline),
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
    await runBossAction(page, () => page.goBack({ waitUntil: 'domcontentloaded', timeout: remainingTime(deadline) }));
  } else {
    await closePositionDetail(page, deadline);
  }
  return detail;
}
