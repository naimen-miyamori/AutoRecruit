import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { JobRecord, PlatformJobIdentity } from '../types/job.js';
import { assertPlatformJobIdentity } from './job-identity.js';
import { JobStore } from './job-store.js';
import { buildJobKey } from '../parsers/jd-parser.js';

const PLATFORM_ORDER: readonly SupportedPlatform[] = ['51job', 'liepin', 'zhilian', 'boss'];
const MANIFEST_ID_PATTERN = /^job-identity-[a-f0-9]{64}$/;

export interface JobIdentityMigrationTarget {
  platform: SupportedPlatform;
  jobKey: string;
  expectedJobName: string;
  nameAuthority: PlatformJobIdentity['nameAuthority'];
  nativePositionId?: string;
}

export interface JobIdentityMigrationIntentItem {
  platform: SupportedPlatform;
  jobKey: string;
  sourceRevision: number;
  sourceRecordHash: string;
  patch: { jobIdentity: PlatformJobIdentity };
  patchHash: string;
}

export interface JobIdentityMigrationItemState {
  status: 'pending' | 'committed' | 'already-applied' | 'conflicted';
  evidence?: {
    resultingRevision: number;
    resultingRecordHash: string;
    verifiedAt: string;
  };
  issue?: string;
}

export interface JobIdentityMigrationManifest {
  version: 1;
  manifestId: string;
  planHash: string;
  preparedAt: string;
  intent: {
    items: JobIdentityMigrationIntentItem[];
  };
  journal: {
    revision: number;
    status: 'prepared' | 'partially-committed' | 'committed' | 'conflicted';
    items: JobIdentityMigrationItemState[];
    finalCommit?: {
      committedAt: string;
      verifiedPlanHash: string;
    };
  };
}

export interface JobIdentityMigrationPreview {
  version: 1;
  manifestId: string;
  planHash: string;
  executable: boolean;
  issues: string[];
  items: JobIdentityMigrationIntentItem[];
  activeTaskReferences: JobIdentityMigrationTaskReference[];
}

