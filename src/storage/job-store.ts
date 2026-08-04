import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { normalizeBossScreeningSettings, normalizePostScoreRoutingSettings } from '../scoring/boss-screening.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';
import type { BossJobSyncRun, BossPositionSummary } from '../types/boss.js';
import {
  JobConfigPatch,
  CandidateListItem,
  CandidateResume,
  BossAutomationSettings,
  BossCandidateRoutingArtifact,
  BossChatReviewItem,
  BossChatReviewRun,
  BossForwardingOutboxEntry,
  BossScreeningWorkItem,
  CandidateRoutingArtifact,
  PostScoreRoutingWorkItem,
  CandidateScoreArtifact,
  JobRecord,
  ResumeDomSnapshot,
  RunResult,
} from '../types/job.js';

interface JobPaths {
  jobDir: string;
  resumesDir: string;
  resultsDir: string;
  scoresDir: string;
  exportsDir: string;
  routingArtifactsDir: string;
  screeningWorkDir: string;
  forwardingOutboxDir: string;
  snapshotsDir: string;
  domSnapshotsDir: string;
  jdPath: string;
  seenIdsPath: string;
}

interface FilterCatalogPaths {
  dir: string;
  latestPath: string;
}

interface BossChatReviewPaths {
  dir: string;
  runsDir: string;
  automationSettingsPath: string;
  reviewedConversationIdsPath: string;
}

interface BossJobSyncPaths {
  dir: string;
  runsDir: string;
  latestPositionsPath: string;
}

interface LegacyResumeSnapshotSource {
  candidateId: string;
  name?: string;
  resumeUrl?: string;
  rawSnapshot?: string;
}

interface LegacyJobRecord extends Omit<JobRecord, 'platform'> {
  platform?: SupportedPlatform;
}

interface LegacyRunResult extends Omit<RunResult, 'platform'> {
  platform?: SupportedPlatform;
}

export interface StoredResumeSnapshot {
  candidateId: string;
  name?: string;
  resumeUrl?: string;
  snapshotContent: string;
  domSnapshot?: ResumeDomSnapshot;
  migratedSnapshot: boolean;
}

/** A stale queued task must fail before it can overwrite a newer job config. */
export class JobConfigConflictError extends Error {
  readonly code = 'JOB_CONFIG_REVISION_CONFLICT' as const;

