import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  buildContextOptions as buildCloakBrowserContextOptions,
  buildLaunchOptions as buildCloakBrowserLaunchOptions,
} from 'cloakbrowser';
import { config, resolveStorageStatePath } from '../config.js';
import { getPlatformAdapter } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { BrowserSession } from './session.js';
import {
  PlatformRuntimeError,
  type PlatformBrowserRuntimeManifestV1,
  type PlatformRuntimeSafeView,
} from './platform-runtime-inspector.js';
import {
  acquirePlatformRuntimeLease,
  platformRuntimeLeaseOwnerExists,
  quarantinePlatformRuntimeLease,
  readPlatformRuntimeLease,
  type PlatformRuntimeLease,
  type PlatformRuntimeOperationIdentity,
} from './platform-runtime-lease.js';
import { PlatformRuntimeStore, type PlatformRuntimeAttemptV1 } from './platform-runtime-store.js';
import {
  bindRuntimePageRegistrar,
  unbindRuntimePageRegistrar,
  type RuntimeTemporaryPageEvidence,
} from './runtime-page-registry.js';

type CdpTargetInfo = {
  targetId: string;
  browserContextId?: string;
};

type RuntimePageIdentity = {
  targetId: string;
  browserContextId: string;
};

type RuntimeEndpointVersion = {
  webSocketDebuggerUrl?: string;
};

const attachedBrowsers = new Map<SupportedPlatform, Browser>();

function runtimeStore(dataDir = config.dataDir): PlatformRuntimeStore {
  return new PlatformRuntimeStore({ dataDir });
}

function cdpEndpoint(platform: SupportedPlatform): string {
  return `http://127.0.0.1:${config.playwright.reuseCdpPortByPlatform[platform]}`;
}

function reusableProfilePath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'browser-profile');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function profileFingerprint(platform: SupportedPlatform): string {
  return sha256(path.resolve(reusableProfilePath(platform)));
}

function originForPage(platform: SupportedPlatform, page: Page): string {
  let origin: string;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    throw new PlatformRuntimeError(platform, 'browser-runtime-auth-required', `${platform} authenticated page has no valid HTTPS origin.`);
  }
  return origin;
}

function runtimeConfigError(platform: SupportedPlatform): PlatformRuntimeError | undefined {
  if (config.playwright.headless) {
    return new PlatformRuntimeError(
      platform,
      'browser-runtime-config-conflict',
      'Login-owned browser runtimes require PLAYWRIGHT_HEADLESS=false.',
    );
  }
  return undefined;
}

async function fetchEndpointVersion(platform: SupportedPlatform): Promise<RuntimeEndpointVersion | undefined> {
  try {
    const response = await fetch(`${cdpEndpoint(platform)}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    const value = await response.json() as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as RuntimeEndpointVersion
      : undefined;
  } catch {
    return undefined;
  }
}

async function browserInstanceId(platform: SupportedPlatform): Promise<string> {
  const version = await fetchEndpointVersion(platform);
  const websocketUrl = version?.webSocketDebuggerUrl;
  if (typeof websocketUrl !== 'string') {
    throw new PlatformRuntimeError(platform, 'browser-runtime-unreachable', `${platform} browser runtime CDP endpoint is unreachable.`);
  }
  let browserId: string;
  try {
    const parsed = new URL(websocketUrl);
    const match = parsed.pathname.match(/\/devtools\/browser\/([^/]+)$/);
    if (!match) throw new Error('missing browser id');
    browserId = match[1]!;
  } catch {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser endpoint did not expose a valid browser identity.`);
  }
  return sha256(browserId);
}

