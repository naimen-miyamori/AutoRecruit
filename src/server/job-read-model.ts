import fs from 'node:fs/promises';
import path from 'node:path';
import { config, resolveStorageStatePath } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '../platforms/types.js';
import type { SearchFilterCatalog } from '../search/filter-catalog.js';
import { normalizeFailureMessage, summarizeFailureMessage } from './failure-summary.js';
import type {
  CandidateResume,
  CandidateScoreArtifact,
  JobRecord,
  RunResult,
} from '../types/job.js';
import type {
  CandidateDetail,
  CandidateSummary,
  DataAnomalySummary,
  FilterCatalogHealth,
  JobDetail,
  JobSummary,
  CandidateFunnelHealth,
  PlatformRunHealth,
  RunResultView,
  ScoreView,
  SessionHealth,
  TaskSummary,
} from './types.js';

interface JobReadModelOptions {
  dataDir?: string;
}

interface JobPaths {
  jobDir: string;
  jdPath: string;
  resumesDir: string;
  scoresDir: string;
  resultsDir: string;
  exportsDir: string;
  snapshotsDir: string;
  domSnapshotsDir: string;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
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

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
}

function normalizeRunResult(platform: SupportedPlatform, runResult: RunResult): RunResult {
  return {
    ...runResult,
    platform: runResult.platform ?? platform,
  };
}

function toScoreView(scoreArtifact?: CandidateScoreArtifact): ScoreView | undefined {
  if (!scoreArtifact) {
    return undefined;
  }

  if (scoreArtifact.status === 'success') {
    return {
      status: scoreArtifact.status,
      artifact: scoreArtifact,
      totalScore: scoreArtifact.score.totalScore,
      summary: scoreArtifact.score.summary,
    };
  }

  return {
    status: scoreArtifact.status,
    artifact: scoreArtifact,
    error: scoreArtifact.error,
  };
}

function latestRunResult(runs: RunResultView[]): RunResultView | undefined {
  return [...runs].sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0];
}

function latestTask(tasks: TaskSummary[], platform: SupportedPlatform, kind: TaskSummary['kind']): TaskSummary | undefined {
  return tasks
    .filter((task) => task.kind === kind && task.inputSummary.platform === platform)
    .sort((left, right) => (right.finishedAt ?? right.updatedAt).localeCompare(left.finishedAt ?? left.updatedAt))[0];
}

function getRunFailureDetail(run: RunResultView): string | undefined {
  return normalizeFailureMessage(run.failedCandidates[0]?.error);
}

function getRunFailureMessage(run: RunResultView): string | undefined {
  return summarizeFailureMessage(run.failedCandidates[0]?.error);
}

function isExportOnlyDirectory(filePaths: string[]): boolean {
  return filePaths.length > 0 && filePaths.every((filePath) => filePath.startsWith('exports/'));
}

async function listRelativeFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string, relativePath = ''): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, nextRelative);
      } else {
        results.push(nextRelative);
      }
    }
  }

  await walk(dirPath);
  return results.sort();
}

function buildCandidateSummary(
  platform: SupportedPlatform,
  jobKey: string,
  resume: CandidateResume,
  scoreArtifact?: CandidateScoreArtifact,
): CandidateSummary {
  const currentWork = resume.workExperiences[0];
  return {
    platform,
    jobKey,
    candidateId: resume.candidateId,
    name: resume.name,
    age: resume.age,
    education: resume.education,
    regions: resume.regions,
    currentCompany: currentWork?.company,
    currentTitle: currentWork?.title,
    candidateShareUrl: resume.candidateShareUrl,
    score: toScoreView(scoreArtifact),
  };
}

function truncateSnapshot(snapshot: string): string {
  const normalized = snapshot.replace(/\s+\n/g, '\n').trim();
  return normalized.length > 6000 ? `${normalized.slice(0, 6000)}...` : normalized;
}

function listReadablePlatforms(): SupportedPlatform[] {
  return [...SUPPORTED_PLATFORMS];
}

export class JobReadModel {
  private readonly dataDir: string;

  constructor(options: JobReadModelOptions = {}) {
    this.dataDir = options.dataDir ?? config.dataDir;
  }