export interface JobIdentityMigrationTaskReference {
  taskId: string;
  status: 'queued' | 'running';
  kind: string;
  references: Array<{ platform: SupportedPlatform; jobKey: string }>;
  unresolvedBatchReference?: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function hashSemantic(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeText(value: string, label: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}

function normalizeTarget(target: JobIdentityMigrationTarget): JobIdentityMigrationTarget {
  if (!PLATFORM_ORDER.includes(target.platform)) throw new Error(`Unsupported migration platform ${target.platform}.`);
  return {
    platform: target.platform,
    jobKey: normalizeText(target.jobKey, 'jobKey'),
    expectedJobName: normalizeText(target.expectedJobName, 'expectedJobName'),
    nameAuthority: target.nameAuthority,
    ...(target.nativePositionId === undefined
      ? {}
      : { nativePositionId: normalizeText(target.nativePositionId, 'nativePositionId') }),
  };
}

function compareTargets(left: JobIdentityMigrationTarget, right: JobIdentityMigrationTarget): number {
  const platformOrder = PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform);
  return platformOrder || left.jobKey.localeCompare(right.jobKey, 'zh-CN');
}

function recordHash(record: JobRecord): string {
  return hashSemantic(record);
}

function planHashFor(items: readonly JobIdentityMigrationIntentItem[]): string {
  return hashSemantic({ version: 1, items });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash.`);
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class JobIdentityMigrationService {
  private readonly dataDir: string;
  private readonly store: JobStore;
  private readonly now: () => Date;
  private readonly taskDir: string;

  constructor(options: { dataDir?: string; store?: JobStore; now?: () => Date; taskDir?: string } = {}) {
    this.dataDir = path.resolve(options.dataDir ?? config.dataDir);
    this.store = options.store ?? new JobStore(this.dataDir);
    this.now = options.now ?? (() => new Date());
    this.taskDir = path.resolve(options.taskDir ?? path.join(this.dataDir, 'runtime', 'tasks'));
  }

  private async scanActiveTaskReferences(
    targets: readonly Pick<JobIdentityMigrationTarget, 'platform' | 'jobKey'>[],
  ): Promise<JobIdentityMigrationTaskReference[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.taskDir)).filter((file) => file.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const targetKeys = new Set(targets.map((target) => `${target.platform}\u0000${target.jobKey}`));
    const references: JobIdentityMigrationTaskReference[] = [];
    for (const file of files) {
      const raw = JSON.parse(await fs.readFile(path.join(this.taskDir, file), 'utf8')) as unknown;
      if (!isRecord(raw) || (raw.status !== 'queued' && raw.status !== 'running')) continue;
      const taskId = typeof raw.taskId === 'string' ? raw.taskId : file.slice(0, -5);
      const kind = typeof raw.kind === 'string' ? raw.kind : '<invalid>';
      const input = isRecord(raw.input) ? raw.input : {};
      const found: Array<{ platform: SupportedPlatform; jobKey: string }> = [];
      const snapshot = isRecord(input.bossCaptureTaskSnapshot) ? input.bossCaptureTaskSnapshot : undefined;
      if (snapshot && typeof snapshot.sourceJobKey === 'string'
        && targetKeys.has(`boss\u0000${snapshot.sourceJobKey}`)) {
        found.push({ platform: 'boss', jobKey: snapshot.sourceJobKey });
      }
      const keyword = typeof input.keyword === 'string' ? buildJobKey(input.keyword, '') : undefined;
      const selectedPlatform = input.platform;
      if (keyword) {
        for (const platform of ['51job', 'liepin', 'zhilian'] as const) {
          if ((selectedPlatform === platform || selectedPlatform === 'all')
            && targetKeys.has(`${platform}\u0000${keyword}`)) {
            found.push({ platform, jobKey: keyword });
          }
        }
      }
      const unresolvedBatchReference = kind === 'batch' || typeof input.jobsFile === 'string';
      if (found.length > 0 || unresolvedBatchReference) {
        references.push({
          taskId,
          status: raw.status,
          kind,
          references: found,
          ...(unresolvedBatchReference ? { unresolvedBatchReference: true } : {}),
        });
      }
    }
    return references;
  }

  manifestPath(manifestId: string): string {
    if (!MANIFEST_ID_PATTERN.test(manifestId)) throw new Error('Invalid job identity migration manifest ID.');
    return path.join(this.dataDir, 'maintenance', 'job-identity-migrations', `${manifestId}.json`);
  }

  async preview(targets: readonly JobIdentityMigrationTarget[]): Promise<JobIdentityMigrationPreview> {
    if (targets.length === 0) throw new Error('Job identity migration requires at least one target.');
    const normalizedTargets = targets.map(normalizeTarget).sort(compareTargets);
    const duplicateKeys = normalizedTargets
      .map((target) => `${target.platform}\u0000${target.jobKey}`)
      .filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateKeys.length > 0) throw new Error('Job identity migration contains duplicate platform/jobKey targets.');

    const items: JobIdentityMigrationIntentItem[] = [];
    const issues: string[] = [];
    for (const target of normalizedTargets) {
      let record: JobRecord;
      try {
        record = await this.store.readJobRecord(target.platform, target.jobKey);
      } catch (error) {
        issues.push(`${target.platform}/${target.jobKey}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const identity = assertPlatformJobIdentity({
        version: 1,
        expectedJobName: target.expectedJobName,
        nameAuthority: target.nameAuthority,
        ...(target.nativePositionId ? { nativePositionId: target.nativePositionId } : {}),
      }, {
        platform: target.platform,
        bossPositionId: record.bossPosition?.bossJobId,
        label: `${target.platform}/${target.jobKey} migration identity`,
      });
      if (!identity) throw new Error(`${target.platform}/${target.jobKey} migration identity is missing.`);
      if (record.jobIdentity && !isDeepStrictEqual(record.jobIdentity, identity)) {
        issues.push(`${target.platform}/${target.jobKey}: existing jobIdentity conflicts with the requested backfill.`);
      }
      const patch = { jobIdentity: identity };
      items.push({
        platform: target.platform,
        jobKey: target.jobKey,
        sourceRevision: record.revision ?? 1,
        sourceRecordHash: recordHash(record),
        patch,
        patchHash: hashSemantic(patch),
      });
    }

