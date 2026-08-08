import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { config } from '../../../config.js';
import type { CandidateListItem } from '../../../types/job.js';
import type { SearchWaitOptions } from '../../types.js';
import {
  waitForBossSearchFrame,
  waitForBossSearchResults,
} from './search-actions.js';

type BossCandidateCardSnapshot = {
  text: string;
  html: string;
  href: string;
  dataJid: string;
  dataExpect: string;
  dataLid: string;
  dataContact: string;
  dataEliteGeek: string;
  dataItemId: string;
  searchResultIndex: number;
};

export const BOSS_RAW_CANDIDATE_CARD_LIMIT = 20;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function createSearchDeadline(options?: SearchWaitOptions): number {
  return options?.deadline ?? Date.now() + Math.max(config.playwright.searchPageTimeoutMs, 1);
}

function hashBossCandidateText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function resolveBossCandidateId(snapshot: BossCandidateCardSnapshot): string {
  if (snapshot.dataExpect) {
    return snapshot.dataExpect;
  }

  if (snapshot.dataJid && snapshot.dataLid) {
    return `${snapshot.dataJid}_${snapshot.dataLid}`;
  }

  if (snapshot.dataJid) {
    return snapshot.dataJid;
  }

  if (snapshot.dataLid) {
    return snapshot.dataLid;
  }

  return `boss-card-${hashBossCandidateText(`${snapshot.href}\n${snapshot.text}\n${snapshot.html}`)}`;
}

function assertBossCandidateCardWindow(snapshots: BossCandidateCardSnapshot[]): void {
  const ids = snapshots.map((snapshot) => {
    if (!snapshot.dataExpect && !snapshot.dataJid && !snapshot.dataLid) {
      throw new Error(
        `Boss candidate card at visible index ${snapshot.searchResultIndex} has no stable candidate identity; refusing to parse or operate it.`,
      );
    }
    return resolveBossCandidateId(snapshot);
  });
  const duplicateIds = ids.filter((candidateId, index) => ids.indexOf(candidateId) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Boss candidate list contains duplicate stable IDs inside the first twenty: ${[...new Set(duplicateIds)].join(', ')}`,
    );
  }
}

function parseBossCandidateName(lines: string[]): string | undefined {
  const isNameLike = (line: string) => /^[\u4e00-\u9fa5A-Za-z·*]{1,24}$/.test(line)
    && !/热搜|刚刚活跃|活跃|联系|职位|期望|城市|院校|不感兴趣|收藏|转发|举报|不合适/.test(line);
  return lines.slice(0, 3).find(isNameLike) ?? lines.find(isNameLike);
}

function readBossLineAfterLabel(lines: string[], label: string, offset: number): string | undefined {
  const labelIndex = lines.findIndex((line) => line === label);
  if (labelIndex < 0) {
    return undefined;
  }

  const value = lines[labelIndex + offset];
  return value && !/^(期望城市|期望|职位|院校|联系Ta|不感兴趣)$/.test(value) ? value : undefined;
}

function parseBossCandidateTitle(lines: string[]): string | undefined {
  const firstPositionTitle = readBossLineAfterLabel(lines, '职位', 2);
  if (firstPositionTitle) {
    return firstPositionTitle;
  }

  const titleLine = lines.find((line) => /职位\s+/.test(line))
    ?? lines.find((line) => /电工|运维|维修|工程师|主管|经理|专员|技工|操作工|装配|弱电|强电/.test(line));
  return titleLine?.replace(/^职位\s*/, '').trim() || undefined;
}

function parseBossCandidateCompany(lines: string[]): string | undefined {
  const firstPositionCompany = readBossLineAfterLabel(lines, '职位', 1);
  if (firstPositionCompany) {
    return firstPositionCompany;
  }

  const companyLine = lines.find((line) => /公司|集团|科技|物业|管理|服务|工程|实业|商贸|股份|有限|酒店|医院|学校|工厂|厂/.test(line));
  return companyLine?.replace(/^职位\s*/, '').trim() || undefined;
}

function parseBossCandidateSnapshots(snapshots: BossCandidateCardSnapshot[]): CandidateListItem[] {
  const candidatesById = new Map<string, CandidateListItem>();

  for (const snapshot of snapshots) {
    const rawText = snapshot.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cardText = normalizeText(rawText);
    if (!cardText) {
      continue;
    }

    const candidateId = resolveBossCandidateId(snapshot);
    const lines = rawText
      .split(/\r?\n|[|｜]/)
      .map((line) => normalizeText(line))
      .filter(Boolean);

    candidatesById.set(candidateId, {
      candidateId,
      resumeUrl: snapshot.href && snapshot.href !== 'javascript:;' ? snapshot.href : undefined,
      name: parseBossCandidateName(lines),
      currentCompany: parseBossCandidateCompany(lines),
      currentTitle: parseBossCandidateTitle(lines),
      cardText,
      sourceText: [
        snapshot.href,
        snapshot.html,
        `data-jid=${snapshot.dataJid}`,
        `data-expect=${snapshot.dataExpect}`,
        `data-lid=${snapshot.dataLid}`,
        `data-contact=${snapshot.dataContact}`,
        `data-elitegeek=${snapshot.dataEliteGeek}`,
        `data-itemid=${snapshot.dataItemId}`,
      ].filter(Boolean).join(' '),
      searchResultIndex: snapshot.searchResultIndex,
    });
  }

  return Array.from(candidatesById.values())
    .sort((left, right) => (left.searchResultIndex ?? 0) - (right.searchResultIndex ?? 0));
}

async function collectBossCandidateSnapshots(page: Page, deadline: number): Promise<BossCandidateCardSnapshot[]> {
  const frame = await waitForBossSearchFrame(page, deadline);
  await waitForBossSearchResults(frame, deadline);

  return frame.locator('.geek-info-card').evaluateAll((cards) => cards.map((card, index) => {
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const anchor = card.querySelector<HTMLAnchorElement>('a[ka="search_click_open_resume"]')
      ?? card.querySelector<HTMLAnchorElement>('a[data-expect], a[data-jid], a[data-lid]');
    const visibleText = card instanceof HTMLElement ? card.innerText : card.textContent;

    return {
      text: (visibleText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      html: card.outerHTML,
      href: anchor?.getAttribute('href') ?? anchor?.href ?? '',
      dataJid: normalize(anchor?.getAttribute('data-jid')),
      dataExpect: normalize(anchor?.getAttribute('data-expect')),
      dataLid: normalize(anchor?.getAttribute('data-lid')),
      dataContact: normalize(anchor?.getAttribute('data-contact')),
      dataEliteGeek: normalize(anchor?.getAttribute('data-elitegeek')),
      dataItemId: normalize(anchor?.getAttribute('data-itemid')),
      searchResultIndex: index,
    };
  }));
}

export async function extractBossCandidateList(page: Page, options?: SearchWaitOptions): Promise<{ candidates: CandidateListItem[] }> {
  const deadline = createSearchDeadline(options);
  const rawSnapshots = await collectBossCandidateSnapshots(page, deadline);
  // Slice before parsing, filtering, or Map-based deduplication.  A malformed
  // or repeated card therefore fails closed and can never cause card 21+ to
  // be promoted into the operation window.
  const snapshots = rawSnapshots.slice(0, BOSS_RAW_CANDIDATE_CARD_LIMIT);
  assertBossCandidateCardWindow(snapshots);
  return { candidates: parseBossCandidateSnapshots(snapshots) };
}
