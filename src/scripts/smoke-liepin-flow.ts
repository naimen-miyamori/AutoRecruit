import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import { buildJobKey } from '../parsers/jd-parser.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { RunResult } from '../types/job.js';
import type { Page } from 'playwright';

function parseKeyword(argv: string[]): string {
  const keywordIndex = argv.indexOf('--keyword');
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;

  if (!keyword || keyword.startsWith('--')) {
    throw new Error('Usage: npm run smoke:liepin -- --keyword "<keyword>" [--parse-first]');
  }

  return keyword;
}

function parseOptionalValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateKeyFromIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : formatLocalDateKey(date);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((entry) => entry.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function collectRunCandidateIds(runResult: Partial<RunResult>): string[] {
  return [
    ...(runResult.newCandidateIds ?? []),
    ...(runResult.scoredCandidates ?? []),
    ...((runResult.failedCandidates ?? []).map((candidate) => candidate.candidateId)),
  ].filter(Boolean);
}

export interface ClearTodayLiepinSeenIdsSummary {
  stage: 'clearTodayLiepinSeenIds';
  keyword: string;
  jobKey: string;
  today: string;
  todayResultIds: number;
  before: number;
  after: number;
  removed: number;
}

export async function clearTodayLiepinSeenIdsForKeyword(keyword: string, now = new Date()): Promise<ClearTodayLiepinSeenIdsSummary> {
  const jobKey = buildJobKey(keyword, '');
  const jobDir = path.join(config.dataDir, 'liepin', 'jobs', jobKey);
  const seenIdsPath = path.join(jobDir, 'seen-ids.json');
  const resultsDir = path.join(jobDir, 'results');
  const seenIds = await readJsonFile<string[]>(seenIdsPath, []);
  const today = formatLocalDateKey(now);
  const todayIds = new Set<string>();

  for (const file of await listJsonFiles(resultsDir)) {
    const runResult = await readJsonFile<Partial<RunResult>>(path.join(resultsDir, file), {});
    const resultDate = localDateKeyFromIso(runResult.fetchedAt);
    if (resultDate !== today && !file.startsWith(today)) {
      continue;
    }

    for (const candidateId of collectRunCandidateIds(runResult)) {
      todayIds.add(String(candidateId));
    }
  }

  const nextSeenIds = seenIds.filter((candidateId) => !todayIds.has(String(candidateId)));
  if (nextSeenIds.length !== seenIds.length) {
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(seenIdsPath, `${JSON.stringify(nextSeenIds, null, 2)}\n`, 'utf8');
  }

  return {
    stage: 'clearTodayLiepinSeenIds',
    keyword,
    jobKey,
    today,
    todayResultIds: todayIds.size,
    before: seenIds.length,
    after: nextSeenIds.length,
    removed: seenIds.length - nextSeenIds.length,
  };
}

async function collectLiepinDetailForwardDiagnostics(page: Page): Promise<Record<string, unknown>> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const candidates = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const directText = (element: Element) => Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    const selectorPath = (element: Element) => {
      const parts: string[] = [];
      let current: Element | null = element;

      while (current && current !== document.body && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const id = current.id ? `#${current.id}` : '';
        const className = typeof current.className === 'string'
          ? current.className.split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join('')
          : '';
        parts.unshift(`${tag}${id}${className}`);
        current = current.parentElement;
      }

      return parts.join(' > ');
    };
    const isVisible = (element: Element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const nearestClickable = (element: Element) => {
      let current: Element | null = element;
      let depth = 0;

      while (current && current !== document.body && depth < 6) {
        if (current instanceof HTMLElement) {
          const tag = current.tagName.toLowerCase();
          const role = current.getAttribute('role') ?? '';
          const className = typeof current.className === 'string' ? current.className : '';
          const style = window.getComputedStyle(current);
          const text = normalize(current.textContent);
          if (
            tag === 'button'
            || tag === 'a'
            || role === 'button'
            || style.cursor === 'pointer'
            || Boolean(current.getAttribute('onclick'))
            || /button|btn|action|operate|forward|share|item|tool|icon/i.test(className)
          ) {
            const rect = current.getBoundingClientRect();
            return {
              tag,
              className,
              role,
              text: text.slice(0, 80),
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              path: selectorPath(current),
            };
          }
        }

        current = current.parentElement;
        depth += 1;
      }

      return null;
    };

    return Array.from(document.querySelectorAll('button, a, [role="button"], span, div, p, i, svg'))
      .map((element) => {
        const text = normalize(element.textContent);
        const ownText = normalize(directText(element));
        const ariaLabel = element.getAttribute('aria-label') ?? '';
        const title = element.getAttribute('title') ?? '';
        const className = typeof element.className === 'string' ? element.className : '';
        const parentText = normalize(element.parentElement?.textContent).slice(0, 180);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text,
          ownText,
          ariaLabel,
          title,
          className,
          role: element.getAttribute('role') ?? '',
          visible: isVisible(element),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          path: selectorPath(element),
          nearestClickable: nearestClickable(element),
          parentText,
        };
      })
      .filter((item) => item.visible && /转发|转给同事|分享|更多|同事/.test([item.ownText, item.text, item.ariaLabel, item.title, item.className, item.parentText].join(' ')))
      .sort((left, right) => {
        const leftExact = left.ownText === '转发' ? 0 : 1;
        const rightExact = right.ownText === '转发' ? 0 : 1;
        if (leftExact !== rightExact) {
          return leftExact - rightExact;
        }
        return (left.text.length + left.parentText.length) - (right.text.length + right.parentText.length);
      })
      .slice(0, 80);
  }).catch((error) => [{
    error: error instanceof Error ? error.message : String(error),
  }]);

  return {
    stage: 'afterResumeDetailOpened',
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    bodyPreview: bodyText.slice(0, 1200),
    forwardLikeElements: candidates,
  };
}