  async listJobs(platform?: SupportedPlatform): Promise<JobSummary[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();
    const jobs: JobSummary[] = [];

    for (const currentPlatform of platforms) {
      const jobsDir = path.join(this.dataDir, currentPlatform, 'jobs');
      const jobKeys = await listDirectories(jobsDir);
      for (const jobKey of jobKeys) {
        if (!await pathExists(path.join(jobsDir, jobKey, 'jd.json'))) {
          continue;
        }
        jobs.push(await this.getJobSummary(currentPlatform, jobKey));
      }
    }

    return jobs.sort((left, right) => (right.latestRunAt ?? right.createdAt ?? '').localeCompare(left.latestRunAt ?? left.createdAt ?? ''));
  }

  async getJobDetail(platform: SupportedPlatform, jobKey: string): Promise<JobDetail | undefined> {
    const summary = await this.getJobSummaryIfExists(platform, jobKey);
    if (!summary) {
      return undefined;
    }

    const paths = this.getJobPaths(platform, jobKey);
    const jobRecord = await readJsonFileIfExists<JobRecord>(paths.jdPath);
    const exportPath = path.join(paths.exportsDir, 'latest.md');

    return {
      ...summary,
      jobRecord,
      normalizedJob: jobRecord?.normalizedJob,
      rawText: jobRecord?.rawText,
      recipientEmail: jobRecord?.recipientEmail,
      ccEmails: jobRecord?.ccEmails,
      exportPath: await pathExists(exportPath) ? exportPath : undefined,
    };
  }

  async listRuns(platform: SupportedPlatform, jobKey: string): Promise<RunResultView[]> {
    const paths = this.getJobPaths(platform, jobKey);
    const files = await listJsonFiles(paths.resultsDir);
    const runs = await Promise.all(files.map(async (file) => ({
      ...normalizeRunResult(platform, await readJsonFile<RunResult>(path.join(paths.resultsDir, file))),
      resultFile: path.join(paths.resultsDir, file),
    })));

    return runs.sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
  }

  async listCandidates(platform: SupportedPlatform, jobKey: string): Promise<CandidateSummary[]> {
    const paths = this.getJobPaths(platform, jobKey);
    const [resumeFiles, scoreFiles] = await Promise.all([
      listJsonFiles(paths.resumesDir),
      listJsonFiles(paths.scoresDir),
    ]);
    const scores = new Map<string, CandidateScoreArtifact>();
    await Promise.all(scoreFiles.map(async (file) => {
      const artifact = await readJsonFile<CandidateScoreArtifact>(path.join(paths.scoresDir, file));
      scores.set(artifact.candidateId, artifact);
    }));
    const candidates = await Promise.all(resumeFiles.map(async (file) => {
      const resume = await readJsonFile<CandidateResume>(path.join(paths.resumesDir, file));
      return buildCandidateSummary(platform, jobKey, resume, scores.get(resume.candidateId));
    }));

    return candidates.sort((left, right) => (right.score?.totalScore ?? -1) - (left.score?.totalScore ?? -1));
  }

  async getCandidateDetail(platform: SupportedPlatform, jobKey: string, candidateId: string): Promise<CandidateDetail | undefined> {
    assertSafeSegment(candidateId, 'candidateId');
    const paths = this.getJobPaths(platform, jobKey);
    const resume = await readJsonFileIfExists<CandidateResume>(path.join(paths.resumesDir, `${candidateId}.json`));
    if (!resume) {
      return undefined;
    }

    const scoreArtifact = await readJsonFileIfExists<CandidateScoreArtifact>(path.join(paths.scoresDir, `${candidateId}.json`));
    const snapshotPath = path.join(paths.snapshotsDir, `${candidateId}.txt`);
    const domSnapshotPath = path.join(paths.domSnapshotsDir, `${candidateId}.json`);
    const snapshot = await pathExists(snapshotPath) ? await fs.readFile(snapshotPath, 'utf8') : undefined;

    return {
      ...buildCandidateSummary(platform, jobKey, resume, scoreArtifact),
      resume,
      snapshotPath: snapshot ? snapshotPath : undefined,
      snapshotPreview: snapshot ? truncateSnapshot(snapshot) : undefined,
      domSnapshotPath: await pathExists(domSnapshotPath) ? domSnapshotPath : undefined,
    };
  }