async function pageIdentity(context: BrowserContext, page: Page): Promise<RuntimePageIdentity> {
  const session = await context.newCDPSession(page);
  try {
    const response = await session.send('Target.getTargetInfo') as { targetInfo?: CdpTargetInfo };
    const info = response.targetInfo;
    if (!info || typeof info.targetId !== 'string' || !info.targetId) {
      throw new Error('CDP target identity is missing');
    }
    return {
      targetId: info.targetId,
      browserContextId: typeof info.browserContextId === 'string' && info.browserContextId
        ? info.browserContextId
        : 'default',
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function resolveExactPage(
  platform: SupportedPlatform,
  context: BrowserContext,
  descriptor: PlatformBrowserRuntimeManifestV1,
): Promise<Page> {
  const matches: Page[] = [];
  for (const page of context.pages().filter((candidate) => !candidate.isClosed())) {
    const identity = await pageIdentity(context, page).catch(() => undefined);
    if (identity?.targetId === descriptor.workPageTargetId
      && identity.browserContextId === descriptor.browserContextId) {
      matches.push(page);
    }
  }
  if (matches.length === 0) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-missing', `${platform} canonical browser work page is missing.`);
  }
  if (matches.length !== 1) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-ambiguous', `${platform} canonical browser work page identity is ambiguous.`);
  }
  return matches[0]!;
}

async function connectRuntimeBrowser(platform: SupportedPlatform): Promise<Browser> {
  const cached = attachedBrowsers.get(platform);
  if (cached?.isConnected()) return cached;
  attachedBrowsers.delete(platform);
  try {
    const browser = await chromium.connectOverCDP(cdpEndpoint(platform), { timeout: 3000 });
    attachedBrowsers.set(platform, browser);
    browser.once('disconnected', () => {
      if (attachedBrowsers.get(platform) === browser) attachedBrowsers.delete(platform);
    });
    return browser;
  } catch (error) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-unreachable', `${platform} browser runtime is unreachable. Run login:session to refresh it.`, { cause: error });
  }
}

async function assertLiveIdentity(platform: SupportedPlatform, descriptor: PlatformBrowserRuntimeManifestV1): Promise<void> {
  if (await browserInstanceId(platform) !== descriptor.browserInstanceId
    || profileFingerprint(platform) !== descriptor.profilePathFingerprint) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} live browser instance does not match the published runtime.`);
  }
}

async function buildLaunchOptions(): Promise<{ executablePath: string; args: string[]; env?: NodeJS.ProcessEnv }> {
  if (config.browser.engine === 'playwright') {
    return {
      executablePath: chromium.executablePath(),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        '--disable-sync',
      ],
    };
  }
  const options = await buildCloakBrowserLaunchOptions({ headless: false });
  if (typeof options.executablePath !== 'string' || !options.executablePath) {
    throw new Error('CloakBrowser did not resolve a Chromium executable path for the login-owned browser runtime.');
  }
  return {
    executablePath: options.executablePath,
    args: Array.isArray(options.args) ? options.args : [],
    env: typeof options.env === 'object' && options.env
      ? { ...process.env, ...options.env as NodeJS.ProcessEnv }
      : process.env,
  };
}

async function waitForEndpoint(platform: SupportedPlatform, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchEndpointVersion(platform)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new PlatformRuntimeError(platform, 'browser-runtime-unreachable', `${platform} login-owned browser did not publish its CDP endpoint.`);
}

async function waitForEndpointStopped(platform: SupportedPlatform, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpointStopped = !await fetchEndpointVersion(platform);
    const profileLocked = await fs.lstat(path.join(reusableProfilePath(platform), 'SingletonLock'))
      .then(() => true)
      .catch(() => false);
    if (endpointStopped && !profileLocked) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new PlatformRuntimeError(
    platform,
    'browser-runtime-recovery-required',
    `${platform} browser endpoint remained reachable after the confirmed stop command.`,
  );
}

async function requestRuntimeBrowserStop(platform: SupportedPlatform, browser: Browser): Promise<void> {
  const browserSession = await browser.newBrowserCDPSession();
  try {
    await browserSession.send('Browser.close');
  } finally {
    await browserSession.detach().catch(() => undefined);
  }
  await waitForEndpointStopped(platform);
  attachedBrowsers.delete(platform);
}

async function launchRuntimeBrowser(platform: SupportedPlatform): Promise<void> {
  const userDataDir = reusableProfilePath(platform);
  await fs.mkdir(userDataDir, { recursive: true });
  const options = await buildLaunchOptions();
  const child = spawn(options.executablePath, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${config.playwright.reuseCdpPortByPlatform[platform]}`,
    '--remote-debugging-address=127.0.0.1',
    ...options.args,
    'about:blank',
  ], {
    detached: true,
    env: options.env ?? process.env,
    stdio: 'ignore',
  });
  child.unref();
  await waitForEndpoint(platform);
}

function sessionRuntimeFields(input: {
  platform: SupportedPlatform;
  generationId: string;
  targetId?: string;
  lease: PlatformRuntimeLease;
  attempt?: PlatformRuntimeAttemptV1;
  priorManifest?: PlatformBrowserRuntimeManifestV1;
}): Pick<BrowserSession,
  'platform' | 'runtimeGenerationId' | 'workPageTargetId' | 'runtimeLease' | 'runtimeAttempt' | 'runtimePriorManifest'
