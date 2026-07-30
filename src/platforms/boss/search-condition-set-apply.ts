import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserSession } from '../../browser/session.js';
import { closeBrowserSession, ensureAuthenticatedBrowserSession } from '../../browser/session.js';
import { config } from '../../config.js';
import {
  SearchConditionSetService,
  type ResolvedSearchConditionSet,
  type SearchConditionSetReference,
} from '../../search/search-condition-sets.js';
import type { SearchCondition } from '../../types/job.js';
import {
  applyBossDirectSearch,
  estimateBossDirectSearchTimeoutMs,
  resetBossSearchFilters,
} from './actions/search-actions.js';

export type BossRecentViewedPolicy = 'exclude' | 'include' | 'condition-set';

export interface ApplyBossSearchConditionSetInput {
  reference: SearchConditionSetReference;
  keyword?: string;
  recentViewedPolicy?: BossRecentViewedPolicy;
  /** An existing absolute deadline for a queue/test caller. */
  deadline?: number;
  signal?: AbortSignal;
  service?: Pick<SearchConditionSetService, 'resolve'>;
  /** Test-only override; production uses the Boss runtime lock path. */
  lockFilePath?: string;
}

export interface BossSearchConditionSetApplySummary {
  status: 'applied';
  platform: 'boss';
  conditionSet: string;
  keyword: string;
  recentViewedPolicy: BossRecentViewedPolicy;
  conditionsVerified: number;
  resultTotal: number;
  resultTotalSource: 'page';
  startedAt: string;
  finishedAt: string;
}

export class BossSearchConditionSetApplyError extends Error {
  readonly phase: 'resolve' | 'lock' | 'session' | 'apply' | 'verify' | 'recover';
  readonly recoveredBaseline: boolean;
  readonly partialStatePossible: boolean;

  constructor(input: {
    phase: BossSearchConditionSetApplyError['phase'];
    message: string;
    recoveredBaseline?: boolean;
    partialStatePossible?: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'BossSearchConditionSetApplyError';
    this.phase = input.phase;
    this.recoveredBaseline = input.recoveredBaseline ?? false;
    this.partialStatePossible = input.partialStatePossible ?? false;
  }
}

type BossSearchConditionSetApplyLock = {
  token: string;
  pid: number;
  startedAt: string;
};

const lockFileName = 'search-condition-set-apply.lock';

export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const applyBossDirectSearchRef = { fn: applyBossDirectSearch };
export const resetBossSearchFiltersRef = { fn: resetBossSearchFilters };

function normalizeKeyword(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Boss search condition-set application was cancelled.');
  }
}

function resolveKeyword(input: ApplyBossSearchConditionSetInput, resolved: ResolvedSearchConditionSet): string {
  const keyword = normalizeKeyword(input.keyword) ?? normalizeKeyword(resolved.revision.defaultKeyword);
  if (!keyword) {
    throw new BossSearchConditionSetApplyError({
      phase: 'resolve',
      message: `Boss search condition set ${resolved.reference.conditionSetId}@${resolved.reference.revision} has no default keyword; pass --keyword explicitly.`,
    });
  }
  return keyword;
}

function readRecentViewedConditionValue(condition: SearchCondition): boolean | undefined {
  if (condition.kind !== 'applicationFilter' || condition.fieldId !== 'filter_recent_viewed') {
    return undefined;
  }
  if (typeof condition.value === 'boolean') {
    return condition.value;
  }
  const fallback = Array.isArray(condition.values)
    && typeof condition.values[0] === 'object'
    && condition.values[0] !== null
    && 'value' in condition.values[0]
    ? (condition.values[0] as { value?: unknown }).value
    : undefined;
  if (fallback === 'true') return true;
  if (fallback === 'false') return false;
  throw new BossSearchConditionSetApplyError({
    phase: 'resolve',
    message: 'Boss condition-set filter_recent_viewed must have a boolean value.',
  });
}

function resolveViewedPolicy(
  policy: BossRecentViewedPolicy,
  conditions: readonly SearchCondition[],
): boolean | undefined {
  const values = conditions
    .map(readRecentViewedConditionValue)
    .filter((value): value is boolean => value !== undefined);
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new BossSearchConditionSetApplyError({
      phase: 'resolve',
      message: 'Boss condition set contains conflicting filter_recent_viewed values.',
    });
  }
  if (policy === 'condition-set') return undefined;

  const includeViewedCandidates = policy === 'include';
  const explicit = distinct[0];
  const expectedChecked = !includeViewedCandidates;
  if (explicit !== undefined && explicit !== expectedChecked) {
    throw new BossSearchConditionSetApplyError({
      phase: 'resolve',
      message: `Boss condition-set filter_recent_viewed=${String(explicit)} conflicts with recent-viewed-policy ${policy}. Remove that condition or use --recent-viewed-policy condition-set.`,
    });
  }
  return includeViewedCandidates;
}