  async listFilterCatalogs(platform?: SupportedPlatform): Promise<SearchFilterCatalog[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();
    const catalogs = await Promise.all(platforms.map(async (currentPlatform) => {
      const latestPath = path.join(this.dataDir, currentPlatform, 'filter-catalog', 'latest.json');
      return readJsonFileIfExists<SearchFilterCatalog>(latestPath);
    }));

    return catalogs.filter((catalog): catalog is SearchFilterCatalog => Boolean(catalog));
  }

  async getDataAnomalies(platform?: SupportedPlatform): Promise<DataAnomalySummary[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();

    return Promise.all(platforms.map(async (currentPlatform) => {
      const jobsDir = path.join(this.dataDir, currentPlatform, 'jobs');
      const jobKeys = await listDirectories(jobsDir);
      let validJobRecords = 0;
      let missingJd = 0;
      let emptyDirectories = 0;
      let exportOnlyDirectories = 0;
      const sampleOrphanDirectories: string[] = [];

      for (const jobKey of jobKeys) {
        const jobDir = path.join(jobsDir, jobKey);
        const hasJd = await pathExists(path.join(jobDir, 'jd.json'));
        if (hasJd) {
          validJobRecords += 1;
          continue;
        }

        missingJd += 1;
        const files = await listRelativeFiles(jobDir);
        if (files.length === 0) {
          emptyDirectories += 1;
        }
        if (isExportOnlyDirectory(files)) {
          exportOnlyDirectories += 1;
        }
        if (sampleOrphanDirectories.length < 5) {
          sampleOrphanDirectories.push(jobKey);
        }
      }

      return {
        platform: currentPlatform,
        jobDirectories: jobKeys.length,
        validJobRecords,
        missingJd,
        emptyDirectories,
        exportOnlyDirectories,
        sampleOrphanDirectories,
      };
    }));
  }

  async getPlatformRunHealth(platform?: SupportedPlatform): Promise<PlatformRunHealth[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();

    return Promise.all(platforms.map(async (currentPlatform) => {
      const jobs = await this.listJobs(currentPlatform);
      const allRuns = (await Promise.all(jobs.map((job) => this.listRuns(currentPlatform, job.jobKey)))).flat();
      const sortedRuns = [...allRuns].sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
      const failedRuns = sortedRuns.filter((run) => run.failedCandidates.length > 0);
      const latestSuccess = sortedRuns.find((run) => run.failedCandidates.length === 0);
      const latestFailure = failedRuns[0];
      let consecutiveFailures = 0;

      for (const run of sortedRuns) {
        if (run.failedCandidates.length === 0) {
          break;
        }
        consecutiveFailures += 1;
      }

      const zeroCandidateRuns = sortedRuns.filter((run) => run.totalCandidates === 0).length;
      const latestFailureDetail = latestFailure ? getRunFailureDetail(latestFailure) : undefined;

      return {
        platform: currentPlatform,
        jobCount: jobs.length,
        runCount: sortedRuns.length,
        latestSuccessAt: latestSuccess?.fetchedAt,
        latestFailureAt: latestFailure?.fetchedAt,
        latestFailureMessage: latestFailure ? getRunFailureMessage(latestFailure) : undefined,
        latestFailureDetail,
        consecutiveFailures,
        zeroCandidateRuns,
        zeroCandidateRate: sortedRuns.length > 0 ? zeroCandidateRuns / sortedRuns.length : 0,
      };
    }));
  }

  async getCandidateFunnels(platform?: SupportedPlatform): Promise<CandidateFunnelHealth[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();

    return Promise.all(platforms.map(async (currentPlatform) => {
      const jobs = await this.listJobs(currentPlatform);
      const runsByJob = await Promise.all(jobs.map((job) => this.listRuns(currentPlatform, job.jobKey)));
      const allRuns = runsByJob.flat();

      return {
        platform: currentPlatform,
        totalCandidates: allRuns.reduce((sum, run) => sum + run.totalCandidates, 0),
        newCandidates: allRuns.reduce((sum, run) => sum + run.newCandidateIds.length, 0),
        capturedResumes: jobs.reduce((sum, job) => sum + job.candidateCount, 0),
        scoredCandidates: allRuns.reduce((sum, run) => sum + run.scoredCandidates.length, 0),
        failedCandidates: allRuns.reduce((sum, run) => sum + run.failedCandidates.length, 0),
        scoreArtifacts: jobs.reduce((sum, job) => sum + job.scoreCount, 0),
      };
    }));
  }