> {
  return {
    platform: input.platform,
    runtimeGenerationId: input.generationId,
    ...(input.targetId ? { workPageTargetId: input.targetId } : {}),
    runtimeLease: input.lease,
    ...(input.attempt ? { runtimeAttempt: input.attempt } : {}),
    ...(input.priorManifest ? { runtimePriorManifest: input.priorManifest } : {}),
  };
}

export async function openOrRefreshPlatformRuntimeForLogin(platform: SupportedPlatform): Promise<BrowserSession> {
  const configError = runtimeConfigError(platform);
  if (configError) throw configError;
  const store = runtimeStore();
  const persistedInspection = await store.inspect(platform);
  const prior = persistedInspection.executableDescriptor;
  if (persistedInspection.validatedManifest && !prior) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} browser runtime requires explicit recovery before login refresh.`);
  }
  const endpointVersion = await fetchEndpointVersion(platform);
  if (!prior && endpointVersion) {
    throw new PlatformRuntimeError(
      platform,
      'browser-runtime-unpublished-endpoint',
      `${platform} has a live browser without a published runtime manifest. Close it manually before creating a login-owned runtime.`,
    );
  }

  const generationId = prior && endpointVersion ? prior.generationId : randomUUID();
  const lease = await acquirePlatformRuntimeLease(store, platform, generationId, {
    operationId: `login-${randomUUID()}`,
    operationKind: prior ? 'session.login-refresh' : 'session.login-open',
  });
  let attempt = await store.startAttempt(platform, prior ? 'refresh' : 'login', generationId);
  try {
    if (!endpointVersion) await launchRuntimeBrowser(platform);
    const browser = await connectRuntimeBrowser(platform);
    const context = browser.contexts()[0];
    if (!context) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} login-owned browser has no default persistent context.`);
    }
    if (config.browser.engine === 'cloakbrowser') {
      const viewport = buildCloakBrowserContextOptions({}).viewport ?? undefined;
      if (viewport) {
        for (const candidate of context.pages()) await candidate.setViewportSize(viewport).catch(() => undefined);
      }
    }
    let page: Page;
    let targetId: string | undefined;
    if (prior && endpointVersion) {
      await assertLiveIdentity(platform, prior);
      page = await resolveExactPage(platform, context, prior);
      targetId = prior.workPageTargetId;
    } else {
      page = context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage();
    }
    attempt = await store.updateAttempt(attempt, 'verifying');
    const runtimeSession: BrowserSession = {
      browser,
      context,
      page,
      temporaryPages: new Map(),
      ...sessionRuntimeFields({ platform, generationId, targetId, lease, attempt, priorManifest: prior }),
    };
    bindRuntimePageRegistrar(context, (temporaryPage, evidence) =>
      registerTemporaryRuntimePage(runtimeSession, temporaryPage, evidence));
    return runtimeSession;
  } catch (error) {
    await store.updateAttempt(
      attempt,
      error instanceof PlatformRuntimeError && error.code === 'browser-runtime-recovery-required' ? 'recovery_required' : 'failed',
      error instanceof PlatformRuntimeError ? error.code : 'browser-runtime-recovery-required',
    ).catch(() => undefined);
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function publishPlatformRuntimeFromLogin(
  session: BrowserSession,
  platform: SupportedPlatform,
): Promise<PlatformBrowserRuntimeManifestV1> {
  if (!session.runtimeLease || !session.runtimeGenerationId || !session.runtimeAttempt) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} login session does not own a runtime publication lease.`);
  }
  const store = runtimeStore();
  await session.runtimeLease.assertOwned();
  const identity = await pageIdentity(session.context, session.page);
  const now = new Date().toISOString();
  const current = (await store.inspect(platform)).executableDescriptor;
  if (session.runtimePriorManifest) {
    if (!current
      || current.generationId !== session.runtimePriorManifest.generationId
      || current.revision !== session.runtimePriorManifest.revision) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} canonical runtime changed during login refresh.`);
    }
  } else if (current) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} canonical runtime appeared during login publication.`);
  }
  const manifest: PlatformBrowserRuntimeManifestV1 = {
    version: 1,
    platform,
    generationId: session.runtimeGenerationId,
    revision: current?.generationId === session.runtimeGenerationId ? current.revision + 1 : 1,
    browserInstanceId: await browserInstanceId(platform),
    browserContextId: identity.browserContextId,
    cdpPort: config.playwright.reuseCdpPortByPlatform[platform],
    profilePathFingerprint: profileFingerprint(platform),
    workPageTargetId: identity.targetId,
    authenticatedOrigin: originForPage(platform, session.page),
    authenticatedAt: now,
    storageStatePersistedAt: now,
    publishedAt: now,
    health: 'ready',
  };
  const published = await store.publishManifest(manifest, current?.generationId === session.runtimeGenerationId
    ? { expectedGenerationId: current.generationId, expectedRevision: current.revision }
    : {});
  await assertLiveIdentity(platform, published);
  await resolveExactPage(platform, session.context, published);
  session.workPageTargetId = published.workPageTargetId;
  session.runtimeAttempt = await store.updateAttempt(session.runtimeAttempt, 'completed');
  return published;
}

export async function attachPlatformRuntime(
  platform: SupportedPlatform,
  operation: PlatformRuntimeOperationIdentity = {
    operationId: `operation-${randomUUID()}`,
    operationKind: 'browser-operation',
  },
): Promise<BrowserSession> {
  const configError = runtimeConfigError(platform);
  if (configError) throw configError;
  const store = runtimeStore();
  const descriptor = await store.requireExecutable(platform);
  const lease = await acquirePlatformRuntimeLease(store, platform, descriptor.generationId, operation);
  try {
    const current = await store.requireExecutable(platform);
    if (current.generationId !== descriptor.generationId || current.revision !== descriptor.revision) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser runtime changed while acquiring its lease.`);
    }
    await assertLiveIdentity(platform, current);
    const browser = await connectRuntimeBrowser(platform);
    const contexts = browser.contexts();
    const candidates: Array<{ context: BrowserContext; page: Page }> = [];
    for (const context of contexts) {
      const page = await resolveExactPage(platform, context, current).catch((error) => {
        if (error instanceof PlatformRuntimeError && error.code === 'browser-runtime-work-page-missing') return undefined;
        throw error;
      });
      if (page) candidates.push({ context, page });
    }
    if (candidates.length === 0) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-missing', `${platform} canonical work page is missing.`);
    }
    if (candidates.length !== 1) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-ambiguous', `${platform} canonical work page is ambiguous across contexts.`);
    }
    const { context, page } = candidates[0]!;
    const liveOrigin = originForPage(platform, page);
    if (liveOrigin !== current.authenticatedOrigin) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-auth-required', `${platform} canonical work page left its authenticated origin.`);
    }
    await getPlatformAdapter(platform).openAuthenticatedHome(page);
    await lease.assertOwned();
    const identity = await pageIdentity(context, page);
    if (identity.targetId !== current.workPageTargetId || identity.browserContextId !== current.browserContextId) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} work page identity changed during authentication verification.`);
    }
    const runtimeSession: BrowserSession = {
      browser,
      context,
      page,
      temporaryPages: new Map(),
      ...sessionRuntimeFields({
        platform,
        generationId: current.generationId,
        targetId: current.workPageTargetId,
        lease,
      }),
    };
    bindRuntimePageRegistrar(context, (temporaryPage, evidence) =>
      registerTemporaryRuntimePage(runtimeSession, temporaryPage, evidence));
    return runtimeSession;
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export function registerTemporaryRuntimePage(
  session: BrowserSession,
  page: Page,
  evidence: RuntimeTemporaryPageEvidence,
): void {
  if (!session.runtimeLease) throw new Error('A platform runtime lease is required before registering a temporary page.');
  session.temporaryPages ??= new Map();
  session.temporaryPages.set(page, evidence);
  page.once('close', () => session.temporaryPages?.delete(page));
}

export async function handoffPlatformWorkPage(
  session: BrowserSession,
  expectedOldPage: Page,
  verifiedNewPage: Page,
): Promise<void> {
  const platform = session.platform;
  if (!platform || !session.runtimeLease || !session.runtimeGenerationId || !session.workPageTargetId) {
    throw new PlatformRuntimeError(platform ?? '51job', 'browser-runtime-handoff-uncertain', 'Browser runtime handoff requires an owned canonical session.');
  }
  registerTemporaryRuntimePage(session, verifiedNewPage, {
    purpose: 'work-page-handoff',
    identity: 'pending-verification',
    cleanupPolicy: 'close',
  });
  const store = runtimeStore();
  await session.runtimeLease.assertOwned();
  const current = await store.requireExecutable(platform);
  if (session.page !== expectedOldPage
    || current.generationId !== session.runtimeGenerationId
    || current.workPageTargetId !== session.workPageTargetId) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} canonical work page changed before handoff.`);
  }
  const oldIdentity = await pageIdentity(session.context, expectedOldPage);
  if (oldIdentity.targetId !== current.workPageTargetId) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} old work page identity no longer matches the manifest.`);
  }
  const newIdentity = await pageIdentity(session.context, verifiedNewPage);
  if (originForPage(platform, verifiedNewPage) !== current.authenticatedOrigin) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-handoff-uncertain', `${platform} new work page has not been verified on the authenticated origin.`);
  }
  const published = await store.publishManifest({
    ...current,
    revision: current.revision + 1,
    workPageTargetId: newIdentity.targetId,
    browserContextId: newIdentity.browserContextId,
    publishedAt: new Date().toISOString(),
    health: 'ready',
    healthIssueCode: undefined,
  }, { expectedGenerationId: current.generationId, expectedRevision: current.revision });
  await session.runtimeLease.assertOwned();
  const resolved = await resolveExactPage(platform, session.context, published).catch((error) => {
    throw new PlatformRuntimeError(platform, 'browser-runtime-handoff-uncertain', `${platform} new work page failed post-publication verification.`, { cause: error });
  });
  session.page = resolved;
  session.workPageTargetId = published.workPageTargetId;
  session.temporaryPages?.delete(verifiedNewPage);
  if (expectedOldPage !== verifiedNewPage && !expectedOldPage.isClosed()) {
    registerTemporaryRuntimePage(session, expectedOldPage, {
      purpose: 'prior-work-page-cleanup',
      identity: current.workPageTargetId,
      cleanupPolicy: 'close',
    });
    await expectedOldPage.close().catch(() => undefined);
  }
}

export async function releasePlatformRuntime(session: BrowserSession): Promise<void> {
  const platform = session.platform;
  if (!platform || !session.runtimeLease || !session.runtimeGenerationId) return;
  const store = runtimeStore();
  if (session.runtimeAttempt && session.runtimeAttempt.state !== 'completed') {
    let releaseError: unknown;
    try {
      await session.runtimeLease.assertOwned();
      await requestRuntimeBrowserStop(platform, session.browser);
      await store.updateAttempt(
        session.runtimeAttempt,
        'failed',
        'browser-runtime-auth-required',
      );
    } catch (error) {
      releaseError = error;
      await store.updateAttempt(
        session.runtimeAttempt,
        'recovery_required',
        error instanceof PlatformRuntimeError ? error.code : 'browser-runtime-recovery-required',
      ).catch(() => undefined);
    } finally {
      try {
        await session.runtimeLease.release();
      } catch (error) {
        releaseError ??= error;
      }
      session.runtimeLease = undefined;
      unbindRuntimePageRegistrar(session.context);
    }
    if (releaseError) throw releaseError;
    return;
  }
  if (!session.workPageTargetId) {
    try {
      await session.runtimeLease.release();
    } finally {
      session.runtimeLease = undefined;
      unbindRuntimePageRegistrar(session.context);
    }
    throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-missing', `${platform} runtime session has no canonical work-page identity.`);
  }
  let releaseError: unknown;
  try {
    await session.runtimeLease.assertOwned();
    const manifest = await store.requireExecutable(platform);
    if (manifest.generationId !== session.runtimeGenerationId || manifest.workPageTargetId !== session.workPageTargetId) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} runtime changed before release.`);
    }
    const retained = [...(session.temporaryPages?.entries() ?? [])]
      .filter(([page, evidence]) => !page.isClosed() && evidence.cleanupPolicy === 'retain-for-inspection');
    const leaked = [...(session.temporaryPages?.entries() ?? [])]
      .filter(([page, evidence]) => !page.isClosed() && evidence.cleanupPolicy === 'close');
    if (retained.length > 0 || leaked.length > 0) {
      await store.publishManifest({
        ...manifest,
        revision: manifest.revision + 1,
        health: 'recovery_required',
        healthIssueCode: 'browser-runtime-recovery-required',
        publishedAt: new Date().toISOString(),
      }, { expectedGenerationId: manifest.generationId, expectedRevision: manifest.revision });
      throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} runtime still owns unclean temporary pages.`);
    }
    const identity = await pageIdentity(session.context, session.page);
    if (identity.targetId !== manifest.workPageTargetId || session.page.isClosed()) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-work-page-missing', `${platform} canonical work page was closed before release.`);
    }
    try {
      await session.context.storageState({ path: resolveStorageStatePath(platform) });
    } catch (error) {
      await store.publishManifest({
        ...manifest,
        revision: manifest.revision + 1,
        health: 'degraded',
        healthIssueCode: 'browser-runtime-degraded',
        publishedAt: new Date().toISOString(),
      }, { expectedGenerationId: manifest.generationId, expectedRevision: manifest.revision }).catch(() => undefined);
      console.warn(`${platform} browser runtime storage-state backup failed; the runtime lease will still be released: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    releaseError = error;
  }
  try {
    await session.runtimeLease.release();
  } catch (error) {
    releaseError ??= error;
  }
  session.runtimeLease = undefined;
  unbindRuntimePageRegistrar(session.context);
  if (releaseError) throw releaseError;
}

