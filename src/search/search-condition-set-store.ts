import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '../platforms/types.js';
import {
  SEARCH_CONDITION_SET_SCHEMA_VERSION,
  SearchConditionSetNotFoundError,
  SearchConditionSetStorageError,
  type SearchConditionSetRevision,
  type SearchConditionSetStatus,
  type SearchConditionSetSummary,
} from './search-condition-set-types.js';

interface SearchConditionSetPaths {
  rootDir: string;
  revisionsDir: string;
  currentPath: string;
}

export interface SearchConditionSetStoreOptions {
  dataDir?: string;
}

function assertSupportedPlatform(value: string): asserts value is SupportedPlatform {
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(value)) {
    throw new SearchConditionSetStorageError('corrupt_storage', `Unknown search condition set platform: ${value}`);
  }
}

export function assertSafeSearchConditionSetId(value: string): void {
  if (!/^scs-[a-z0-9](?:[a-z0-9-]{2,126})$/.test(value) || value.includes('--')) {
    throw new SearchConditionSetStorageError('invalid_id', 'conditionSetId must be a generated, path-safe scs-* identifier.');
  }
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new SearchConditionSetStorageError('corrupt_storage', `${label} must be a positive integer.`);
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SearchConditionSetStorageError('corrupt_storage', `${label} must be an object.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SearchConditionSetStorageError('corrupt_storage', `${label} must be a non-empty string.`);
  }
}

function toSummary(revision: SearchConditionSetRevision): SearchConditionSetSummary {
  return {
    schemaVersion: SEARCH_CONDITION_SET_SCHEMA_VERSION,
    conditionSetId: revision.conditionSetId,
    platform: revision.platform,
    revision: revision.revision,
    name: revision.name,
    description: revision.description,
    defaultKeyword: revision.defaultKeyword,
    status: revision.status,
    fieldIds: Object.keys(revision.applicationFilterInput).sort(),
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
  };
}

function normalizeRevision(raw: unknown, expected: { platform: SupportedPlatform; conditionSetId: string; revision?: number }): SearchConditionSetRevision {
  assertPlainObject(raw, 'Search condition set revision');
  if (raw.schemaVersion !== SEARCH_CONDITION_SET_SCHEMA_VERSION) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Unsupported search condition set schema version.');
  }
  if (raw.conditionSetId !== expected.conditionSetId) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set revision ID does not match its path.');
  }
  if (raw.platform !== expected.platform || typeof raw.platform !== 'string') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set revision platform does not match its path.');
  }
  assertSupportedPlatform(raw.platform);
  if (typeof raw.revision !== 'number') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set revision number is invalid.');
  }
  assertPositiveRevision(raw.revision, 'revision');
  if (expected.revision !== undefined && raw.revision !== expected.revision) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set revision number does not match its path.');
  }
  assertNonEmptyString(raw.name, 'name');
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'description must be a string when present.');
  }
  if (raw.defaultKeyword !== undefined && typeof raw.defaultKeyword !== 'string') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'defaultKeyword must be a string when present.');
  }
  assertPlainObject(raw.applicationFilterInput, 'applicationFilterInput');
  if (!Array.isArray(raw.compiledConditions)) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'compiledConditions must be an array.');
  }
  assertPlainObject(raw.catalogEvidence, 'catalogEvidence');
  assertNonEmptyString(raw.catalogEvidence.capturedAt, 'catalogEvidence.capturedAt');
  assertNonEmptyString(raw.catalogEvidence.selectedFieldsFingerprint, 'catalogEvidence.selectedFieldsFingerprint');
  if (raw.status !== 'active' && raw.status !== 'archived') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'status must be active or archived.');
  }
  assertNonEmptyString(raw.createdAt, 'createdAt');
  assertNonEmptyString(raw.updatedAt, 'updatedAt');

  return raw as unknown as SearchConditionSetRevision;
}

function normalizeSummary(raw: unknown, expected: { platform: SupportedPlatform; conditionSetId: string }): SearchConditionSetSummary {
  assertPlainObject(raw, 'Search condition set current record');
  if (raw.schemaVersion !== SEARCH_CONDITION_SET_SCHEMA_VERSION) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Unsupported search condition set current schema version.');
  }
  if (raw.conditionSetId !== expected.conditionSetId || raw.platform !== expected.platform) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set current record does not match its path.');
  }
  if (typeof raw.revision !== 'number') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'Search condition set current revision is invalid.');
  }
  assertPositiveRevision(raw.revision, 'current revision');
  assertNonEmptyString(raw.name, 'name');
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'description must be a string when present.');
  }
  if (raw.defaultKeyword !== undefined && typeof raw.defaultKeyword !== 'string') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'defaultKeyword must be a string when present.');
  }
  if (raw.status !== 'active' && raw.status !== 'archived') {
    throw new SearchConditionSetStorageError('corrupt_storage', 'status must be active or archived.');
  }
  if (!Array.isArray(raw.fieldIds) || raw.fieldIds.some((fieldId) => typeof fieldId !== 'string')) {
    throw new SearchConditionSetStorageError('corrupt_storage', 'fieldIds must be a string array.');
  }
  assertNonEmptyString(raw.createdAt, 'createdAt');
  assertNonEmptyString(raw.updatedAt, 'updatedAt');
  return raw as unknown as SearchConditionSetSummary;
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new SearchConditionSetStorageError('corrupt_storage', `Invalid JSON at ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** Create an immutable revision file without ever replacing an existing revision. */
async function writeNewJsonAtomically(filePath: string, value: unknown): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await fs.link(tempPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export class SearchConditionSetStore {
  readonly dataDir: string;
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(options: SearchConditionSetStoreOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? config.dataDir);
  }

  private getPaths(platform: SupportedPlatform, conditionSetId: string): SearchConditionSetPaths {
    assertSafeSearchConditionSetId(conditionSetId);
    const rootDir = path.join(this.dataDir, platform, 'search-condition-sets', conditionSetId);
    return {
      rootDir,
      revisionsDir: path.join(rootDir, 'revisions'),
      currentPath: path.join(rootDir, 'current.json'),
    };
  }

  private revisionPath(platform: SupportedPlatform, conditionSetId: string, revision: number): string {
    assertPositiveRevision(revision, 'revision');
    return path.join(this.getPaths(platform, conditionSetId).revisionsDir, `${String(revision).padStart(6, '0')}.json`);
  }

  private async serializeMutation<T>(platform: SupportedPlatform, conditionSetId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${platform}:${conditionSetId}`;
    const prior = this.mutationQueues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => gate);
    this.mutationQueues.set(key, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.mutationQueues.get(key) === queued) {
        this.mutationQueues.delete(key);
      }
    }
  }

  async create(revision: SearchConditionSetRevision): Promise<void> {
    const paths = this.getPaths(revision.platform, revision.conditionSetId);
    if (revision.revision !== 1) {
      throw new SearchConditionSetStorageError('corrupt_storage', 'Initial search condition set revision must be 1.');
    }

    await this.serializeMutation(revision.platform, revision.conditionSetId, async () => {
      await fs.mkdir(path.dirname(paths.rootDir), { recursive: true });
      try {
        await fs.mkdir(paths.rootDir, { recursive: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new SearchConditionSetStorageError('duplicate_id', `Search condition set ${revision.conditionSetId} already exists for ${revision.platform}.`);
        }
        throw error;
      }

      const wroteRevision = await writeNewJsonAtomically(
        this.revisionPath(revision.platform, revision.conditionSetId, revision.revision),
        revision,
      );
      if (!wroteRevision) {
        throw new SearchConditionSetStorageError('duplicate_id', `Search condition set ${revision.conditionSetId} revision 1 already exists.`);
      }
      await writeJsonAtomically(paths.currentPath, toSummary(revision));
    });
  }

  async list(options: { platform?: SupportedPlatform; status?: SearchConditionSetStatus } = {}): Promise<SearchConditionSetSummary[]> {
    const platforms = options.platform ? [options.platform] : [...SUPPORTED_PLATFORMS];
    const summaries = (await Promise.all(platforms.map(async (platform) => {
      const root = path.join(this.dataDir, platform, 'search-condition-sets');
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [] as SearchConditionSetSummary[];
        }
        throw error;
      }
      return Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^scs-[a-z0-9][a-z0-9-]*$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => this.readCurrentSummary(platform, entry.name)));
    }))).flat();

    return summaries
      .filter((summary) => !options.status || summary.status === options.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  }

  async readCurrentSummary(platform: SupportedPlatform, conditionSetId: string): Promise<SearchConditionSetSummary> {
    const raw = await readJsonIfExists(this.getPaths(platform, conditionSetId).currentPath);
    if (raw === undefined) {
      throw new SearchConditionSetNotFoundError({ platform, conditionSetId });
    }
    return normalizeSummary(raw, { platform, conditionSetId });
  }

  async getCurrent(platform: SupportedPlatform, conditionSetId: string): Promise<SearchConditionSetRevision> {
    const summary = await this.readCurrentSummary(platform, conditionSetId);
    const revision = await this.getRevision({ platform, conditionSetId, revision: summary.revision });
    if (revision.name !== summary.name || revision.status !== summary.status || revision.updatedAt !== summary.updatedAt) {
      throw new SearchConditionSetStorageError('corrupt_storage', `Search condition set ${conditionSetId} current record does not match revision ${summary.revision}.`);
    }
    return revision;
  }

  async getRevision(reference: { platform: SupportedPlatform; conditionSetId: string; revision: number }): Promise<SearchConditionSetRevision> {
    const raw = await readJsonIfExists(this.revisionPath(reference.platform, reference.conditionSetId, reference.revision));
    if (raw === undefined) {
      throw new SearchConditionSetNotFoundError(reference);
    }
    return normalizeRevision(raw, reference);
  }

  async listRevisions(platform: SupportedPlatform, conditionSetId: string): Promise<SearchConditionSetRevision[]> {
    const { revisionsDir } = this.getPaths(platform, conditionSetId);
    let entries: string[];
    try {
      entries = await fs.readdir(revisionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SearchConditionSetNotFoundError({ platform, conditionSetId });
      }
      throw error;
    }
    const revisions = await Promise.all(entries
      .filter((entry) => /^\d{6}\.json$/.test(entry))
      .sort((left, right) => right.localeCompare(left))
      .map(async (entry) => this.getRevision({
        platform,
        conditionSetId,
        revision: Number(entry.slice(0, -'.json'.length)),
      })));
    if (revisions.length === 0) {
      throw new SearchConditionSetStorageError('corrupt_storage', `Search condition set ${conditionSetId} has no revisions.`);
    }
    return revisions;
  }

  async appendRevision(revision: SearchConditionSetRevision, expectedRevision: number): Promise<void> {
    const paths = this.getPaths(revision.platform, revision.conditionSetId);
    assertPositiveRevision(expectedRevision, 'expectedRevision');
    if (revision.revision !== expectedRevision + 1) {
      throw new SearchConditionSetStorageError('corrupt_storage', 'New search condition set revision must be expectedRevision + 1.');
    }

    await this.serializeMutation(revision.platform, revision.conditionSetId, async () => {
      const current = await this.getCurrent(revision.platform, revision.conditionSetId);
      if (current.revision !== expectedRevision) {
        const { SearchConditionSetConflictError } = await import('./search-condition-set-types.js');
        throw new SearchConditionSetConflictError({
          conditionSetId: revision.conditionSetId,
          platform: revision.platform,
          expectedRevision,
          actualRevision: current.revision,
        });
      }

      const wroteRevision = await writeNewJsonAtomically(
        this.revisionPath(revision.platform, revision.conditionSetId, revision.revision),
        revision,
      );
      if (!wroteRevision) {
        const latest = await this.getCurrent(revision.platform, revision.conditionSetId);
        const { SearchConditionSetConflictError } = await import('./search-condition-set-types.js');
        throw new SearchConditionSetConflictError({
          conditionSetId: revision.conditionSetId,
          platform: revision.platform,
          expectedRevision,
          actualRevision: latest.revision,
        });
      }
      await writeJsonAtomically(paths.currentPath, toSummary(revision));
    });
  }
}