  async getSessionHealth(tasks: TaskSummary[], platform?: SupportedPlatform): Promise<SessionHealth[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();

    return Promise.all(platforms.map(async (currentPlatform) => {
      const storageStatePath = resolveStorageStatePath(currentPlatform);
      const loginTask = latestTask(tasks, currentPlatform, 'login-refresh');
      let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
      try {
        stat = await fs.stat(storageStatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      return {
        platform: currentPlatform,
        storageStatePath,
        exists: Boolean(stat),
        updatedAt: stat?.mtime.toISOString(),
        recentLoginRefreshAt: loginTask?.finishedAt ?? loginTask?.updatedAt,
        recentLoginRefreshStatus: loginTask?.status,
        recentLoginRefreshError: loginTask?.error,
      };
    }));
  }

  async getFilterHealth(platform?: SupportedPlatform): Promise<FilterCatalogHealth[]> {
    const platforms = platform ? [platform] : listReadablePlatforms();
    const now = Date.now();

    return Promise.all(platforms.map(async (currentPlatform) => {
      const catalog = await readJsonFileIfExists<SearchFilterCatalog>(
        path.join(this.dataDir, currentPlatform, 'filter-catalog', 'latest.json'),
      );
      if (!catalog) {
        return {
          platform: currentPlatform,
          exists: false,
          fieldCount: 0,
          failedControls: 0,
          unknownControls: 0,
          optionsExtracted: 0,
        };
      }

      const capturedAtTime = Date.parse(catalog.capturedAt);
      return {
        platform: currentPlatform,
        exists: true,
        capturedAt: catalog.capturedAt,
        ageHours: Number.isNaN(capturedAtTime) ? undefined : Math.max(0, (now - capturedAtTime) / 3_600_000),
        fieldCount: catalog.stats.discoveredControls,
        failedControls: catalog.stats.failedControls,
        unknownControls: catalog.stats.unknownControls,
        optionsExtracted: catalog.stats.optionsExtracted,
      };
    }));
  }

  parsePlatform(value: string | undefined): SupportedPlatform | undefined {
    return value ? parsePlatformArg(value) : undefined;
  }

  private async getJobSummaryIfExists(platform: SupportedPlatform, jobKey: string): Promise<JobSummary | undefined> {
    try {
      return await this.getJobSummary(platform, jobKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  private async getJobSummary(platform: SupportedPlatform, jobKey: string): Promise<JobSummary> {
    const paths = this.getJobPaths(platform, jobKey);
    if (!await pathExists(paths.jobDir)) {
      const error = new Error(`Job not found: ${platform}/${jobKey}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }

    const [jobRecord, runs, resumeFiles, scoreFiles] = await Promise.all([
      readJsonFileIfExists<JobRecord>(paths.jdPath),
      this.listRuns(platform, jobKey),
      listJsonFiles(paths.resumesDir),
      listJsonFiles(paths.scoresDir),
    ]);
    const latestRun = latestRunResult(runs);

    return {
      platform,
      jobKey,
      searchKeyword: jobRecord?.searchKeyword,
      title: jobRecord?.normalizedJob.title,
      location: jobRecord?.normalizedJob.location,
      createdAt: jobRecord?.createdAt,
      runCount: runs.length,
      candidateCount: resumeFiles.length,
      scoreCount: scoreFiles.length,
      latestRunAt: latestRun?.fetchedAt,
      latestRun,
    };
  }

  private getJobPaths(platform: SupportedPlatform, jobKey: string): JobPaths {
    assertSafeSegment(jobKey, 'jobKey');
    const jobDir = path.join(this.dataDir, platform, 'jobs', jobKey);
    return {
      jobDir,
      jdPath: path.join(jobDir, 'jd.json'),
      resumesDir: path.join(jobDir, 'resumes'),
      scoresDir: path.join(jobDir, 'scores'),
      resultsDir: path.join(jobDir, 'results'),
      exportsDir: path.join(jobDir, 'exports'),
      snapshotsDir: path.join(jobDir, 'snapshots'),
      domSnapshotsDir: path.join(jobDir, 'snapshots-dom'),
    };
  }
}
