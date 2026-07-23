import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';
import type { BossJobSyncRun, BossPositionSummary } from '../types/boss.js';
import {
  CandidateListItem,
  CandidateResume,
  BossAutomationSettings,
  BossChatReviewItem,
  BossChatReviewRun,
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

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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

  await fs.writeFile(filePath, content, 'utf8');
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

function normalizeJobRecord(jobRecord: LegacyJobRecord): JobRecord {
  const {
    recipientEmail,
    ccEmails,
    bossForwarding,
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
    }
    : undefined;

  return {
    ...rest,
    platform: jobRecord.platform ?? '51job',
    ...(normalizedRecipientEmail ? { recipientEmail: normalizedRecipientEmail } : {}),
    ...(normalizedCcEmails ? { ccEmails: normalizedCcEmails } : {}),
    ...(normalizedBossForwarding ? { bossForwarding: normalizedBossForwarding } : {}),
  };
}

function normalizeRunResult(runResult: LegacyRunResult): RunResult {
  return {
    ...runResult,
    platform: runResult.platform ?? '51job',
  };
}

export class JobStore {
  private getBossJobSyncPaths(): BossJobSyncPaths {
    const dir = path.join(config.dataDir, 'boss', 'job-sync');
    return {
      dir,
      runsDir: path.join(dir, 'runs'),
      latestPositionsPath: path.join(dir, 'positions.latest.json'),
    };
  }

  private getBossChatReviewPaths(): BossChatReviewPaths {
    const dir = path.join(config.dataDir, 'boss', 'chat-review');
    return {
      dir,
      runsDir: path.join(dir, 'runs'),
      automationSettingsPath: path.join(dir, 'automation-settings.json'),
      reviewedConversationIdsPath: path.join(dir, 'reviewed-conversation-ids.json'),
    };
  }

  private getFilterCatalogPaths(platform: SupportedPlatform): FilterCatalogPaths {
    const dir = path.join(config.dataDir, platform, 'filter-catalog');
    return {
      dir,
      latestPath: path.join(dir, 'latest.json'),
    };
  }

  private getJobPaths(platform: SupportedPlatform, jobKey: string): JobPaths {
    const jobDir = path.join(config.dataDir, platform, 'jobs', jobKey);
    return {
      jobDir,
      resumesDir: path.join(jobDir, 'resumes'),
      resultsDir: path.join(jobDir, 'results'),
      scoresDir: path.join(jobDir, 'scores'),
      exportsDir: path.join(jobDir, 'exports'),
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
      ensureDir(paths.snapshotsDir),
      ensureDir(paths.domSnapshotsDir),
    ]);
  }

  async initializeJob(platform: SupportedPlatform, jobKey: string): Promise<JobPaths> {
    const paths = this.getJobPaths(platform, jobKey);
    await this.ensureJobPaths(paths);
    return paths;
  }

  async saveJobRecord(platform: SupportedPlatform, jobRecord: JobRecord): Promise<void> {
    const paths = await this.initializeJob(platform, jobRecord.jobKey);
    await writeJsonIfChanged(paths.jdPath, {
      ...jobRecord,
      platform,
      recipientEmail: jobRecord.recipientEmail?.trim() || undefined,
      ccEmails: jobRecord.ccEmails
        ? [...new Set(jobRecord.ccEmails.map((email) => email.trim()).filter(Boolean))]
        : undefined,
      bossForwarding: jobRecord.bossForwarding?.recipient.trim()
        ? {
          mode: jobRecord.bossForwarding.mode,
          recipient: jobRecord.bossForwarding.recipient.trim(),
        }
        : undefined,
    });
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
    const jobsDir = path.join(config.dataDir, platform, 'jobs');
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

  async getNewCandidates(platform: SupportedPlatform, jobKey: string, candidates: CandidateListItem[]): Promise<CandidateListItem[]> {
    const seenIds = new Set(await this.readSeenIds(platform, jobKey));
    return candidates.filter((candidate) => !seenIds.has(candidate.candidateId));
  }

  async saveCandidateResume(platform: SupportedPlatform, jobKey: string, resume: CandidateResume, rawText?: string, domSnapshot?: ResumeDomSnapshot): Promise<string> {
    const paths = await this.initializeJob(platform, jobKey);
    const filePath = path.join(paths.resumesDir, `${resume.candidateId}.json`);
    await writeJson(filePath, resume);

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
    const paths = await this.initializeJob(platform, jobKey);
    const timestamp = runResult.fetchedAt.replace(/[:.]/g, '-');
    const filePath = path.join(paths.resultsDir, `${timestamp}.json`);
    await writeJson(filePath, {
      ...runResult,
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