    const planHash = planHashFor(items);
    const activeTaskReferences = await this.scanActiveTaskReferences(normalizedTargets);
    if (activeTaskReferences.length > 0) {
      issues.push(`Active queued/running tasks reference migration targets: ${activeTaskReferences.map((item) => item.taskId).join(', ')}.`);
    }
    return {
      version: 1,
      manifestId: `job-identity-${planHash}`,
      planHash,
      executable: issues.length === 0 && items.length === normalizedTargets.length,
      issues,
      items,
      activeTaskReferences,
    };
  }

  async prepare(
    targets: readonly JobIdentityMigrationTarget[],
    confirmationHash: string,
  ): Promise<JobIdentityMigrationManifest> {
    const preview = await this.preview(targets);
    if (confirmationHash !== preview.planHash) {
      throw new Error('Job identity migration confirmation hash does not match the current preview.');
    }
    if (!preview.executable) {
      throw new Error(`Job identity migration preview is not executable: ${preview.issues.join('; ')}`);
    }

    const filePath = this.manifestPath(preview.manifestId);
    try {
      const existing = await this.readManifest(preview.manifestId);
      if (existing.planHash !== preview.planHash || !isDeepStrictEqual(existing.intent.items, preview.items)) {
        throw new Error(`Job identity migration manifest ${preview.manifestId} conflicts with its existing immutable intent.`);
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const manifest: JobIdentityMigrationManifest = {
      version: 1,
      manifestId: preview.manifestId,
      planHash: preview.planHash,
      preparedAt: this.now().toISOString(),
      intent: { items: preview.items },
      journal: {
        revision: 1,
        status: 'prepared',
        items: await Promise.all(preview.items.map(async (item): Promise<JobIdentityMigrationItemState> => {
          const current = await this.store.readJobRecord(item.platform, item.jobKey);
          return {
            status: isDeepStrictEqual(current.jobIdentity, item.patch.jobIdentity) ? 'already-applied' : 'pending',
          };
        })),
      },
    };
    await writeJsonAtomically(filePath, manifest);
    return manifest;
  }

  async readManifest(manifestId: string): Promise<JobIdentityMigrationManifest> {
    const raw = JSON.parse(await fs.readFile(this.manifestPath(manifestId), 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || raw.manifestId !== manifestId) {
      throw new Error('Job identity migration manifest shape or identity is invalid.');
    }
    assertHash(raw.planHash, 'manifest.planHash');
    if (!isRecord(raw.intent) || !Array.isArray(raw.intent.items) || raw.intent.items.length === 0) {
      throw new Error('Job identity migration manifest intent is invalid.');
    }
    if (!isRecord(raw.journal) || !Array.isArray(raw.journal.items)
      || raw.journal.items.length !== raw.intent.items.length) {
      throw new Error('Job identity migration manifest journal is invalid.');
    }
    const manifest = raw as unknown as JobIdentityMigrationManifest;
    const computedPlanHash = planHashFor(manifest.intent.items);
    if (computedPlanHash !== manifest.planHash) {
      throw new Error('Job identity migration manifest plan hash does not match its immutable intent.');
    }
    if (manifest.manifestId !== `job-identity-${manifest.planHash}`) {
      throw new Error('Job identity migration manifest ID does not match its plan hash.');
    }
    if (!Number.isSafeInteger(manifest.journal.revision) || manifest.journal.revision <= 0) {
      throw new Error('Job identity migration journal revision is invalid.');
    }
    const validManifestStatuses = new Set(['prepared', 'partially-committed', 'committed', 'conflicted']);
    const validItemStatuses = new Set(['pending', 'committed', 'already-applied', 'conflicted']);
    if (!validManifestStatuses.has(manifest.journal.status)
      || manifest.journal.items.some((item) => !validItemStatuses.has(item.status))) {
      throw new Error('Job identity migration journal status is invalid.');
    }
    for (const item of manifest.intent.items) {
      if (!PLATFORM_ORDER.includes(item.platform) || !item.jobKey
        || !Number.isSafeInteger(item.sourceRevision) || item.sourceRevision <= 0) {
        throw new Error('Job identity migration intent item is invalid.');
      }
      assertHash(item.sourceRecordHash, 'intent.sourceRecordHash');
      assertHash(item.patchHash, 'intent.patchHash');
      if (hashSemantic(item.patch) !== item.patchHash) {
        throw new Error('Job identity migration patch hash does not match its immutable patch.');
      }
    }
    return manifest;
  }

  private async persistJournal(manifest: JobIdentityMigrationManifest): Promise<void> {
    manifest.journal.revision += 1;
    await writeJsonAtomically(this.manifestPath(manifest.manifestId), manifest);
  }

  private async verifyCommittedItem(
    intent: JobIdentityMigrationIntentItem,
    state: JobIdentityMigrationItemState,
  ): Promise<void> {
    if (!state.evidence) throw new Error(`Committed migration item ${intent.platform}/${intent.jobKey} lacks evidence.`);
    const current = await this.store.readJobRecord(intent.platform, intent.jobKey);
    if (!isDeepStrictEqual(current.jobIdentity, intent.patch.jobIdentity)) {
      throw new Error(`Committed migration identity for ${intent.platform}/${intent.jobKey} no longer matches.`);
    }
    if ((current.revision ?? 1) !== state.evidence.resultingRevision
      || recordHash(current) !== state.evidence.resultingRecordHash) {
      throw new Error(`Committed migration evidence for ${intent.platform}/${intent.jobKey} no longer matches the current record.`);
    }
  }

  async commit(
    manifestId: string,
    confirmationHash: string,
    options: { afterItemCommitted?: (item: JobIdentityMigrationIntentItem) => void | Promise<void> } = {},
  ): Promise<JobIdentityMigrationManifest> {
    const manifest = await this.readManifest(manifestId);
    if (confirmationHash !== manifest.planHash) {
      throw new Error('Job identity migration confirmation hash does not match the prepared manifest.');
    }
    if (manifest.journal.status === 'conflicted') {
      throw new Error('Job identity migration manifest is conflicted; create a fresh preview.');
    }
    if (manifest.journal.status === 'committed') {
      for (let index = 0; index < manifest.intent.items.length; index += 1) {
        await this.verifyCommittedItem(manifest.intent.items[index]!, manifest.journal.items[index]!);
      }
      return manifest;
    }
    const activeTaskReferences = await this.scanActiveTaskReferences(manifest.intent.items);
    if (activeTaskReferences.length > 0) {
      throw new Error(`Job identity migration commit is blocked by active queued/running tasks: ${activeTaskReferences.map((item) => item.taskId).join(', ')}.`);
    }

    for (let index = 0; index < manifest.intent.items.length; index += 1) {
      const intent = manifest.intent.items[index]!;
      const state = manifest.journal.items[index]!;
      if (state.status === 'committed' || state.status === 'already-applied') {
        if (state.evidence) await this.verifyCommittedItem(intent, state);
        else {
          const current = await this.store.readJobRecord(intent.platform, intent.jobKey);
          if (!isDeepStrictEqual(current.jobIdentity, intent.patch.jobIdentity)) {
            throw new Error(`Prepared already-applied identity for ${intent.platform}/${intent.jobKey} no longer matches.`);
          }
          state.evidence = {
            resultingRevision: current.revision ?? 1,
            resultingRecordHash: recordHash(current),
            verifiedAt: this.now().toISOString(),
          };
          manifest.journal.status = 'partially-committed';
          await this.persistJournal(manifest);
        }
        continue;
      }

      const current = await this.store.readJobRecord(intent.platform, intent.jobKey);
      if (isDeepStrictEqual(current.jobIdentity, intent.patch.jobIdentity)) {
        state.status = 'already-applied';
        state.evidence = {
          resultingRevision: current.revision ?? 1,
          resultingRecordHash: recordHash(current),
          verifiedAt: this.now().toISOString(),
        };
      } else if ((current.revision ?? 1) !== intent.sourceRevision) {
        state.status = 'conflicted';
        state.issue = `source revision conflict: expected ${intent.sourceRevision}, found ${current.revision ?? 1}`;
      } else if (recordHash(current) !== intent.sourceRecordHash) {
        state.status = 'conflicted';
        state.issue = 'source record hash conflict';
      } else {
        try {
          const updated = await this.store.updateJobIdentityIfRevision(
            intent.platform,
            intent.jobKey,
            intent.sourceRevision,
            intent.patch.jobIdentity,
            { authority: 'migration-backfill' },
          );
          state.status = 'committed';
          state.evidence = {
            resultingRevision: updated.revision ?? 1,
            resultingRecordHash: recordHash(updated),
            verifiedAt: this.now().toISOString(),
          };
        } catch (error) {
          state.status = 'conflicted';
          state.issue = error instanceof Error ? error.message : String(error);
        }
      }

      manifest.journal.status = state.status === 'conflicted' ? 'conflicted' : 'partially-committed';
      await this.persistJournal(manifest);
      if (state.status === 'conflicted') {
        throw new Error(`Job identity migration source revision or record hash conflict for ${intent.platform}/${intent.jobKey}: ${state.issue}`);
      }
      await options.afterItemCommitted?.(intent);
    }

    for (let index = 0; index < manifest.intent.items.length; index += 1) {
      await this.verifyCommittedItem(manifest.intent.items[index]!, manifest.journal.items[index]!);
    }
    manifest.journal.status = 'committed';
    manifest.journal.finalCommit = {
      committedAt: this.now().toISOString(),
      verifiedPlanHash: manifest.planHash,
    };
    await this.persistJournal(manifest);
    return manifest;
  }
}