  constructor(
    readonly platform: SupportedPlatform,
    readonly jobKey: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Job configuration revision conflict for ${platform}/${jobKey}: `
      + `expected ${expectedRevision}, found ${actualRevision}. Refresh the job and confirm again.`,
    );
    this.name = 'JobConfigConflictError';
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

let atomicWriteCounter = 0;
const jobConfigWriteChains = new Map<string, Promise<void>>();

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${atomicWriteCounter += 1}`;
  try {
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomically(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeJsonIfChanged(filePath: string, data: unknown): Promise<boolean> {
  const content = `${JSON.stringify(data, null, 2)}\n`;

  try {
    const existingContent = await fs.readFile(filePath, 'utf8');
    if (existingContent === content
      || isDeepStrictEqual(JSON.parse(existingContent), JSON.parse(content))) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  await writeFileAtomically(filePath, content);
  return true;
}

async function readJsonFile<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && arguments.length >= 2) {
      return fallback as T;
    }

    throw error;
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((entry) => entry.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function routingCandidateFileName(candidateId: string): string {
  return encodeURIComponent(candidateId);
}

function routingTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-');
}

function normalizeJobRecord(jobRecord: LegacyJobRecord): JobRecord {
  const {
    recipientEmail,
    ccEmails,
    bossForwarding,
    bossScreening,
    postScoreRouting,
    searchSettings,
    ...rest
  } = jobRecord;
  const normalizedRecipientEmail = recipientEmail?.trim();
  const normalizedCcEmails = ccEmails
    ? [...new Set(ccEmails.map((email) => email.trim()).filter(Boolean))]
    : undefined;
  const normalizedBossForwarding = bossForwarding?.recipient.trim()
    ? {
      mode: bossForwarding.mode,
      recipient: bossForwarding.recipient.trim(),
      ...(bossForwarding.ccEmails === undefined ? {} : {
        ccEmails: [...new Set(bossForwarding.ccEmails.map((email) => email.trim()).filter(Boolean))],
      }),
    }
    : undefined;
  const normalizedBossScreening = bossScreening === undefined
    ? undefined
    : normalizeBossScreeningSettings(bossScreening);
  const normalizedPostScoreRouting = postScoreRouting === undefined
    ? undefined
    : normalizePostScoreRoutingSettings(postScoreRouting);
  const normalizedPageKeyword = searchSettings?.pageKeyword
    ?.normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  const normalizedSearchSettings = searchSettings
    ? {
      ...searchSettings,
      ...(normalizedPageKeyword ? { pageKeyword: normalizedPageKeyword } : {}),
    }
    : undefined;
  if (normalizedSearchSettings && !normalizedPageKeyword) {
    delete normalizedSearchSettings.pageKeyword;
  }

  return {
    ...rest,
    platform: jobRecord.platform ?? '51job',
    revision: Number.isSafeInteger(jobRecord.revision) && (jobRecord.revision as number) > 0
      ? jobRecord.revision
      : 1,
    ...(normalizedRecipientEmail ? { recipientEmail: normalizedRecipientEmail } : {}),
    ...(normalizedCcEmails ? { ccEmails: normalizedCcEmails } : {}),
    ...(normalizedSearchSettings ? { searchSettings: normalizedSearchSettings } : {}),
    ...(normalizedBossForwarding ? { bossForwarding: normalizedBossForwarding } : {}),
    ...(normalizedBossScreening ? { bossScreening: normalizedBossScreening } : {}),
    ...(normalizedPostScoreRouting ? { postScoreRouting: normalizedPostScoreRouting } : {}),
  };
}

function normalizeRunResult(runResult: LegacyRunResult): RunResult {
  return {
    ...runResult,
    platform: runResult.platform ?? '51job',
  };
}

export class JobStore {
  private readonly dataDir: string;

  constructor(dataDir: string | { dataDir?: string } = config.dataDir) {
    this.dataDir = path.resolve(typeof dataDir === 'string' ? dataDir : dataDir.dataDir ?? config.dataDir);
  }

  private withConfigLock<T>(platform: SupportedPlatform, jobKey: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${this.dataDir}/${platform}/${jobKey}`;
    const previous = jobConfigWriteChains.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const chain = current.then(() => undefined, () => undefined);
    jobConfigWriteChains.set(lockKey, chain);
    return current.finally(() => {
      if (jobConfigWriteChains.get(lockKey) === chain) {
        jobConfigWriteChains.delete(lockKey);
      }
    });
  }

  private getBossJobSyncPaths(): BossJobSyncPaths {
    const dir = path.join(this.dataDir, 'boss', 'job-sync');
    return {
      dir,
      runsDir: path.join(dir, 'runs'),
      latestPositionsPath: path.join(dir, 'positions.latest.json'),
    };
  }

  private getBossChatReviewPaths(): BossChatReviewPaths {
    const dir = path.join(this.dataDir, 'boss', 'chat-review');
    return {
      dir,
      runsDir: path.join(dir, 'runs'),
      automationSettingsPath: path.join(dir, 'automation-settings.json'),
      reviewedConversationIdsPath: path.join(dir, 'reviewed-conversation-ids.json'),
    };
  }

  private getFilterCatalogPaths(platform: SupportedPlatform): FilterCatalogPaths {
    const dir = path.join(this.dataDir, platform, 'filter-catalog');
    return {
      dir,
      latestPath: path.join(dir, 'latest.json'),
    };
  }

  private getJobPaths(platform: SupportedPlatform, jobKey: string): JobPaths {
    const jobDir = path.join(this.dataDir, platform, 'jobs', jobKey);
    return {
      jobDir,
      resumesDir: path.join(jobDir, 'resumes'),
      resultsDir: path.join(jobDir, 'results'),
      scoresDir: path.join(jobDir, 'scores'),
      exportsDir: path.join(jobDir, 'exports'),
      routingArtifactsDir: path.join(jobDir, 'routing', 'artifacts'),
      screeningWorkDir: path.join(jobDir, 'routing', 'pending-score'),
      forwardingOutboxDir: path.join(jobDir, 'routing', 'outbox'),
      snapshotsDir: path.join(jobDir, 'snapshots'),
      domSnapshotsDir: path.join(jobDir, 'snapshots-dom'),
      jdPath: path.join(jobDir, 'jd.json'),
      seenIdsPath: path.join(jobDir, 'seen-ids.json'),
    };
  }

  private async ensureJobPaths(paths: JobPaths): Promise<void> {
    await Promise.all([
      ensureDir(paths.jobDir),
      ensureDir(paths.resumesDir),
      ensureDir(paths.resultsDir),
      ensureDir(paths.scoresDir),
      ensureDir(paths.exportsDir),
      ensureDir(paths.routingArtifactsDir),
      ensureDir(paths.screeningWorkDir),
      ensureDir(paths.forwardingOutboxDir),
      ensureDir(paths.snapshotsDir),
      ensureDir(paths.domSnapshotsDir),
    ]);
  }

  async initializeJob(platform: SupportedPlatform, jobKey: string): Promise<JobPaths> {
    const paths = this.getJobPaths(platform, jobKey);
    await this.ensureJobPaths(paths);
    return paths;
  }

  async saveJobRecord(
    platform: SupportedPlatform,
    jobRecord: JobRecord,
    options: { expectedRevision?: number } = {},
  ): Promise<void> {
    const current = await this.readJobRecordIfExists(platform, jobRecord.jobKey);
    const currentRevision = current?.revision ?? 1;
    if (options.expectedRevision !== undefined && currentRevision !== options.expectedRevision) {
      throw new JobConfigConflictError(platform, jobRecord.jobKey, options.expectedRevision, currentRevision);
    }
    if (options.expectedRevision === undefined && jobRecord.revision !== undefined && current && jobRecord.revision !== currentRevision) {
      throw new JobConfigConflictError(platform, jobRecord.jobKey, jobRecord.revision, currentRevision);
    }
    const paths = await this.initializeJob(platform, jobRecord.jobKey);
    const normalizedPageKeyword = jobRecord.searchSettings?.pageKeyword
      ?.normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim();
    const searchSettings = jobRecord.searchSettings
      ? {
        ...jobRecord.searchSettings,
        ...(normalizedPageKeyword ? { pageKeyword: normalizedPageKeyword } : {}),
      }
      : undefined;
    if (searchSettings && !normalizedPageKeyword) {
      delete searchSettings.pageKeyword;
    }
    const bossScreening = jobRecord.bossScreening === undefined
      ? undefined
      : normalizeBossScreeningSettings(jobRecord.bossScreening);
    const postScoreRouting = jobRecord.postScoreRouting === undefined
      ? undefined
      : normalizePostScoreRoutingSettings(jobRecord.postScoreRouting);
    await writeJsonIfChanged(paths.jdPath, {
      ...jobRecord,
      platform,
      revision: jobRecord.revision ?? currentRevision,
      ...(searchSettings ? { searchSettings } : {}),
      recipientEmail: jobRecord.recipientEmail?.trim() || undefined,
      ccEmails: jobRecord.ccEmails
        ? [...new Set(jobRecord.ccEmails.map((email) => email.trim()).filter(Boolean))]
        : undefined,
      bossForwarding: jobRecord.bossForwarding?.recipient.trim()
        ? {
          mode: jobRecord.bossForwarding.mode,
          recipient: jobRecord.bossForwarding.recipient.trim(),
          ...(jobRecord.bossForwarding.ccEmails === undefined ? {} : {
            ccEmails: [...new Set(jobRecord.bossForwarding.ccEmails.map((email) => email.trim()).filter(Boolean))],
          }),
        }
        : undefined,
      bossScreening,
      postScoreRouting,
    });
  }

  /**
   * Apply only explicitly requested reusable configuration fields.  The
   * operation is serialized per job and checks the revision immediately
   * before writing, so a queued task cannot resurrect a later clear/edit.
   */
  async applyJobConfigPatch(
    platform: SupportedPlatform,
    jobKey: string,
    expectedRevision: number,
    patch: JobConfigPatch,
  ): Promise<JobRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw new Error('expectedRevision must be a positive integer');
    }
    return this.withConfigLock(platform, jobKey, async () => {
      const current = await this.readJobRecordIfExists(platform, jobKey);
      if (!current) {
        throw new Error(`Missing job record for job key ${jobKey}`);
      }
      const currentRevision = current.revision ?? 1;
      if (currentRevision !== expectedRevision) {
        throw new JobConfigConflictError(platform, jobKey, expectedRevision, currentRevision);
      }

      const next: JobRecord = { ...current };
      if (patch.recipientEmail !== undefined) {
        if (patch.recipientEmail === null || !patch.recipientEmail.trim()) delete next.recipientEmail;
        else next.recipientEmail = patch.recipientEmail.trim();
      }
      if (patch.ccEmails !== undefined) {
        next.ccEmails = [...new Set(patch.ccEmails.map((email) => email.trim()).filter(Boolean))];
      }
      if (patch.bossForwarding !== undefined) {
        if (patch.bossForwarding === null) delete next.bossForwarding;
        else {
          next.bossForwarding = {
            mode: patch.bossForwarding.mode,
            recipient: patch.bossForwarding.recipient.trim(),
            ...(patch.bossForwarding.ccEmails === undefined
              ? {}
              : { ccEmails: [...new Set(patch.bossForwarding.ccEmails.map((email) => email.trim()).filter(Boolean))] }),
          };
        }
      }
      if (patch.bossScreening !== undefined) {
        if (patch.bossScreening === null) delete next.bossScreening;
        else next.bossScreening = normalizeBossScreeningSettings(patch.bossScreening);
      }
      if (patch.postScoreRouting !== undefined) {
        if (patch.postScoreRouting === null) delete next.postScoreRouting;
        else next.postScoreRouting = normalizePostScoreRoutingSettings(patch.postScoreRouting);
      }
      if (patch.searchSource !== undefined
        || patch.pageKeyword !== undefined
        || patch.applicationFilterInput !== undefined
        || patch.conditions !== undefined
        || patch.conditionSetRef !== undefined
        || patch.selectedFieldsFingerprint !== undefined
        || patch.savedSearch !== undefined) {
        const existing = next.searchSettings ?? { source: patch.searchSource ?? 'saved', conditions: [] };
        const searchSettings: NonNullable<JobRecord['searchSettings']> = {
          ...existing,
          ...(patch.searchSource !== undefined ? { source: patch.searchSource } : {}),
          ...(patch.pageKeyword === null ? {} : patch.pageKeyword !== undefined ? { pageKeyword: patch.pageKeyword } : {}),
          ...(patch.applicationFilterInput === null
            ? {}
            : patch.applicationFilterInput !== undefined ? { applicationFilterInput: patch.applicationFilterInput } : {}),
          ...(patch.conditions !== undefined ? { conditions: [...patch.conditions] } : {}),
          ...(patch.conditionSetRef === null
            ? {}
            : patch.conditionSetRef !== undefined ? { conditionSetRef: patch.conditionSetRef } : {}),
          ...(patch.selectedFieldsFingerprint === null
            ? {}
            : patch.selectedFieldsFingerprint !== undefined
              ? { resolution: { selectedFieldsFingerprint: patch.selectedFieldsFingerprint } }
              : {}),
          ...(patch.savedSearch === null
            ? {}
            : patch.savedSearch !== undefined ? { savedSearch: patch.savedSearch } : {}),
        };
        if (patch.pageKeyword === null) delete searchSettings.pageKeyword;
        if (patch.applicationFilterInput === null) delete searchSettings.applicationFilterInput;
        if (patch.conditionSetRef === null) delete searchSettings.conditionSetRef;
        if (patch.selectedFieldsFingerprint === null) delete searchSettings.resolution;
        if (patch.savedSearch === null) delete searchSettings.savedSearch;
        next.searchSettings = searchSettings;
      }

      next.revision = currentRevision + 1;
      await this.saveJobRecord(platform, next, { expectedRevision: currentRevision });
      return (await this.readJobRecord(platform, jobKey));
    });
  }

  /** Alias with an explicit name for callers that treat this as a CAS update. */
  async updateJobConfigIfRevision(
    platform: SupportedPlatform,
    jobKey: string,
    expectedRevision: number,
    patch: JobConfigPatch,
  ): Promise<JobRecord> {
    return this.applyJobConfigPatch(platform, jobKey, expectedRevision, patch);
  }

  async readJobRecord(platform: SupportedPlatform, jobKey: string): Promise<JobRecord> {
    const jobRecord = await this.readJobRecordIfExists(platform, jobKey);

    if (!jobRecord) {
      throw new Error(`Missing job record for job key ${jobKey}`);
    }

    return jobRecord;
  }

  async readJobRecordIfExists(platform: SupportedPlatform, jobKey: string): Promise<JobRecord | undefined> {
    const { jdPath } = this.getJobPaths(platform, jobKey);
    const jobRecord = await readJsonFile<LegacyJobRecord | undefined>(jdPath, undefined);
    return jobRecord ? normalizeJobRecord(jobRecord) : undefined;
  }

  async listJobRecords(platform: SupportedPlatform): Promise<JobRecord[]> {
    const jobsDir = path.join(this.dataDir, platform, 'jobs');
    let jobDirs: string[];
    try {
      jobDirs = await fs.readdir(jobsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const records = await Promise.all(jobDirs.map(async (jobKey) => {
      try {
        return await this.readJobRecordIfExists(platform, jobKey);
      } catch {
        return undefined;
      }
    }));
    return records.filter((record): record is JobRecord => Boolean(record));
  }

  async findBossJobRecordByPositionId(bossJobId: string): Promise<JobRecord | undefined> {
    const records = await this.listJobRecords('boss');
    return records.find((record) => record.bossPosition?.bossJobId === bossJobId);
  }

  async findBossJobRecordsByName(jobName: string): Promise<JobRecord[]> {
    const normalizedName = jobName.replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
    const records = await this.listJobRecords('boss');
    return records.filter((record) => [record.searchKeyword, record.normalizedJob.title]
      .some((value) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN') === normalizedName));
  }

  async resolveBossConversationJobRecord(input: { bossJobId?: string; jobName: string }): Promise<JobRecord> {
    if (input.bossJobId) {
      const byId = await this.findBossJobRecordByPositionId(input.bossJobId);
      if (byId) return byId;
    }
    const byName = await this.findBossJobRecordsByName(input.jobName);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new Error(`Ambiguous stored Boss JD for job ${input.jobName}; capture the Boss job ID or synchronize positions first.`);
    }
    throw new Error(`Missing stored Boss JD for job ${input.jobName}${input.bossJobId ? ` (Boss ID ${input.bossJobId})` : ''}`);
  }

  async readSeenIds(platform: SupportedPlatform, jobKey: string): Promise<string[]> {
    const { seenIdsPath } = this.getJobPaths(platform, jobKey);
    return readJsonFile<string[]>(seenIdsPath, []);
  }

  async saveSeenIds(platform: SupportedPlatform, jobKey: string, candidateIds: string[]): Promise<void> {
    const paths = await this.initializeJob(platform, jobKey);
    await writeJson(paths.seenIdsPath, [...new Set(candidateIds)]);
  }

  /**
   * Adds only candidates whose resume files are already present and whose
   * serialized identity matches the requested ID. Capture workflows use this
   * instead of treating a list-card discovery as a successful capture.
   */
  async markCapturedCandidatesSeen(
    platform: SupportedPlatform,
    jobKey: string,
    candidateIds: readonly string[],
  ): Promise<void> {
    if (candidateIds.length === 0) return;
    const paths = await this.initializeJob(platform, jobKey);
    const uniqueCandidateIds = [...new Set(candidateIds)];
    for (const candidateId of uniqueCandidateIds) {
      if (!candidateId.trim() || path.basename(candidateId) !== candidateId) {
        throw new Error(`Cannot mark invalid candidate ID as captured: ${candidateId}`);
      }
      const resume = await readJsonFile<CandidateResume>(
        path.join(paths.resumesDir, `${candidateId}.json`),
      );
      if (resume.candidateId !== candidateId) {
        throw new Error(`Captured resume identity ${resume.candidateId} does not match requested candidate ${candidateId}.`);
      }
    }
    const seenIds = await readJsonFile<string[]>(paths.seenIdsPath, []);
    await writeJson(paths.seenIdsPath, [...new Set([...seenIds, ...uniqueCandidateIds])]);
  }

  /** Fails closed when a historical captured ID has no matching persisted resume. */
  async assertSeenIdsHaveResumes(platform: SupportedPlatform, jobKey: string): Promise<void> {
    const seenIds = await this.readSeenIds(platform, jobKey);
    for (const candidateId of seenIds) {
      const resume = await this.readCandidateResume(platform, jobKey, candidateId).catch((error) => {
        throw new Error(
          `Captured history invariant failed for ${platform}/${jobKey}: seen candidate ${candidateId} has no readable resume.`,
          { cause: error },
        );
      });
      if (resume.candidateId !== candidateId) {
        throw new Error(
          `Captured history invariant failed for ${platform}/${jobKey}: seen candidate ${candidateId} maps to resume ${resume.candidateId}.`,
        );
      }
    }
  }

  async getNewCandidates(platform: SupportedPlatform, jobKey: string, candidates: CandidateListItem[]): Promise<CandidateListItem[]> {
    const seenIds = new Set(await this.readSeenIds(platform, jobKey));
    return candidates.filter((candidate) => !seenIds.has(candidate.candidateId));
  }

  async saveCandidateResume(platform: SupportedPlatform, jobKey: string, resume: CandidateResume, rawText?: string, domSnapshot?: ResumeDomSnapshot): Promise<string> {
    if (!resume.candidateId.trim() || path.basename(resume.candidateId) !== resume.candidateId) {
      throw new Error(`Cannot save resume with invalid candidate ID: ${resume.candidateId}`);
    }
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.resumesDir, `${resume.candidateId}.json`);
    await writeJson(filePath, resume);
    const persisted = await readJsonFile<CandidateResume>(filePath);
    if (persisted.candidateId !== resume.candidateId) {
      throw new Error(`Persisted resume identity ${persisted.candidateId} does not match candidate ${resume.candidateId}.`);
    }

    if (rawText) {
      await fs.writeFile(path.join(paths.snapshotsDir, `${resume.candidateId}.txt`), rawText, 'utf8');
    }

    if (domSnapshot) {
      await writeJson(path.join(paths.domSnapshotsDir, `${resume.candidateId}.json`), domSnapshot);
    }

    return filePath;
  }

  async readCandidateResume(platform: SupportedPlatform, jobKey: string, candidateId: string): Promise<CandidateResume> {
    const { resumesDir } = this.getJobPaths(platform, jobKey);
    return readJsonFile<CandidateResume>(path.join(resumesDir, `${candidateId}.json`));
  }

  async readCandidateSnapshotIfExists(platform: SupportedPlatform, jobKey: string, candidateId: string): Promise<string | undefined> {
    const { snapshotsDir } = this.getJobPaths(platform, jobKey);

    try {
      return await fs.readFile(path.join(snapshotsDir, `${candidateId}.txt`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  /**
   * Stores a platform-neutral post-score routing decision.  Boss keeps its
   * historical artifact API below because its record additionally owns
   * native-forwarding state; non-Boss adapters use this API only.
   */
  async saveCandidateRoutingArtifact(
    platform: SupportedPlatform,
    jobKey: string,
    artifact: CandidateRoutingArtifact,
  ): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    if (artifact.routingDecisionId) {
      const filePath = path.join(
        paths.routingArtifactsDir,
        `${routingCandidateFileName(artifact.routingDecisionId)}.json`,
      );
      try {
        const existing = await readJsonFile<CandidateRoutingArtifact>(filePath);
        if (!isDeepStrictEqual(existing, artifact)) {
          throw new Error(`Routing decision ${artifact.routingDecisionId} already exists with different content.`);
        }
        return filePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeJson(filePath, artifact);
      const persisted = await readJsonFile<CandidateRoutingArtifact>(filePath);
      if (!isDeepStrictEqual(persisted, artifact)) {
        throw new Error(`Routing decision ${artifact.routingDecisionId} changed during idempotent write.`);
      }
      return filePath;
    }
    const stem = `${routingTimestamp(artifact.decidedAt)}-${routingCandidateFileName(artifact.candidateId)}`;
    let filePath = path.join(paths.routingArtifactsDir, `${stem}.json`);
    let suffix = 0;
    while (true) {
      try {
        await fs.access(filePath);
        suffix += 1;
        filePath = path.join(paths.routingArtifactsDir, `${stem}-${suffix}.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    await writeJson(filePath, artifact);
    return filePath;
  }

  async listCandidateRoutingArtifacts(
    platform: SupportedPlatform,
    jobKey: string,
  ): Promise<CandidateRoutingArtifact[]> {
    const { routingArtifactsDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(routingArtifactsDir);
    const artifacts = await Promise.all(files.map((file) =>
      readJsonFile<CandidateRoutingArtifact>(path.join(routingArtifactsDir, file)),
    ));
    return artifacts.sort((left, right) => left.decidedAt.localeCompare(right.decidedAt)
      || (left.routingDecisionId ?? left.candidateId).localeCompare(right.routingDecisionId ?? right.candidateId));
  }

  async readCandidateRoutingArtifactByDecisionId(
    platform: SupportedPlatform,
    jobKey: string,
    routingDecisionId: string,
  ): Promise<CandidateRoutingArtifact | undefined> {
    const { routingArtifactsDir } = this.getJobPaths(platform, jobKey);
    return readJsonFile<CandidateRoutingArtifact | undefined>(
      path.join(routingArtifactsDir, `${routingCandidateFileName(routingDecisionId)}.json`),
      undefined,
    );
  }

  async savePostScoreRoutingWorkItem(
    platform: SupportedPlatform,
    jobKey: string,
    item: PostScoreRoutingWorkItem,
  ): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.screeningWorkDir, `${routingCandidateFileName(item.candidateId)}.json`);
    await writeJsonIfChanged(filePath, item);
    return filePath;
  }

  async deletePostScoreRoutingWorkItem(
    platform: SupportedPlatform,
    jobKey: string,
    candidateId: string,
  ): Promise<void> {
    const { screeningWorkDir } = this.getJobPaths(platform, jobKey);
    await fs.rm(path.join(screeningWorkDir, `${routingCandidateFileName(candidateId)}.json`), { force: true });
  }

  async listPostScoreRoutingWorkItems(
    platform: SupportedPlatform,
    jobKey: string,
  ): Promise<PostScoreRoutingWorkItem[]> {
    const { screeningWorkDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(screeningWorkDir);
    return Promise.all(files.map((file) =>
      readJsonFile<PostScoreRoutingWorkItem>(path.join(screeningWorkDir, file)),
    ));
  }

  async saveCandidateResumeDocx(platform: SupportedPlatform, jobKey: string, fileName: string, content: Buffer): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const resumeExportsDir = path.join(paths.exportsDir, 'resumes');
    await ensureDir(resumeExportsDir);

    const filePath = path.join(resumeExportsDir, fileName);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  async saveCandidateScoreArtifact(platform: SupportedPlatform, jobKey: string, scoreArtifact: CandidateScoreArtifact): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.scoresDir, `${scoreArtifact.candidateId}.json`);
    await writeJson(filePath, scoreArtifact);
    return filePath;
  }

  /**
   * Appends an immutable Boss screening decision. The separate outbox API is
   * intentionally responsible for mutable external-forwarding state.
   */
  async saveBossCandidateRoutingArtifact(
    platform: 'boss',
    jobKey: string,
    artifact: BossCandidateRoutingArtifact,
  ): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    if (artifact.routingDecisionId) {
      const filePath = path.join(
        paths.routingArtifactsDir,
        `${routingCandidateFileName(artifact.routingDecisionId)}.json`,
      );
      try {
        const existing = await readJsonFile<BossCandidateRoutingArtifact>(filePath);
        if (!isDeepStrictEqual(existing, artifact)) {
          throw new Error(`Routing decision ${artifact.routingDecisionId} already exists with different content.`);
        }
        return filePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeJson(filePath, artifact);
      const persisted = await readJsonFile<BossCandidateRoutingArtifact>(filePath);
      if (!isDeepStrictEqual(persisted, artifact)) {
        throw new Error(`Routing decision ${artifact.routingDecisionId} changed during idempotent write.`);
      }
      return filePath;
    }
    const stem = `${routingTimestamp(artifact.decidedAt)}-${routingCandidateFileName(artifact.candidateId)}`;
    let suffix = 0;
    let filePath = path.join(paths.routingArtifactsDir, `${stem}.json`);

    while (true) {
      try {
        await fs.access(filePath);
        suffix += 1;
        filePath = path.join(paths.routingArtifactsDir, `${stem}-${suffix}.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        break;
      }
    }

    await writeJson(filePath, artifact);
    return filePath;
  }

  async listBossCandidateRoutingArtifacts(
    platform: 'boss',
    jobKey: string,
  ): Promise<BossCandidateRoutingArtifact[]> {
    const { routingArtifactsDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(routingArtifactsDir);
    const artifacts = await Promise.all(files.map((file) =>
      readJsonFile<BossCandidateRoutingArtifact>(path.join(routingArtifactsDir, file)),
    ));
    return artifacts.sort((left, right) => left.decidedAt.localeCompare(right.decidedAt)
      || (left.routingDecisionId ?? left.candidateId).localeCompare(right.routingDecisionId ?? right.candidateId));
  }

  async readBossCandidateRoutingArtifactByDecisionId(
    platform: 'boss',
    jobKey: string,
    routingDecisionId: string,
  ): Promise<BossCandidateRoutingArtifact | undefined> {
    const { routingArtifactsDir } = this.getJobPaths(platform, jobKey);
    const filePath = path.join(routingArtifactsDir, `${routingCandidateFileName(routingDecisionId)}.json`);
    return readJsonFile<BossCandidateRoutingArtifact | undefined>(filePath, undefined);
  }

  async saveBossScreeningWorkItem(
    platform: 'boss',
    jobKey: string,
    item: BossScreeningWorkItem,
  ): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.screeningWorkDir, `${routingCandidateFileName(item.candidateId)}.json`);
    await writeJsonIfChanged(filePath, item);
    return filePath;
  }

  async deleteBossScreeningWorkItem(
    platform: 'boss',
    jobKey: string,
    candidateId: string,
  ): Promise<void> {
    const { screeningWorkDir } = this.getJobPaths(platform, jobKey);
    await fs.rm(path.join(screeningWorkDir, `${routingCandidateFileName(candidateId)}.json`), { force: true });
  }

  async listBossScreeningWorkItems(
    platform: 'boss',
    jobKey: string,
  ): Promise<BossScreeningWorkItem[]> {
    const { screeningWorkDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(screeningWorkDir);
    return Promise.all(files.map((file) =>
      readJsonFile<BossScreeningWorkItem>(path.join(screeningWorkDir, file)),
    ));
  }

  async saveBossForwardingOutboxEntry(
    platform: 'boss',
    jobKey: string,
    entry: BossForwardingOutboxEntry,
  ): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.forwardingOutboxDir, `${routingCandidateFileName(entry.candidateId)}.json`);
    await writeJsonIfChanged(filePath, entry);
    return filePath;
  }

  async readBossForwardingOutboxEntry(
    platform: 'boss',
    jobKey: string,
    candidateId: string,
  ): Promise<BossForwardingOutboxEntry | undefined> {
    const { forwardingOutboxDir } = this.getJobPaths(platform, jobKey);
    return readJsonFile<BossForwardingOutboxEntry | undefined>(
      path.join(forwardingOutboxDir, `${routingCandidateFileName(candidateId)}.json`),
      undefined,
    );
  }

  async listBossForwardingOutboxEntries(
    platform: 'boss',
    jobKey: string,
  ): Promise<BossForwardingOutboxEntry[]> {
    const { forwardingOutboxDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(forwardingOutboxDir);
    return Promise.all(files.map((file) =>
      readJsonFile<BossForwardingOutboxEntry>(path.join(forwardingOutboxDir, file)),
    ));
  }

  async saveJobExport(platform: SupportedPlatform, jobKey: string, markdown: string): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.exportsDir, 'latest.md');
    await fs.writeFile(filePath, markdown, 'utf8');
    return filePath;
  }

  async listStoredResumes(platform: SupportedPlatform, jobKey: string): Promise<CandidateResume[]> {
    const { resumesDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(resumesDir);

    return Promise.all(files.map((file) => readJsonFile<CandidateResume>(path.join(resumesDir, file))));
  }

  async listRunResults(platform: SupportedPlatform, jobKey: string): Promise<RunResult[]> {
    const { resultsDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(resultsDir);
    return Promise.all(files.map(async (file) => normalizeRunResult(
      await readJsonFile<LegacyRunResult>(path.join(resultsDir, file)),
    )));
  }

  async listStoredScoreArtifacts(platform: SupportedPlatform, jobKey: string): Promise<CandidateScoreArtifact[]> {
    const { scoresDir } = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(scoresDir);

    return Promise.all(files.map((file) => readJsonFile<CandidateScoreArtifact>(path.join(scoresDir, file))));
  }

  async listStoredResumeSnapshots(platform: SupportedPlatform, jobKey: string): Promise<StoredResumeSnapshot[]> {
    const paths = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(paths.resumesDir);

    return Promise.all(files.map(async (file) => {
      const candidateId = file.replace(/\.json$/, '');
      const resumePath = path.join(paths.resumesDir, file);
      const snapshotPath = path.join(paths.snapshotsDir, `${candidateId}.txt`);
      const domSnapshotPath = path.join(paths.domSnapshotsDir, `${candidateId}.json`);
      const resume = await readJsonFile<LegacyResumeSnapshotSource>(resumePath, { candidateId });

      let snapshotContent: string;
      let migratedSnapshot = false;

      try {
        snapshotContent = await fs.readFile(snapshotPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        if (!resume.rawSnapshot) {
          throw new Error(`Missing snapshot for candidate ${candidateId}`);
        }

        snapshotContent = resume.rawSnapshot;
        await fs.writeFile(snapshotPath, snapshotContent, 'utf8');
        migratedSnapshot = true;
      }

      let domSnapshot: ResumeDomSnapshot | undefined;
      try {
        domSnapshot = JSON.parse(await fs.readFile(domSnapshotPath, 'utf8')) as ResumeDomSnapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      return {
        candidateId,
        name: resume.name,
        resumeUrl: resume.resumeUrl,
        snapshotContent,
        domSnapshot,
        migratedSnapshot,
      };
    }));
  }

  async saveRunResult(platform: SupportedPlatform, jobKey: string, runResult: RunResult): Promise<string> {
    if (runResult.runResultVersion === 2 && !Array.isArray(runResult.capturedCandidateIds)) {
      throw new Error(`RunResult v2 for ${platform}/${jobKey} must include capturedCandidateIds.`);
    }
    const paths = await this.initializeJob(platform, jobKey);
    const timestamp = runResult.fetchedAt.replace(/[:.]/g, '-');
    const filePath = path.join(paths.resultsDir, `${timestamp}.json`);
    const persistedRunResult = runResult.runResultVersion === 2
      ? (() => {
        const { newCandidateIds: _legacyAttemptIds, ...v2RunResult } = runResult;
        return v2RunResult;
      })()
      : runResult;
    await writeJson(filePath, {
      ...persistedRunResult,
      platform,
    });
    return filePath;
  }

  async readBossChatReviewedConversationIds(): Promise<string[]> {
    const { reviewedConversationIdsPath } = this.getBossChatReviewPaths();
    return readJsonFile<string[]>(reviewedConversationIdsPath, []);
  }

  async readBossAutomationSettings(): Promise<BossAutomationSettings> {
    const { automationSettingsPath } = this.getBossChatReviewPaths();
    return readJsonFile<BossAutomationSettings>(automationSettingsPath, {});
  }

  async saveBossAutomationSettings(settings: BossAutomationSettings): Promise<void> {
    const paths = this.getBossChatReviewPaths();
    await ensureDir(paths.dir);
    await writeJsonIfChanged(paths.automationSettingsPath, {
      ...(settings.forwarding ? {
        forwarding: {
          mode: settings.forwarding.mode,
          recipient: settings.forwarding.recipient.trim(),
          ...(settings.forwarding.ccEmails === undefined ? {} : {
            ccEmails: [...new Set(settings.forwarding.ccEmails.map((email) => email.trim()).filter(Boolean))],
          }),
        },
      } : {}),
      ...(settings.summaryDelivery ? {
        summaryDelivery: {
          recipientEmail: settings.summaryDelivery.recipientEmail.trim(),
          ccEmails: settings.summaryDelivery.ccEmails
            ? [...new Set(settings.summaryDelivery.ccEmails.map((email) => email.trim()).filter(Boolean))]
            : undefined,
        },
      } : {}),
    });
  }

  async saveBossChatReviewedConversationIds(conversationIds: string[]): Promise<void> {
    const paths = this.getBossChatReviewPaths();
    await ensureDir(paths.dir);
    await writeJson(paths.reviewedConversationIdsPath, [...new Set(conversationIds)]);
  }

  async readBossChatRetryItems(): Promise<BossChatReviewItem[]> {
    const { runsDir } = this.getBossChatReviewPaths();
    const files = await listJsonFiles(runsDir);
    const runs = await Promise.all(files.map((file) => readJsonFile<BossChatReviewRun>(path.join(runsDir, file))));
    const retryItems = new Map<string, BossChatReviewItem>();

    for (const run of runs.sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt))) {
      for (const item of run.items) {
        const retryableLegacyConfigSkip = item.status === 'skipped_missing_jd'
          || item.status === 'skipped_missing_forwarding_config';
        if ((item.status === 'failed' && item.forwarded !== true) || retryableLegacyConfigSkip) {
          retryItems.set(item.conversationId, item);
        } else {
          retryItems.delete(item.conversationId);
        }
      }
    }

    return [...retryItems.values()];
  }

  async saveBossChatReviewRun(run: BossChatReviewRun): Promise<string> {
    const paths = this.getBossChatReviewPaths();
    await ensureDir(paths.runsDir);
    const timestamp = run.reviewedAt.replace(/[:.]/g, '-');
    const filePath = path.join(paths.runsDir, `${timestamp}.json`);
    await writeJson(filePath, run);
    return filePath;
  }

  async saveBossPositionSnapshot(positions: readonly BossPositionSummary[]): Promise<string> {
    const paths = this.getBossJobSyncPaths();
    await ensureDir(paths.dir);
    await writeJson(paths.latestPositionsPath, positions);
    return paths.latestPositionsPath;
  }

  async readLatestBossPositionSnapshot(): Promise<BossPositionSummary[]> {
    return readJsonFile<BossPositionSummary[]>(this.getBossJobSyncPaths().latestPositionsPath, []);
  }

  async saveBossJobSyncRun(run: BossJobSyncRun): Promise<string> {
    const paths = this.getBossJobSyncPaths();
    await ensureDir(paths.runsDir);
    const timestamp = run.syncedAt.replace(/[:.]/g, '-');
    const filePath = path.join(paths.runsDir, `${timestamp}.json`);
    await writeJson(filePath, run);
    return filePath;
  }

  async saveSearchFilterCatalog(
    platform: SupportedPlatform,
    catalog: SearchFilterCatalog,
    outputPath?: string,
  ): Promise<{ latestPath: string; timestampedPath: string; outputPath?: string }> {
    const paths = this.getFilterCatalogPaths(platform);
    await ensureDir(paths.dir);
    const timestamp = catalog.capturedAt.replace(/[:.]/g, '-');
    const timestampedPath = path.join(paths.dir, `${timestamp}.json`);

    await Promise.all([
      writeJson(paths.latestPath, catalog),
      writeJson(timestampedPath, catalog),
      outputPath ? writeJson(path.resolve(outputPath), catalog) : Promise.resolve(),
    ]);

    return {
      latestPath: paths.latestPath,
      timestampedPath,
      outputPath: outputPath ? path.resolve(outputPath) : undefined,
    };
  }

  async readLatestSearchFilterCatalog(platform: SupportedPlatform): Promise<SearchFilterCatalog | undefined> {
    const { latestPath } = this.getFilterCatalogPaths(platform);
    return readJsonFile<SearchFilterCatalog | undefined>(latestPath, undefined);
  }
}
