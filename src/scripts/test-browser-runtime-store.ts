import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { PlatformRuntimeError, type PlatformBrowserRuntimeManifestV1 } from '../browser/platform-runtime-inspector.js';
import { PlatformRuntimeStore, type PlatformRuntimeAttemptV1 } from '../browser/platform-runtime-store.js';

async function withStore<T>(run: (store: PlatformRuntimeStore, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-store-'));
  try {
    return await run(new PlatformRuntimeStore({ dataDir: root }), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function manifest(revision = 1): PlatformBrowserRuntimeManifestV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    platform: 'boss',
    generationId: randomUUID(),
    revision,
    browserInstanceId: 'browser-instance',
    browserContextId: 'default',
    cdpPort: 19331,
    profilePathFingerprint: 'b'.repeat(64),
    workPageTargetId: 'target-1',
    authenticatedOrigin: 'https://www.zhipin.com',
    authenticatedAt: now,
    storageStatePersistedAt: now,
    publishedAt: now,
    health: 'ready',
  };
}

describe('platform runtime store', () => {
  it('publishes atomically, rereads, and rejects stale generation/revision CAS', async () => {
    await withStore(async (store) => {
      const first = await store.publishManifest(manifest());
      const second = await store.publishManifest({ ...first, revision: 2 }, {
        expectedGenerationId: first.generationId,
        expectedRevision: 1,
      });
      assert.equal(second.revision, 2);
      await assert.rejects(
        store.publishManifest({ ...second, revision: 3 }, {
          expectedGenerationId: first.generationId,
          expectedRevision: 1,
        }),
        (error) => error instanceof PlatformRuntimeError && error.code === 'browser-runtime-generation-mismatch',
      );
      assert.equal((await store.requireExecutable('boss')).revision, 2);
    });
  });

  it('preserves recovery evidence as valid but non-executable', async () => {
    await withStore(async (store) => {
      const first = await store.publishManifest(manifest());
      await store.publishManifest({
        ...first,
        revision: 2,
        health: 'recovery_required',
        healthIssueCode: 'browser-runtime-recovery-required',
      }, { expectedGenerationId: first.generationId, expectedRevision: 1 });
      assert.equal((await store.requireValid('boss')).revision, 2);
      await assert.rejects(
        store.requireExecutable('boss'),
        (error) => error instanceof PlatformRuntimeError && error.code === 'browser-runtime-recovery-required',
      );
    });
  });

  it('prunes only resolved attempt evidence at the explicit bounded-maintenance boundary', async () => {
    await withStore(async (store) => {
      const write = (attemptId: string, state: PlatformRuntimeAttemptV1['state'], updatedAt: string) =>
        store.writeAttempt({
          version: 1,
          attemptId,
          platform: 'boss',
          kind: 'recover',
          state,
          startedAt: updatedAt,
          updatedAt,
        });
      await write('recent', 'completed', '2026-08-09T00:00:00.000Z');
      await write('old-resolved', 'failed', '2026-06-01T00:00:00.000Z');
      await write('old-unresolved', 'recovery_required', '2026-05-01T00:00:00.000Z');

      await store.pruneResolvedAttempts('boss', {
        now: new Date('2026-08-10T00:00:00.000Z'),
        maxEntries: 1,
        maxAgeDays: 30,
      });

      const remaining = await fs.readdir(store.attemptsDir('boss'));
      assert.equal(remaining.some((name) => name.includes('recent')), true);
      assert.equal(remaining.some((name) => name.includes('old-resolved')), false);
      assert.equal(remaining.some((name) => name.includes('old-unresolved')), true);
    });
  });
});
