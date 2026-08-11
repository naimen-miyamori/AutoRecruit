import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parsePlatformRuntimeListResponse } from '../server/api-contracts.js';
import { handleApiRequest } from '../server/routes.js';
import { acquirePlatformRuntimeLease } from '../browser/platform-runtime-lease.js';
import { PlatformRuntimeStore } from '../browser/platform-runtime-store.js';

describe('platform browser runtime API', () => {
  it('returns a browser-safe complete platform set without creating runtime files', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-api-'));
    try {
      const before = await fs.readdir(dataDir);
      const response = await handleApiRequest({
        method: 'GET',
        pathname: '/api/platform-browser-runtimes',
        dataDir,
      });
      assert.equal(response.statusCode, 200);
      const parsed = parsePlatformRuntimeListResponse(response.body);
      assert.deepStrictEqual(parsed.runtimes.map((runtime) => runtime.platform), ['51job', 'liepin', 'zhilian', 'boss']);
      assert.equal(parsed.runtimes.every((runtime) =>
        runtime.status === 'absent'
        || (runtime.status === 'recovery_required'
          && runtime.issueCodes.length === 1
          && runtime.issueCodes[0] === 'browser-runtime-unpublished-endpoint')),
      true);
      assert.deepStrictEqual(await fs.readdir(dataDir), before);
      assert.doesNotMatch(JSON.stringify(response.body), /cookie|storageState|profilePath|webSocketDebuggerUrl/i);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed on duplicate or malformed client payloads', () => {
    assert.throws(
      () => parsePlatformRuntimeListResponse({ runtimes: [] }),
      /platform-browser-runtime-shape/,
    );
    assert.throws(
      () => parsePlatformRuntimeListResponse({
        runtimes: [
          { platform: '51job', status: 'published', issueCodes: [], secret: 'cookie' },
          { platform: 'liepin', status: 'absent', issueCodes: [] },
          { platform: 'zhilian', status: 'absent', issueCodes: [] },
          { platform: 'boss', status: 'absent', issueCodes: [] },
        ],
      }),
      /platform-browser-runtime-shape/,
    );
  });

  it('projects an unpublished login attempt as login_required without attaching to Playwright', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-api-login-'));
    const store = new PlatformRuntimeStore({ dataDir });
    const generationId = 'cf01554a-32f2-4f73-9a79-b237fce33142';
    const lease = await acquirePlatformRuntimeLease(store, 'boss', generationId, {
      operationId: 'login-test',
      operationKind: 'session.login-open',
    });
    try {
      const attempt = await store.startAttempt('boss', 'login', generationId);
      await store.updateAttempt(attempt, 'verifying');
      const response = await handleApiRequest({
        method: 'GET',
        pathname: '/api/platform-browser-runtimes',
        dataDir,
      });
      const parsed = parsePlatformRuntimeListResponse(response.body);
      const boss = parsed.runtimes.find((runtime) => runtime.platform === 'boss');
      assert.equal(boss?.status, 'login_required');
      assert.equal(boss?.generationFingerprint, generationId.slice(0, 8));
      assert.equal(boss?.occupiedBy?.operationId, 'login-test');
    } finally {
      await lease.release();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
