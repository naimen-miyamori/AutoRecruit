import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  CandidateListItem,
  CandidateResume,
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
  return {
    ...jobRecord,
    platform: jobRecord.platform ?? '51job',
  };
}

function normalizeRunResult(runResult: LegacyRunResult): RunResult {
  return {
    ...runResult,
    platform: runResult.platform ?? '51job',
  };
}

export class JobStore {
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
    await writeJson(paths.jdPath, {
      ...jobRecord,
      platform,
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
}
