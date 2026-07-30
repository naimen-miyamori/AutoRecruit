import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { JobStore } from '../storage/job-store.js';
import type {
  BossJobSyncInput,
  BossJobSyncItem,
  BossJobSyncRun,
  BossPositionDetail,
} from '../types/boss.js';
import type { JobRecord, NormalizedJob } from '../types/job.js';
import { BOSS_PAGE_RULES_NORMALIZATION, normalizeBossPositionDetail } from './boss/parsing/job-parser.js';
import {
  openAndReadBossPositionDetail,
  openBossJobList,
  readBossPositionSummaries,
} from './boss/actions/job-actions.js';

export {
  inferBossPositionStatus,
  openAndReadBossPositionDetail,
  openBossJobList,
  readBossPositionSummaries,
} from './boss/actions/job-actions.js';

function buildBossJobNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildBossSyncedJobKey(name: string, bossJobId: string): string {
  const nameKey = buildBossJobNameKey(name) || 'boss-job';
  const idKey = bossJobId.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    || createHash('sha256').update(bossJobId).digest('hex').slice(0, 16);
  return `${nameKey}-${idKey}`;
}

export function hashBossJd(rawJd: string): string {
  return createHash('sha256').update(rawJd.replace(/\r\n/g, '\n').trim()).digest('hex');
}

export interface SyncBossJobsOptions {
  store?: JobStore;
  normalizeDetail?: (detail: BossPositionDetail) => NormalizedJob;
  now?: () => Date;
}

function hasCurrentBossNormalization(existing: JobRecord | undefined): boolean {
  const normalization = existing?.bossPosition?.normalization;
  return normalization?.kind === BOSS_PAGE_RULES_NORMALIZATION.kind
    && normalization.version === BOSS_PAGE_RULES_NORMALIZATION.version;
}

export async function syncBossPositions(
  page: Page,
  input: BossJobSyncInput = { platform: 'boss' },
  options: SyncBossJobsOptions = {},
): Promise<BossJobSyncRun> {
  const store = options.store ?? new JobStore();
  const normalizeDetail = options.normalizeDetail ?? normalizeBossPositionDetail;
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
      if (existing?.bossPosition?.sourceHash === sourceHash && hasCurrentBossNormalization(existing)) {
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

      const normalizedJob = normalizeDetail(detail);
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
          normalization: BOSS_PAGE_RULES_NORMALIZATION,
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
