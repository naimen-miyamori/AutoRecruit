import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspectPlatformRuntime, type PlatformBrowserRuntimeManifestV1 } from '../browser/platform-runtime-inspector.js';

function manifest(overrides: Partial<PlatformBrowserRuntimeManifestV1> = {}): PlatformBrowserRuntimeManifestV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    platform: '51job',
    generationId: randomUUID(),
    revision: 1,
    browserInstanceId: 'browser-instance',
    browserContextId: 'default',
    cdpPort: 19325,
    profilePathFingerprint: 'a'.repeat(64),
    workPageTargetId: 'target-1',
    authenticatedOrigin: 'https://ehire.51job.com',
    authenticatedAt: now,
    storageStatePersistedAt: now,
    publishedAt: now,
    health: 'ready',
    ...overrides,
  };
}

describe('platform runtime inspector', () => {
  it('produces an executable descriptor only for a complete ready manifest', () => {
    const raw = manifest();
    const inspected = inspectPlatformRuntime('51job', raw);
    assert.equal(inspected.safeView.status, 'published');
    assert.equal(inspected.executableDescriptor?.generationId, raw.generationId);
    assert.equal(inspected.safeView.generationFingerprint, raw.generationId.slice(0, 8));
    assert.equal(JSON.stringify(inspected.safeView).includes('/Users/'), false);
  });

  it('fails closed for missing, partial, wrong-platform, query-bearing origin, and unknown version data', () => {
    const cases: unknown[] = [
      undefined,
      { version: 1, platform: '51job' },
      manifest({ platform: 'boss' }),
      manifest({ authenticatedOrigin: 'https://ehire.51job.com/?token=secret' }),
      { ...manifest(), version: 2 },
    ];
    const results = cases.map((raw) => inspectPlatformRuntime('51job', raw));
    assert.deepStrictEqual(results.map((result) => result.safeView.status), [
      'absent', 'invalid', 'invalid', 'invalid', 'invalid',
    ]);
    assert.equal(results.every((result) => result.executableDescriptor === undefined), true);
  });

  it('keeps a valid recovery manifest readable but not executable', () => {
    const inspected = inspectPlatformRuntime('51job', manifest({
      health: 'recovery_required',
      healthIssueCode: 'browser-runtime-recovery-required',
    }));
    assert.equal(inspected.safeView.status, 'recovery_required');
    assert.ok(inspected.validatedManifest);
    assert.equal(inspected.executableDescriptor, undefined);
  });
});