export async function inspectPlatformRuntimeStatus(
  platform: SupportedPlatform,
  options: { dataDir?: string } = {},
): Promise<PlatformRuntimeSafeView> {
  const store = runtimeStore(options.dataDir);
  const inspection = await store.inspect(platform);
  const [lease, attempt, endpointVersion] = await Promise.all([
    readPlatformRuntimeLease(store, platform),
    store.readLatestAttempt(platform),
    fetchEndpointVersion(platform),
  ]);
  const reachable = !!endpointVersion;
  if (lease !== 'invalid' && lease && !platformRuntimeLeaseOwnerExists(lease)) {
    return {
      ...inspection.safeView,
      status: 'recovery_required',
      endpointReachable: reachable,
      issueCodes: ['browser-runtime-recovery-required'],
    };
  }
  if (inspection.safeView.status === 'absent'
    && lease !== 'invalid'
    && lease
    && attempt
    && attempt.generationId === lease.generationId
    && (attempt.state === 'starting' || attempt.state === 'verifying')) {
    return {
      platform,
      status: attempt.state === 'starting' ? 'starting' : 'login_required',
      issueCodes: attempt.state === 'starting' ? [] : ['browser-runtime-auth-required'],
      ...(attempt.generationId ? { generationFingerprint: attempt.generationId.slice(0, 8) } : {}),
      endpointReachable: reachable,
      occupiedBy: {
        operationId: lease.operationId,
        operationKind: lease.operationKind,
        acquiredAt: lease.acquiredAt,
      },
    };
  }
  if (inspection.safeView.status === 'absent'
    && (lease === 'invalid' || attempt?.state === 'recovery_required')) {
    return {
      ...inspection.safeView,
      status: 'recovery_required',
      endpointReachable: reachable,
      issueCodes: [attempt?.issueCode ?? 'browser-runtime-recovery-required'],
    };
  }
  if (inspection.safeView.status === 'absent' && reachable) {
    return {
      ...inspection.safeView,
      status: 'recovery_required',
      endpointReachable: true,
      issueCodes: ['browser-runtime-unpublished-endpoint'],
    };
  }
  if (inspection.safeView.status === 'published' || inspection.safeView.status === 'degraded') {
    if (!reachable) {
      return {
        ...inspection.safeView,
        status: 'unreachable',
        endpointReachable: false,
        issueCodes: ['browser-runtime-unreachable'],
      };
    }
    if (lease === 'invalid') {
      return {
        ...inspection.safeView,
        status: 'recovery_required',
        endpointReachable: true,
        issueCodes: ['browser-runtime-recovery-required'],
      };
    }
    if (lease) {
      return {
        ...inspection.safeView,
        status: 'busy',
        endpointReachable: true,
        issueCodes: ['browser-runtime-busy'],
        occupiedBy: {
          operationId: lease.operationId,
          operationKind: lease.operationKind,
          acquiredAt: lease.acquiredAt,
        },
      };
    }
  }
  return { ...inspection.safeView, endpointReachable: reachable };
}