export async function runLiepinSmokeFlow(argv = process.argv.slice(2)): Promise<void> {
  const keyword = parseKeyword(argv);
  const parseFirst = argv.includes('--parse-first');
  const forwardContact = parseOptionalValue(argv, '--forward-contact');
  const adapter = getPlatformAdapter('liepin');

  console.error(JSON.stringify(await clearTodayLiepinSeenIdsForKeyword(keyword)));

  const session = await ensureAuthenticatedBrowserSession('liepin');

  try {
    let searchPage;
    try {
      searchPage = await adapter.openSubscribeSearch(session.page, keyword);
    } catch (error) {
      const page = session.page;
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const diagnostics = {
        stage: 'openSubscribeSearch',
        platform: adapter.platform,
        keyword,
        finalUrl: page.url(),
        title: await page.title().catch(() => ''),
        bodyPreview: bodyText.slice(0, 1200),
      };
      console.error(JSON.stringify(diagnostics, null, 2));
      throw error;
    }

    const { candidates } = await adapter.extractCandidateList(searchPage);
    const summary: Record<string, unknown> = {
      platform: adapter.platform,
      keyword,
      totalCandidates: candidates.length,
      sampleCandidates: candidates.slice(0, 5),
    };

    if (parseFirst && candidates[0]) {
      const detailPage = await adapter.openResumeDetail(session.context, searchPage, candidates[0]);
      let preserveDetailPageForInspection = false;

      try {
        await adapter.afterResumeDetailOpened?.(detailPage, candidates[0], {
          liepinForwardContact: forwardContact,
        });
        summary.firstResume = await adapter.parseResumeDetail(detailPage, candidates[0]);
      } catch (error) {
        preserveDetailPageForInspection = true;
        console.error(JSON.stringify(await collectLiepinDetailForwardDiagnostics(detailPage), null, 2));
        throw error;
      } finally {
        if (detailPage !== session.page && !preserveDetailPageForInspection) {
          await detailPage.close();
        }
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeBrowserSession(session);
  }
}

async function main(): Promise<void> {
  await runLiepinSmokeFlow(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
