import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  inspectPlatformRuntime,
  platformRuntimeIssueCodes,
  PlatformRuntimeError,
  type PlatformBrowserRuntimeManifestV1,
  type PlatformRuntimeInspection,
  type PlatformRuntimeIssueCode,
} from './platform-runtime-inspector.js';

export type PlatformRuntimeAttemptKind = 'login' | 'refresh' | 'handoff' | 'stop' | 'recover';
export type PlatformRuntimeAttemptState = 'starting' | 'verifying' | 'completed' | 'failed' | 'recovery_required';

export type PlatformRuntimeAttemptV1 = {
  version: 1;
  attemptId: string;
  platform: SupportedPlatform;
  kind: PlatformRuntimeAttemptKind;
  state: PlatformRuntimeAttemptState;
  generationId?: string;
  issueCode?: PlatformRuntimeIssueCode;
  startedAt: string;
  updatedAt: string;
};

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class PlatformRuntimeStore {
  readonly dataDir: string;

  constructor(options: { dataDir: string }) {
    this.dataDir = options.dataDir;
  }

  runtimeDir(platform: SupportedPlatform): string {
    return path.join(this.dataDir, platform, 'runtime');
  }

  manifestPath(platform: SupportedPlatform): string {
    return path.join(this.runtimeDir(platform), 'browser-runtime.json');
  }

  leaseDir(platform: SupportedPlatform): string {
    return path.join(this.runtimeDir(platform), 'browser-lease');
  }

  attemptsDir(platform: SupportedPlatform): string {
    return path.join(this.runtimeDir(platform), 'browser-attempts');
  }

  quarantineDir(platform: SupportedPlatform): string {
    return path.join(this.runtimeDir(platform), 'quarantine');
  }

  async readRawManifest(platform: SupportedPlatform): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.manifestPath(platform), 'utf8')) as unknown;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      if (error instanceof SyntaxError) return { invalidJson: true };
      throw error;
    }
  }

  async inspect(platform: SupportedPlatform): Promise<PlatformRuntimeInspection> {
    return inspectPlatformRuntime(platform, await this.readRawManifest(platform));
  }

  async requireExecutable(platform: SupportedPlatform): Promise<PlatformBrowserRuntimeManifestV1> {
    const inspection = await this.inspect(platform);
    if (!inspection.executableDescriptor) {
      const code = inspection.issues[0] ?? 'browser-runtime-manifest-invalid';
      throw new PlatformRuntimeError(platform, code, `${platform} browser runtime is not executable (${code}).`);
    }
    return inspection.executableDescriptor;
  }

  async requireValid(platform: SupportedPlatform): Promise<PlatformBrowserRuntimeManifestV1> {
    const inspection = await this.inspect(platform);
    if (!inspection.validatedManifest) {
      const code = inspection.issues[0] ?? 'browser-runtime-manifest-invalid';
      throw new PlatformRuntimeError(platform, code, `${platform} browser runtime manifest is not valid (${code}).`);
    }
    return inspection.validatedManifest;
  }

  async publishManifest(
    manifest: PlatformBrowserRuntimeManifestV1,
    options: { expectedGenerationId?: string; expectedRevision?: number } = {},
  ): Promise<PlatformBrowserRuntimeManifestV1> {
    const inspectedCandidate = inspectPlatformRuntime(manifest.platform, manifest);
    if (!inspectedCandidate.validatedManifest) {
      throw new PlatformRuntimeError(
        manifest.platform,
        'browser-runtime-manifest-invalid',
        `${manifest.platform} pending browser runtime manifest is invalid.`,
      );
    }

    const current = await this.inspect(manifest.platform);
    if (options.expectedGenerationId !== undefined) {
      const descriptor = current.executableDescriptor;
      if (!descriptor
        || descriptor.generationId !== options.expectedGenerationId
        || descriptor.revision !== options.expectedRevision) {
        throw new PlatformRuntimeError(
          manifest.platform,
          'browser-runtime-generation-mismatch',
          `${manifest.platform} browser runtime changed before publication.`,
        );
      }
    }

    await writeJsonAtomically(this.manifestPath(manifest.platform), inspectedCandidate.validatedManifest);
    const reread = await this.requireValid(manifest.platform);
    if (JSON.stringify(reread) !== JSON.stringify(inspectedCandidate.validatedManifest)) {
      throw new PlatformRuntimeError(
        manifest.platform,
        'browser-runtime-manifest-invalid',
        `${manifest.platform} browser runtime manifest failed publication verification.`,
      );
    }
    return reread;
  }

  async writeAttempt(attempt: PlatformRuntimeAttemptV1): Promise<void> {
    const filePath = path.join(this.attemptsDir(attempt.platform), `${attempt.startedAt.replace(/[:.]/g, '-')}-${attempt.attemptId}.json`);
    await writeJsonAtomically(filePath, attempt);
  }

  async readLatestAttempt(platform: SupportedPlatform): Promise<PlatformRuntimeAttemptV1 | undefined> {
    let names: string[];
    try {
      names = await fs.readdir(this.attemptsDir(platform));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
    const attempts: PlatformRuntimeAttemptV1[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.attemptsDir(platform), name), 'utf8')) as PlatformRuntimeAttemptV1;
        if (parsed.version === 1
          && parsed.platform === platform
          && typeof parsed.attemptId === 'string'
          && parsed.attemptId.length > 0
          && parsed.attemptId.length <= 128
          && ['login', 'refresh', 'handoff', 'stop', 'recover'].includes(parsed.kind)
          && ['starting', 'verifying', 'completed', 'failed', 'recovery_required'].includes(parsed.state)
          && (parsed.generationId === undefined
            || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.generationId))
          && (parsed.issueCode === undefined || platformRuntimeIssueCodes.includes(parsed.issueCode))
          && Number.isFinite(Date.parse(parsed.startedAt))
          && new Date(parsed.startedAt).toISOString() === parsed.startedAt
          && Number.isFinite(Date.parse(parsed.updatedAt))
          && new Date(parsed.updatedAt).toISOString() === parsed.updatedAt) {
          attempts.push(parsed);
        }
      } catch {
        // Malformed evidence remains on disk but is never projected as state.
      }
    }
    return attempts.sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || right.attemptId.localeCompare(left.attemptId))[0];
  }

  async startAttempt(platform: SupportedPlatform, kind: PlatformRuntimeAttemptKind, generationId?: string): Promise<PlatformRuntimeAttemptV1> {
    const now = new Date().toISOString();
    const attempt: PlatformRuntimeAttemptV1 = {
      version: 1,
      attemptId: randomUUID(),
      platform,
      kind,
      state: 'starting',
      ...(generationId ? { generationId } : {}),
      startedAt: now,
      updatedAt: now,
    };
    await this.writeAttempt(attempt);
    return attempt;
  }

  async updateAttempt(
    attempt: PlatformRuntimeAttemptV1,
    state: PlatformRuntimeAttemptState,
    issueCode?: PlatformRuntimeIssueCode,
  ): Promise<PlatformRuntimeAttemptV1> {
    const updated: PlatformRuntimeAttemptV1 = {
      ...attempt,
      state,
      ...(issueCode ? { issueCode } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.writeAttempt(updated);
    return updated;
  }

  async pruneResolvedAttempts(
    platform: SupportedPlatform,
    options: { now?: Date; maxEntries?: number; maxAgeDays?: number } = {},
  ): Promise<void> {
    const maxEntries = options.maxEntries ?? 100;
    const maxAgeMs = (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
    const nowMs = (options.now ?? new Date()).getTime();
    let names: string[];
    try {
      names = await fs.readdir(this.attemptsDir(platform));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const resolved: Array<{ name: string; updatedAtMs: number }> = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.attemptsDir(platform), name), 'utf8')) as PlatformRuntimeAttemptV1;
        if ((parsed.state === 'completed' || parsed.state === 'failed')
          && typeof parsed.updatedAt === 'string'
          && Number.isFinite(Date.parse(parsed.updatedAt))) {
          resolved.push({ name, updatedAtMs: Date.parse(parsed.updatedAt) });
        }
      } catch {
        // Malformed or unresolved evidence is retained for explicit inspection.
      }
    }
    resolved.sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.name.localeCompare(right.name));
    const removals = resolved.filter((attempt, index) => index >= maxEntries || nowMs - attempt.updatedAtMs > maxAgeMs);
    await Promise.all(removals.map((attempt) =>
      fs.rm(path.join(this.attemptsDir(platform), attempt.name), { force: true }),
    ));
  }

  async quarantineManifest(
    platform: SupportedPlatform,
    expectedGenerationId: string,
    expectedRevision: number,
    reason: 'stop' | 'recover',
  ): Promise<string> {
    const current = await this.requireValid(platform);
    if (current.generationId !== expectedGenerationId || current.revision !== expectedRevision) {
      throw new PlatformRuntimeError(platform, 'browser-runtime-generation-mismatch', `${platform} browser runtime changed before quarantine.`);
    }
    await fs.mkdir(this.quarantineDir(platform), { recursive: true });
    const destination = path.join(
      this.quarantineDir(platform),
      `browser-runtime-${reason}-${expectedGenerationId.slice(0, 8)}-${Date.now()}-${randomUUID()}.json`,
    );
    await fs.rename(this.manifestPath(platform), destination);
    return destination;
  }
}
