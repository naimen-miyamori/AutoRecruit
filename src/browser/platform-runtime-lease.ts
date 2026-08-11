import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupportedPlatform } from '../platforms/types.js';
import { PlatformRuntimeError } from './platform-runtime-inspector.js';
import type { PlatformRuntimeStore } from './platform-runtime-store.js';

export type PlatformRuntimeOperationIdentity = {
  operationId: string;
  operationKind: string;
};

export type PlatformRuntimeLeaseRecordV1 = {
  version: 1;
  platform: SupportedPlatform;
  generationId: string;
  ownerToken: string;
  operationId: string;
  operationKind: string;
  pid: number;
  acquiredAt: string;
};

export type PlatformRuntimeLease = {
  record: PlatformRuntimeLeaseRecordV1;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function inspectPlatformRuntimeLeaseRecord(raw: unknown): PlatformRuntimeLeaseRecordV1 | undefined {
  if (!isRecord(raw)
    || raw.version !== 1
    || !['51job', 'liepin', 'zhilian', 'boss'].includes(raw.platform as string)
    || typeof raw.generationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.generationId)
    || typeof raw.ownerToken !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(raw.ownerToken)
    || typeof raw.operationId !== 'string'
    || raw.operationId.length < 1
    || raw.operationId.length > 256
    || typeof raw.operationKind !== 'string'
    || raw.operationKind.length < 1
    || raw.operationKind.length > 128
    || !Number.isSafeInteger(raw.pid)
    || (raw.pid as number) <= 0
    || typeof raw.acquiredAt !== 'string'
    || Number.isNaN(Date.parse(raw.acquiredAt))
    || new Date(raw.acquiredAt).toISOString() !== raw.acquiredAt) {
    return undefined;
  }
  return raw as PlatformRuntimeLeaseRecordV1;
}

async function readLeaseRecord(leaseDir: string): Promise<PlatformRuntimeLeaseRecordV1 | undefined> {
  try {
    return inspectPlatformRuntimeLeaseRecord(JSON.parse(await fs.readFile(path.join(leaseDir, 'owner.json'), 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

async function writeExclusiveRecord(filePath: string, record: PlatformRuntimeLeaseRecordV1): Promise<void> {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function acquirePlatformRuntimeLease(
  store: PlatformRuntimeStore,
  platform: SupportedPlatform,
  generationId: string,
  operation: PlatformRuntimeOperationIdentity,
): Promise<PlatformRuntimeLease> {
  const leaseDir = store.leaseDir(platform);
  await fs.mkdir(path.dirname(leaseDir), { recursive: true });
  const record: PlatformRuntimeLeaseRecordV1 = {
    version: 1,
    platform,
    generationId,
    ownerToken: randomUUID(),
    operationId: operation.operationId,
    operationKind: operation.operationKind,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(leaseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = await readLeaseRecord(leaseDir);
    if (!current) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} browser runtime lease evidence is incomplete.`);
    }
    throw new PlatformRuntimeError(
      platform,
      'browser-runtime-busy',
      `${platform} browser runtime is busy with ${current.operationKind} (${current.operationId}).`,
    );
  }

  try {
    await writeExclusiveRecord(path.join(leaseDir, 'owner.json'), record);
  } catch (error) {
    await fs.rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const assertOwned = async (): Promise<void> => {
    const current = await readLeaseRecord(leaseDir);
    if (!current
      || current.ownerToken !== record.ownerToken
      || current.generationId !== record.generationId
      || current.platform !== record.platform) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-lease-lost', `${platform} browser runtime lease ownership changed.`);
    }
  };

  return {
    record,
    assertOwned,
    release: async () => {
      await assertOwned();
      await fs.rm(path.join(leaseDir, 'owner.json'));
      await fs.rmdir(leaseDir);
    },
  };
}

export async function readPlatformRuntimeLease(
  store: PlatformRuntimeStore,
  platform: SupportedPlatform,
): Promise<PlatformRuntimeLeaseRecordV1 | undefined | 'invalid'> {
  try {
    await fs.access(store.leaseDir(platform));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return await readLeaseRecord(store.leaseDir(platform)) ?? 'invalid';
}

export function platformRuntimeLeaseOwnerExists(lease: PlatformRuntimeLeaseRecordV1): boolean {
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function quarantinePlatformRuntimeLease(
  store: PlatformRuntimeStore,
  platform: SupportedPlatform,
  confirmation: { confirmed: true; observedGenerationId: string },
): Promise<string | undefined> {
  const lease = await readPlatformRuntimeLease(store, platform);
  if (lease === undefined) return undefined;
  if (lease === 'invalid') {
    throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} browser runtime lease is malformed and requires manual inspection.`);
  }
  if (lease.generationId !== confirmation.observedGenerationId) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser runtime generation changed before recovery.`);
  }
  if (platformRuntimeLeaseOwnerExists(lease)) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-busy', `${platform} browser runtime lease owner is still alive.`);
  }

  await fs.mkdir(store.quarantineDir(platform), { recursive: true });
  const quarantinePath = path.join(
    store.quarantineDir(platform),
    `browser-lease-${lease.generationId.slice(0, 8)}-${Date.now()}-${randomUUID()}`,
  );
  await fs.rename(store.leaseDir(platform), quarantinePath);
  return quarantinePath;
}
