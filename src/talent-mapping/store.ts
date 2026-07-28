import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { config } from '../config.js';
import { buildTalentMappingDerivedViews } from './aggregation.js';
import type {
  MappingAnnotation,
  MappingBatchCheckpoint,
  MappingCandidateObservation,
  MappingCandidateView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingDerivedViews,
  MappingEntityLink,
  MappingProfileObservation,
  MappingRunRecord,
  MappingSliceRun,
  TalentMappingCorePlatform,
  TalentMappingPlan,
  TalentMappingProject,
} from '../types/talent-mapping.js';

interface TalentMappingPaths {
  rootDir: string;
  mappingPath: string;
  runsDir: string;
  checkpointsDir: string;
  annotationsPath: string;
  entityLinksPath: string;
  viewsDir: string;
  candidatesViewPath: string;
  companiesViewPath: string;
  coverageViewPath: string;
  exportsLatestDir: string;
}

interface PlatformMappingPaths {
  dir: string;
  cardObservationsPath: string;
  profileObservationsPath: string;
  profilesDir: string;
  snapshotsDir: string;
}

export interface TalentMappingStoreOptions {
  dataDir?: string;
  now?: () => Date;
}

function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim() || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty path-safe value`);
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function writeJsonIfChanged(filePath: string, value: unknown): Promise<boolean> {
  const existing = await readJsonIfExists<unknown>(filePath);
  if (existing !== undefined && isDeepStrictEqual(existing, value)) {
    return false;
  }
  await writeJson(filePath, value);
  return true;
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) {
      return [];
    }
    try {
      return [JSON.parse(line) as T];
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function appendJsonLineIdempotently<T extends Record<string, unknown>>(
  filePath: string,
  value: T,
  identityField: keyof T,
): Promise<boolean> {
  const identity = value[identityField];
  const existing = await readJsonLines<T>(filePath);
  if (existing.some((item) => item[identityField] === identity)) {
    return false;
  }

  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
  return true;
}

function profileFileName(platformCandidateKey: string): string {
  return `${createHash('sha256').update(platformCandidateKey).digest('hex')}.json`;
}

function projectToPlan(project: TalentMappingProject): TalentMappingPlan {
  const { sourceFilePath: _sourceFilePath, createdAt: _createdAt, updatedAt: _updatedAt, ...plan } = project;
  return plan;
}

function canonicalJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class TalentMappingStore {
  readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: TalentMappingStoreOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? config.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  private getPaths(mappingKey: string): TalentMappingPaths {
    assertSafePathSegment(mappingKey, 'mappingKey');
    const rootDir = path.join(this.dataDir, 'talent-mapping', mappingKey);
    const viewsDir = path.join(rootDir, 'views');
    return {
      rootDir,
      mappingPath: path.join(rootDir, 'mapping.json'),
      runsDir: path.join(rootDir, 'runs'),
      checkpointsDir: path.join(rootDir, 'runs', 'checkpoints'),
      annotationsPath: path.join(rootDir, 'annotations.jsonl'),
      entityLinksPath: path.join(rootDir, 'entity-links.json'),
      viewsDir,
      candidatesViewPath: path.join(viewsDir, 'candidates.latest.json'),
      companiesViewPath: path.join(viewsDir, 'companies.latest.json'),
      coverageViewPath: path.join(viewsDir, 'coverage.latest.json'),
      exportsLatestDir: path.join(rootDir, 'exports', 'latest'),
    };
  }

  private getPlatformPaths(mappingKey: string, platform: TalentMappingCorePlatform): PlatformMappingPaths {
    const dir = path.join(this.getPaths(mappingKey).rootDir, 'platforms', platform);
    return {
      dir,
      cardObservationsPath: path.join(dir, 'card-observations.jsonl'),
      profileObservationsPath: path.join(dir, 'profile-observations.jsonl'),
      profilesDir: path.join(dir, 'profiles'),
      snapshotsDir: path.join(dir, 'snapshots'),
    };
  }

  createRunId(): string {
    return `${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  }

  async saveProject(
    plan: TalentMappingPlan,
    sourceFilePath: string,
  ): Promise<{ project: TalentMappingProject; changed: boolean; path: string }> {
    const paths = this.getPaths(plan.mappingKey);
    const existing = await readJsonIfExists<TalentMappingProject>(paths.mappingPath);
    const now = this.now().toISOString();
    const comparableProject = canonicalJson<TalentMappingProject>({
      ...plan,
      sourceFilePath: path.resolve(sourceFilePath),
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    });

    if (existing && isDeepStrictEqual(existing, comparableProject)) {
      return { project: existing, changed: false, path: paths.mappingPath };
    }

    const project = canonicalJson<TalentMappingProject>({
      ...comparableProject,
      updatedAt: now,
    });
    await writeJson(paths.mappingPath, project);
    return { project, changed: true, path: paths.mappingPath };
  }

  async readProject(mappingKey: string): Promise<TalentMappingProject | undefined> {
    return readJsonIfExists<TalentMappingProject>(this.getPaths(mappingKey).mappingPath);
  }

  async listProjects(): Promise<TalentMappingProject[]> {
    const root = path.join(this.dataDir, 'talent-mapping');
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const projects = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readProject(entry.name)));
    return projects
      .filter((project): project is TalentMappingProject => project !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async appendCandidateObservation(observation: MappingCandidateObservation): Promise<boolean> {
    if (observation.platformCandidateKey !== `${observation.platform}:${observation.candidateId}`) {
      throw new Error(`Invalid platformCandidateKey for observation ${observation.observationId}`);
    }
    return appendJsonLineIdempotently(
      this.getPlatformPaths(observation.mappingKey, observation.platform).cardObservationsPath,
      observation as MappingCandidateObservation & Record<string, unknown>,
      'observationId',
    );
  }

  async appendProfileObservation(
    observation: MappingProfileObservation,
    options: { rawText?: string } = {},
  ): Promise<{ appended: boolean; observation: MappingProfileObservation }> {
    const paths = this.getPlatformPaths(observation.mappingKey, observation.platform);
    let storedObservation = observation;
    if (options.rawText) {
      await ensureDir(paths.snapshotsDir);
      const snapshotPath = path.join(paths.snapshotsDir, `${observation.profileObservationId}.txt`);
      await fs.writeFile(snapshotPath, options.rawText, 'utf8');
      storedObservation = {
        ...observation,
        rawSnapshotPath: path.relative(this.getPaths(observation.mappingKey).rootDir, snapshotPath),
      };
    }

    const appended = await appendJsonLineIdempotently(
      paths.profileObservationsPath,
      storedObservation as MappingProfileObservation & Record<string, unknown>,
      'profileObservationId',
    );
    if (appended) {
      await writeJson(
        path.join(paths.profilesDir, profileFileName(observation.platformCandidateKey)),
        storedObservation,
      );
    }
    return { appended, observation: storedObservation };
  }

  async readCandidateObservations(mappingKey: string): Promise<MappingCandidateObservation[]> {
    const values = await Promise.all((['51job', 'liepin', 'zhilian'] as const).map((platform) =>
      readJsonLines<MappingCandidateObservation>(this.getPlatformPaths(mappingKey, platform).cardObservationsPath),
    ));
    return values.flat();
  }

  async readProfileObservations(mappingKey: string): Promise<MappingProfileObservation[]> {
    const values = await Promise.all((['51job', 'liepin', 'zhilian'] as const).map((platform) =>
      readJsonLines<MappingProfileObservation>(this.getPlatformPaths(mappingKey, platform).profileObservationsPath),
    ));
    return values.flat();
  }

  async saveCheckpoint(checkpoint: MappingBatchCheckpoint): Promise<string> {
    assertSafePathSegment(checkpoint.runId, 'runId');
    assertSafePathSegment(checkpoint.sliceId, 'sliceId');
    const paths = this.getPaths(checkpoint.mappingKey);
    const filePath = path.join(paths.checkpointsDir, checkpoint.runId, `${checkpoint.sliceId}-${checkpoint.platform}.json`);
    await writeJson(filePath, checkpoint);
    return filePath;
  }

  async saveRun(run: MappingRunRecord): Promise<string> {
    assertSafePathSegment(run.runId, 'runId');
    const filePath = path.join(this.getPaths(run.mappingKey).runsDir, `${run.runId}.json`);
    await writeJson(filePath, run);
    return filePath;
  }

  async readRun(mappingKey: string, runId: string): Promise<MappingRunRecord | undefined> {
    assertSafePathSegment(runId, 'runId');
    return readJsonIfExists<MappingRunRecord>(path.join(this.getPaths(mappingKey).runsDir, `${runId}.json`));
  }

  async listRuns(mappingKey: string): Promise<MappingRunRecord[]> {
    const { runsDir } = this.getPaths(mappingKey);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const runs = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJsonIfExists<MappingRunRecord>(path.join(runsDir, entry.name))));
    return runs
      .filter((run): run is MappingRunRecord => run !== undefined)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async appendAnnotation(annotation: MappingAnnotation): Promise<boolean> {
    return appendJsonLineIdempotently(
      this.getPaths(annotation.mappingKey).annotationsPath,
      annotation as MappingAnnotation & Record<string, unknown>,
      'annotationId',
    );
  }

  async readAnnotations(mappingKey: string): Promise<MappingAnnotation[]> {
    return readJsonLines<MappingAnnotation>(this.getPaths(mappingKey).annotationsPath);
  }

  async saveEntityLinks(mappingKey: string, links: readonly MappingEntityLink[]): Promise<void> {
    const platformKeys = new Set<string>();
    for (const link of links) {
      if (link.platformCandidateKeys.length < 2) {
        throw new Error(`Mapping entity link ${link.entityId} must contain at least two platform candidate keys`);
      }
      for (const platformKey of link.platformCandidateKeys) {
        if (platformKeys.has(platformKey)) {
          throw new Error(`Mapping platform candidate key ${platformKey} appears in more than one entity link`);
        }
        platformKeys.add(platformKey);
      }
    }
    await writeJson(this.getPaths(mappingKey).entityLinksPath, links);
  }

  async readEntityLinks(mappingKey: string): Promise<MappingEntityLink[]> {
    return (await readJsonIfExists<MappingEntityLink[]>(this.getPaths(mappingKey).entityLinksPath)) ?? [];
  }

  async rebuildDerivedViews(mappingKey: string): Promise<MappingDerivedViews> {
    const project = await this.readProject(mappingKey);
    if (!project) {
      throw new Error(`Talent Mapping project not found: ${mappingKey}`);
    }
    const [observations, profileObservations, runs] = await Promise.all([
      this.readCandidateObservations(mappingKey),
      this.readProfileObservations(mappingKey),
      this.listRuns(mappingKey),
    ]);
    const views = buildTalentMappingDerivedViews({
      plan: projectToPlan(project),
      observations,
      profileObservations,
      sliceRuns: runs.flatMap((run) => run.sliceRuns),
      generatedAt: this.now().toISOString(),
    });
    const paths = this.getPaths(mappingKey);
    await Promise.all([
      writeJsonIfChanged(paths.candidatesViewPath, views.candidates),
      writeJsonIfChanged(paths.companiesViewPath, views.companies),
      writeJsonIfChanged(paths.coverageViewPath, views.coverage),
    ]);
    return views;
  }

  async readCandidateView(mappingKey: string): Promise<MappingCandidateView[]> {
    return (await readJsonIfExists<MappingCandidateView[]>(this.getPaths(mappingKey).candidatesViewPath)) ?? [];
  }

  async readCompanyView(mappingKey: string): Promise<MappingCompanyRoleMatrixRow[]> {
    return (await readJsonIfExists<MappingCompanyRoleMatrixRow[]>(this.getPaths(mappingKey).companiesViewPath)) ?? [];
  }

  async readCoverageView(mappingKey: string): Promise<MappingCoverageViewRow[]> {
    return (await readJsonIfExists<MappingCoverageViewRow[]>(this.getPaths(mappingKey).coverageViewPath)) ?? [];
  }

  getLatestExportDir(mappingKey: string): string {
    return this.getPaths(mappingKey).exportsLatestDir;
  }

  async listAllSliceRuns(mappingKey: string): Promise<MappingSliceRun[]> {
    return (await this.listRuns(mappingKey)).flatMap((run) => run.sliceRuns);
  }
}
