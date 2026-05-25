import { readFile } from 'node:fs/promises';
import { buildJobKey, parseJobDescription } from './parsers/jd-parser.js';
import { config } from './config.js';
import { JobStore } from './storage/job-store.js';
import { BrowserSession, closeBrowserSession, ensureAuthenticatedBrowserSession } from './browser/session.js';
import { createProductionExtractionBoundary } from './extraction/production-extractor.js';
import { isCrawl4aiAdapterAvailable } from './extraction/crawl4ai-extractor.js';
import { getPlatformAdapter, listSupportedPlatforms, parsePlatformArg } from './platforms/registry.js';
import { fiftyOneJobAdapter } from './platforms/51job-adapter.js';
import type { PlatformAdapter, SupportedPlatform } from './platforms/types.js';
import { scoreResumeAgainstJob } from './scoring/score-resume.js';
import { exportJobResults, type ExportJobResultsSummary } from './scripts/export-job-results.js';
import { sendJobReport, type SendJobReportSummary } from './scripts/send-job-report-email.js';
import { CandidateListItem, JobRecord, NormalizedJob, parseEmailList, ReportDeliveryOptions, resolveReportDelivery, RunResult } from './types/job.js';

interface CandidateProcessResult {
  candidateId: string;
  markAsSeen: boolean;
  captured: boolean;
  failureReason?: string;
}

interface CandidateScoringResult {
  scoredCandidates: string[];
  failedCandidates: Array<{
    candidateId: string;
    error: string;
  }>;
}

type CliPlatformSelection = SupportedPlatform | 'all';

interface CliInput extends ReportDeliveryOptions {
  platform: CliPlatformSelection;
  searchKeyword: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
}

interface SinglePlatformCliInput extends ReportDeliveryOptions {
  platform: SupportedPlatform;
  searchKeyword: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
}

export interface MainRunSummary {
  jobKey: string;
  totalCandidates: number;
  newCandidates: number;
  scoredCandidates: number;
  failedCandidates: number;
  resultPath: string;
  exportPath?: string;
  exportError?: string;
  emailAttempted: boolean;
  emailDelivered: boolean;
  emailRecipient?: string;
  emailSubject?: string;
  emailError?: string;
  sampleCandidateIds: string[];
}