export async function inspectAllPlatformRuntimeStatuses(
  options: { dataDir?: string } = {},
): Promise<PlatformRuntimeSafeView[]> {
  const platforms: SupportedPlatform[] = ['51job', 'liepin', 'zhilian', 'boss'];
  return Promise.all(platforms.map((platform) => inspectPlatformRuntimeStatus(platform, options)));
}

export async function preflightPlatformRuntimeManifests(
  platforms: readonly SupportedPlatform[],
): Promise<void> {
  const store = runtimeStore();
  const failures: string[] = [];
  for (const platform of platforms) {
    const inspection = await store.inspect(platform);
    if (!inspection.executableDescriptor) {
      failures.push(`${platform}:${inspection.issues[0] ?? 'browser-runtime-manifest-invalid'}`);
    }
  }
  if (failures.length > 0) {
    throw new PlatformRuntimeError(
      platforms[0] ?? '51job',
      failures.some((failure) => failure.endsWith('browser-runtime-missing'))
        ? 'browser-runtime-missing'
        : 'browser-runtime-recovery-required',
      `Browser runtime preflight failed before platform work: ${failures.join(', ')}. Run login:session for each affected platform.`,
    );
  }
}

export async function stopPlatformRuntime(
  platform: SupportedPlatform,
  confirmation: { confirmed: true; observedGenerationId: string },
): Promise<void> {
  const store = runtimeStore();
  const manifest = await store.requireValid(platform);
  const observedGenerationMatches = manifest.generationId === confirmation.observedGenerationId
    || (/^[0-9a-f]{8}$/i.test(confirmation.observedGenerationId)
      && manifest.generationId.startsWith(confirmation.observedGenerationId));
  if (!observedGenerationMatches) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser runtime changed before stop.`);
  }
  const existingLease = await readPlatformRuntimeLease(store, platform);
  if (existingLease === 'invalid') {
    throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} browser runtime lease evidence is incomplete.`);
  }
  if (existingLease) {
    await quarantinePlatformRuntimeLease(store, platform, {
      confirmed: true,
      observedGenerationId: manifest.generationId,
    });
  }
  const lease = await acquirePlatformRuntimeLease(store, platform, manifest.generationId, {
    operationId: `stop-${randomUUID()}`,
    operationKind: 'runtime.stop',
  });
  let attempt = await store.startAttempt(platform, 'stop', manifest.generationId);
  try {
    attempt = await store.updateAttempt(attempt, 'verifying');
    await assertLiveIdentity(platform, manifest);
    const browser = await connectRuntimeBrowser(platform);
    await lease.assertOwned();
    await requestRuntimeBrowserStop(platform, browser);
    await store.quarantineManifest(platform, manifest.generationId, manifest.revision, 'stop');
    attempt = await store.updateAttempt(attempt, 'completed');
  } catch (error) {
    await store.updateAttempt(
      attempt,
      'recovery_required',
      error instanceof PlatformRuntimeError ? error.code : 'browser-runtime-recovery-required',
    ).catch(() => undefined);
    throw error;
  } finally {
    await lease.release();
  }
  await store.pruneResolvedAttempts(platform);
}

