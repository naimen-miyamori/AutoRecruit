import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import {
  assertScheduleId,
  assertScheduleRunId,
  isScheduleId,
  isScheduleRunId,
} from './schedule-identifiers.js';
import {
  inspectPersistedScheduleRecord,
} from './schedule-record-validation.js';
import type {
  PersistedScheduleDefinition,
  ScheduleDetailView,
  ScheduleRunRecord,
  ScheduleSummary,
} from './types.js';

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function readScheduleRecord(filePath: string): Promise<PersistedScheduleDefinition> {
  const value = await readJsonFile<unknown>(filePath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid schedule record: ${path.basename(filePath)}`);
  }
  return value as PersistedScheduleDefinition;
}

function storageRevision(value: PersistedScheduleDefinition | undefined): number {
  return value && Number.isSafeInteger(value.storageRevision) && value.storageRevision! >= 0
    ? value.storageRevision!
    : 0;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalizeJson(item)]));
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

interface ScheduleLeaseOwner {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
}

interface ScheduleLeaseSnapshot {
  owner?: ScheduleLeaseOwner;
  ageMs: number;
}

export interface ScheduleTransactionDecision<T> {
  schedule?: PersistedScheduleDefinition;
  value: T;
}

export class ScheduleStoreConflictError extends Error {
  readonly code = 'schedule-write-conflict' as const;

  constructor(readonly scheduleId: string) {
    super(`Schedule changed before write: ${scheduleId}`);
    this.name = 'ScheduleStoreConflictError';
  }
}

export class ScheduleLeaseTimeoutError extends Error {
  readonly code = 'schedule-lease-timeout' as const;

  constructor(readonly scheduleId: string) {
    super(`Timed out waiting for schedule lease: ${scheduleId}`);
    this.name = 'ScheduleLeaseTimeoutError';
  }
}

export class ScheduleLeaseRecoveryRequiredError extends Error {
  readonly code = 'schedule-lease-recovery-required' as const;

  constructor(readonly scheduleId: string) {
    super(`Schedule lease requires explicit offline recovery: ${scheduleId}`);
    this.name = 'ScheduleLeaseRecoveryRequiredError';
  }
}

export class ScheduleLeaseOwnershipLostError extends Error {
  readonly code = 'schedule-lease-ownership-lost' as const;

  constructor(readonly scheduleId: string) {
    super(`Schedule lease ownership was lost: ${scheduleId}`);
    this.name = 'ScheduleLeaseOwnershipLostError';
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForLeaseRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function resolveContainedPath(rootDir: string, ...segments: string[]): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Schedule storage path must remain inside its configured directory');
  }
  return resolved;
}

export function toScheduleDetailView(
  schedule: PersistedScheduleDefinition,
  expectedScheduleId = typeof schedule.scheduleId === 'string' ? schedule.scheduleId : undefined,
): ScheduleDetailView {
  return inspectPersistedScheduleRecord(schedule, expectedScheduleId).detail;
}

export interface StoredScheduleEntry {
  scheduleId: string;
  record: PersistedScheduleDefinition;
}

export class ScheduleStore {
  private readonly schedulesDir: string;
  private readonly runsDir: string;
  private readonly scheduleLocksDir: string;
  private writeSerial: Promise<void> = Promise.resolve();

  constructor(dataDir = config.dataDir) {
    const runtimeDir = path.join(dataDir, 'runtime');
    this.schedulesDir = path.join(runtimeDir, 'schedules');
    this.runsDir = path.join(runtimeDir, 'schedule-runs');
    this.scheduleLocksDir = path.join(runtimeDir, 'schedule-locks');
  }

  async listSchedules(): Promise<PersistedScheduleDefinition[]> {
    return (await this.listScheduleEntries()).map((entry) => entry.record);
  }

  async listScheduleEntries(): Promise<StoredScheduleEntry[]> {
    await ensureDir(this.schedulesDir);
    const entries = await fs.readdir(this.schedulesDir);
    const schedules = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json') && isScheduleId(entry.slice(0, -'.json'.length)))
      .sort()
      .map(async (entry) => ({
        scheduleId: entry.slice(0, -'.json'.length),
        record: await readScheduleRecord(resolveContainedPath(this.schedulesDir, entry)),
      })));
    return schedules.sort((left, right) => inspectPersistedScheduleRecord(
      right.record,
      right.scheduleId,
    ).summary.updatedAt.localeCompare(inspectPersistedScheduleRecord(
      left.record,
      left.scheduleId,
    ).summary.updatedAt));
  }

  async listScheduleSummaries(): Promise<ScheduleSummary[]> {
    return (await this.listScheduleEntries()).map((entry) => inspectPersistedScheduleRecord(
      entry.record,
      entry.scheduleId,
    ).summary);
  }

  async readSchedule(scheduleId: string): Promise<PersistedScheduleDefinition | undefined> {
    assertScheduleId(scheduleId);
    try {
      return await readScheduleRecord(resolveContainedPath(this.schedulesDir, `${scheduleId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async saveSchedule(schedule: PersistedScheduleDefinition): Promise<void> {
    assertScheduleId(schedule.scheduleId);
    await this.transactSchedule(schedule.scheduleId, (current) => {
      if (current && storageRevision(current) !== storageRevision(schedule)) {
        throw new ScheduleStoreConflictError(schedule.scheduleId);
      }
      return { schedule, value: undefined };
    });
  }

  async saveScheduleIfUnchanged(
    expected: PersistedScheduleDefinition,
    updated: PersistedScheduleDefinition,
  ): Promise<boolean> {
    assertScheduleId(expected.scheduleId);
    assertScheduleId(updated.scheduleId);
    if (expected.scheduleId !== updated.scheduleId) {
      throw new Error('Schedule compare-and-swap IDs must match');
    }
    return this.transactSchedule(expected.scheduleId, (current) => {
      const currentComparable = current
        ? inspectPersistedScheduleRecord(current, expected.scheduleId).executable ?? current
        : undefined;
      const expectedComparable = inspectPersistedScheduleRecord(expected, expected.scheduleId).executable ?? expected;
      if (!currentComparable || !sameJsonValue(currentComparable, expectedComparable)) {
        return { value: false };
      }
      return { schedule: updated, value: true };
    });
  }

  async transactSchedule<T>(
    scheduleId: string,
    operation: (
      current: PersistedScheduleDefinition | undefined,
    ) => Promise<ScheduleTransactionDecision<T>> | ScheduleTransactionDecision<T>,
  ): Promise<T> {
    assertScheduleId(scheduleId);
    return this.runWriteSerialized(() => this.withScheduleLease(scheduleId, async (assertOwned) => {
      const current = await this.readSchedule(scheduleId);
      const decision = await operation(current);
      if (decision.schedule) {
        assertScheduleId(decision.schedule.scheduleId);
        if (decision.schedule.scheduleId !== scheduleId) {
          throw new Error('Schedule transaction cannot change its schedule ID');
        }
        const schedule = {
          ...decision.schedule,
          storageRevision: storageRevision(current) + 1,
        } satisfies PersistedScheduleDefinition;
        await assertOwned();
        await writeJsonAtomically(
          resolveContainedPath(this.schedulesDir, `${scheduleId}.json`),
          schedule,
        );
      }
      return decision.value;
    }));
  }

  async readRun(scheduleId: string, runId: string): Promise<ScheduleRunRecord | undefined> {
    assertScheduleId(scheduleId);
    assertScheduleRunId(runId);
    try {
      return await readJsonFile<ScheduleRunRecord>(resolveContainedPath(this.runsDir, scheduleId, `${runId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async listRuns(scheduleId: string): Promise<ScheduleRunRecord[]> {
    assertScheduleId(scheduleId);
    const dir = resolveContainedPath(this.runsDir, scheduleId);
    try {
      const entries = await fs.readdir(dir);
      const runs = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json') && isScheduleRunId(entry.slice(0, -'.json'.length)))
        .sort()
        .map((entry) => readJsonFile<ScheduleRunRecord>(resolveContainedPath(dir, entry))));
      return runs.sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async saveRun(run: ScheduleRunRecord): Promise<void> {
    assertScheduleId(run.scheduleId);
    assertScheduleRunId(run.runId);
    await writeJsonAtomically(resolveContainedPath(this.runsDir, run.scheduleId, `${run.runId}.json`), run);
  }

  private runWriteSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeSerial.then(operation, operation);
    this.writeSerial = result.then(() => undefined, () => undefined);
    return result;
  }

  async recoverScheduleLease(scheduleId: string, options: {
    processesStopped: true;
    confirmedToken?: string;
  }): Promise<{
    recovered: boolean;
    quarantinePath?: string;
  }> {
    assertScheduleId(scheduleId);
    if (options.processesStopped !== true) {
      throw new Error('Schedule lease recovery requires confirmation that every API and scheduler process is stopped');
    }
    await ensureDir(this.scheduleLocksDir);
    const lockPath = resolveContainedPath(this.scheduleLocksDir, `${scheduleId}.lock`);
    let snapshot: ScheduleLeaseSnapshot;
    try {
      snapshot = await this.readLeaseSnapshot(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false };
      throw error;
    }
    if (snapshot.owner && isProcessAlive(snapshot.owner.pid)) {
      throw new Error(`Cannot recover a live schedule lease: ${scheduleId}`);
    }
    if (options.confirmedToken !== undefined && snapshot.owner?.token !== options.confirmedToken) {
      throw new Error(`Schedule lease owner changed before recovery: ${scheduleId}`);
    }
    const ownerLabel = crypto.createHash('sha256')
      .update(snapshot.owner?.token ?? 'invalid')
      .digest('hex')
      .slice(0, 16);
    const quarantinePath = resolveContainedPath(
      this.scheduleLocksDir,
      `${scheduleId}.${ownerLabel}.${Date.now()}.${crypto.randomUUID()}.quarantine`,
    );
    try {
      await fs.rename(lockPath, quarantinePath);
      return { recovered: true, quarantinePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false };
      throw error;
    }
  }

  private async readLeaseSnapshot(lockPath: string): Promise<ScheduleLeaseSnapshot> {
    const stat = await fs.stat(lockPath);
    let owner: ScheduleLeaseOwner | undefined;
    try {
      const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
      if ((value.version === 1 || value.version === undefined)
        && typeof value.token === 'string'
        && value.token.length > 0
        && Number.isSafeInteger(value.pid)
        && (value.pid as number) > 0
        && typeof value.acquiredAt === 'string'
        && Number.isFinite(Date.parse(value.acquiredAt))) {
        owner = {
          version: 1,
          token: value.token,
          pid: value.pid as number,
          acquiredAt: value.acquiredAt,
        };
      }
    } catch {
      // A just-created owner file may be observed before its JSON write completes.
    }
    return { owner, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  }

  private async withScheduleLease<T>(
    scheduleId: string,
    operation: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await ensureDir(this.scheduleLocksDir);
    const lockPath = resolveContainedPath(this.scheduleLocksDir, `${scheduleId}.lock`);
    const owner: ScheduleLeaseOwner = {
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const deadline = Date.now() + 10_000;

    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let snapshot: ScheduleLeaseSnapshot;
        try {
          snapshot = await this.readLeaseSnapshot(lockPath);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        if ((snapshot.owner && !isProcessAlive(snapshot.owner.pid))
          || (!snapshot.owner && snapshot.ageMs > 30_000)) {
          throw new ScheduleLeaseRecoveryRequiredError(scheduleId);
        }
        if (Date.now() >= deadline) {
          throw new ScheduleLeaseTimeoutError(scheduleId);
        }
        await waitForLeaseRetry();
      }
    }

    const assertOwned = async (): Promise<void> => {
      try {
        const snapshot = await this.readLeaseSnapshot(lockPath);
        if (snapshot.owner?.token !== owner.token) {
          throw new ScheduleLeaseOwnershipLostError(scheduleId);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ScheduleLeaseOwnershipLostError(scheduleId);
        }
        throw error;
      }
    };

    try {
      await assertOwned();
      return await operation(assertOwned);
    } finally {
      try {
        const existing = JSON.parse(await fs.readFile(lockPath, 'utf8')) as ScheduleLeaseOwner;
        if (existing.token === owner.token) {
          await fs.unlink(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