function lockPath(): string {
  return path.join(config.dataDir, 'boss', 'runtime', lockFileName);
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(filePath: string): Promise<BossSearchConditionSetApplyLock | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<BossSearchConditionSetApplyLock>;
    return typeof parsed.token === 'string' && typeof parsed.pid === 'number' && typeof parsed.startedAt === 'string'
      ? { token: parsed.token, pid: parsed.pid, startedAt: parsed.startedAt }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function acquireBossSearchConditionSetApplyLock(filePath = lockPath()): Promise<{
  lock: BossSearchConditionSetApplyLock;
  release: () => Promise<void>;
}> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lock: BossSearchConditionSetApplyLock = {
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(filePath, 'wx');
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      await handle.close();
      return {
        lock,
        release: async () => {
          const current = await readLock(filePath);
          if (current?.token === lock.token) {
            await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readLock(filePath);
      if (current && processExists(current.pid)) {
        throw new BossSearchConditionSetApplyError({
          phase: 'lock',
          message: `A Boss search-condition-set apply run is already active (pid ${current.pid}, started ${current.startedAt}).`,
        });
      }
      await fs.unlink(filePath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
  }

  throw new BossSearchConditionSetApplyError({
    phase: 'lock',
    message: 'Unable to acquire the Boss search-condition-set apply lock.',
  });
}

async function recoverBossSearchBaseline(
  session: BrowserSession,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<{ recoveredBaseline: boolean; partialStatePossible: boolean }> {
  if (signal?.aborted || deadline <= Date.now()) {
    return { recoveredBaseline: false, partialStatePossible: true };
  }
  try {
    await resetBossSearchFiltersRef.fn(session.page, deadline);
    return { recoveredBaseline: true, partialStatePossible: false };
  } catch {
    return { recoveredBaseline: false, partialStatePossible: true };
  }
}

/**
 * Apply one fixed Boss condition-set revision without entering ordinary
 * capture. It neither reads candidate cards nor writes job/seen/score/report
 * state; the only page side effect is replacing the current search filters.
 */
export async function applyBossSearchConditionSetWorkflow(
  input: ApplyBossSearchConditionSetInput,
): Promise<BossSearchConditionSetApplySummary> {
  if (input.reference.platform !== 'boss') {
    throw new BossSearchConditionSetApplyError({
      phase: 'resolve',
      message: '--condition-set must reference platform boss.',
    });
  }

  const startedAt = new Date().toISOString();
  const policy = input.recentViewedPolicy ?? 'exclude';
  let resolved: ResolvedSearchConditionSet;
  try {
    throwIfAborted(input.signal);
    resolved = await (input.service ?? new SearchConditionSetService()).resolve(input.reference);
  } catch (error) {
    if (error instanceof BossSearchConditionSetApplyError) throw error;
    throw new BossSearchConditionSetApplyError({
      phase: 'resolve',
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }

  const keyword = resolveKeyword(input, resolved);
  const includeViewedCandidates = resolveViewedPolicy(policy, resolved.conditions);
  const estimatedTimeoutMs = estimateBossDirectSearchTimeoutMs({
    conditions: resolved.conditions,
    includeViewedCandidates,
  });
  const deadline = input.deadline ?? Date.now() + estimatedTimeoutMs;
  if (deadline <= Date.now()) {
    throw new BossSearchConditionSetApplyError({ phase: 'apply', message: 'Boss search condition-set deadline has already expired.' });
  }

  let releaseLock: (() => Promise<void>) | undefined;
  let session: BrowserSession | undefined;
  let phase: BossSearchConditionSetApplyError['phase'] = 'lock';
  try {
    throwIfAborted(input.signal);
    ({ release: releaseLock } = await acquireBossSearchConditionSetApplyLock(input.lockFilePath));
    phase = 'session';
    throwIfAborted(input.signal);
    session = await ensureAuthenticatedBrowserSessionRef.fn('boss');
    phase = 'apply';
    throwIfAborted(input.signal);
    const applied = await applyBossDirectSearchRef.fn(session.page, keyword, resolved.conditions, {
      deadline,
      includeViewedCandidates,
      signal: input.signal,
    });
    session.page = applied.page;
    phase = 'verify';
    throwIfAborted(input.signal);
    const verification = applied.verification;
    const failed = verification.conditions.find((entry) => !entry.verified);
    if (failed) {
      throw new Error(failed.message ?? `Boss search condition verification failed for ${failed.fieldId}.`);
    }
    return {
      status: 'applied',
      platform: 'boss',
      conditionSet: `${resolved.reference.conditionSetId}@${resolved.reference.revision}`,
      keyword,
      recentViewedPolicy: policy,
      conditionsVerified: resolved.conditions.length,
      resultTotal: verification.resultTotal,
      resultTotalSource: verification.resultTotalSource,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const recovery = session
      ? await recoverBossSearchBaseline(session, deadline, input.signal)
      : { recoveredBaseline: false, partialStatePossible: false };
    if (error instanceof BossSearchConditionSetApplyError) throw error;
    throw new BossSearchConditionSetApplyError({
      phase,
      message: error instanceof Error ? error.message : String(error),
      recoveredBaseline: recovery.recoveredBaseline,
      partialStatePossible: recovery.partialStatePossible,
      cause: error,
    });
  } finally {
    if (session) {
      await closeBrowserSessionRef.fn(session, { announceKeptOpen: false }).catch(() => undefined);
    }
    await releaseLock?.().catch(() => undefined);
  }
}