export async function recoverPlatformRuntime(
  platform: SupportedPlatform,
  confirmation: { confirmed: true; observedGenerationId: string },
): Promise<void> {
  const store = runtimeStore();
  const manifest = await store.requireValid(platform);
  const observedGenerationMatches = manifest.generationId === confirmation.observedGenerationId
    || (/^[0-9a-f]{8}$/i.test(confirmation.observedGenerationId)
      && manifest.generationId.startsWith(confirmation.observedGenerationId));
  if (!observedGenerationMatches) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser runtime changed before recovery.`);
  }
  if (await fetchEndpointVersion(platform)) {
    throw new PlatformRuntimeError(platform, 'browser-runtime-recovery-required', `${platform} browser is still reachable; stop it explicitly before quarantining its manifest.`);
  }
  let attempt = await store.startAttempt(platform, 'recover', manifest.generationId);
  try {
    attempt = await store.updateAttempt(attempt, 'verifying');
    await quarantinePlatformRuntimeLease(store, platform, {
      confirmed: true,
      observedGenerationId: manifest.generationId,
    });
    await store.quarantineManifest(platform, manifest.generationId, manifest.revision, 'recover');
    attempt = await store.updateAttempt(attempt, 'completed');
    await store.pruneResolvedAttempts(platform);
  } catch (error) {
    await store.updateAttempt(
      attempt,
      'recovery_required',
      error instanceof PlatformRuntimeError ? error.code : 'browser-runtime-recovery-required',
    ).catch(() => undefined);
    throw error;
  }
}
