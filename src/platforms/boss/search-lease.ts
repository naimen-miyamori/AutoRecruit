import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';

type BossSearchLeaseLock = {
  token: string;
  pid: number;
  startedAt: string;
};

const lockFileName = 'search-lease.lock';

export class BossSearchLeaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BossSearchLeaseError';
  }
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

async function readLock(filePath: string): Promise<BossSearchLeaseLock | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<BossSearchLeaseLock>;
    return typeof parsed.token === 'string' && typeof parsed.pid === 'number' && typeof parsed.startedAt === 'string'
      ? { token: parsed.token, pid: parsed.pid, startedAt: parsed.startedAt }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

/**
 * Acquire ownership of the mutable Boss talent-search surface. Apply-only and
 * ordinary capture must both hold this lease before changing or reusing the
 * search page, and release it only after they no longer need that result list.
 */
export async function acquireBossSearchLease(filePath = lockPath()): Promise<{
  lock: BossSearchLeaseLock;
  release: () => Promise<void>;
}> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lock: BossSearchLeaseLock = {
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
        throw new BossSearchLeaseError(
          `A Boss search run is already active (pid ${current.pid}, started ${current.startedAt}).`,
        );
      }
      await fs.unlink(filePath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
  }

  throw new BossSearchLeaseError('Unable to acquire the Boss search lease.');
}
