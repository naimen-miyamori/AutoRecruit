import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, it } from 'node:test';
import { config } from '../config.js';
import { runBrowserCliMain } from '../browser/cli-lifecycle.js';
import { acquirePlatformRuntimeLease } from '../browser/platform-runtime-lease.js';
import { releasePlatformRuntime } from '../browser/platform-runtime.js';
import { PlatformRuntimeStore } from '../browser/platform-runtime-store.js';

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local fixture port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForEndpoint(endpoint: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {
      // Fixture browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Fixture Chromium CDP endpoint did not become ready.');
}

async function waitForEndpointStopped(endpoint: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${endpoint}/json/version`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Fixture Chromium CDP endpoint remained reachable after Browser.close.');
}

describe('platform runtime CDP fixture evidence', () => {
  it('exposes no runtime policy switch alongside the single login-owned runtime', () => {
    assert.equal('runtimePolicy' in config.browser, false);
  });

  it('explicitly exits a completed login-owned CLI only after awaited work settles', async () => {
    const events: string[] = [];
    await runBrowserCliMain(async () => {
      await Promise.resolve();
      events.push('completed');
    }, {
      exit: (code) => { events.push(`exit:${code}`); },
      reportError: (error) => { events.push(`error:${String(error)}`); },
    });
    assert.deepStrictEqual(events, ['completed', 'exit:0']);
  });

  it('keeps the browser and exact target alive after an attach client exits', { timeout: 30_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-cdp-'));
    const port = await reservePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const browserProcess = spawn(chromium.executablePath(), [
      `--user-data-dir=${path.join(root, 'profile')}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: 'ignore' });
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      await waitForEndpoint(endpoint);
      browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      assert.ok(context);
      assert.ok(page);
      const cdp = await context.newCDPSession(page);
      const target = await cdp.send('Target.getTargetInfo') as {
        targetInfo: { targetId?: string; browserContextId?: string };
      };
      await cdp.detach();
      assert.match(target.targetInfo.targetId ?? '', /^[0-9A-F]+$/i);
      assert.equal(
        target.targetInfo.browserContextId === undefined || typeof target.targetInfo.browserContextId === 'string',
        true,
      );

      const childSource = [
        "import { chromium } from 'playwright';",
        `const browser = await chromium.connectOverCDP(${JSON.stringify(endpoint)});`,
        "const page = browser.contexts()[0]?.pages()[0];",
        "if (!page || page.url() !== 'about:blank') process.exit(2);",
        'process.exit(0);',
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(exitCode, 0);
      assert.equal((await fetch(`${endpoint}/json/version`)).ok, true);
      assert.equal(page.isClosed(), false);
      assert.equal(page.url(), 'about:blank');
      const stopSession = await browser.newBrowserCDPSession();
      await stopSession.send('Browser.close');
      await stopSession.detach().catch(() => undefined);
      await waitForEndpointStopped(endpoint);
      if (browserProcess.exitCode === null) {
        await new Promise<void>((resolve) => browserProcess.once('exit', () => resolve()));
      }
      browser = undefined;
    } finally {
      if (browser?.isConnected()) await browser.close().catch(() => undefined);
      if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('stops an unpublished login browser before releasing its lease', { timeout: 30_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-runtime-unpublished-'));
    const port = await reservePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const profilePath = path.join(root, 'liepin', 'browser-profile');
    await fs.mkdir(profilePath, { recursive: true });
    const browserProcess = spawn(chromium.executablePath(), [
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: 'ignore' });
    const priorDataDir = config.dataDir;
    const priorPort = config.playwright.reuseCdpPortByPlatform.liepin;
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      await waitForEndpoint(endpoint);
      browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      assert.ok(context);
      assert.ok(page);
      (config as { dataDir: string }).dataDir = root;
      config.playwright.reuseCdpPortByPlatform.liepin = port;
      const store = new PlatformRuntimeStore({ dataDir: root });
      const generationId = randomUUID();
      const lease = await acquirePlatformRuntimeLease(store, 'liepin', generationId, {
        operationId: 'fixture-login',
        operationKind: 'session.login-open',
      });
      const attempt = await store.updateAttempt(
        await store.startAttempt('liepin', 'login', generationId),
        'verifying',
      );
      const session = {
        browser,
        context,
        page,
        temporaryPages: new Map(),
        platform: 'liepin' as const,
        runtimeGenerationId: generationId,
        runtimeLease: lease,
        runtimeAttempt: attempt,
      };
      await releasePlatformRuntime(session);
      await waitForEndpointStopped(endpoint);
      assert.equal(session.runtimeLease, undefined);
      assert.equal((await store.readLatestAttempt('liepin'))?.state, 'failed');
      assert.equal(await store.readRawManifest('liepin'), undefined);
      if (browserProcess.exitCode === null) {
        await new Promise<void>((resolve) => browserProcess.once('exit', () => resolve()));
      }
      browser = undefined;
    } finally {
      (config as { dataDir: string }).dataDir = priorDataDir;
      config.playwright.reuseCdpPortByPlatform.liepin = priorPort;
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession().catch(() => undefined);
        await session?.send('Browser.close').catch(() => undefined);
        await session?.detach().catch(() => undefined);
      }
      if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
