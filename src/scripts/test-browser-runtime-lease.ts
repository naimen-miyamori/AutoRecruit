import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { PlatformRuntimeError } from '../browser/platform-runtime-inspector.js';
import {
  acquirePlatformRuntimeLease,
  platformRuntimeLeaseOwnerExists,
  quarantinePlatformRuntimeLease,
  readPlatformRuntimeLease,
} from '../browser/platform-runtime-lease.js';
import { PlatformRuntimeStore } from '../browser/platform-runtime-store.js';

async function withStore<T>(run: (store: PlatformRuntimeStore) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-lease-'));
  try {
    return await run(new PlatformRuntimeStore({ dataDir: root }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('platform runtime lease', () => {
  it('allows one platform owner and never takes over an existing directory online', async () => {
    await withStore(async (store) => {
      const generationId = randomUUID();
      const first = await acquirePlatformRuntimeLease(store, 'liepin', generationId, {
        operationId: 'one',
        operationKind: 'capture',
      });
      await assert.rejects(
        acquirePlatformRuntimeLease(store, 'liepin', generationId, {
          operationId: 'two',
          operationKind: 'capture',
        }),
        (error) => error instanceof PlatformRuntimeError && error.code === 'browser-runtime-busy',
      );
      await first.release();
      const second = await acquirePlatformRuntimeLease(store, 'liepin', generationId, {
        operationId: 'two',
        operationKind: 'capture',
      });
      await second.release();
    });
  });

  it('prevents an old owner from releasing a replaced token', async () => {
    await withStore(async (store) => {
      const lease = await acquirePlatformRuntimeLease(store, 'zhilian', randomUUID(), {
        operationId: 'one',
        operationKind: 'subscription',
      });
      const ownerPath = path.join(store.leaseDir('zhilian'), 'owner.json');
      const current = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(ownerPath, `${JSON.stringify({ ...current, ownerToken: randomUUID() })}\n`, 'utf8');
      await assert.rejects(
        lease.release(),
        (error) => error instanceof PlatformRuntimeError && error.code === 'browser-runtime-lease-lost',
      );
    });
  });

  it('isolates different platform leases', async () => {
    await withStore(async (store) => {
      const generationId = randomUUID();
      const [job, boss] = await Promise.all([
        acquirePlatformRuntimeLease(store, '51job', generationId, { operationId: 'a', operationKind: 'capture' }),
        acquirePlatformRuntimeLease(store, 'boss', generationId, { operationId: 'b', operationKind: 'job-sync' }),
      ]);
      await Promise.all([job.release(), boss.release()]);
    });
  });

  it('quarantines a generation-matching dead owner only at an explicit recovery boundary', async () => {
    await withStore(async (store) => {
      const generationId = randomUUID();
      await acquirePlatformRuntimeLease(store, 'liepin', generationId, {
        operationId: 'abandoned-login',
        operationKind: 'session.login-refresh',
      });
      const ownerPath = path.join(store.leaseDir('liepin'), 'owner.json');
      const record = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(ownerPath, `${JSON.stringify({ ...record, pid: 2_147_483_647 })}\n`, 'utf8');
      const deadLease = await readPlatformRuntimeLease(store, 'liepin');
      assert.notEqual(deadLease, undefined);
      assert.notEqual(deadLease, 'invalid');
      if (!deadLease || deadLease === 'invalid') return;
      assert.equal(platformRuntimeLeaseOwnerExists(deadLease), false);
      await assert.rejects(
        quarantinePlatformRuntimeLease(store, 'liepin', {
          confirmed: true,
          observedGenerationId: randomUUID(),
        }),
        (error) => error instanceof PlatformRuntimeError && error.code === 'browser-runtime-generation-mismatch',
      );
      const quarantinePath = await quarantinePlatformRuntimeLease(store, 'liepin', {
        confirmed: true,
        observedGenerationId: generationId,
      });
      assert.ok(quarantinePath?.includes('browser-lease-'));
      assert.equal(await readPlatformRuntimeLease(store, 'liepin'), undefined);
    });
  });
});