export interface AllPlatformsRunSummary {
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export type MainResult = MainRunSummary | AllPlatformsRunSummary[];

export const parseJobDescriptionRef = { fn: parseJobDescription };
export const extractionBoundary = createProductionExtractionBoundary();
export const openSubscribeSearchRef = { fn: fiftyOneJobAdapter.openSubscribeSearch };
export const openResumeDetailRef = { fn: fiftyOneJobAdapter.openResumeDetail };
export const extractCandidateListRef = {
  fn: extractionBoundary.extractCandidateListFromPage,
};
export const extractCandidateListWithAdapterRef = {
  fn: async (adapter: PlatformAdapter, page: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>) => adapter.extractCandidateList(page),
};
export const extractResumeFromPageRef = {
  fn: extractionBoundary.extractResumeFromPage,
};
export const scoreResumeAgainstJobRef = { fn: scoreResumeAgainstJob };
export const exportJobResultsRef = { fn: exportJobResults };
export const sendJobReportRef = { fn: sendJobReport };
export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export { JobStore };

export function resolvePlatformAdapter(platform: SupportedPlatform): PlatformAdapter {
  const adapter = getPlatformAdapter(platform);

  if (platform === '51job') {
    return {
      ...adapter,
      openSubscribeSearch: openSubscribeSearchRef.fn,
      extractCandidateList: async (page) => extractCandidateListRef.fn(page),
      openResumeDetail: openResumeDetailRef.fn,
    };
  }

  return adapter;
}

function parsePlatformSelection(platform?: string): CliPlatformSelection {
  if (platform === 'all') {
    return 'all';
  }

  return parsePlatformArg(platform);
}

function parseArgs(argv: readonly string[]): CliInput {
  const values = new Map<string, string>();
  const flagPresence = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    flagPresence.add(key);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  const searchKeyword = values.get('keyword');
  const platform = parsePlatformSelection(values.get('platform'));
  const jobDescriptionText = values.get('jd');
  const jobDescriptionFilePath = values.get('jd-file');
  const recipientEmail = values.get('email');
  const ccEmails = flagPresence.has('cc') ? parseEmailList(values.get('cc')) : undefined;

  if (!searchKeyword) {
    throw new Error('Missing required argument --keyword');
  }

  if (jobDescriptionText && jobDescriptionFilePath) {
    throw new Error('Arguments --jd and --jd-file are mutually exclusive');
  }

  return {
    platform,
    searchKeyword,
    recipientEmail,
    ccEmails,
    jobDescriptionText,
    jobDescriptionFilePath,
  };
}

function buildSinglePlatformInput(input: CliInput, platform: SupportedPlatform): SinglePlatformCliInput {
  return {
    platform,
    searchKeyword: input.searchKeyword,
    recipientEmail: input.recipientEmail,
    ccEmails: input.ccEmails,
    jobDescriptionText: input.jobDescriptionText,
    jobDescriptionFilePath: input.jobDescriptionFilePath,
  };
}

async function captureCandidateResume(
  platform: SupportedPlatform,
  jobKey: string,
  candidate: CandidateListItem,
  store: JobStore,
  session: BrowserSession,
  searchPage: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
  platformAdapter: PlatformAdapter,
): Promise<CandidateProcessResult> {
  let detailPage = session.page;

  try {
    detailPage = await platformAdapter.openResumeDetail(session.context, searchPage, candidate);
    const extraction = platformAdapter.platform === '51job'
      ? await extractResumeFromPageRef.fn(detailPage, candidate)
      : {
        resume: await platformAdapter.parseResumeDetail(detailPage, candidate),
      };
    const { resume, domSnapshot } = extraction;
    const rawSource = await detailPage.locator('body').innerText().catch(() => undefined);
    await store.saveCandidateResume(platform, jobKey, resume, rawSource, domSnapshot);

    return {
      candidateId: candidate.candidateId,
      markAsSeen: true,
      captured: true,
    };
  } catch (error) {
    return {
      candidateId: candidate.candidateId,
      markAsSeen: false,
      captured: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (detailPage !== session.page && detailPage !== searchPage) {
      await detailPage.close().catch(() => undefined);
    }
  }
}

async function scoreCapturedResumes(
  platform: SupportedPlatform,
  jobKey: string,
  job: NormalizedJob,
  store: JobStore,
  capturedCandidateIds: string[],
): Promise<CandidateScoringResult> {
  if (capturedCandidateIds.length === 0) {
    return {
      scoredCandidates: [],
      failedCandidates: [],
    };
  }

  const capturedCandidateIdSet = new Set(capturedCandidateIds);
  const storedResumes = await store.listStoredResumes(platform, jobKey);
  const resumesById = new Map(storedResumes.map((resume) => [resume.candidateId, resume]));
  const scoredCandidates: string[] = [];
  const failedCandidates: Array<{ candidateId: string; error: string }> = [];

  for (const candidateId of capturedCandidateIds) {
    const resume = resumesById.get(candidateId);

    if (!resume) {
      failedCandidates.push({
        candidateId,
        error: `Stored resume not found for captured candidate ${candidateId}`,
      });
      continue;
    }

    const scoredAt = new Date().toISOString();
    const scoreArtifactBase = {
      candidateId: resume.candidateId,
      model: config.scoring.model,
      scoredAt,
    };

    try {
      const score = await scoreResumeAgainstJobRef.fn(job, resume);
      await store.saveCandidateScoreArtifact(platform, jobKey, {
        ...scoreArtifactBase,
        status: 'success',
        score,
      });
      scoredCandidates.push(resume.candidateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.saveCandidateScoreArtifact(platform, jobKey, {
        ...scoreArtifactBase,
        status: 'failed',
        error: message,
      });
      failedCandidates.push({ candidateId: resume.candidateId, error: message });
    }
  }

  return {
    scoredCandidates: scoredCandidates.filter((candidateId) => capturedCandidateIdSet.has(candidateId)),
    failedCandidates,
  };
}

export async function runResumeCaptureFlow(platform: SupportedPlatform, jobKey: string, job: NormalizedJob, searchKeyword: string, store: JobStore, session: BrowserSession, fetchedAt: string, platformAdapter: PlatformAdapter): Promise<{ candidates: CandidateListItem[]; newCandidates: CandidateListItem[]; runResult: RunResult; resultPath: string }> {
  const searchPage = await platformAdapter.openSubscribeSearch(session.page, searchKeyword);
  const { candidates } = platformAdapter.platform === '51job'
    ? await extractCandidateListRef.fn(searchPage)
    : await extractCandidateListWithAdapterRef.fn(platformAdapter, searchPage);
  const seenCandidateIdsBeforeRun = await store.readSeenIds(platform, jobKey);
  const seenCandidateIdsSet = new Set(seenCandidateIdsBeforeRun);
  const newCandidates = candidates.filter((candidate) => !seenCandidateIdsSet.has(candidate.candidateId));
  const candidateResults: CandidateProcessResult[] = [];

  for (const candidate of newCandidates) {
    candidateResults.push(await captureCandidateResume(platform, jobKey, candidate, store, session, searchPage, platformAdapter));
  }

  const seenCandidateIds = candidateResults
    .filter((result) => result.markAsSeen)
    .map((result) => result.candidateId);
  const capturedCandidateIds = candidateResults
    .filter((result) => result.captured)
    .map((result) => result.candidateId);

  await store.saveSeenIds(platform, jobKey, [
    ...seenCandidateIdsBeforeRun,
    ...seenCandidateIds,
  ]);

  const scoringResult = await scoreCapturedResumes(platform, jobKey, job, store, capturedCandidateIds);
  const failedCandidates = [
    ...candidateResults
      .filter((result) => !result.captured)
      .map((result) => ({
        candidateId: result.candidateId,
        error: result.failureReason ?? 'Unknown error',
      })),
    ...scoringResult.failedCandidates,
  ];

  const runResult: RunResult = {
    jobKey,
    platform: platformAdapter.platform,
    fetchedAt,
    totalCandidates: candidates.length,
    newCandidateIds: newCandidates.map((candidate) => candidate.candidateId),
    scoredCandidates: scoringResult.scoredCandidates,
    failedCandidates,
  };

  const resultPath = await store.saveRunResult(platform, jobKey, runResult);

  return { candidates, newCandidates, runResult, resultPath };
}

async function runSinglePlatform(input: SinglePlatformCliInput, options: { printSummary: boolean } = { printSummary: true }): Promise<MainRunSummary> {
  const platformAdapter = resolvePlatformAdapter(input.platform);
  const store = new JobStore();
  const jobKey = buildJobKey(input.searchKeyword, '');
  const fetchedAt = new Date().toISOString();
  const existingJobRecord = await store.readJobRecordIfExists(input.platform, jobKey);

  if (!existingJobRecord && !input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error('Missing required argument --jd or --jd-file');
  }

  const jobDescriptionText = existingJobRecord
    ? existingJobRecord.rawText
    : input.jobDescriptionText ?? await readFile(input.jobDescriptionFilePath!, 'utf8');
  const normalizedJob = existingJobRecord
    ? existingJobRecord.normalizedJob
    : await parseJobDescriptionRef.fn(jobDescriptionText);
  const effectiveJobRecord: JobRecord = existingJobRecord
    ? {
      ...existingJobRecord,
      platform: existingJobRecord.platform,
      searchKeyword: input.searchKeyword,
      recipientEmail: input.recipientEmail ?? existingJobRecord.recipientEmail,
      ccEmails: input.ccEmails === undefined ? existingJobRecord.ccEmails : input.ccEmails,
    }
    : {
      jobKey,
      platform: input.platform,
      searchKeyword: input.searchKeyword,
      recipientEmail: input.recipientEmail,
      ccEmails: input.ccEmails,
      rawText: jobDescriptionText,
      normalizedJob,
      createdAt: fetchedAt,
    };
  const storedDelivery: ReportDeliveryOptions = existingJobRecord
    ? {
      recipientEmail: existingJobRecord.recipientEmail,
      ccEmails: existingJobRecord.ccEmails,
    }
    : {};
  const delivery = resolveReportDelivery(storedDelivery, input);

  const jobRecord: JobRecord = {
    ...effectiveJobRecord,
    recipientEmail: delivery.recipientEmail,
    ccEmails: delivery.ccEmails,
  };

  await store.saveJobRecord(input.platform, jobRecord);

  if (!isCrawl4aiAdapterAvailable()) {
    console.warn('Crawl4AI adapter unavailable at startup; continuing with built-in extraction only.');
  }

  const session = await ensureAuthenticatedBrowserSessionRef.fn(platformAdapter.platform);

  try {
    const { candidates, newCandidates, runResult, resultPath } = await runResumeCaptureFlow(
      input.platform,
      jobKey,
      normalizedJob,
      input.searchKeyword,
      store,
      session,
      fetchedAt,
      platformAdapter,
    );

    let exportSummary: ExportJobResultsSummary | undefined;
    let exportError: string | undefined;
    let emailSummary: SendJobReportSummary | undefined;
    let emailError: string | undefined;

    const exportPromise = exportJobResultsRef.fn(input.platform, jobKey);
    const emailPromise = delivery.recipientEmail
      ? sendJobReportRef.fn(input.platform, jobKey, delivery)
      : undefined;

    const [exportResult, emailResult] = await Promise.allSettled([
      exportPromise,
      emailPromise,
    ]);

    if (exportResult.status === 'fulfilled') {
      exportSummary = exportResult.value;
    } else {
      exportError = exportResult.reason instanceof Error ? exportResult.reason.message : String(exportResult.reason);
      console.error(exportError);
    }

    if (emailResult?.status === 'fulfilled') {
      emailSummary = emailResult.value;
    } else if (emailResult?.status === 'rejected') {
      emailError = emailResult.reason instanceof Error ? emailResult.reason.message : String(emailResult.reason);
      console.error(emailError);
    }

    const summary: MainRunSummary = {
      jobKey,
      totalCandidates: candidates.length,
      newCandidates: newCandidates.length,
      scoredCandidates: runResult.scoredCandidates.length,
      failedCandidates: runResult.failedCandidates.length,
      resultPath,
      exportPath: exportSummary?.exportPath,
      exportError,
      emailAttempted: Boolean(delivery.recipientEmail),
      emailDelivered: Boolean(emailSummary),
      emailRecipient: emailSummary?.recipient,
      emailSubject: emailSummary?.subject,
      emailError,
      sampleCandidateIds: newCandidates.slice(0, 10).map((candidate) => candidate.candidateId),
    };

    if (options.printSummary) {
      console.log(JSON.stringify(summary, null, 2));
    }

    return summary;
  } finally {
    await closeBrowserSessionRef.fn(session);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<MainResult> {
  const input = parseArgs(argv);

  if (input.platform === 'all') {
    const summaries: AllPlatformsRunSummary[] = [];

    for (const platform of listSupportedPlatforms()) {
      summaries.push({
        platform,
        summary: await runSinglePlatform(buildSinglePlatformInput(input, platform), { printSummary: false }),
      });
    }

    console.log(JSON.stringify(summaries, null, 2));
    return summaries;
  }

  return runSinglePlatform(buildSinglePlatformInput(input, input.platform));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
